import { describe, expect, it } from "vitest";
import { WakeEventSchema } from "../../core/event.js";
import {
  InvalidLinearAgentSessionEventError,
  linearAgentSessionToWakeEvent,
} from "./agent-session.js";

const created = {
  type: "AgentSessionEvent",
  action: "created",
  webhookId: "webhook-1",
  webhookTimestamp: Date.now(),
  createdAt: "2026-07-27T12:00:00.000Z",
  organizationId: "org-1",
  appUserId: "chip-app-user",
  promptContext:
    '<issue identifier="ENG-123"><title>Fix it</title></issue><primary-directive-thread comment-id="comment-1"><comment author="CJ"><user id="chip-app-user">Chip Byte</user> please fix this</comment></primary-directive-thread>',
  agentSession: {
    id: "session-1",
    appUserId: "chip-app-user",
    organizationId: "org-1",
    creatorId: "cj-linear",
    creator: { id: "cj-linear", name: "CJ Lazell", email: "cj@snapcorp.com" },
    commentId: "comment-1",
    comment: { id: "comment-1", userId: "cj-linear", body: "please fix this" },
    issueId: "issue-1",
    issue: {
      id: "issue-1",
      identifier: "ENG-123",
      title: "Fix it",
      url: "https://linear.app/snap/issue/ENG-123/fix-it",
    },
  },
};

