import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import { SourceReplyDispatcher, SourceReplyWorker } from "./reply-dispatcher.js";
import {
  PermanentSourceReplyError,
  RetryableSourceReplyError,
  type SourceReplyResponder,
  SourceReplyResponderRegistry,
} from "./reply-responders.js";
import { AgentRequestStore, type SourceReplyJob, WorkItemStore } from "./store.js";

class RecordingResponder implements SourceReplyResponder {
  readonly provider = "slack";
  readonly calls: string[] = [];
  error: Error | null = null;

  async send(job: SourceReplyJob) {
    this.calls.push(job.id);
    if (this.error) throw this.error;
    return { providerResultId: "slack:C:2.0" };
  }
}

function fixture() {
  const db = openDatabase(":memory:");
  const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
  const work = new WorkItemStore(db).getOrCreate({
    kind: "slack",
    key: "slack:T:C:1.0",
    title: "Slack request",
  });
  const requests = new AgentRequestStore(db);
  const accepted = requests.accept({
    sourceId: "slack-snap",
    event: {
      source: "slack",
      kind: "message",
      deliveryId: "Ev1",
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
  const reply = requests.enqueueFinalReply({
    requestId: accepted.request.id,
    codexTurnId: "turn-1",
    spec: {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Done" },
    },
  });
  return { requests, requestId: accepted.request.id, reply };
}

function terminalFailureFixture() {
  const db = openDatabase(":memory:");
  const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
  const work = new WorkItemStore(db).getOrCreate({
    kind: "slack",
    key: "slack:T:C:terminal",
    title: "Slack request",
  });
  const requests = new AgentRequestStore(db);
  const accepted = requests.accept({
    sourceId: "slack-snap",
    event: {
      source: "slack",
      kind: "message",
      deliveryId: "Ev-terminal",
      occurredAt: "2026-07-31T00:00:00.000Z",
      summary: "request",
      payload: { text: "do it" },
    },
    personId: person.id,
    workItemId: work.id,
    requestText: "do it",
  });
  const reply = requests.stageTerminalFailureReply({
    requestId: accepted.request.id,
    error: "root workspace prerequisite failed",
    spec: {
      provider: "slack",
      kind: "thread-reply",
      destination: "T:C:1.0",
      payload: { channel: "C", threadTs: "1.0", text: "Workspace preparation failed." },
    },
  });
  return { requests, requestId: accepted.request.id, reply };
}

describe("SourceReplyWorker", () => {
  it("completes the request only after provider acceptance", async () => {
    const context = fixture();
    const responder = new RecordingResponder();
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
    );

    expect(context.requests.get(context.requestId)?.status).toBe("submitted");
    await worker.tick();
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "sent",
      providerResultId: "slack:C:2.0",
    });
    expect(context.requests.get(context.requestId)?.status).toBe("completed");
  });

  it("preserves a terminal request failure after provider acceptance", async () => {
    const context = terminalFailureFixture();
    const responder = new RecordingResponder();
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
    );

    expect(context.requests.get(context.requestId)).toMatchObject({
      status: "failed",
      error: "root workspace prerequisite failed",
    });
    await worker.tick();
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "sent",
      requestOutcome: "failed",
      providerResultId: "slack:C:2.0",
    });
    expect(context.requests.get(context.requestId)).toMatchObject({
      status: "failed",
      error: "root workspace prerequisite failed",
    });
  });

  it("keeps terminal delivery failure on the outbox without replacing the request error", async () => {
    const context = terminalFailureFixture();
    const responder = new RecordingResponder();
    responder.error = new PermanentSourceReplyError("Slack chat:write is missing");
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
    );

    await worker.tick();

    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "failed",
      requestOutcome: "failed",
      error: "Slack chat:write is missing",
    });
    expect(context.requests.get(context.requestId)).toMatchObject({
      status: "failed",
      error: "root workspace prerequisite failed",
    });
  });

  it("holds transient failures with backoff and retries when due", async () => {
    const context = fixture();
    const responder = new RecordingResponder();
    responder.error = new Error("Slack unavailable");
    let now = new Date("2026-07-28T00:00:00.000Z");
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
      { initialBackoffMs: 100, backoffCapMs: 100, now: () => now },
    );

    await worker.tick();
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "held",
      attemptCount: 1,
      nextAttemptAt: "2026-07-28T00:00:00.100Z",
    });
    now = new Date("2026-07-28T00:00:00.100Z");
    responder.error = null;
    await worker.tick();
    expect(responder.calls).toHaveLength(2);
    expect(context.requests.get(context.requestId)?.status).toBe("completed");
  });

  it("leaves a live lease alone and recovers it only after expiration", async () => {
    const context = fixture();
    let now = new Date("2026-07-28T00:00:00.000Z");
    const [original] = context.requests.claimSourceReplies({
      leaseOwner: "worker-before-crash",
      at: now.toISOString(),
      leaseExpiresAt: "2026-07-28T00:01:00.000Z",
    });
    expect(original?.claimIsRecovery).toBe(false);
    const responder = new RecordingResponder();
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
      { tickMs: 60_000, now: () => now, leaseOwner: "replacement-worker" },
    );
    expect(worker.start()).toBe(0);
    await worker.tick();
    expect(responder.calls).toEqual([]);
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "sending",
      leaseOwner: "worker-before-crash",
    });

    now = new Date("2026-07-28T00:01:00.000Z");
    await worker.tick();
    expect(responder.calls).toEqual([context.reply.id]);
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "sent",
      attemptCount: 2,
      leaseOwner: null,
    });
    await worker.stop();
  });

  it("honors a provider retry-after delay", async () => {
    const context = fixture();
    const responder = new RecordingResponder();
    responder.error = new RetryableSourceReplyError("Slack rate limited", 3_000);
    const now = new Date("2026-07-28T00:00:00.000Z");
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
      { initialBackoffMs: 100, now: () => now },
    );

    await worker.tick();
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "held",
      attemptCount: 1,
      nextAttemptAt: "2026-07-28T00:00:03.000Z",
    });
  });

  it("fails permanent provider errors without retrying", async () => {
    const context = fixture();
    const responder = new RecordingResponder();
    responder.error = new PermanentSourceReplyError("Slack chat:write is missing");
    const worker = new SourceReplyWorker(
      context.requests,
      new SourceReplyDispatcher(new SourceReplyResponderRegistry([responder])),
    );

    await worker.tick();
    expect(context.requests.sourceReply(context.reply.id)).toMatchObject({
      status: "failed",
      attemptCount: 1,
      error: "Slack chat:write is missing",
    });
    expect(context.requests.get(context.requestId)).toMatchObject({
      status: "failed",
      error: "source reply failed: Slack chat:write is missing",
    });
    await worker.tick();
    expect(responder.calls).toHaveLength(1);
  });
});
