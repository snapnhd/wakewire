import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookSourceConfigSchema } from "./source.js";
import { isFreshLinearWebhook, verifyWebhook } from "./verify.js";

const secret = "shhh";
const body = JSON.stringify({ id: "evt_1", type: "issue.created" });

function hmac(encoding: "hex" | "base64"): string {
  return crypto.createHmac("sha256", secret).update(body).digest(encoding);
}

describe("verifyWebhook — hmac-sha256", () => {
  it("accepts valid hex and base64 signatures, with and without prefixes", () => {
    expect(
      verifyWebhook(
        { kind: "hmac-sha256", header: "x-signature", prefix: "", encoding: "hex" },
        secret,
        body,
        hmac("hex"),
      ),
    ).toBe(true);
    expect(
      verifyWebhook(
        { kind: "hmac-sha256", header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex" },
        secret,
        body,
        `sha256=${hmac("hex")}`,
      ),
    ).toBe(true);
    expect(
      verifyWebhook(
        { kind: "hmac-sha256", header: "x-signature", prefix: "", encoding: "base64" },
        secret,
        body,
        hmac("base64"),
      ),
    ).toBe(true);
  });

  it("rejects wrong secret, tampered body, missing prefix, and absent header", () => {
    const config = {
      kind: "hmac-sha256",
      header: "x-signature",
      prefix: "sha256=",
      encoding: "hex",
    } as const;
    const otherMac = crypto.createHmac("sha256", "other").update(body).digest("hex");
    expect(verifyWebhook(config, secret, body, `sha256=${otherMac}`)).toBe(false);
    expect(verifyWebhook(config, secret, `${body} `, `sha256=${hmac("hex")}`)).toBe(false);
    expect(verifyWebhook(config, secret, body, hmac("hex"))).toBe(false); // prefix required
    expect(verifyWebhook(config, secret, body, undefined)).toBe(false);
    expect(verifyWebhook(config, secret, body, "")).toBe(false);
  });
});

describe("WebhookSourceConfigSchema", () => {
  it("preserves a configured Linear app user id for privileged source pinning", () => {
    expect(
      WebhookSourceConfigSchema.parse({
        name: "linear",
        mode: "listen",
        verification: { kind: "hmac-sha256", header: "linear-signature" },
        linearAppUserId: "  chip-app-user  ",
      }).linearAppUserId,
    ).toBe("chip-app-user");
  });

  it("rejects secret-header verification in smee mode (relay would leak the bearer)", () => {
    const secretHeader = { kind: "secret-header", header: "x-token" } as const;
    expect(
      WebhookSourceConfigSchema.safeParse({
        name: "p",
        mode: "smee",
        verification: secretHeader,
      }).success,
    ).toBe(false);
    // allowed behind your own listen tunnel
    expect(
      WebhookSourceConfigSchema.safeParse({
        name: "p",
        mode: "listen",
        verification: secretHeader,
      }).success,
    ).toBe(true);
    // hmac is fine over smee
    expect(
      WebhookSourceConfigSchema.safeParse({
        name: "p",
        mode: "smee",
        verification: { kind: "hmac-sha256", header: "x-sig" },
      }).success,
    ).toBe(true);
  });
});

describe("verifyWebhook — secret-header", () => {
  const config = { kind: "secret-header", header: "x-webhook-token" } as const;

  it("accepts only the exact secret", () => {
    expect(verifyWebhook(config, secret, body, "shhh")).toBe(true);
    expect(verifyWebhook(config, secret, body, "shhh ")).toBe(false);
    expect(verifyWebhook(config, secret, body, "nope")).toBe(false);
    expect(verifyWebhook(config, secret, body, undefined)).toBe(false);
  });
});

describe("isFreshLinearWebhook", () => {
  it("accepts only timestamps within Linear's one-minute replay window", () => {
    const now = 1_700_000_000_000;
    expect(isFreshLinearWebhook({ webhookTimestamp: now - 60_000 }, now)).toBe(true);
    expect(isFreshLinearWebhook({ webhookTimestamp: String(now + 1_000) }, now)).toBe(true);
    expect(isFreshLinearWebhook({ webhookTimestamp: now - 60_001 }, now)).toBe(false);
    expect(isFreshLinearWebhook({}, now)).toBe(false);
  });
});
