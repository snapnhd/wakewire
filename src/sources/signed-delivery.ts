import { createHash } from "node:crypto";

/**
 * Stable replay key derived only from bytes covered by the provider signature.
 * Relay-supplied delivery headers are intentionally excluded because a relay
 * observer can change those headers without invalidating the body signature.
 */
export function signedBodyDeliveryId(provider: "github" | "linear", rawBody: string): string {
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `${provider}-body-sha256-${digest}`;
}
