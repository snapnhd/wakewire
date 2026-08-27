import { describe, expect, it } from "vitest";
import { normalizeLinearAgentEvent } from "./normalize.js";

describe("normalizeLinearAgentEvent", () => {
  it("adds immutable actor and issue identities from mapped fields", () => {
    const event = normalizeLinearAgentEvent({
      source: "webhook",
      sourceId: "webhook-linear",
      kind: "Comment",
      deliveryId: "linear-delivery-1",
      occurredAt: "2026-07-27T00:00:00.000Z",
      summary: "comment",
      payload: {
        provider: "linear",
        organizationId: "org-1",
        actorId: "user-1",
        actorEmail: "CJ@SNAPCORP.COM",
        actorName: "CJ Lazell",
        issueId: "issue-1",
        identifier: "eng-4610",
        commentId: "comment-1",
        body: "@Chip Byte please take this",
        agentSessionId: "session-1",
      },
    });
    expect(event).toMatchObject({
      principal: {
        provider: "linear",
        tenantId: "org-1",
        subjectId: "user-1",
        email: "cj@snapcorp.com",
      },
      conversation: {
        nativeKey: "org-1:issue-1:comment:comment-1",
        rootKey: "org-1:issue-1",
        replyTarget: "session-1",
      },
      payload: { identifier: "ENG-4610" },
    });
    expect(event.targetMentions).toBeUndefined();
  });

  it("does not invent an authenticated principal when mapped ids are missing", () => {
    const event = normalizeLinearAgentEvent({
      source: "webhook",
      kind: "Comment",
      deliveryId: "d",
      occurredAt: "t",
      summary: "s",
      payload: { provider: "linear", body: "@Chip Byte hi" },
    });
    expect(event.principal).toBeUndefined();
    expect(event.targetMentions).toBeUndefined();
  });
});
