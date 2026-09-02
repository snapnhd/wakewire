import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { exactPingPongReply, isChipAddressed, isChipPrincipal, requestText } from "./targeting.js";

function event(overrides: Partial<WakeEvent>): WakeEvent {
  return {
    source: "github",
    kind: "issue_comment.created",
    deliveryId: "d-1",
    occurredAt: "2026-07-27T00:00:00.000Z",
    summary: "event",
    payload: {},
    ...overrides,
  };
}

describe("Chip targeting", () => {
  it("accepts only pinned normal-user Slack mentions and one-to-one PMs", () => {
    expect(isChipAddressed(event({ source: "slack", kind: "app_mention" }))).toBe(false);
    expect(isChipAddressed(event({ source: "slack", kind: "message" }))).toBe(false);

    const directMessage = event({
      source: "slack",
      kind: "message",
      payload: {
        team: "T1",
        channel: "D1",
        channelType: "im",
        user: "U-CJ",
        recipientUser: "UCHIP",
        ts: "1.0",
      },
      principal: { provider: "slack", tenantId: "T1", subjectId: "U-CJ" },
      conversation: {
        nativeKey: "T1:D1:1.0",
        rootKey: "T1:D1:1.0",
        replyTarget: "D1:1.0",
      },
      targetMentions: [{ kind: "direct-message", value: "UCHIP" }],
    });
    expect(isChipAddressed(directMessage)).toBe(true);
    expect(
      isChipAddressed({
        ...directMessage,
        principal: { provider: "slack", tenantId: "T1", subjectId: "U-OTHER" },
      }),
    ).toBe(false);
    expect(isChipAddressed({ ...directMessage, targetMentions: undefined })).toBe(false);
    expect(
      isChipAddressed({
        ...directMessage,
        payload: { ...directMessage.payload, channelType: "channel" },
      }),
    ).toBe(false);

    const mention = {
      ...directMessage,
      payload: {
        ...directMessage.payload,
        channel: "C1",
        channelType: "channel",
        text: "please help <@UCHIP>",
      },
      conversation: {
        nativeKey: "T1:C1:1.0",
        rootKey: "T1:C1:1.0",
        replyTarget: "C1:1.0",
      },
      targetMentions: [{ kind: "slack-user" as const, value: "UCHIP" }],
    };
    expect(isChipAddressed(mention)).toBe(true);
    expect(
      isChipAddressed({
        ...mention,
        payload: { ...mention.payload, channelType: "mpim" },
      }),
    ).toBe(true);
    expect(
      isChipAddressed({
        ...mention,
        payload: { ...mention.payload, text: "plain @chip was not resolved by Slack" },
      }),
    ).toBe(false);
  });

  it("matches exact GitHub handles and requires both Gmail routing and an explicit @chip", () => {
    expect(
      isChipAddressed(event({ targetMentions: [{ kind: "handle", value: "chipbyte-snap" }] })),
    ).toBe(true);
    expect(isChipAddressed(event({ targetMentions: [{ kind: "handle", value: "chip" }] }))).toBe(
      true,
    );
    expect(
      isChipAddressed(
        event({
          source: "gmail",
          kind: "email",
          targetMentions: [
            { kind: "email", value: "chip@snapcorp.com" },
            { kind: "handle", value: "chip" },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isChipAddressed(
        event({
          source: "gmail",
          kind: "email",
          targetMentions: [{ kind: "email", value: "chip@snapcorp.com" }],
        }),
      ),
    ).toBe(false);
    expect(
      isChipAddressed(
        event({
          source: "gmail",
          kind: "email",
          targetMentions: [{ kind: "handle", value: "chip" }],
        }),
      ),
    ).toBe(false);
    expect(
      isChipAddressed(event({ targetMentions: [{ kind: "handle", value: "chipbyte-snapper" }] })),
    ).toBe(false);
    expect(
      isChipAddressed(event({ targetMentions: [{ kind: "handle", value: "chipmunk" }] })),
    ).toBe(false);
    expect(
      isChipAddressed(
        event({
          kind: "pull_request.review_requested",
          targetMentions: [{ kind: "handle", value: "chip" }],
        }),
      ),
    ).toBe(false);
    expect(
      isChipAddressed(
        event({
          kind: "pull_request.review_requested",
          targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
        }),
      ),
    ).toBe(true);
  });

  it("addresses requested third-party PR synchronize events", () => {
    const synchronize = event({
      kind: "pull_request.synchronize",
      payload: {
        repo: "snapnhd/system",
        number: 1165,
        isPullRequest: true,
        author: "zadams",
        requestedReviewerLogins: ["chipbyte-snap"],
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17470",
        handle: "zadams",
      },
    });

    expect(isChipAddressed(synchronize)).toBe(true);
    expect(
      isChipAddressed({
        ...synchronize,
        payload: { ...synchronize.payload, requestedReviewerLogins: ["someone-else"] },
      }),
    ).toBe(false);
    expect(
      isChipAddressed({
        ...synchronize,
        payload: { ...synchronize.payload, author: "chipbyte-snap" },
      }),
    ).toBe(false);

    const chipSender = {
      ...synchronize,
      principal: {
        provider: "github" as const,
        tenantId: "github.com",
        subjectId: "1",
        handle: "chipbyte-snap",
      },
    };
    expect(isChipPrincipal(chipSender)).toBe(true);
    expect(isChipAddressed(chipSender)).toBe(true);
  });

  it("auto-targets new engineer feedback only on Chip-authored pull requests", () => {
    const maintained = (kind: string, payload: Record<string, unknown> = {}) =>
      event({
        kind,
        payload: {
          repo: "snapnhd/system",
          repositoryId: 101,
          number: 1117,
          isPullRequest: true,
          pullRequestAuthorLogin: "chipbyte-snap",
          senderAuthoredFeedback: true,
          senderType: "User",
          body: "review feedback without a mention",
          ...payload,
        },
      });

    expect(isChipAddressed(maintained("issue_comment.created"))).toBe(true);
    expect(isChipAddressed(maintained("pull_request_review_comment.created"))).toBe(true);
    expect(isChipAddressed(maintained("pull_request_review.submitted"))).toBe(true);
    expect(requestText(maintained("pull_request_review_comment.created"))).toContain(
      "fetch every unresolved review thread and top-level comment",
    );

    expect(
      isChipAddressed(
        maintained("pull_request_review_comment.created", {
          pullRequestAuthorLogin: "another-engineer",
        }),
      ),
    ).toBe(false);
    expect(
      isChipAddressed(maintained("pull_request_review_comment.created", { repositoryId: null })),
    ).toBe(false);
    expect(isChipAddressed(maintained("pull_request_review_comment.edited"))).toBe(false);
    expect(
      isChipAddressed(maintained("pull_request_review_comment.created", { senderType: "Bot" })),
    ).toBe(false);
    expect(
      isChipAddressed(
        maintained("pull_request_review.submitted", {
          senderAuthoredFeedback: false,
          body: "",
        }),
      ),
    ).toBe(false);
  });

  it("keeps generic mapped Linear mentions out of the privileged coordinator", () => {
    expect(
      isChipAddressed(
        event({
          source: "webhook",
          payload: { provider: "linear", body: "@Chip Byte please fix" },
        }),
      ),
    ).toBe(false);
    expect(
      isChipAddressed(
        event({ source: "webhook", payload: { provider: "linear", body: "@Chip Bytecode" } }),
      ),
    ).toBe(false);
  });

  it("accepts only a source-pinned native Linear AgentSession target", () => {
    const native = event({
      source: "webhook",
      kind: "AgentSessionEvent.created",
      payload: {
        provider: "linear",
        appUserId: "chip-app-user",
        agentSessionId: "session-1",
      },
      conversation: {
        nativeKey: "session-1",
        rootKey: "org:issue",
        replyTarget: "session-1",
      },
      targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
    });
    expect(isChipAddressed(native)).toBe(true);
    expect(
      isChipAddressed({
        ...native,
        targetMentions: [{ kind: "agent-session", value: "different-app-user" }],
      }),
    ).toBe(false);
    expect(
      isChipAddressed({
        ...native,
        kind: "Comment.create",
        payload: { ...native.payload, body: "@Chip Byte forged mapped shape" },
      }),
    ).toBe(false);
  });

  it("accepts a source-pinned dedicated Linear user target", () => {
    const native = event({
      source: "webhook",
      kind: "LinearUserEvent.assignment",
      payload: {
        provider: "linear",
        organizationId: "org",
        issueId: "issue",
        chipUserId: "chip-user",
      },
      conversation: {
        nativeKey: "org:issue",
        rootKey: "org:issue",
        replyTarget: "issue",
      },
      targetMentions: [{ kind: "linear-user", value: "chip-user" }],
    });
    expect(isChipAddressed(native)).toBe(true);
    expect(
      isChipAddressed({
        ...native,
        targetMentions: [{ kind: "linear-user", value: "different-user" }],
      }),
    ).toBe(false);
    expect(
      isChipPrincipal({
        ...native,
        principal: { provider: "linear", tenantId: "org", subjectId: "chip-user" },
      }),
    ).toBe(true);
  });

  it("suppresses Chip's own GitHub and email output", () => {
    expect(
      isChipPrincipal(
        event({
          principal: {
            provider: "github",
            tenantId: "github.com",
            subjectId: "1",
            handle: "chipbyte-snap",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isChipPrincipal(
        event({
          source: "gmail",
          principal: {
            provider: "gmail",
            tenantId: "chip@snapcorp.com",
            subjectId: "chip@snapcorp.com",
            email: "chip@snapcorp.com",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isChipPrincipal(
        event({
          source: "slack",
          payload: { team: "T1", recipientUser: "U-CHIP" },
          principal: { provider: "slack", tenantId: "T1", subjectId: "U-CHIP" },
        }),
      ),
    ).toBe(true);
  });

  it("extracts the sender-authored request field", () => {
    expect(requestText(event({ payload: { body: "do this", text: "not this" } }))).toBe("do this");
    expect(
      requestText(
        event({
          source: "gmail",
          payload: { body: "new request\n> old request", authoredBody: "new request" },
        }),
      ),
    ).toBe("new request");
  });

  it("maps bare and Chip-addressed ping to pong only", () => {
    expect(exactPingPongReply("ping")).toBe("pong");
    expect(exactPingPongReply("@chipbyte-snap ping")).toBe("pong");
    expect(exactPingPongReply("@chip ping")).toBe("pong");
    expect(exactPingPongReply("  @chipbyte-snap   ping  ")).toBe("pong");
    expect(exactPingPongReply("ping please")).toBeNull();
    expect(exactPingPongReply("Ping")).toBeNull();
    expect(exactPingPongReply('"ping"')).toBeNull();
  });
});
