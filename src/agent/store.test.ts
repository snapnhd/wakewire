import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import {
  AckConflictError,
  AgentRequestStore,
  PROGRESS_ACK_SUPPRESSED_REASON,
  SourceReplyConflictError,
  SourceReplyLeaseConflictError,
  WorkItemConflictError,
  WorkItemStore,
} from "./store.js";

function sourceReplyFixture(db = openDatabase(":memory:")) {
  const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
  const work = new WorkItemStore(db).getOrCreate({
    kind: "slack",
    key: "T:C:lease",
    title: "Slack lease test",
  });
  const requests = new AgentRequestStore(db);
  const accepted = requests.accept({
    sourceId: "slack-snap",
    event: {
      source: "slack",
      kind: "message",
      deliveryId: "Ev-lease",
      occurredAt: "2026-07-28T00:00:00.000Z",
      summary: "request",
      payload: { text: "do it" },
    },
    personId: person.id,
    workItemId: work.id,
    requestText: "do it",
  });
  requests.setStatus(accepted.request.id, "dispatching");
  requests.bindSubmittedCompletion({
    requestId: accepted.request.id,
    codexThreadId: "thread-lease",
    correlationMarker: "marker-lease",
  });
  const reply = requests.enqueueFinalReply({
    requestId: accepted.request.id,
    codexTurnId: "turn-lease",
    spec: {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Done" },
    },
  });
  return { requests, requestId: accepted.request.id, reply };
}

function enqueueSourceReply(args: {
  requests: AgentRequestStore;
  personId: string;
  workItemId: string;
  deliveryId: string;
  sourceId: string;
  provider?: string;
  destination: string;
}) {
  const accepted = args.requests.accept({
    sourceId: args.sourceId,
    event: {
      source: "slack",
      sourceId: args.sourceId,
      kind: "message",
      deliveryId: args.deliveryId,
      occurredAt: "2026-07-28T00:00:00.000Z",
      summary: args.deliveryId,
      payload: { text: args.deliveryId },
    },
    personId: args.personId,
    workItemId: args.workItemId,
    requestText: args.deliveryId,
  });
  args.requests.setStatus(accepted.request.id, "dispatching");
  args.requests.bindSubmittedCompletion({
    requestId: accepted.request.id,
    codexThreadId: `thread-${args.deliveryId}`,
    correlationMarker: `marker-${args.deliveryId}`,
  });
  return args.requests.enqueueFinalReply({
    requestId: accepted.request.id,
    codexTurnId: `turn-${args.deliveryId}`,
    spec: {
      provider: args.provider ?? "slack",
      kind: "thread-reply",
      destination: args.destination,
      payload: { text: args.deliveryId },
    },
  });
}

