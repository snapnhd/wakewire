import { describe, expect, it, vi } from "vitest";
import type { AckJob } from "../store.js";
import { GithubAckResponder, type GithubFetch } from "./github.js";
import { GmailAckResponder } from "./gmail.js";
import { LinearAckResponder } from "./linear.js";
import { SlackAckResponder } from "./slack.js";
import { PermanentAckError } from "./types.js";

function job(overrides: Partial<AckJob>): AckJob {
  return {
    id: "ack-1",
    requestId: "request-1",
    sourceId: "source-1",
    provider: "slack",
    providerDeliveryId: "delivery-1",
    ackKind: "eyes-reaction",
    destination: "destination",
    payload: {},
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: null,
    providerResultId: null,
    error: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("SlackAckResponder", () => {
  it("calls reactions.add and treats already_reacted as success", async () => {
    const add = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: "already_reacted" } })
      .mockResolvedValueOnce({ ok: false, error: "already_reacted" });
    const responder = new SlackAckResponder({ reactions: { add } });
    const ack = job({
      payload: { channel: "C1", timestamp: "1.0", reaction: "eyes" },
    });

    await expect(responder.send(ack)).resolves.toMatchObject({
      providerResultId: "slack:C1:1.0:eyes",
    });
    await expect(responder.send(ack)).resolves.toBeDefined();
    expect(add).toHaveBeenCalledWith({ channel: "C1", timestamp: "1.0", name: "eyes" });
  });

  it("classifies missing reaction scope as a permanent configuration error", async () => {
    const responder = new SlackAckResponder({
      reactions: { add: vi.fn(async () => ({ ok: false, error: "missing_scope" })) },
    });

    await expect(
      responder.send(job({ payload: { channel: "C1", timestamp: "1.0", reaction: "eyes" } })),
    ).rejects.toBeInstanceOf(PermanentAckError);
  });
});

