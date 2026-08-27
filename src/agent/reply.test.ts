import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import {
  buildClaudeProxyReplySpec,
  buildFinalReplySpec,
  InvalidSourceReplyEventError,
  MAX_SLACK_FINAL_REPLY_CHARACTERS,
  normalizeSlackClaudeProxyReplyText,
  normalizeSlackFinalReplyText,
  UnsupportedSourceReplyEventError,
} from "./reply.js";

function slackEvent(args: { ts?: string; threadTs?: string }): WakeEvent {
  const ts = args.ts ?? "1785250274.616359";
  const rootTs = args.threadTs ?? ts;
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId: "Ev1",
    occurredAt: "2026-07-28T14:51:14.000Z",
    summary: "Slack PM from CJ",
    payload: {
      team: "T2FCQUJ5P",
      channel: "D0B7NH419CY",
      ts,
      ...(args.threadTs ? { threadTs: args.threadTs } : {}),
    },
    conversation: {
      nativeKey: `T2FCQUJ5P:D0B7NH419CY:${ts}`,
      rootKey: `T2FCQUJ5P:D0B7NH419CY:${rootTs}`,
      replyTarget: `D0B7NH419CY:${ts}`,
    },
  };
}

function gmailEvent(): WakeEvent {
  return {
    source: "gmail",
    sourceId: "gmail-chip",
    kind: "email",
    deliveryId: "<message@example.com>",
    occurredAt: "2026-07-28T14:51:14.000Z",
    summary: "Email from CJ: Help",
    payload: {
      fromEmail: "cj@snapcorp.com",
      subject: "Help",
      rfcMessageId: "<message@example.com>",
      references: ["<root@example.com>"],
    },
    conversation: {
      nativeKey: "<message@example.com>",
      rootKey: "<root@example.com>",
      replyTarget: "<message@example.com>",
    },
  };
}

function claudeSlackEvent(args: {
  channelType: "im" | "channel" | "group" | "mpim";
  threadTs?: string;
}): WakeEvent {
  const team = "T2FCQUJ5P";
  const channel = args.channelType === "im" ? "D0B7NH419CY" : "G0B7NH419CY";
  const ts = "1785250274.616359";
  const rootTs = args.threadTs ?? ts;
  const recipientUser = "UCHIP";
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId: "EvClaude1",
    occurredAt: "2026-07-28T14:51:14.000Z",
    summary: "Slack message from CJ",
    payload: {
      team,
      channel,
      channelType: args.channelType,
      user: "UCJ",
      userName: "CJ",
      recipientUser,
      ts,
      text: args.channelType === "im" ? "follow up" : "<@UCHIP> run on Claude",
      ...(args.threadTs ? { threadTs: args.threadTs } : {}),
    },
    principal: {
      provider: "slack",
      tenantId: team,
      subjectId: "UCJ",
      displayName: "CJ",
    },
    conversation: {
      nativeKey: `${team}:${channel}:${ts}`,
      rootKey: `${team}:${channel}:${rootTs}`,
      replyTarget: `${channel}:${ts}`,
    },
    targetMentions:
      args.channelType === "im"
        ? [{ kind: "direct-message", value: recipientUser }]
        : [{ kind: "slack-user", value: recipientUser }],
  };
}