describe("WorkItemStore", () => {
  it("reuses canonical items and provider aliases", () => {
    const db = openDatabase(":memory:");
    const store = new WorkItemStore(db);
    const item = store.getOrCreate({ kind: "github", key: "101:42", title: "PR 42" });
    store.attachAlias(item.id, { provider: "github", scope: "101", nativeKey: "42" });
    expect(store.getOrCreate({ kind: "github", key: "101:42", title: "ignored" }).id).toBe(item.id);
    expect(store.findByAlias("github", "101", "42")?.id).toBe(item.id);
  });

  it("fails closed when an alias is attached to two work items", () => {
    const store = new WorkItemStore(openDatabase(":memory:"));
    const first = store.getOrCreate({ kind: "github", key: "1:1", title: "one" });
    const second = store.getOrCreate({ kind: "github", key: "1:2", title: "two" });
    store.attachAlias(first.id, { provider: "slack", scope: "T:C", nativeKey: "1.0" });
    expect(() =>
      store.attachAlias(second.id, { provider: "slack", scope: "T:C", nativeKey: "1.0" }),
    ).toThrow(WorkItemConflictError);
  });

  it("promotes a GitHub item to the Linear canonical identity", () => {
    const store = new WorkItemStore(openDatabase(":memory:"));
    const item = store.getOrCreate({ kind: "github", key: "101:42", title: "PR 42" });
    store.attachAlias(item.id, { provider: "github", scope: "101", nativeKey: "42" });
    store.setCodexThread(item.id, "thread-1");
    const promoted = store.promoteToLinear(item.id, "linear:org:issue-uuid", "ENG-4610");
    expect(promoted).toMatchObject({
      id: item.id,
      canonicalKind: "linear",
      canonicalKey: "linear:org:issue-uuid",
      codexThreadId: "thread-1",
    });
    expect(store.findByAlias("github", "101", "42")?.id).toBe(item.id);
  });

  it("tracks the last title synchronized to the Codex task", () => {
    const store = new WorkItemStore(openDatabase(":memory:"));
    const item = store.getOrCreate({ kind: "slack", key: "T:C:1", title: "CJ — Check this" });
    expect(item.codexThreadTitle).toBeNull();

    store.setCodexThreadTitle(item.id, item.title);

    expect(store.get(item.id)?.codexThreadTitle).toBe("CJ — Check this");

    store.setCodexThread(item.id, "thread-1");
    store.setCodexThreadTitle(item.id, item.title);
    store.setCodexThread(item.id, "thread-1");
    expect(store.get(item.id)?.codexThreadTitle).toBe("CJ — Check this");

    store.setCodexThread(item.id, "thread-2");
    expect(store.get(item.id)?.codexThreadTitle).toBeNull();
  });

  it("never retargets an existing Linear task to another ticket", () => {
    const store = new WorkItemStore(openDatabase(":memory:"));
    const item = store.getOrCreate({
      kind: "linear",
      key: "linear:org:issue-1",
      title: "ENG-1",
    });
    expect(() => store.promoteToLinear(item.id, "linear:org:issue-2", "ENG-2")).toThrow(
      WorkItemConflictError,
    );
    expect(store.get(item.id)?.canonicalKey).toBe("linear:org:issue-1");
  });
});

