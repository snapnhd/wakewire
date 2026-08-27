import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import {
  ScheduledFollowupAuthorizationError,
  ScheduledFollowupConflictError,
  ScheduledFollowupService,
  ScheduledFollowupStore,
} from "./scheduled-followup.js";
import { AgentRequestStore, WorkItemStore } from "./store.js";

function slackEvent(deliveryId = "Ev-origin"): WakeEvent {
  const team = "T2FCQUJ5P";
  const channel = "C0BLL630E68";
  const ts = "1785386602.344259";
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId,
    occurredAt: "2026-07-30T05:00:00.000Z",
    summary: "Slack request from CJ",
    principal: { provider: "slack", tenantId: team, subjectId: "U-CJ" },
    payload: { team, channel, ts, threadTs: ts, text: "Monitor access" },
    conversation: {
      nativeKey: `${team}:${channel}:${ts}`,
      rootKey: `${team}:${channel}:${ts}`,
      replyTarget: `${channel}:${ts}`,
    },
  };
}

function gmailEvent(): WakeEvent {
  const messageId = "<access-request@example.com>";
  return {
    source: "gmail",
    sourceId: "gmail-chip",
    kind: "email",
    deliveryId: messageId,
    occurredAt: "2026-07-30T05:00:00.000Z",
    summary: "Email request from CJ",
    principal: { provider: "gmail", tenantId: "chip@snapcorp.com", subjectId: "cj" },
    payload: {
      fromEmail: "cj@snapcorp.com",
      subject: "Monitor access",
      rfcMessageId: messageId,
      references: ["<root@example.com>"],
      text: "Monitor access",
    },
    conversation: {
      nativeKey: messageId,
      rootKey: "<root@example.com>",
      replyTarget: messageId,
    },
  };
}

function fixture(event: WakeEvent = slackEvent()) {
  const db = openDatabase(":memory:");
  const people = new PeopleStore(db);
  const person = people.add({ nickname: "CJ", roleName: "owner" });
  const work = new WorkItemStore(db).getOrCreate({
    kind: event.source === "gmail" ? "email" : "slack",
    key: `scheduled:${event.deliveryId}`,
    title: "Scheduled follow-up",
  });
  const requests = new AgentRequestStore(db);
  const accepted = requests.accept({
    sourceId: event.sourceId ?? `${event.source}-source`,
    event,
    personId: person.id,
    workItemId: work.id,
    requestText: "Monitor access",
  });
  requests.setStatus(accepted.request.id, "dispatching");
  requests.bindSubmittedCompletion({
    requestId: accepted.request.id,
    codexThreadId: "thread-origin",
    codexTurnId: "turn-origin",
    correlationMarker: "wakewire:event:v1:origin",
  });
  let wakeCount = 0;
  const service = new ScheduledFollowupService(
    new ScheduledFollowupStore(db),
    requests,
    people,
    () => wakeCount++,
    () => new Date("2026-07-30T06:00:00.000Z"),
  );
  return {
    db,
    people,
    person,
    requests,
    service,
    originRequestId: accepted.request.id,
    wakeCount: () => wakeCount,
  };
}

function register(context: ReturnType<typeof fixture>, automationId = "monitor-access") {
  return context.service.register({
    automationId,
    originRequestId: context.originRequestId,
    currentCodexThreadId: "thread-origin",
  });
}

describe("ScheduledFollowupService", () => {
  it("registers an immutable origin-task binding idempotently", () => {
    const context = fixture();
    const first = register(context);
    const replay = register(context);

    expect(first).toMatchObject({ duplicate: false, source: "slack" });
    expect(replay).toMatchObject({ duplicate: true, source: "slack" });
    expect(replay.binding.id).toBe(first.binding.id);
    expect(() =>
      context.service.register({
        automationId: "monitor-access",
        originRequestId: context.originRequestId,
        currentCodexThreadId: "another-thread",
      }),
    ).toThrow(ScheduledFollowupConflictError);

    const secondOrigin = context.requests.accept({
      sourceId: "slack-snap",
      event: slackEvent("Ev-second"),
      personId: context.person.id,
      workItemId: context.requests.get(context.originRequestId)?.workItemId as string,
      requestText: "second",
    });
    context.requests.setStatus(secondOrigin.request.id, "dispatching");
    context.requests.bindSubmittedCompletion({
      requestId: secondOrigin.request.id,
      codexThreadId: "thread-origin",
      codexTurnId: "turn-second",
      correlationMarker: "marker-second",
    });
    expect(() =>
      context.service.register({
        automationId: "monitor-access",
        originRequestId: secondOrigin.request.id,
        currentCodexThreadId: "thread-origin",
      }),
    ).toThrow(ScheduledFollowupConflictError);
  });

  it("queues one provider-only Slack reply and replays it binding-wide", () => {
    const context = fixture();
    const { binding } = register(context);
    const input = {
      followupId: binding.id,
      automationId: "monitor-access",
      currentCodexThreadId: "thread-origin",
      message:
        'Access is approved.\n::inbox-item{title="Access approved" summary="No checks needed"}',
    };

    const first = context.service.complete(input);
    const replay = context.service.complete(input);

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.request.id).toBe(first.request.id);
    expect(replay.reply.id).toBe(first.reply.id);
    expect(context.wakeCount()).toBe(2);
    expect(first.request).toMatchObject({
      status: "submitted",
      codexThreadId: "thread-origin",
      codexTurnId: null,
    });
    expect(first.reply).toMatchObject({
      provider: "slack",
      destination: "T2FCQUJ5P:C0BLL630E68:1785386602.344259",
      status: "pending",
      payload: {
        channel: "C0BLL630E68",
        threadTs: "1785386602.344259",
        text: "Access is approved.",
      },
    });
    expect(context.requests.listReady().map(({ id }) => id)).not.toContain(first.request.id);
    expect(context.requests.listSubmittedAwaitingCompletion().map(({ id }) => id)).not.toContain(
      first.request.id,
    );
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 1,
    });
    expect(() => context.service.complete({ ...input, message: "Different result" })).toThrow(
      ScheduledFollowupConflictError,
    );
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("rejects a callback from a different task or disabled person", () => {
    const context = fixture();
    const { binding } = register(context);
    expect(() =>
      context.service.complete({
        followupId: binding.id,
        automationId: "monitor-access",
        currentCodexThreadId: "standalone-cron-thread",
        message: "Done",
      }),
    ).toThrow(ScheduledFollowupConflictError);

    context.people.disable(context.person.id);
    expect(() =>
      context.service.complete({
        followupId: binding.id,
        automationId: "monitor-access",
        currentCodexThreadId: "thread-origin",
        message: "Done",
      }),
    ).toThrow(ScheduledFollowupAuthorizationError);
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 0,
    });
  });

  it("preserves the frozen Gmail target without dispatching the synthetic child", () => {
    const context = fixture(gmailEvent());
    const { binding } = register(context, "monitor-email-access");
    const completed = context.service.complete({
      followupId: binding.id,
      automationId: "monitor-email-access",
      currentCodexThreadId: "thread-origin",
      message: "Access is approved.",
    });

    expect(completed.reply).toMatchObject({
      provider: "gmail",
      destination: "<access-request@example.com>",
      payload: {
        originalMessageId: "<access-request@example.com>",
        to: "cj@snapcorp.com",
        text: "Access is approved.",
      },
    });
    expect(completed.request.event.deliveryId).toMatch(/^scheduled-followup:/);
    expect(context.requests.listSubmittedAwaitingCompletion()).not.toContainEqual(
      expect.objectContaining({ id: completed.request.id }),
    );
  });
});
