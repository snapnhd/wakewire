import { describe, expect, it, vi } from "vitest";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import { LINEAR_AGENT_SCOPES, LinearAgentTokenProvider, linearViewer } from "./token.js";

class MemorySecrets implements SecretStore {
  readonly backend = "file" as const;
  readonly values = new Map<string, string>();

  get(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }
}

describe("LinearAgentTokenProvider", () => {
  it("requests both mention and assignment agent capabilities", () => {
    expect(LINEAR_AGENT_SCOPES).toBe("read,write,app:mentionable,app:assignable");
  });

  it("mints one renewable app token for concurrent callers and caches until expiry", async () => {
    const secrets = new MemorySecrets();
    secrets.set(secretNames.linearAgentClientId("linear"), "client-id");
    secrets.set(secretNames.linearAgentClientSecret("linear"), "client-secret");
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get("grant_type")).toBe("client_credentials");
      expect(form.get("scope")).toBe(LINEAR_AGENT_SCOPES);
      expect(form.get("client_id")).toBe("client-id");
      expect(form.get("client_secret")).toBe("client-secret");
      return new Response(JSON.stringify({ access_token: "agent-token", expires_in: 2_592_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new LinearAgentTokenProvider("linear", secrets, {
      fetch,
      now: () => 1_000,
    });

    await expect(Promise.all([provider.getToken(), provider.getToken()])).resolves.toEqual([
      "agent-token",
      "agent-token",
    ]);
    await expect(provider.getToken()).resolves.toBe("agent-token");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(secrets.get(secretNames.linearAgentTokenExpiresAt("linear"))).toBe(
      String(1_000 + 2_592_000_000),
    );
  });

  it("fails closed when an expired token has no renewable credentials", async () => {
    const secrets = new MemorySecrets();
    secrets.set(secretNames.linearAgentToken("linear"), "expired");
    secrets.set(secretNames.linearAgentTokenExpiresAt("linear"), "1");
    const provider = new LinearAgentTokenProvider("linear", secrets, { now: () => 10_000 });

    await expect(provider.getToken()).rejects.toThrow(/renewable Linear app credentials/);
  });

  it("does not accept a legacy non-expiring bearer token", async () => {
    const secrets = new MemorySecrets();
    secrets.set(secretNames.linearAgentToken("linear"), "legacy-manual-token");
    const provider = new LinearAgentTokenProvider("linear", secrets);

    await expect(provider.getToken()).rejects.toThrow(/renewable Linear app credentials/);
  });
});

describe("linearViewer", () => {
  it("queries and returns the immutable app user id", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
      return new Response(
        JSON.stringify({
          data: {
            viewer: { id: "app-user", name: "Chip Byte", email: "chip@snapcorp.com" },
            organization: { id: "org" },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    await expect(linearViewer("token", fetch)).resolves.toEqual({
      id: "app-user",
      name: "Chip Byte",
    });
  });

  it("uses raw API-key authorization when requested", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("api-key");
      return Response.json({
        data: {
          viewer: { id: "chip-user", name: "Chip Byte", email: "chip@snapcorp.com" },
          organization: { id: "org" },
        },
      });
    });

    await expect(linearViewer("api-key", fetch, "api-key")).resolves.toEqual({
      id: "chip-user",
      name: "Chip Byte",
    });
  });
});