describe("AgentRequestStore", () => {
  it("atomically deduplicates a request with its acknowledgment job", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const person = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:1.0",
      title: "Slack request",
    });
    const requests = new AgentRequestStore(db);
    const input = {
      sourceId: "slack-snap",
      event: {
        source: "slack" as const,
        kind: "app_mention",
        deliveryId: "Ev1",
        occurredAt: "2026-07-27T00:00:00.000Z",
        summary: "request",
        payload: { text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
      ack: {
        provider: "slack",
        kind: "eyes-reaction",
        destination: "C:1.0",
        payload: { channel: "C", timestamp: "1.0", reaction: "eyes" },
      },
    };
    const first = requests.accept(input);
    const duplicate = requests.accept(input);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.request.id).toBe(first.request.id);
    expect(first.ack).not.toBeNull();
    expect(duplicate.ack?.id).toBe(first.ack?.id);
    expect(requests.listAcksReady()).toHaveLength(1);
  });

  it("deduplicates without an ingress ack and idempotently enqueues one later", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:1.0",
      title: "Slack request",
    });
    const requests = new AgentRequestStore(db);
    const input = {
      sourceId: "slack-snap",
      event: {
        source: "slack" as const,
        kind: "message",
        deliveryId: "Ev1",
        occurredAt: "2026-07-27T00:00:00.000Z",
        summary: "request",
        payload: { channel: "C", ts: "1.0", text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
    };

    const first = requests.accept(input);
    const duplicate = requests.accept(input);
    expect(first.ack).toBeNull();
    expect(duplicate).toMatchObject({ duplicate: true, ack: null });
    expect(duplicate.request.id).toBe(first.request.id);
    expect(requests.listAcksReady()).toEqual([]);

    const spec = {
      provider: "slack",
      kind: "eyes-reaction",
      destination: "C:1.0",
      payload: { channel: "C", timestamp: "1.0", reaction: "eyes" },
    };
    const queued = requests.enqueueAckForRequest(first.request.id, spec);
    const replayed = requests.enqueueAckForRequest(first.request.id, spec);
    expect(replayed.id).toBe(queued.id);
    expect(requests.listAcksReady()).toEqual([queued]);
    expect(() =>
      requests.enqueueAckForRequest(first.request.id, {
        ...spec,
        destination: "C:2.0",
      }),
    ).toThrow(AckConflictError);
  });

  it("durably debounces pending feedback for one maintained pull request", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "Zack", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "github",
      key: "github:101:1117",
      title: "Chip PR",
    });
    const requests = new AgentRequestStore(db);
    const input = {
      sourceId: "github-snap",
      event: {
        source: "github" as const,
        kind: "pull_request_review_comment.created",
        deliveryId: "review-comment-1",
        occurredAt: "2026-08-25T15:27:32.000Z",
        summary: "review feedback",
        payload: { repo: "snapnhd/system", number: 1117 },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "address the review ledger",
      coalesceKey: "github-maintained-pr-feedback:101#1117",
      requestNotBefore: "2026-08-25T15:28:02.000Z",
    };

    const first = requests.accept(input);
    const second = requests.accept({
      ...input,
      event: {
        ...input.event,
        deliveryId: "review-comment-2",
        occurredAt: "2026-08-25T15:27:45.000Z",
      },
      requestNotBefore: "2026-08-25T15:28:15.000Z",
    });

    expect(second).toMatchObject({ duplicate: true });
    expect(second.request.id).toBe(first.request.id);
    expect(requests.get(first.request.id)).toMatchObject({
      coalesceKey: "github-maintained-pr-feedback:101#1117",
      nextAttemptAt: "2026-08-25T15:28:15.000Z",
    });
    expect(requests.listReady("2026-08-25T15:28:14.999Z")).toEqual([]);
    expect(requests.listReady("2026-08-25T15:28:15.000Z").map((request) => request.id)).toEqual([
      first.request.id,
    ]);

    requests.setStatus(first.request.id, "dispatching");
    const afterDispatch = requests.accept({
      ...input,
      event: {
        ...input.event,
        deliveryId: "review-comment-3",
        occurredAt: "2026-08-25T15:28:20.000Z",
      },
      requestNotBefore: "2026-08-25T15:28:50.000Z",
    });
    expect(afterDispatch.duplicate).toBe(false);
    expect(afterDispatch.request.id).not.toBe(first.request.id);
  });

  it("keeps the original delayed acknowledgment deadline and claims it once", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:delayed",
      title: "Delayed Slack request",
    });
    const requests = new AgentRequestStore(db);
    const input = {
      sourceId: "slack-snap",
      event: {
        source: "slack" as const,
        kind: "app_mention",
        deliveryId: "Ev-delayed",
        occurredAt: "2026-07-28T00:00:00.000Z",
        summary: "request",
        payload: { channel: "C", ts: "1.0", text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
      ack: {
        provider: "slack",
        kind: "eyes-reaction",
        destination: "C:1.0",
        payload: { channel: "C", timestamp: "1.0", reaction: "eyes" },
      },
      ackNotBefore: "2026-07-28T00:00:05.000Z",
    };

    const first = requests.accept(input);
    const duplicate = requests.accept({
      ...input,
      ackNotBefore: "2026-07-28T00:00:10.000Z",
    });

    expect(duplicate.request.id).toBe(first.request.id);
    expect(duplicate.ack?.nextAttemptAt).toBe("2026-07-28T00:00:05.000Z");
    expect(requests.claimAckForSend(first.ack?.id ?? "", "2026-07-28T00:00:04.999Z")).toBeNull();
    expect(requests.claimAckForSend(first.ack?.id ?? "", "2026-07-28T00:00:05.000Z")).toMatchObject(
      { status: "sending" },
    );
    expect(requests.claimAckForSend(first.ack?.id ?? "", "2026-07-28T00:00:05.001Z")).toBeNull();
  });

  it("defers a stop acknowledgment until interruption is confirmed", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const item = new WorkItemStore(db).getOrCreate({
      kind: "linear",
      key: "linear:org:issue",
      title: "ENG-1",
    });
    const requests = new AgentRequestStore(db);
    requests.accept({
      sourceId: "slack",
      event: {
        source: "slack",
        sourceId: "slack",
        kind: "app_mention",
        deliveryId: "ordinary-1",
        occurredAt: "2026-07-27T00:00:00.000Z",
        summary: "ordinary work",
        payload: { text: "work" },
      },
      personId: person.id,
      workItemId: item.id,
      requestText: "work",
      ack: {
        provider: "slack",
        kind: "eyes-reaction",
        destination: "C:1",
        payload: { channel: "C", timestamp: "1", reaction: "eyes" },
      },
    });
    const accepted = requests.accept({
      sourceId: "linear",
      event: {
        source: "webhook",
        sourceId: "linear",
        kind: "AgentSessionEvent.prompted",
        deliveryId: "stop-1",
        occurredAt: "2026-07-27T00:00:00.000Z",
        summary: "CJ stopped Chip",
        payload: { provider: "linear", agentSignal: "stop" },
      },
      personId: person.id,
      workItemId: item.id,
      requestText: "stop",
      ack: {
        provider: "linear",
        kind: "activity",
        destination: "session-1",
        payload: { target: "session-1", text: "Stopped, CJ." },
      },
      deferAck: true,
    });

    expect(accepted.ack?.status).toBe("held");
    expect(requests.listReady()[0]?.sourceDeliveryId).toBe("stop-1");
    expect(requests.listAcksReady()).toHaveLength(1);
    expect(() =>
      requests.finalizeDeferredRequest({
        requestId: accepted.request.id,
        status: "completed",
      }),
    ).toThrow(/must be dispatching/);
    expect(requests.get(accepted.request.id)?.status).toBe("acknowledged");
    expect(requests.ackForRequest(accepted.request.id)?.status).toBe("held");

    requests.setStatus(accepted.request.id, "dispatching");
    requests.finalizeDeferredRequest({
      requestId: accepted.request.id,
      status: "completed",
    });
    expect(requests.get(accepted.request.id)?.status).toBe("completed");
    expect(requests.ackForRequest(accepted.request.id)?.status).toBe("pending");
    expect(requests.listAcksReady()).toHaveLength(2);
  });

  it("still resets an ordinary dispatching request during startup recovery", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:ordinary-recovery",
      title: "Ordinary recovery",
    });
    const requests = new AgentRequestStore(db);
    const accepted = requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        sourceId: "slack-snap",
        kind: "message",
        deliveryId: "ordinary-recovery",
        occurredAt: "2026-07-28T00:00:00.000Z",
        summary: "ordinary recovery",
        payload: { text: "ordinary recovery" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "ordinary recovery",
    });
    requests.setStatus(accepted.request.id, "dispatching");

    expect(requests.resetInFlight()).toBe(1);
    expect(requests.get(accepted.request.id)?.status).toBe("acknowledged");
  });

  it("binds one completion and keeps a final reply alongside an acknowledgment", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:1.0",
      title: "Slack request",
    });
    const requests = new AgentRequestStore(db);
    const accepted = requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        kind: "message",
        deliveryId: "Ev-final",
        occurredAt: "2026-07-28T00:00:00.000Z",
        summary: "request",
        payload: { text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
      ack: {
        provider: "slack",
        kind: "eyes-reaction",
        destination: "C:1.0",
        payload: { channel: "C", timestamp: "1.0", reaction: "eyes" },
      },
    });
    requests.setStatus(accepted.request.id, "dispatching");
    const bound = requests.bindSubmittedCompletion({
      requestId: accepted.request.id,
      codexThreadId: "thread-1",
      correlationMarker: "wakewire:event:v1:marker-1",
    });
    expect(bound).toMatchObject({
      status: "submitted",
      codexThreadId: "thread-1",
      codexTurnId: null,
      correlationMarker: "wakewire:event:v1:marker-1",
    });
    expect(requests.listSubmittedAwaitingCompletion().map((request) => request.id)).toEqual([
      accepted.request.id,
    ]);

    const spec = {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Done" },
    };
    const reply = requests.enqueueFinalReply({
      requestId: accepted.request.id,
      codexTurnId: "turn-1",
      spec,
    });
    expect(reply.requestOutcome).toBe("completed");
    expect(requests.enqueueFinalReply({ requestId: accepted.request.id, spec }).id).toBe(reply.id);
    expect(requests.ackForRequest(accepted.request.id)?.ackKind).toBe("eyes-reaction");
    expect(requests.sourceReplyForRequest(accepted.request.id)).toEqual(reply);
    expect(requests.listSubmittedAwaitingCompletion()).toEqual([]);
    expect(requests.get(accepted.request.id)).toMatchObject({
      status: "submitted",
      codexTurnId: "turn-1",
    });

    const [claim] = requests.claimSourceReplies({
      leaseOwner: "worker-a",
      at: "2026-07-28T00:00:00.000Z",
      leaseExpiresAt: "2026-07-28T00:01:00.000Z",
    });
    expect(claim).toMatchObject({
      id: reply.id,
      leaseOwner: "worker-a",
      deliveryAttempt: 1,
      claimIsRecovery: false,
    });
    requests.markSourceReplySent(reply.id, "worker-a", "slack:C:2.0");
    expect(requests.sourceReply(reply.id)).toMatchObject({
      status: "sent",
      providerResultId: "slack:C:2.0",
    });
    expect(requests.get(accepted.request.id)?.status).toBe("completed");
  });

  it("atomically stages a pre-dispatch failure and preserves it after reply delivery", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:terminal-failure",
      title: "Slack request",
    });
    const requests = new AgentRequestStore(db);
    const accepted = requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        kind: "message",
        deliveryId: "Ev-terminal-failure",
        occurredAt: "2026-07-31T00:00:00.000Z",
        summary: "request",
        payload: { text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
      ack: {
        provider: "slack",
        kind: "eyes-reaction",
        destination: "C:1.0",
        payload: { channel: "C", timestamp: "1.0", reaction: "eyes" },
      },
      ackNotBefore: "2026-07-31T00:01:00.000Z",
    });
    requests.hold(accepted.request.id, "temporary preparation failure", "2026-07-31T00:01:00.000Z");
    const spec = {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Workspace preparation failed." },
    };

    expect(() =>
      requests.stageTerminalFailureReply({
        requestId: accepted.request.id,
        error: "root workspace prerequisite failed",
        spec: { ...spec, provider: "" },
      }),
    ).toThrow("source reply provider must not be empty");
    expect(requests.get(accepted.request.id)).toMatchObject({
      status: "held",
      error: "temporary preparation failure",
      nextAttemptAt: "2026-07-31T00:01:00.000Z",
    });
    expect(requests.sourceReplyForRequest(accepted.request.id)).toBeNull();
    expect(requests.ackForRequest(accepted.request.id)?.status).toBe("pending");

    const reply = requests.stageTerminalFailureReply({
      requestId: accepted.request.id,
      error: "root workspace prerequisite failed",
      spec,
    });
    expect(reply).toMatchObject({ requestOutcome: "failed", status: "pending" });
    expect(requests.get(accepted.request.id)).toMatchObject({
      status: "failed",
      error: "root workspace prerequisite failed",
      nextAttemptAt: null,
    });
    expect(requests.ackForRequest(accepted.request.id)).toMatchObject({
      status: "failed",
      error: PROGRESS_ACK_SUPPRESSED_REASON,
    });
    expect(
      requests.stageTerminalFailureReply({
        requestId: accepted.request.id,
        error: "root workspace prerequisite failed",
        spec,
      }).id,
    ).toBe(reply.id);
    expect(() =>
      requests.stageTerminalFailureReply({
        requestId: accepted.request.id,
        error: "different terminal failure",
        spec,
      }),
    ).toThrow(SourceReplyConflictError);
    expect(() => requests.enqueueFinalReply({ requestId: accepted.request.id, spec })).toThrow(
      SourceReplyConflictError,
    );

    const [claim] = requests.claimSourceReplies({
      leaseOwner: "worker-terminal",
      at: "2026-07-31T00:00:00.000Z",
      leaseExpiresAt: "2026-07-31T00:01:00.000Z",
    });
    expect(claim).toMatchObject({ id: reply.id, requestOutcome: "failed" });
    requests.markSourceReplySent(reply.id, "worker-terminal", "slack:C:2.0");
    expect(requests.sourceReply(reply.id)).toMatchObject({
      status: "sent",
      requestOutcome: "failed",
      providerResultId: "slack:C:2.0",
    });
    expect(requests.get(accepted.request.id)).toMatchObject({
      status: "failed",
      error: "root workspace prerequisite failed",
    });
  });

  it("atomically stages and deduplicates a blocking adapter's final reply", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:inline",
      title: "Inline response",
    });
    const requests = new AgentRequestStore(db);
    const accepted = requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        kind: "message",
        deliveryId: "Ev-inline",
        occurredAt: "2026-07-28T00:00:00.000Z",
        summary: "request",
        payload: { text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
    });
    requests.setStatus(accepted.request.id, "dispatching");
    const spec = {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Done" },
    };

    expect(() =>
      requests.stageImmediateFinalReply({
        requestId: accepted.request.id,
        codexThreadId: "thread-inline",
        codexTurnId: "turn-inline",
        spec: { ...spec, provider: "" },
      }),
    ).toThrow("source reply provider must not be empty");
    expect(requests.get(accepted.request.id)).toMatchObject({
      status: "dispatching",
      codexThreadId: null,
      correlationMarker: null,
    });
    expect(requests.sourceReplyForRequest(accepted.request.id)).toBeNull();

    const first = requests.stageImmediateFinalReply({
      requestId: accepted.request.id,
      codexThreadId: "thread-inline",
      codexTurnId: "turn-inline",
      spec,
    });
    const duplicate = requests.stageImmediateFinalReply({
      requestId: accepted.request.id,
      codexThreadId: "thread-inline",
      codexTurnId: "turn-inline",
      spec,
    });

    expect(duplicate.id).toBe(first.id);
    expect(requests.get(accepted.request.id)).toMatchObject({
      status: "submitted",
      codexThreadId: "thread-inline",
      codexTurnId: "turn-inline",
      correlationMarker: `wakewire:immediate:v1:${accepted.request.id}`,
    });
    expect(requests.sourceReplyForRequest(accepted.request.id)?.id).toBe(first.id);

    const unsupported = requests.accept({
      sourceId: "github-snap",
      event: {
        source: "github",
        kind: "pull_request",
        deliveryId: "Ev-inline-unsupported",
        occurredAt: "2026-07-28T00:00:00.000Z",
        summary: "review request",
        payload: { action: "review_requested" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "review this",
    });
    requests.setStatus(unsupported.request.id, "dispatching");
    expect(
      requests.finalizeImmediateCompletion({
        requestId: unsupported.request.id,
        codexThreadId: "thread-unsupported",
        codexTurnId: "turn-unsupported",
        status: "completed",
      }),
    ).toMatchObject({
      status: "completed",
      codexThreadId: "thread-unsupported",
      codexTurnId: "turn-unsupported",
      correlationMarker: `wakewire:immediate:v1:${unsupported.request.id}`,
    });
    expect(requests.sourceReplyForRequest(unsupported.request.id)).toBeNull();
  });

  it("atomically leases source replies and recovers only expired claims", () => {
    const context = sourceReplyFixture();
    const first = context.requests.claimSourceReplies({
      leaseOwner: "worker-a",
      at: "2026-07-28T00:00:00.000Z",
      leaseExpiresAt: "2026-07-28T00:01:00.000Z",
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      status: "sending",
      attemptCount: 1,
      deliveryAttempt: 1,
      claimIsRecovery: false,
      leaseOwner: "worker-a",
    });

    expect(
      context.requests.claimSourceReplies({
        leaseOwner: "worker-b",
        at: "2026-07-28T00:00:59.999Z",
        leaseExpiresAt: "2026-07-28T00:02:00.000Z",
      }),
    ).toEqual([]);
    expect(() =>
      context.requests.markSourceReplySent(context.reply.id, "worker-b", "wrong-owner"),
    ).toThrow(SourceReplyLeaseConflictError);
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "sending",
      leaseOwner: "worker-a",
      attemptCount: 1,
    });

    const recovered = context.requests.claimSourceReplies({
      leaseOwner: "worker-b",
      at: "2026-07-28T00:01:00.000Z",
      leaseExpiresAt: "2026-07-28T00:02:00.000Z",
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      attemptCount: 2,
      deliveryAttempt: 2,
      claimIsRecovery: true,
      leaseOwner: "worker-b",
    });
    expect(() =>
      context.requests.holdSourceReply(
        context.reply.id,
        "worker-a",
        "stale worker",
        "2026-07-28T00:03:00.000Z",
      ),
    ).toThrow(SourceReplyLeaseConflictError);

    context.requests.holdSourceReply(
      context.reply.id,
      "worker-b",
      "retry later",
      "2026-07-28T00:03:00.000Z",
    );
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "held",
      attemptCount: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: "2026-07-28T00:03:00.000Z",
    });
  });

  it("preserves reply order within an exact source, provider, and destination", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:ordered-replies",
      title: "Ordered replies",
    });
    const requests = new AgentRequestStore(db);
    const queue = (deliveryId: string, sourceId: string, destination: string, provider?: string) =>
      enqueueSourceReply({
        requests,
        personId: person.id,
        workItemId: work.id,
        deliveryId,
        sourceId,
        destination,
        ...(provider ? { provider } : {}),
      });

    const firstA = queue("ordered-a-1", "slack-snap", "T:C:thread-a");
    const secondA = queue("ordered-a-2", "slack-snap", "T:C:thread-a");
    const firstB = queue("ordered-b-1", "slack-snap", "T:C:thread-b");
    const secondB = queue("ordered-b-2", "slack-snap", "T:C:thread-b");
    const independentSource = queue("ordered-other-source", "slack-other", "T:C:thread-a");
    const independentProvider = queue(
      "ordered-other-provider",
      "slack-snap",
      "T:C:thread-a",
      "test-provider",
    );

    const initial = requests.claimSourceReplies({
      leaseOwner: "ordering-worker",
      at: "2026-07-28T00:00:00.000Z",
      leaseExpiresAt: "2026-07-28T00:01:00.000Z",
    });
    expect(initial.map(({ id }) => id)).toEqual([
      firstA.id,
      firstB.id,
      independentSource.id,
      independentProvider.id,
    ]);

    requests.holdSourceReply(
      firstA.id,
      "ordering-worker",
      "provider backoff",
      "2026-07-28T00:10:00.000Z",
    );
    requests.markSourceReplySent(firstB.id, "ordering-worker", "sent-b-1");
    requests.markSourceReplySent(independentSource.id, "ordering-worker", "sent-other-source");
    requests.markSourceReplySent(independentProvider.id, "ordering-worker", "sent-other-provider");

    const afterSent = requests.claimSourceReplies({
      leaseOwner: "ordering-worker",
      at: "2026-07-28T00:00:01.000Z",
      leaseExpiresAt: "2026-07-28T00:01:01.000Z",
    });
    expect(afterSent.map(({ id }) => id)).toEqual([secondB.id]);
    expect(requests.sourceReply(secondA.id)?.status).toBe("pending");
    requests.markSourceReplySent(secondB.id, "ordering-worker", "sent-b-2");

    const [recoveredA] = requests.claimSourceReplies({
      leaseOwner: "ordering-worker",
      at: "2026-07-28T00:10:00.000Z",
      leaseExpiresAt: "2026-07-28T00:11:00.000Z",
    });
    expect(recoveredA?.id).toBe(firstA.id);
    requests.markSourceReplyFailed(firstA.id, "ordering-worker", "permanent provider failure");

    const afterFailed = requests.claimSourceReplies({
      leaseOwner: "ordering-worker",
      at: "2026-07-28T00:10:01.000Z",
      leaseExpiresAt: "2026-07-28T00:11:01.000Z",
    });
    expect(afterFailed.map(({ id }) => id)).toEqual([secondA.id]);
  });

  it("allows only one SQLite connection to claim a live reply lease", () => {
    const directory = mkdtempSync(join(tmpdir(), "wakewire-source-reply-lease-"));
    const path = join(directory, "wakewire.db");
    const firstDb = openDatabase(path);
    const context = sourceReplyFixture(firstDb);
    const secondDb = openDatabase(path);
    try {
      const secondStore = new AgentRequestStore(secondDb);
      const firstClaim = context.requests.claimSourceReplies({
        leaseOwner: "process-a",
        at: "2026-07-28T00:00:00.000Z",
        leaseExpiresAt: "2026-07-28T00:01:00.000Z",
      });
      const competingClaim = secondStore.claimSourceReplies({
        leaseOwner: "process-b",
        at: "2026-07-28T00:00:00.000Z",
        leaseExpiresAt: "2026-07-28T00:01:00.000Z",
      });

      expect(firstClaim.map(({ id }) => id)).toEqual([context.reply.id]);
      expect(competingClaim).toEqual([]);
      expect(secondStore.sourceReply(context.reply.id)).toMatchObject({
        status: "sending",
        leaseOwner: "process-a",
        attemptCount: 1,
      });
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects completion or final-reply retargeting", () => {
    const db = openDatabase(":memory:");
    const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
    const work = new WorkItemStore(db).getOrCreate({
      kind: "slack",
      key: "T:C:1.0",
      title: "Slack request",
    });
    const requests = new AgentRequestStore(db);
    const accepted = requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        kind: "message",
        deliveryId: "Ev-conflict",
        occurredAt: "2026-07-28T00:00:00.000Z",
        summary: "request",
        payload: { text: "do it" },
      },
      personId: person.id,
      workItemId: work.id,
      requestText: "do it",
    });
    requests.setStatus(accepted.request.id, "dispatching");
    requests.bindSubmittedCompletion({
      requestId: accepted.request.id,
      codexThreadId: "thread-1",
      correlationMarker: "marker-1",
    });
    expect(() =>
      requests.bindSubmittedCompletion({
        requestId: accepted.request.id,
        codexThreadId: "thread-2",
        correlationMarker: "marker-1",
      }),
    ).toThrow(SourceReplyConflictError);

    const spec = {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Done" },
    };
    requests.enqueueFinalReply({ requestId: accepted.request.id, spec });
    expect(() =>
      requests.enqueueFinalReply({
        requestId: accepted.request.id,
        spec: { ...spec, destination: "T:C:2.0" },
      }),
    ).toThrow(SourceReplyConflictError);
  });
});
