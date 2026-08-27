import { z } from "zod";

/**
 * Normalized event emitted by every source. Payloads are already trimmed by the
 * source (see sources/github/trim.ts and sources/gmail/extract.ts) — the queue
 * and sink never see raw provider payloads.
 */
export const WakeEventSchema = z.object({
  source: z.enum(["github", "gmail", "slack", "webhook"]),
  /** WakeWire source record that accepted the event. Needed for scoped credentials/replies. */
  sourceId: z.string().min(1).optional(),
  /** e.g. "push", "pull_request.opened", "email", "app_mention", "message" */
  kind: z.string().min(1),
  /** Source-native unique id: X-GitHub-Delivery, RFC 5322 Message-ID. */
  deliveryId: z.string().min(1),
  /** ISO 8601, UTC. */
  occurredAt: z.string(),
  /** One-line human summary, built by the source. */
  summary: z.string(),
  /** Trimmed, source-specific payload. Treated as untrusted data everywhere. */
  payload: z.record(z.string(), z.unknown()),
  /**
   * Provider identity after source-level authentication. Slack, GitHub, and
   * Linear authorize immutable provider IDs. Gmail is the explicit exception:
   * its subject is the aligned From address, which is only domain-authenticated
   * by DMARC and therefore carries the mail-infrastructure trust caveat.
   */
  principal: z
    .object({
      provider: z.enum(["github", "gmail", "slack", "linear", "webhook"]),
      tenantId: z.string().min(1),
      subjectId: z.string().min(1),
      handle: z.string().min(1).optional(),
      email: z.string().email().optional(),
      displayName: z.string().min(1).optional(),
    })
    .optional(),
  /** Stable provider conversation keys and the exact object to acknowledge. */
  conversation: z
    .object({
      nativeKey: z.string().min(1),
      rootKey: z.string().min(1).optional(),
      replyTarget: z.string().min(1),
    })
    .optional(),
  /** Provider-normalized evidence that this message addressed Chip. */
  targetMentions: z
    .array(
      z.object({
        kind: z.enum([
          "app-mention",
          "handle",
          "email",
          "display-name",
          "agent-session",
          "linear-user",
          "direct-message",
          "slack-user",
        ]),
        value: z.string().min(1),
      }),
    )
    .optional(),
});

export type WakeEvent = z.infer<typeof WakeEventSchema>;
