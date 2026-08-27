import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { type SecretStore, secretNames } from "../secrets/store.js";
import { configureLinearAgentCredentials } from "./auth-agent-api.js";

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

describe("configureLinearAgentCredentials", () => {
  it("validates mint and viewer before replacing working credentials", async () => {
    const db = openDatabase(":memory:");
    const sources = createStores(db).sources;
    sources.upsert({
      id: "linear",
      kind: "webhook",
      config: { name: "linear", linearAppUserId: "old-viewer" },
    });
    const secrets = seededSecrets();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth/token")) {
        return Response.json({ access_token: "candidate-token", expires_in: 2_592_000 });
      }
      return Response.json({ errors: [{ message: "wrong app identity" }] }, { status: 401 });
    });

    await expect(
      configureLinearAgentCredentials({
        sourceId: "linear",
        clientId: "candidate-id",
        clientSecret: "candidate-secret",
        secrets,
        sources,
        fetch,
      }),
    ).rejects.toThrow(/wrong app identity/);

    expect(currentCredentials(secrets)).toEqual([
      "working-id",
      "working-secret",
      "working-token",
      "9999999999999",
    ]);
    expect(sources.get("linear")?.config.linearAppUserId).toBe("old-viewer");
  });

  it("commits the complete renewable set and immutable viewer pin together", async () => {
    const db = openDatabase(":memory:");
    const sources = createStores(db).sources;
    sources.upsert({
      id: "linear",
      kind: "webhook",
      config: { name: "linear", linearAppUserId: "old-viewer" },
    });
    const secrets = seededSecrets();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth/token")) {
        return Response.json({ access_token: "new-token", expires_in: 1_000 });
      }
      return Response.json({
        data: {
          viewer: { id: "chip-app-user", name: "Chip Byte", email: "chip@snapcorp.com" },
          organization: { id: "org" },
        },
      });
    });

    await expect(
      configureLinearAgentCredentials({
        sourceId: "linear",
        clientId: "new-id",
        clientSecret: "new-secret",
        secrets,
        sources,
        fetch,
        now: () => 10,
      }),
    ).resolves.toEqual({ id: "chip-app-user", name: "Chip Byte" });

    expect(currentCredentials(secrets)).toEqual(["new-id", "new-secret", "new-token", "1000010"]);
    expect(sources.get("linear")?.config.linearAppUserId).toBe("chip-app-user");
  });
});

function seededSecrets(): MemorySecrets {
  const secrets = new MemorySecrets();
  const values = ["working-id", "working-secret", "working-token", "9999999999999"];
  for (const [index, name] of credentialNames().entries()) {
    secrets.set(name, values[index] ?? "");
  }
  return secrets;
}

function credentialNames(): string[] {
  return [
    secretNames.linearAgentClientId("linear"),
    secretNames.linearAgentClientSecret("linear"),
    secretNames.linearAgentToken("linear"),
    secretNames.linearAgentTokenExpiresAt("linear"),
  ];
}

function currentCredentials(secrets: SecretStore): Array<string | null> {
  return credentialNames().map((name) => secrets.get(name));
}