describe("buildFinalReplySpec", () => {
  it("targets the existing Slack root instead of nesting under the latest reply", () => {
    expect(
      buildFinalReplySpec(
        slackEvent({ threadTs: "1785250218.127339" }),
        "Done, with <@U123> kept as inert provider data.",
      ),
    ).toEqual({
      provider: "slack",
      kind: "thread-reply",
      destination: "T2FCQUJ5P:D0B7NH419CY:1785250218.127339",
      payload: {
        channel: "D0B7NH419CY",
        threadTs: "1785250218.127339",
        text: "Done, with <@U123> kept as inert provider data.",
      },
    });
  });

  it("uses the originating message as the root for a new thread", () => {
    const spec = buildFinalReplySpec(slackEvent({}), "Done");
    expect(spec.payload.threadTs).toBe("1785250274.616359");
  });

  it("fails closed when provider fields disagree with normalized conversation metadata", () => {
    const event = slackEvent({ threadTs: "1785250218.127339" });
    if (!event.conversation) throw new Error("fixture conversation missing");
    event.conversation.rootKey = "T2FCQUJ5P:D0B7NH419CY:different";
    expect(() => buildFinalReplySpec(event, "Done")).toThrow(InvalidSourceReplyEventError);
  });

  it("deterministically keeps Slack text below the provider limit", () => {
    const spec = buildFinalReplySpec(
      slackEvent({}),
      "x".repeat(MAX_SLACK_FINAL_REPLY_CHARACTERS + 1_000),
    );
    expect([...(spec.payload.text as string)]).toHaveLength(MAX_SLACK_FINAL_REPLY_CHARACTERS);
    expect(spec.payload.text).toContain(
      "[Response truncated; the full result remains in Codex Desktop.]",
    );
  });

  it("removes standalone Codex app directives from provider-visible text", () => {
    const spec = buildFinalReplySpec(
      slackEvent({}),
      [
        "Created the branch.",
        '::git-create-branch{cwd="/Users/chip/Snap" branch="codex/test"}',
        'Inline `::git-stage{cwd="/tmp"}` stays ordinary text.',
      ].join("\n"),
    );

    expect(spec.payload.text).toBe(
      'Created the branch.\nInline `::git-stage{cwd="/tmp"}` stays ordinary text.',
    );
  });

  it("removes standalone inbox item directives from Slack and Gmail replies", () => {
    const response = [
      "Access is approved.",
      '::inbox-item{title="Access approved" summary="No further checks needed"}',
    ].join("\n");

    expect(buildFinalReplySpec(slackEvent({}), response).payload.text).toBe("Access is approved.");
    expect(buildFinalReplySpec(gmailEvent(), response).payload.text).toBe("Access is approved.");
  });

  it("posts a GitHub PR/issue comment on the originating item", () => {
    const event: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "issue_comment.created",
      deliveryId: "d1",
      occurredAt: "2026-08-05T06:34:44.000Z",
      summary: "Comment on PR",
      payload: {
        repo: "snapnhd/system",
        number: 997,
        commentId: 1,
        body: "@chipbyte-snap ping",
      },
      conversation: {
        nativeKey: "981891254:997:comment:1",
        rootKey: "981891254:997",
        replyTarget: "981891254:comment:1",
      },
    };
    expect(buildFinalReplySpec(event, "pong")).toEqual({
      provider: "github",
      kind: "issue-comment",
      destination: "snapnhd/system:issue:997",
      payload: { repo: "snapnhd/system", number: "997", text: "pong" },
    });
  });

  it("does not echo a review_requested final answer as a second issue comment", () => {
    const event: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request.review_requested",
      deliveryId: "d-review",
      occurredAt: "2026-08-20T23:27:09.000Z",
      summary: "Review requested",
      payload: {
        repo: "snapnhd/system",
        number: 1108,
        title: "fix(fraud): compare co-borrower (FRA-2943)",
      },
      conversation: {
        nativeKey: "101:1108",
        rootKey: "101:1108",
        replyTarget: "101:1108",
      },
    };
    expect(() => buildFinalReplySpec(event, "Approved FRA-2943. 0 blocking.")).toThrow(
      UnsupportedSourceReplyEventError,
    );
  });

  it("posts a Linear issue comment on the originating issue", () => {
    const event: WakeEvent = {
      source: "webhook",
      sourceId: "webhook-linear",
      kind: "LinearUserEvent.mention",
      deliveryId: "lin-d1",
      occurredAt: "2026-08-05T06:53:48.000Z",
      summary: "CJ mentioned Chip on FRA-2818",
      payload: {
        provider: "linear",
        issueId: "646708d7-ea5e-4a4e-a906-df906ca53e13",
        identifier: "FRA-2818",
        commentId: "39dd588a-5d69-4b3f-bf1b-3eddbf982a0c",
        body: "@chip ping",
        chipUserId: "21a831cd-a81d-4baa-8ab3-d46fde387739",
        organizationId: "6bf541a3-dfd0-4854-9e93-438eedba1c6e",
      },
      conversation: {
        nativeKey: "org:issue:comment:1",
        rootKey: "org:issue",
        replyTarget: "646708d7-ea5e-4a4e-a906-df906ca53e13",
      },
    };
    expect(buildFinalReplySpec(event, "pong")).toEqual({
      provider: "linear",
      kind: "issue-comment",
      destination:
        "646708d7-ea5e-4a4e-a906-df906ca53e13:comment:39dd588a-5d69-4b3f-bf1b-3eddbf982a0c",
      payload: {
        target: "646708d7-ea5e-4a4e-a906-df906ca53e13",
        text: "pong",
        parentId: "39dd588a-5d69-4b3f-bf1b-3eddbf982a0c",
      },
    });
  });

  it("threads a Linear reply under the existing comment root, not the nested mention", () => {
    const event: WakeEvent = {
      source: "webhook",
      sourceId: "webhook-linear",
      kind: "LinearUserEvent.mention",
      deliveryId: "lin-d2",
      occurredAt: "2026-08-18T16:13:17.000Z",
      summary: "CJ mentioned Chip on ENG-4673",
      payload: {
        provider: "linear",
        issueId: "e9b50530-e85d-4e8a-9e50-772e8a143c87",
        identifier: "ENG-4673",
        commentId: "edad4e55-b73e-4772-a706-34780ed323b3",
        parentCommentId: "7d6bfba8-4a3c-40e6-a3aa-598653726994",
        body: "@chip put the plan in the description",
        chipUserId: "21a831cd-a81d-4baa-8ab3-d46fde387739",
        organizationId: "6bf541a3-dfd0-4854-9e93-438eedba1c6e",
      },
      conversation: {
        nativeKey: "org:issue:comment:nested",
        rootKey: "org:issue",
        replyTarget: "e9b50530-e85d-4e8a-9e50-772e8a143c87",
      },
    };
    expect(buildFinalReplySpec(event, "plan is in the description")).toEqual({
      provider: "linear",
      kind: "issue-comment",
      destination:
        "e9b50530-e85d-4e8a-9e50-772e8a143c87:comment:7d6bfba8-4a3c-40e6-a3aa-598653726994",
      payload: {
        target: "e9b50530-e85d-4e8a-9e50-772e8a143c87",
        text: "plan is in the description",
        parentId: "7d6bfba8-4a3c-40e6-a3aa-598653726994",
      },
    });
  });

  it("removes a trailing ChatGPT product attribution from provider-visible text", () => {
    expect(
      buildFinalReplySpec(slackEvent({}), "Done.\n\n**Sent using** ChatGPT").payload.text,
    ).toBe("Done.");
    expect(buildFinalReplySpec(slackEvent({}), "Done.\n\n*Sent using* ChatGPT").payload.text).toBe(
      "Done.",
    );
    expect(
      buildFinalReplySpec(slackEvent({}), "Done.\n\n**Sent using ChatGPT**").payload.text,
    ).toBe("Done.");
    expect(buildFinalReplySpec(slackEvent({}), "Done.\n\nSent using ChatGPT").payload.text).toBe(
      "Done.",
    );
  });

  it("removes linked and mentioned ChatGPT attribution from Slack and Gmail replies", () => {
    const variants = [
      "**Sent using** [**@ChatGPT**](https://snapnhd.slack.com/team/U0BKXQ0M4AK)",
      "Sent using @ChatGPT",
      "*sent using* <https://app.slack.com/team/u0bkxq0m4ak|@chatgpt>",
      "*Sent using* <@U0BKXQ0M4AK|ChatGPT>",
    ];

    for (const attribution of variants) {
      const response = `Done.\n\n${attribution}`;
      expect(buildFinalReplySpec(slackEvent({}), response).payload.text).toBe("Done.");
      expect(buildFinalReplySpec(gmailEvent(), response).payload.text).toBe("Done.");
    }
  });

  it("preserves non-ChatGPT links and non-standalone attribution text", () => {
    const otherProduct =
      "Done.\n\n**Sent using** [**@AnotherApp**](https://snapnhd.slack.com/team/U123)";
    const embedded =
      "Done.\n\nDocumentation: **Sent using** [**@ChatGPT**](https://snapnhd.slack.com/team/U0BKXQ0M4AK)";
    const externalLink =
      "Done.\n\n**Sent using** [**@ChatGPT**](https://example.com/team/U0BKXQ0M4AK)";

    expect(buildFinalReplySpec(slackEvent({}), otherProduct).payload.text).toBe(otherProduct);
    expect(buildFinalReplySpec(slackEvent({}), embedded).payload.text).toBe(embedded);
    expect(buildFinalReplySpec(slackEvent({}), externalLink).payload.text).toBe(externalLink);
  });

  it("rejects a response containing only linked ChatGPT attribution", () => {
    expect(() =>
      buildFinalReplySpec(
        slackEvent({}),
        "**Sent using** [**@ChatGPT**](https://snapnhd.slack.com/team/U0BKXQ0M4AK)",
      ),
    ).toThrow(InvalidSourceReplyEventError);
  });

  it("builds a completed answer for the immutable originating Gmail thread", () => {
    expect(buildFinalReplySpec(gmailEvent(), "Done.\n\n**Sent using** ChatGPT")).toEqual({
      provider: "gmail",
      kind: "thread-reply",
      destination: "<message@example.com>",
      payload: {
        originalMessageId: "<message@example.com>",
        to: "cj@snapcorp.com",
        subject: "Re: Help",
        text: "Done.",
        inReplyTo: "<message@example.com>",
        references: ["<root@example.com>", "<message@example.com>"],
      },
    });
  });

  it("fails closed when Gmail provider fields disagree with normalized metadata", () => {
    const event = gmailEvent();
    if (!event.conversation) throw new Error("fixture conversation missing");
    event.conversation.replyTarget = "<different@example.com>";
    expect(() => buildFinalReplySpec(event, "Done")).toThrow(InvalidSourceReplyEventError);
  });

  it("never treats a synthetic Gmail delivery id as a replyable RFC Message-ID", () => {
    const event = gmailEvent();
    delete event.payload.rfcMessageId;
    event.deliveryId = "gmail-chip:1:42";
    event.conversation = {
      nativeKey: "gmail-chip:1:42",
      rootKey: "gmail-chip:1:42",
      replyTarget: "gmail-chip:1:42",
    };

    expect(() => buildFinalReplySpec(event, "Done")).toThrow(InvalidSourceReplyEventError);
  });
});

