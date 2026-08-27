import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { openDatabase } from "../db/db.js";
import { migrate } from "../db/migrations.js";
import { PeopleStore } from "../people/store.js";
import { OWNER_ROLE_POLICY } from "./policy.js";
import {
  InvalidScheduledChannelDeliveryError,
  ScheduledChannelDeliveryAuthorizationError,
  ScheduledChannelDeliveryConflictError,
  ScheduledChannelDeliveryService,
  ScheduledChannelDeliveryStore,
} from "./scheduled-channel-delivery.js";
import { AgentRequestStore, WorkItemStore } from "./store.js";

function slackEvent(deliveryId = "Ev-origin", channel = "C0BLL630E68"): WakeEvent {
  const team = "T2FCQUJ5P";
  const ts = deliveryId === "Ev-origin" ? "1785386602.344259" : "1785386603.344259";
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId,
    occurredAt: "2026-07-30T05:00:00.000Z",
    summary: "Slack request from CJ",
    principal: { provider: "slack", tenantId: team, subjectId: "U-CJ" },
    payload: { team, channel, ts, threadTs: ts, text: "Schedule a daily report" },
    conversation: {
      nativeKey: `${team}:${channel}:${ts}`,
      rootKey: `${team}:${channel}:${ts}`,
      replyTarget: `${channel}:${ts}`,
    },
  };
}

function gmailEvent(): WakeEvent {
  const messageId = "<daily-report@example.com>";
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
      subject: "Daily report",
      rfcMessageId: messageId,
      text: "Schedule a daily report",
    },
    conversation: {
      nativeKey: messageId,
      rootKey: messageId,
      replyTarget: messageId,
    },
  };
}

function fixture(
  event: WakeEvent = slackEvent(),
  now: () => Date = () => new Date("2026-07-30T13:00:00.000Z"),
) {
  const db = openDatabase(":memory:");
  const people = new PeopleStore(db);
  const person = people.add({ nickname: "CJ", roleName: "owner" });
  const work = new WorkItemStore(db).getOrCreate({
    kind: event.source === "gmail" ? "email" : "slack",
    key: `scheduled-channel:${event.deliveryId}`,
    title: "Scheduled channel delivery",
  });
  const requests = new AgentRequestStore(db);
  const accepted = requests.accept({
    sourceId: event.sourceId ?? `${event.source}-source`,
    event,
    personId: person.id,
    workItemId: work.id,
    requestText: "Schedule a daily report",
  });
  requests.setStatus(accepted.request.id, "dispatching");
  requests.bindSubmittedCompletion({
    requestId: accepted.request.id,
    codexThreadId: "thread-origin",
    codexTurnId: "turn-origin",
    correlationMarker: "wakewire:event:v1:origin",
  });
  let wakeCount = 0;
  const store = new ScheduledChannelDeliveryStore(db);
  const service = new ScheduledChannelDeliveryService(
    store,
    requests,
    people,
    () => wakeCount++,
    now,
  );
  return {
    db,
    people,
    person,
    requests,
    service,
    store,
    originRequestId: accepted.request.id,
    wakeCount: () => wakeCount,
  };
}

function register(context: ReturnType<typeof fixture>) {
  return context.service.register({
    automationId: "daily-fraud-report",
    originRequestId: context.originRequestId,
    currentCodexThreadId: "thread-origin",
  });
}

function send(
  context: ReturnType<typeof fixture>,
  deliveryId: string,
  occurrenceKey = "2026-07-29@America/Chicago",
  message = "Fraud orders for July 29: 7.",
) {
  return context.service.send({
    deliveryId,
    automationId: "daily-fraud-report",
    currentCodexThreadId: "thread-origin",
    occurrenceKey,
    message,
  });
}