describe("GithubAckResponder", () => {
  it.each([
    ["issue", "42", "/repos/snapnhd/system/issues/42/reactions"],
    ["issue-comment", "99", "/repos/snapnhd/system/issues/comments/99/reactions"],
    ["review-comment", "100", "/repos/snapnhd/system/pulls/comments/100/reactions"],
  ])("posts an eyes reaction to the exact %s endpoint", async (targetType, targetId, endpoint) => {
    const fetch = vi.fn(async () => ({ status: 201, json: async () => ({ id: 123 }) }));
    const responder = new GithubAckResponder(fetch as GithubFetch);
    const result = await responder.send(
      job({
        provider: "github",
        payload: { repo: "snapnhd/system", targetType, targetId, content: "eyes" },
      }),
    );

    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com${endpoint}`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "eyes" }) }),
    );
    expect(result.providerResultId).toBe("123");
  });

  it("treats GitHub's 200 existing-reaction response as success", async () => {
    const fetch = vi.fn(async () => ({ status: 200 }));
    const responder = new GithubAckResponder(fetch as GithubFetch);
    await expect(
      responder.send(
        job({
          provider: "github",
          payload: {
            repo: "snapnhd/system",
            targetType: "issue-comment",
            targetId: "99",
            content: "eyes",
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("classifies GitHub authorization failures as permanent", async () => {
    const responder = new GithubAckResponder(vi.fn(async () => ({ status: 403 })) as GithubFetch);

    await expect(
      responder.send(
        job({
          provider: "github",
          payload: {
            repo: "snapnhd/system",
            targetType: "issue",
            targetId: "42",
            content: "eyes",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PermanentAckError);
  });
});

describe("transport-backed responders", () => {
  it("hands Gmail an explicit same-thread reply without implementing OAuth lookup", async () => {
    const replySameThread = vi.fn(async () => ({ messageId: "sent-1" }));
    const responder = new GmailAckResponder({ replySameThread });
    const result = await responder.send(
      job({
        provider: "gmail",
        ackKind: "brief-reply",
        sourceId: "gmail-chip",
        payload: {
          originalMessageId: "<message@example.com>",
          to: "cj@snapcorp.com",
          subject: "Re: Help",
          text: "I'm on it, CJ.",
          inReplyTo: "<message@example.com>",
          references: ["<root@example.com>", "<message@example.com>"],
        },
      }),
    );

    expect(replySameThread).toHaveBeenCalledWith({
      sourceId: "gmail-chip",
      originalMessageId: "<message@example.com>",
      to: "cj@snapcorp.com",
      subject: "Re: Help",
      text: "I'm on it, CJ.",
      inReplyTo: "<message@example.com>",
      references: ["<root@example.com>", "<message@example.com>"],
    });
    expect(result.providerResultId).toBe("sent-1");
  });

  it("hands Linear an already-normalized activity target", async () => {
    const createActivity = vi.fn(async () => ({ activityId: "activity-1" }));
    const responder = new LinearAckResponder({
      createActivity,
      createComment: vi.fn(),
      createReaction: vi.fn(),
    });
    const result = await responder.send(
      job({
        provider: "linear",
        ackKind: "activity",
        sourceId: "linear-snap",
        payload: { target: "issue-1", text: "👀 I'm on it, CJ." },
      }),
    );

    expect(createActivity).toHaveBeenCalledWith({
      sourceId: "linear-snap",
      target: "issue-1",
      text: "👀 I'm on it, CJ.",
      idempotencyKey: "ack-1",
      contentType: "thought",
      ephemeral: true,
    });
    expect(result.providerResultId).toBe("activity-1");
  });

  it("hands an API-key-backed Linear user an issue comment target", async () => {
    const createComment = vi.fn(async () => ({ commentId: "comment-1" }));
    const responder = new LinearAckResponder({
      createActivity: vi.fn(),
      createComment,
      createReaction: vi.fn(),
    });
    const result = await responder.send(
      job({
        provider: "linear",
        ackKind: "comment",
        sourceId: "linear-snap",
        payload: { target: "issue-1", text: "👀 I'm on it, CJ." },
      }),
    );

    expect(createComment).toHaveBeenCalledWith({
      sourceId: "linear-snap",
      issueId: "issue-1",
      text: "👀 I'm on it, CJ.",
      idempotencyKey: "ack-1",
    });
    expect(result.providerResultId).toBe("comment-1");
  });

  it("threads an API-key-backed Linear progress comment under the human comment", async () => {
    const createComment = vi.fn(async () => ({ commentId: "ack-comment-1" }));
    const responder = new LinearAckResponder({
      createActivity: vi.fn(),
      createComment,
      createReaction: vi.fn(),
    });
    const result = await responder.send(
      job({
        provider: "linear",
        ackKind: "comment",
        sourceId: "linear-snap",
        payload: {
          target: "issue-1",
          parentId: "comment-1",
          text: "👀 I'm on it, CJ.",
        },
      }),
    );

    expect(createComment).toHaveBeenCalledWith({
      sourceId: "linear-snap",
      issueId: "issue-1",
      parentId: "comment-1",
      text: "👀 I'm on it, CJ.",
      idempotencyKey: "ack-1",
    });
    expect(result.providerResultId).toBe("ack-comment-1");
  });

  it("reacts on the Linear comment that mentioned Chip", async () => {
    const createReaction = vi.fn(async () => ({ reactionId: "reaction-1" }));
    const responder = new LinearAckResponder({
      createActivity: vi.fn(),
      createComment: vi.fn(),
      createReaction,
    });
    const result = await responder.send(
      job({
        provider: "linear",
        ackKind: "eyes-reaction",
        sourceId: "linear-snap",
        payload: { commentId: "comment-1", emoji: "👀" },
      }),
    );

    expect(createReaction).toHaveBeenCalledWith({
      sourceId: "linear-snap",
      commentId: "comment-1",
      emoji: "👀",
    });
    expect(result.providerResultId).toBe("reaction-1");
  });
});