describe("buildClaudeProxyReplySpec", () => {
  it("opens a thread on the exact authenticated one-to-one DM message", () => {
    expect(buildClaudeProxyReplySpec(claudeSlackEvent({ channelType: "im" }), "Done")).toEqual({
      provider: "slack",
      kind: "thread-reply",
      destination: "T2FCQUJ5P:D0B7NH419CY:1785250274.616359",
      payload: {
        channel: "D0B7NH419CY",
        threadTs: "1785250274.616359",
        text: "Done",
      },
    });
  });

  it.each([
    "im",
    "channel",
    "group",
    "mpim",
  ] as const)("returns a reply to the exact authenticated %s thread root", (channelType) => {
    const channel = channelType === "im" ? "D0B7NH419CY" : "G0B7NH419CY";
    expect(
      buildClaudeProxyReplySpec(
        claudeSlackEvent({ channelType, threadTs: "1785250218.127339" }),
        "Done",
      ),
    ).toEqual({
      provider: "slack",
      kind: "thread-reply",
      destination: `T2FCQUJ5P:${channel}:1785250218.127339`,
      payload: {
        channel,
        threadTs: "1785250218.127339",
        text: "Done",
      },
    });
  });

  it("uses the originating channel message as the root when a thread is first opened", () => {
    const spec = buildClaudeProxyReplySpec(claudeSlackEvent({ channelType: "channel" }), "Done");

    expect(spec.destination).toBe("T2FCQUJ5P:G0B7NH419CY:1785250274.616359");
    expect(spec.payload.threadTs).toBe("1785250274.616359");
  });

  it("fails closed when authenticated principal or normalized conversation fields disagree", () => {
    const wrongPrincipal = claudeSlackEvent({ channelType: "group" });
    if (!wrongPrincipal.principal) throw new Error("fixture principal missing");
    wrongPrincipal.principal.subjectId = "UOTHER";

    const wrongRoot = claudeSlackEvent({ channelType: "group" });
    if (!wrongRoot.conversation) throw new Error("fixture conversation missing");
    wrongRoot.conversation.rootKey = "T2FCQUJ5P:G0B7NH419CY:different";

    const missingDmBinding = claudeSlackEvent({ channelType: "im" });
    delete missingDmBinding.targetMentions;

    for (const event of [wrongPrincipal, wrongRoot, missingDmBinding]) {
      expect(() => buildClaudeProxyReplySpec(event, "Done")).toThrow(InvalidSourceReplyEventError);
    }
  });

  it("rejects non-Slack events", () => {
    expect(() => buildClaudeProxyReplySpec(gmailEvent(), "Done")).toThrow(
      UnsupportedSourceReplyEventError,
    );
  });

  it("uses a Claude terminal suffix without changing Codex truncation", () => {
    const oversized = "x".repeat(MAX_SLACK_FINAL_REPLY_CHARACTERS + 1_000);
    const claudeText = normalizeSlackClaudeProxyReplyText(oversized);
    const codexText = normalizeSlackFinalReplyText(oversized);

    expect([...claudeText]).toHaveLength(MAX_SLACK_FINAL_REPLY_CHARACTERS);
    expect(claudeText).toContain(
      "[Response truncated; the full result remains in the Claude terminal session.]",
    );
    expect(claudeText).not.toContain("Codex Desktop");
    expect(codexText).toContain("[Response truncated; the full result remains in Codex Desktop.]");
    expect(codexText).not.toContain("Claude terminal session");
  });

  it("applies the existing provider-bound cleanup to Claude responses", () => {
    expect(
      normalizeSlackClaudeProxyReplyText(
        ["Done.", '::git-stage{cwd="/Users/chip/Snap"}', "", "**Sent using** ChatGPT"].join("\n"),
      ),
    ).toBe("Done.");
    expect(normalizeSlackClaudeProxyReplyText("Done.\n\n**Sent using** Claude Code")).toBe("Done.");
    expect(normalizeSlackFinalReplyText("Done.\n\n**Sent using** Claude Code")).toBe(
      "Done.\n\n**Sent using** Claude Code",
    );
  });
});