describe("linearAgentSessionToWakeEvent", () => {
  it("normalizes an authenticated created mention with immutable actor and issue ids", () => {
    const event = linearAgentSessionToWakeEvent({
      body: created,
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(WakeEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      source: "webhook",
      sourceId: "webhook-linear",
      kind: "AgentSessionEvent.created",
      deliveryId: "webhook-1",
      principal: {
        provider: "linear",
        tenantId: "org-1",
        subjectId: "cj-linear",
        email: "cj@snapcorp.com",
      },
      conversation: {
        rootKey: "org-1:issue-1",
        replyTarget: "session-1",
      },
      targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
      payload: {
        body: "please fix this",
        identifier: "ENG-123",
        issueId: "issue-1",
        agentSessionId: "session-1",
      },
    });
  });

  it("uses the frozen prompt activity and its human user for follow-ups", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        action: "prompted",
        webhookId: "webhook-2",
        agentActivity: {
          id: "activity-2",
          userId: "cj-linear",
          user: { id: "cj-linear", name: "CJ Lazell", email: "cj@snapcorp.com" },
          content: { type: "prompt", body: "Also add a regression test" },
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event).toMatchObject({
      kind: "AgentSessionEvent.prompted",
      deliveryId: "webhook-2",
      principal: { subjectId: "cj-linear" },
      conversation: {
        nativeKey: "session-1:activity:activity-2",
        replyTarget: "session-1",
      },
      targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
      payload: { body: "Also add a regression test" },
    });
  });

  it("accepts a source-pinned issue-root created session as delegation", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        webhookId: "delegated",
        promptContext:
          '<issue identifier="ENG-123"><title>Fix it</title><description>Untrusted issue text</description></issue>',
        agentSession: {
          ...created.agentSession,
          commentId: null,
          comment: null,
          sourceCommentId: null,
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event).toMatchObject({
      summary: "CJ Lazell delegated Chip on ENG-123",
      payload: {
        agentTrigger: "delegation",
        body: "Work on the Linear issue delegated to Chip.",
        identifier: "ENG-123",
        issueId: "issue-1",
      },
      targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
    });
    expect(event?.payload.body).not.toContain("Untrusted issue text");
  });

  it("fails closed for ambiguous issue-root created sessions", () => {
    const promptContexts = [
      "<issue><description>Missing immutable identifier</description></issue>",
      '<issue identifier="ENG-999"><description>Mismatched issue</description></issue>',
      '<issue identifier="ENG-123"></issue><issue identifier="ENG-123"></issue>',
    ];

    for (const promptContext of promptContexts) {
      const event = linearAgentSessionToWakeEvent({
        body: {
          ...created,
          webhookId: `ambiguous-${promptContexts.indexOf(promptContext)}`,
          promptContext,
          agentSession: {
            ...created.agentSession,
            commentId: undefined,
            comment: undefined,
            sourceCommentId: undefined,
          },
        },
        sourceId: "webhook-linear",
        expectedAppUserId: "chip-app-user",
      });
      expect(event?.targetMentions).toBeUndefined();
      expect(event?.payload.agentTrigger).toBeUndefined();
      expect(event?.payload.body).toBeUndefined();
    }
  });

  it("does not confuse an unmentioned comment-root session with delegation", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        webhookId: "unmentioned-comment",
        promptContext:
          '<issue identifier="ENG-123"><title>Fix it</title></issue><primary-directive-thread comment-id="comment-1"><comment author="CJ">please fix this</comment></primary-directive-thread>',
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event?.targetMentions).toBeUndefined();
    expect(event?.payload.agentTrigger).toBeUndefined();
  });

  it("accepts exact raw source-comment @chip and @Chip Byte mentions only", () => {
    for (const body of ["@chip please fix this", "@Chip Byte please fix this"]) {
      const event = linearAgentSessionToWakeEvent({
        body: {
          ...created,
          webhookId: `raw-${body}`,
          promptContext:
            '<issue identifier="ENG-123"><title>Fix it</title></issue><primary-directive-thread comment-id="comment-1"><comment author="CJ">please fix this</comment></primary-directive-thread>',
          agentSession: {
            ...created.agentSession,
            comment: { id: "comment-1", userId: "cj-linear", body },
          },
        },
        sourceId: "webhook-linear",
        expectedAppUserId: "chip-app-user",
      });
      expect(event).toMatchObject({
        payload: { body },
        targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
      });
    }

    const prefixedHandle = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        webhookId: "raw-prefixed-handle",
        promptContext:
          '<issue identifier="ENG-123"><title>Fix it</title></issue><primary-directive-thread comment-id="comment-1"><comment author="CJ">please fix this</comment></primary-directive-thread>',
        agentSession: {
          ...created.agentSession,
          comment: {
            id: "comment-1",
            userId: "cj-linear",
            body: "@chipmunk please fix this",
          },
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(prefixedHandle?.targetMentions).toBeUndefined();
  });

  it("fails closed when the source has no pinned app user id or the payload id differs", () => {
    const missingPin = linearAgentSessionToWakeEvent({
      body: created,
      sourceId: "webhook-linear",
    });
    const wrongPin = linearAgentSessionToWakeEvent({
      body: created,
      sourceId: "webhook-linear",
      expectedAppUserId: "different-app-user",
    });
    expect(missingPin?.targetMentions).toBeUndefined();
    expect(wrongPin?.targetMentions).toBeUndefined();

    const inconsistentSession = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        agentSession: { ...created.agentSession, appUserId: "different-app-user" },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(inconsistentSession?.targetMentions).toBeUndefined();
  });

  it("does not accept a structured mention from another thread or another author's comment", () => {
    const otherThread = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        promptContext:
          '<primary-directive-thread comment-id="comment-1"><comment>please fix this</comment></primary-directive-thread><other-thread comment-id="other"><comment><user id="chip-app-user">Chip Byte</user> do something else</comment></other-thread>',
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    const wrongAuthor = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        agentSession: {
          ...created.agentSession,
          comment: { id: "comment-1", userId: "attacker", body: "please fix this" },
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(otherThread?.targetMentions).toBeUndefined();
    expect(wrongAuthor?.targetMentions).toBeUndefined();
  });

  it("does not let an older thread mention authorize a later unmentioned directive", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        promptContext:
          '<primary-directive-thread comment-id="root-comment"><comment author="CJ"><user id="chip-app-user">Chip Byte</user> earlier request</comment><comment author="CJ">assigning this now without a mention</comment></primary-directive-thread>',
        previousComments: [],
        agentSession: {
          ...created.agentSession,
          commentId: "root-comment",
          sourceCommentId: "child-comment",
          comment: { id: "root-comment", userId: "cj-linear", body: "Earlier request" },
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event?.targetMentions).toBeUndefined();
    expect(event?.payload.body).toBeUndefined();
  });

  it("accepts a structured mention in the triggering child comment of a root thread", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        promptContext:
          '<primary-directive-thread comment-id="root-comment"><comment author="Someone else">Earlier context</comment><comment author="CJ"><user id="chip-app-user">Chip Byte</user> handle this reply</comment></primary-directive-thread>',
        previousComments: [],
        agentSession: {
          ...created.agentSession,
          commentId: "root-comment",
          sourceCommentId: "child-comment",
          comment: { id: "root-comment", userId: "someone-else", body: "Earlier context" },
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event).toMatchObject({
      payload: { body: "@Chip Byte handle this reply" },
      targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
    });
  });

  it("represents an authenticated human stop signal distinctly even without prompt text", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        action: "prompted",
        webhookId: "stop-webhook",
        agentActivity: {
          id: "stop-activity",
          userId: "cj-linear",
          user: { id: "cj-linear", name: "CJ Lazell", email: "cj@snapcorp.com" },
          content: { type: "prompt", body: "" },
          signal: "stop",
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event).toMatchObject({
      kind: "AgentSessionEvent.prompted",
      principal: { provider: "linear", subjectId: "cj-linear" },
      payload: {
        agentSessionId: "session-1",
        agentSignal: "stop",
      },
      targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
    });
    expect(event?.payload.body).toBeUndefined();
  });

  it("does not honor stop metadata on an agent-authored non-prompt activity", () => {
    const event = linearAgentSessionToWakeEvent({
      body: {
        ...created,
        action: "prompted",
        webhookId: "fake-stop",
        agentActivity: {
          id: "agent-activity",
          userId: "chip-app-user",
          user: { id: "chip-app-user", name: "Chip Byte" },
          content: { type: "thought", body: "working" },
          signal: "stop",
        },
      },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
    });
    expect(event?.payload.agentSignal).toBeUndefined();
    expect(event?.targetMentions).toBeUndefined();
  });

  it("rejects conflicting duplicated organization, issue, and actor ids", () => {
    const cases = [
      {
        ...created,
        agentSession: { ...created.agentSession, organizationId: "other-org" },
      },
      {
        ...created,
        agentSession: {
          ...created.agentSession,
          issue: { ...created.agentSession.issue, id: "other-issue" },
        },
      },
      {
        ...created,
        agentSession: {
          ...created.agentSession,
          creator: { ...created.agentSession.creator, id: "other-actor" },
        },
      },
      {
        ...created,
        action: "prompted",
        agentActivity: {
          id: "activity-mismatch",
          userId: "cj-linear",
          user: { id: "other-actor", name: "CJ Lazell" },
          content: { type: "prompt", body: "do this" },
        },
      },
    ];

    for (const body of cases) {
      expect(() =>
        linearAgentSessionToWakeEvent({
          body,
          sourceId: "webhook-linear",
          expectedAppUserId: "chip-app-user",
        }),
      ).toThrow(InvalidLinearAgentSessionEventError);
    }
  });

  it("uses a verified signed-body digest when Linear omits webhookId", () => {
    const event = linearAgentSessionToWakeEvent({
      body: { ...created, webhookId: undefined },
      sourceId: "webhook-linear",
      expectedAppUserId: "chip-app-user",
      signedBodyDeliveryId: "linear-body-sha256-test",
    });

    expect(event?.deliveryId).toBe("linear-body-sha256-test");
  });

  it("does not authorize a generic Issue assignment webhook", () => {
    expect(
      linearAgentSessionToWakeEvent({
        body: {
          type: "Issue",
          action: "update",
          data: { id: "issue-1", delegateId: "chip-app-user" },
        },
        sourceId: "webhook-linear",
        expectedAppUserId: "chip-app-user",
      }),
    ).toBeNull();
  });
});
