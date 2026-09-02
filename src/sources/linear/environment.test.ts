import { describe, expect, it, vi } from "vitest";
import { linearApiKeyFromEnvironment, resolveLinearEnvironmentIdentity } from "./environment.js";

describe("Linear environment credential", () => {
  it("normalizes a dedicated key without accepting an empty value", () => {
    expect(linearApiKeyFromEnvironment({ LINEAR_API_KEY: "  chip-key  " })).toBe("chip-key");
    expect(linearApiKeyFromEnvironment({ LINEAR_API_KEY: "   " })).toBeNull();
    expect(linearApiKeyFromEnvironment({})).toBeNull();
  });

  it("validates and returns the immutable viewer and organization", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init) throw new Error("expected Linear request init");
      expect((init.headers as Record<string, string>).authorization).toBe("chip-key");
      return Response.json({
        data: {
          viewer: { id: "chip-user", name: "Chip Byte", email: "chip@snapcorp.com" },
          organization: { id: "snap-org" },
        },
      });
    });

    await expect(
      resolveLinearEnvironmentIdentity({ LINEAR_API_KEY: "chip-key" }, fetch),
    ).resolves.toEqual({
      apiKey: "chip-key",
      id: "chip-user",
      name: "Chip Byte",
      email: "chip@snapcorp.com",
      organizationId: "snap-org",
    });
  });

  it("rejects a controller or human key that is not Chip Byte's", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: {
          viewer: { id: "cj-user", name: "CJ Lazell", email: "cj@snapcorp.com" },
          organization: { id: "snap-org" },
        },
      }),
    );

    await expect(
      resolveLinearEnvironmentIdentity({ LINEAR_API_KEY: "controller-key" }, fetch),
    ).rejects.toThrow(/expected Chip Byte <chip@snapcorp.com>/);
  });
});
