import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../../core/event.js";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import { WebhookIngestSource, WebhookSourceConfigSchema } from "./source.js";

const created = {
  type: "AgentSessionEvent",
  action: "created",
  webhookId: "linear-webhook-1",
  webhookTimestamp: Date.now(),
  organizationId: "org-1",
  appUserId: "chip-app-user",
  promptContext:
    '<primary-directive-thread comment-id="comment-1"><comment><user id="chip-app-user">Chip Byte</user> do it</comment></primary-directive-thread>',
  agentSession: {
    id: "session-1",
    appUserId: "chip-app-user",
    organizationId: "org-1",
    creatorId: "cj-linear",
    creator: { id: "cj-linear", name: "CJ Lazell" },
    commentId: "comment-1",
    comment: { id: "comment-1", userId: "cj-linear", body: "@Chip Byte do it" },
    issueId: "issue-1",
    issue: { id: "issue-1", identifier: "ENG-1" },
  },
};

describe("WebhookIngestSource privileged Linear replay identity", () => {
  it("uses signed webhookId and ignores a mutable relay delivery header", async () => {
    const { source, events, secret } = linearSource();
    const rawBody = JSON.stringify(created);
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

    await source.handleWebhook({
      getHeader: (name) =>
        name === "linear-signature"
          ? signature
          : name === "linear-delivery"
            ? "relay-header-one"
            : undefined,
      rawBody,
    });
    await source.handleWebhook({
      getHeader: (name) =>
        name === "linear-signature"
          ? signature
          : name === "linear-delivery"
            ? "relay-header-two"
            : undefined,
      rawBody,
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.deliveryId).toBe("linear-webhook-1");
    expect(events[1]?.deliveryId).toBe(events[0]?.deliveryId);
  });

  it("rejects a native event with conflicting immutable ids before emitting it", async () => {
    const { source, events, secret } = linearSource();
    const rawBody = JSON.stringify({
      ...created,
      agentSession: { ...created.agentSession, organizationId: "other-org" },
    });
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

    const response = await source.handleWebhook({
      getHeader: (name) => (name === "linear-signature" ? signature : undefined),
      rawBody,
    });

    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });

  it("emits a privileged pinned-user event only after Linear HMAC verification", async () => {
    const { source, events, secret } = linearSource();
    const rawBody = JSON.stringify({
      type: "Comment",
      action: "create",
      webhookTimestamp: Date.now(),
      organizationId: "org-1",
      createdAt: new Date().toISOString(),
      actor: { id: "cj-linear", name: "CJ Lazell", email: "cj@snapcorp.com" },
      data: {
        id: "comment-1",
        issueId: "issue-1",
        userId: "cj-linear",
        body: "@chip please handle this",
      },
      url: "https://linear.app/snap/issue/ENG-1/test#comment-comment-1",
    });
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

    const response = await source.handleWebhook({
      getHeader: (name) => (name === "linear-signature" ? signature : undefined),
      rawBody,
    });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "LinearUserEvent.mention",
      principal: { tenantId: "org-1", subjectId: "cj-linear" },
      payload: {
        chipUserId: "chip-user",
        issueId: "issue-1",
        identifier: "ENG-1",
      },
      targetMentions: [{ kind: "linear-user", value: "chip-user" }],
    });
    expect(events[0]?.deliveryId).not.toBe("linear-webhook-1");
  });
});

function linearSource(): {
  source: WebhookIngestSource;
  events: WakeEvent[];
  secret: string;
} {
  const sourceId = "webhook-linear";
  const secret = "test-linear-secret";
  const values = new Map([[secretNames.webhookSecret(sourceId), secret]]);
  const secrets: SecretStore = {
    backend: "file",
    get: (name) => values.get(name) ?? null,
    set: (name, value) => values.set(name, value),
    delete: (name) => {
      values.delete(name);
    },
  };
  const events: WakeEvent[] = [];
  const source = new WebhookIngestSource(
    sourceId,
    WebhookSourceConfigSchema.parse({
      name: "linear",
      mode: "listen",
      verification: {
        kind: "hmac-sha256",
        header: "linear-signature",
        prefix: "",
        encoding: "hex",
      },
      linearAppUserId: "chip-app-user",
      linearUserId: "chip-user",
      linearOrganizationId: "org-1",
      captureRemaining: 0,
    }),
    secrets,
    { emit: (event) => events.push(event), logger: pino({ level: "silent" }) },
    { capture: () => {}, persistConfig: () => {} },
  );
  return { source, events, secret };
}
