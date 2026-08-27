import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readGmailOAuthClientCredentials, receiveAuthCode } from "./auth-gmail.js";

describe("readGmailOAuthClientCredentials", () => {
  it("uses hidden input for the OAuth client secret", async () => {
    const promptVisible = vi.fn(async () => " client-id ");
    const promptSecret = vi.fn(async () => " client-secret ");

    await expect(
      readGmailOAuthClientCredentials({}, { promptVisible, promptSecret }),
    ).resolves.toEqual({ clientId: "client-id", clientSecret: "client-secret" });
    expect(promptVisible).toHaveBeenCalledWith("Google OAuth client ID: ");
    expect(promptSecret).toHaveBeenCalledWith("Google OAuth client secret: ");
  });

  it("does not prompt when both credentials are supplied as options", async () => {
    const promptVisible = vi.fn(async () => "unused");
    const promptSecret = vi.fn(async () => "unused");

    await expect(
      readGmailOAuthClientCredentials(
        { clientId: "client-id", clientSecret: "client-secret" },
        { promptVisible, promptSecret },
      ),
    ).resolves.toEqual({ clientId: "client-id", clientSecret: "client-secret" });
    expect(promptVisible).not.toHaveBeenCalled();
    expect(promptSecret).not.toHaveBeenCalled();
  });
});

describe("receiveAuthCode", () => {
  it("verifies state and returns a PKCE verifier for the token exchange", async () => {
    let authorizationUrl: URL | undefined;
    let callbackResponse: Promise<Response> | undefined;
    let randomCall = 0;

    const authorization = receiveAuthCode("client-id", "client-secret", {
      timeoutMs: 1_000,
      randomBytes: () => Buffer.alloc(32, ++randomCall),
      onAuthorizationUrl(url) {
        authorizationUrl = new URL(url);
        const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
        callbackResponse = fetch(callback);
      },
    });

    const result = await authorization;
    expect((await callbackResponse)?.status).toBe(200);
    expect(result.code).toBe("authorization-code");
    expect(result.redirectUri).toBe(authorizationUrl?.searchParams.get("redirect_uri"));
    expect(result.codeVerifier).toHaveLength(43);
    expect(authorizationUrl?.searchParams.get("state")).toBeTruthy();
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("code_challenge")).toBe(
      crypto.createHash("sha256").update(result.codeVerifier).digest("base64url"),
    );
    expect(authorizationUrl?.searchParams.has("client_secret")).toBe(false);
  });

  it("rejects a callback with the wrong state", async () => {
    let callbackResponse: Promise<Response> | undefined;
    const authorization = receiveAuthCode("client-id", "client-secret", {
      timeoutMs: 1_000,
      onAuthorizationUrl(url) {
        const authorizationUrl = new URL(url);
        const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", "wrong-state");
        callbackResponse = fetch(callback);
      },
    });

    await expect(authorization).rejects.toThrow("invalid OAuth state");
    expect((await callbackResponse)?.status).toBe(400);
  });

  it("closes the callback listener after a bounded timeout", async () => {
    const authorization = receiveAuthCode("client-id", "client-secret", {
      timeoutMs: 20,
      onAuthorizationUrl() {},
    });

    await expect(authorization).rejects.toThrow("authorization timed out after 20ms");
  });
});