describe("ScheduledChannelDeliveryService", () => {
  it("registers an immutable same-channel Slack binding idempotently", () => {
    const context = fixture();
    const first = register(context);
    const replay = register(context);

    expect(first).toMatchObject({ duplicate: false, source: "slack" });
    expect(replay).toMatchObject({ duplicate: true, source: "slack" });
    expect(replay.binding.id).toBe(first.binding.id);
    expect(first.binding).toMatchObject({
      automationId: "daily-fraud-report",
      originRequestId: context.originRequestId,
      originCodexThreadId: "thread-origin",
      originCodexTurnId: "turn-origin",
      originCorrelationMarker: "wakewire:event:v1:origin",
      originSourceId: "slack-snap",
      slackTeamId: "T2FCQUJ5P",
      slackChannelId: "C0BLL630E68",
    });

    expect(() =>
      context.service.register({
        automationId: "daily-fraud-report",
        originRequestId: context.originRequestId,
        currentCodexThreadId: "different-thread",
      }),
    ).toThrow(ScheduledChannelDeliveryConflictError);
    expect(() =>
      context.db
        .prepare("UPDATE scheduled_channel_delivery_bindings SET slack_channel_id = ? WHERE id = ?")
        .run("C-RETARGETED", first.binding.id),
    ).toThrow(/binding is immutable/);
  });

  it("queues one top-level provider-only message per stable occurrence", () => {
    const context = fixture();
    const { binding } = register(context);
    const first = send(context, binding.id);
    const replay = send(context, binding.id);
    const next = send(
      context,
      binding.id,
      "2026-07-30@America/Chicago",
      "Fraud orders for July 30: 4.",
    );

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(next.duplicate).toBe(false);
    expect(replay.request.id).toBe(first.request.id);
    expect(replay.reply.id).toBe(first.reply.id);
    expect(next.request.id).not.toBe(first.request.id);
    expect(context.wakeCount()).toBe(3);
    expect(first.request).toMatchObject({
      status: "submitted",
      codexThreadId: "thread-origin",
      codexTurnId: null,
    });
    expect(first.request.event).toMatchObject({
      source: "slack",
      kind: "message.scheduled_channel_delivery",
      payload: {
        text: "Fraud orders for July 29: 7.",
        wakewireScheduledChannelDelivery: {
          automationId: "daily-fraud-report",
          occurrenceKey: "2026-07-29@America/Chicago",
        },
      },
    });
    expect(first.reply).toMatchObject({
      provider: "slack",
      replyKind: "channel-message",
      destination: "T2FCQUJ5P:C0BLL630E68",
      status: "pending",
      payload: {
        channel: "C0BLL630E68",
        text: "Fraud orders for July 29: 7.",
      },
    });
    expect(first.reply.payload).not.toHaveProperty("threadTs");
    expect(context.requests.listReady().map(({ id }) => id)).not.toContain(first.request.id);
    expect(context.requests.listSubmittedAwaitingCompletion().map(({ id }) => id)).not.toContain(
      first.request.id,
    );
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 2,
    });
    expect(
      context.db
        .prepare("SELECT COUNT(*) AS count FROM scheduled_channel_delivery_occurrences")
        .get(),
    ).toEqual({ count: 2 });

    const status = context.service.status(binding.id);
    expect(status.occurrences).toHaveLength(2);
    expect(status.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrence: expect.objectContaining({
            occurrenceKey: "2026-07-29@America/Chicago",
          }),
          sourceReply: expect.objectContaining({ provider: "slack", status: "pending" }),
        }),
      ]),
    );
    expect(() => send(context, binding.id, undefined, "Different result")).toThrow(
      ScheduledChannelDeliveryConflictError,
    );
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 2,
    });
  });

  it("replays an identical occurrence after time advances without rebuilding its request", () => {
    let clock = new Date("2026-07-30T13:00:00.000Z");
    const context = fixture(slackEvent(), () => clock);
    const { binding } = register(context);
    const first = send(context, binding.id);

    clock = new Date("2026-07-30T15:30:00.000Z");
    const replay = send(context, binding.id);

    expect(replay.duplicate).toBe(true);
    expect(replay.request.id).toBe(first.request.id);
    expect(replay.reply.id).toBe(first.reply.id);
    expect(replay.request.event.occurredAt).toBe("2026-07-30T13:00:00.000Z");
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM agent_requests").get()).toEqual({
      count: 2,
    });
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("requires both connected-app and source-reply authorization at registration and send", () => {
    const registration = fixture();
    registration.people.setRole("reply-only", {
      ...OWNER_ROLE_POLICY,
      capabilities: {
        ...OWNER_ROLE_POLICY.capabilities,
        connectedApps: "read",
      },
    });
    registration.people.setRoleForPerson(registration.person.id, "reply-only");
    expect(() => register(registration)).toThrow(ScheduledChannelDeliveryAuthorizationError);

    const delivery = fixture();
    const { binding } = register(delivery);
    delivery.people.setRole("apps-only", {
      ...OWNER_ROLE_POLICY,
      capabilities: {
        ...OWNER_ROLE_POLICY.capabilities,
        sourceReplies: "read",
      },
    });
    delivery.people.setRoleForPerson(delivery.person.id, "apps-only");
    expect(() => send(delivery, binding.id)).toThrow(ScheduledChannelDeliveryAuthorizationError);
    expect(delivery.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 0,
    });
  });

  it("rejects non-Slack origins and normalized-target drift", () => {
    const email = fixture(gmailEvent());
    expect(() => register(email)).toThrow(InvalidScheduledChannelDeliveryError);

    const { sourceId: _sourceId, ...missingSourceEvent } = slackEvent();
    const missingSource = fixture(missingSourceEvent);
    expect(() => register(missingSource)).toThrow(InvalidScheduledChannelDeliveryError);

    const context = fixture();
    const { binding } = register(context);
    const origin = context.requests.get(context.originRequestId);
    if (!origin) throw new Error("missing test origin");
    const changed = {
      ...origin.event,
      payload: { ...origin.event.payload, channel: "C-DIFFERENT" },
      conversation: {
        ...origin.event.conversation,
        nativeKey: "T2FCQUJ5P:C-DIFFERENT:1785386602.344259",
        rootKey: "T2FCQUJ5P:C-DIFFERENT:1785386602.344259",
        replyTarget: "C-DIFFERENT:1785386602.344259",
      },
    };
    context.db
      .prepare("UPDATE agent_requests SET event_json = ? WHERE id = ?")
      .run(JSON.stringify(changed), context.originRequestId);
    expect(() => send(context, binding.id)).toThrow(ScheduledChannelDeliveryConflictError);
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 0,
    });
  });
});

describe("migration 16", () => {
  it("upgrades the existing schema with recurring binding and occurrence tables", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 15);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_channel_delivery_bindings'",
        )
        .get(),
    ).toBeUndefined();

    migrate(db);

    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'scheduled_channel_delivery_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "scheduled_channel_delivery_bindings" },
      { name: "scheduled_channel_delivery_occurrences" },
    ]);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 16").get()).toEqual({
      name: "scheduled-channel-deliveries",
    });
  });
});
