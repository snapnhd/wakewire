import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import {
  buildAckSpec,
  InvalidAckEventError,
  LINEAR_PROGRESS_EYES_EMOJI,
  UnsupportedAckEventError,
} from "./ack.js";

function baseEvent(overrides: Partial<WakeEvent>): WakeEvent {
  return {
    source: "slack",
    kind: "app_mention",
    deliveryId: "delivery-1",
    occurredAt: "2026-07-27T00:00:00.000Z",
    summary: "request",
    payload: {},
    ...overrides,
  };
}

describe("buildAckSpec", () => {
  it("builds a Slack eyes reaction for the exact message", () => {
    const spec = buildAckSpec(
      baseEvent({ payload: { channel: "C123", ts: "172.001", text: "<@UCHIP> help" } }),
      "CJ",
    );
    expect(spec).toEqual({
      provider: "slack",
      kind: "eyes-reaction",
      destination: "C123:172.001",
      payload: { channel: "C123", timestamp: "172.001", reaction: "eyes" },
    });
  });

  it("selects exact GitHub reaction targets", () => {
    const issueComment = buildAckSpec(
      baseEvent({
        source: "github",
        kind: "issue_comment.created",
        payload: { repo: "snapnhd/system", number: 42, commentId: 99 },
      }),
      "CJ",
    );
    expect(issueComment.payload).toMatchObject({
      targetType: "issue-comment",
      targetId: "99",
      content: "eyes",
    });

    const reviewComment = buildAckSpec(
      baseEvent({
        source: "github",
        kind: "pull_request_review_comment.created",
        payload: { repo: "snapnhd/system", number: 42, commentId: 100 },
      }),
      "CJ",
    );
    expect(reviewComment.payload).toMatchObject({ targetType: "review-comment", targetId: "100" });

    const pullRequest = buildAckSpec(
      baseEvent({
        source: "github",
        kind: "pull_request.edited",
        payload: { repo: "snapnhd/system", number: 42 },
      }),
      "CJ",
    );
    expect(pullRequest.payload).toMatchObject({ targetType: "issue", targetId: "42" });
  });

  it("builds a brief Gmail reply in the originating RFC thread", () => {
    const spec = buildAckSpec(
      baseEvent({
        source: "gmail",
        kind: "email",
        deliveryId: "<message@example.com>",
        conversation: {
          nativeKey: "<message@example.com>",
          rootKey: "<root@example.com>",
          replyTarget: "<message@example.com>",
        },
        payload: {
          fromEmail: "cj@snapcorp.com",
          rfcMessageId: "<message@example.com>",
          subject: "Need help",
          references: ["<root@example.com>"],
        },
      }),
      "CJ",
    );
    expect(spec).toEqual({
      provider: "gmail",
      kind: "brief-reply",
      destination: "<message@example.com>",
      payload: {
        to: "cj@snapcorp.com",
        subject: "Re: Need help",
        text: "I'm on it, CJ.",
        originalMessageId: "<message@example.com>",
        inReplyTo: "<message@example.com>",
        references: ["<root@example.com>", "<message@example.com>"],
      },
    });
  });

  it("builds a Linear activity against its normalized target", () => {
    const spec = buildAckSpec(
      baseEvent({
        source: "webhook",
        kind: "AgentSessionEvent.created",
        principal: { provider: "linear", tenantId: "org", subjectId: "user" },
        conversation: { nativeKey: "session-1", rootKey: "issue-1", replyTarget: "session-1" },
        targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
        payload: {
          provider: "linear",
          appUserId: "chip-app-user",
          agentSessionId: "session-1",
          identifier: "ENG-4610",
        },
      }),
      "CJ",
    );
    expect(spec).toEqual({
      provider: "linear",
      kind: "activity",
      destination: "session-1",
      payload: {
        target: "session-1",
        text: "👀 I'm on it, CJ.",
        contentType: "thought",
        ephemeral: true,
      },
    });
  });

  it("builds a non-ephemeral Linear stop confirmation", () => {
    const spec = buildAckSpec(
      baseEvent({
        source: "webhook",
        kind: "AgentSessionEvent.prompted",
        principal: { provider: "linear", tenantId: "org", subjectId: "user" },
        conversation: { nativeKey: "stop-1", rootKey: "issue-1", replyTarget: "session-1" },
        targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
        payload: {
          provider: "linear",
          appUserId: "chip-app-user",
          agentSessionId: "session-1",
          agentSignal: "stop",
        },
      }),
      "CJ",
    );

    expect(spec.payload).toEqual({
      target: "session-1",
      text: "Stopped, CJ.",
      contentType: "response",
      ephemeral: false,
    });
  });

  it("reacts with 👀 on the Linear comment that mentioned Chip", () => {
    const spec = buildAckSpec(
      baseEvent({
        source: "webhook",
        kind: "LinearUserEvent.mention",
        principal: { provider: "linear", tenantId: "org", subjectId: "cj-user" },
        conversation: {
          nativeKey: "org:issue-1:comment:comment-1",
          rootKey: "org:issue-1",
          replyTarget: "issue-1",
        },
        targetMentions: [{ kind: "linear-user", value: "chip-user" }],
        payload: {
          provider: "linear",
          organizationId: "org",
          issueId: "issue-1",
          commentId: "comment-1",
          chipUserId: "chip-user",
          body: "@chip please fix this",
        },
      }),
      "CJ",
    );

    expect(spec).toEqual({
      provider: "linear",
      kind: "eyes-reaction",
      destination: "comment:comment-1",
      payload: {
        commentId: "comment-1",
        emoji: LINEAR_PROGRESS_EYES_EMOJI,
      },
    });
  });

  it("reacts with 👀 on a nested Linear mention comment", () => {
    const spec = buildAckSpec(
      baseEvent({
        source: "webhook",
        kind: "LinearUserEvent.mention",
        principal: { provider: "linear", tenantId: "org", subjectId: "cj-user" },
        conversation: {
          nativeKey: "org:issue-1:comment:nested",
          rootKey: "org:issue-1",
          replyTarget: "issue-1",
        },
        targetMentions: [{ kind: "linear-user", value: "chip-user" }],
        payload: {
          provider: "linear",
          organizationId: "org",
          issueId: "issue-1",
          commentId: "edad4e55-b73e-4772-a706-34780ed323b3",
          parentCommentId: "7d6bfba8-4a3c-40e6-a3aa-598653726994",
          chipUserId: "chip-user",
          body: "@chip put the plan in the description",
        },
      }),
      "CJ",
    );

    expect(spec).toEqual({
      provider: "linear",
      kind: "eyes-reaction",
      destination: "comment:edad4e55-b73e-4772-a706-34780ed323b3",
      payload: {
        commentId: "edad4e55-b73e-4772-a706-34780ed323b3",
        emoji: LINEAR_PROGRESS_EYES_EMOJI,
      },
    });
  });

  it("reacts with 👀 on the Linear issue when assignment has no comment", () => {
    const spec = buildAckSpec(
      baseEvent({
        source: "webhook",
        kind: "LinearUserEvent.assignment",
        principal: { provider: "linear", tenantId: "org", subjectId: "cj-user" },
        conversation: {
          nativeKey: "org:issue-1",
          rootKey: "org:issue-1",
          replyTarget: "issue-1",
        },
        targetMentions: [{ kind: "linear-user", value: "chip-user" }],
        payload: {
          provider: "linear",
          organizationId: "org",
          issueId: "issue-1",
          chipUserId: "chip-user",
          body: "Work on the Linear issue assigned to Chip.",
        },
      }),
      "CJ",
    );

    expect(spec).toEqual({
      provider: "linear",
      kind: "eyes-reaction",
      destination: "issue:issue-1",
      payload: {
        issueId: "issue-1",
        emoji: LINEAR_PROGRESS_EYES_EMOJI,
      },
    });
  });

  it("does not turn a generic mapped Linear mention into an AgentSession activity", () => {
    expect(() =>
      buildAckSpec(
        baseEvent({
          source: "webhook",
          kind: "Comment.create",
          principal: { provider: "linear", tenantId: "org", subjectId: "user" },
          conversation: { nativeKey: "comment-1", rootKey: "issue-1", replyTarget: "issue-1" },
          targetMentions: [{ kind: "display-name", value: "Chip Byte" }],
          payload: { provider: "linear", body: "@Chip Byte do it", agentSessionId: "issue-1" },
        }),
        "CJ",
      ),
    ).toThrow(UnsupportedAckEventError);
  });

  it("fails closed for incomplete and unsupported events", () => {
    expect(() => buildAckSpec(baseEvent({ payload: {} }), "CJ")).toThrow(InvalidAckEventError);
    expect(() =>
      buildAckSpec(baseEvent({ source: "webhook", payload: { provider: "sentry" } }), "CJ"),
    ).toThrow(UnsupportedAckEventError);
  });
});
