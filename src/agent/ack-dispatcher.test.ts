import { describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import { AckDispatcher, AckWorker } from "./ack-dispatcher.js";
import { type AckResponder, AckResponderRegistry, PermanentAckError } from "./responders/types.js";
import {
  type AckJob,
  AgentRequestStore,
  PROGRESS_ACK_SUPPRESSED_REASON,
  WorkItemStore,
} from "./store.js";

interface Fixture {
  db: Database;
  requests: AgentRequestStore;
  accept(deliveryId: string, ackNotBefore?: string): AckJob;
}

function fixture(): Fixture {
  const db = openDatabase(":memory:");
  const person = new PeopleStore(db).add({ nickname: "CJ", roleName: "owner" });
  const workItem = new WorkItemStore(db).getOrCreate({
    kind: "slack",
    key: "T:C:1.0",
    title: "Slack request",
  });
  const requests = new AgentRequestStore(db);
  return {
    db,
    requests,
    accept(deliveryId: string, ackNotBefore?: string): AckJob {
      const ack = requests.accept({
        sourceId: "slack-snap",
        event: {
          source: "slack",
          kind: "app_mention",
          deliveryId,
          occurredAt: "2026-07-27T00:00:00.000Z",
          summary: deliveryId,
          payload: { channel: "C", ts: deliveryId },
        },
        personId: person.id,
        workItemId: workItem.id,
        requestText: deliveryId,
        ack: {
          provider: "slack",
          kind: "eyes-reaction",
          destination: `C:${deliveryId}`,
          payload: { channel: "C", timestamp: deliveryId, reaction: "eyes" },
        },
        ...(ackNotBefore ? { ackNotBefore } : {}),
      }).ack;
      if (!ack) throw new Error("fixture acknowledgment was not created");
      return ack;
    },
  };
}

class RecordingResponder implements AckResponder {
  readonly provider = "slack";
  readonly calls: string[] = [];
  error: Error | null = null;

  async send(job: AckJob) {
    this.calls.push(job.providerDeliveryId);
    if (this.error) throw this.error;
    return { providerResultId: `result-${job.providerDeliveryId}` };
  }
}

describe("AckWorker", () => {
  it("waits until the persisted not-before deadline before sending one reaction", async () => {
    const context = fixture();
    const ack = context.accept("event-delayed", "2026-07-27T00:00:05.000Z");
    const responder = new RecordingResponder();
    let now = new Date("2026-07-27T00:00:04.999Z");
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
      { now: () => now },
    );

    await worker.tick();
    expect(responder.calls).toEqual([]);
    expect(context.requests.ack(ack.id)?.status).toBe("pending");

    now = new Date("2026-07-27T00:00:05.000Z");
    await worker.tick();
    await worker.tick();

    expect(responder.calls).toEqual(["event-delayed"]);
    expect(context.requests.ack(ack.id)?.status).toBe("sent");
  });

  it("suppresses a delayed reaction when the request resolves first", async () => {
    const context = fixture();
    const ack = context.accept("event-fast", "2026-07-27T00:00:05.000Z");
    const responder = new RecordingResponder();
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
      { now: () => new Date("2026-07-27T00:00:05.000Z") },
    );

    context.requests.setStatus(ack.requestId, "completed");
    await worker.tick();

    expect(responder.calls).toEqual([]);
    expect(context.requests.ack(ack.id)).toMatchObject({
      status: "failed",
      attemptCount: 0,
      nextAttemptAt: null,
      error: PROGRESS_ACK_SUPPRESSED_REASON,
    });
  });

  it("does nothing when an accepted request has no progress acknowledgment", async () => {
    const context = fixture();
    const request = context.requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        kind: "message",
        deliveryId: "event-without-ack",
        occurredAt: "2026-07-27T00:00:00.000Z",
        summary: "short request",
        payload: { channel: "C", ts: "1.0" },
      },
      personId: new PeopleStore(context.db).add({ nickname: "Second", roleName: "owner" }).id,
      workItemId: new WorkItemStore(context.db).getOrCreate({
        kind: "slack",
        key: "T:C:without-ack",
        title: "Short request",
      }).id,
      requestText: "short request",
    });
    const responder = new RecordingResponder();
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
    );

    await worker.tick();

    expect(request.ack).toBeNull();
    expect(responder.calls).toEqual([]);
  });

  it("dispatches one acknowledgment for a deduplicated request", async () => {
    const context = fixture();
    const first = context.accept("event-1");
    const duplicate = context.requests.accept({
      sourceId: "slack-snap",
      event: {
        source: "slack",
        kind: "app_mention",
        deliveryId: "event-1",
        occurredAt: "2026-07-27T00:00:00.000Z",
        summary: "duplicate",
        payload: {},
      },
      personId: context.requests.get(first.requestId)?.personId ?? "",
      workItemId: context.requests.get(first.requestId)?.workItemId ?? "",
      requestText: "duplicate",
      ack: {
        provider: "slack",
        kind: "eyes-reaction",
        destination: "different",
        payload: {},
      },
    });
    const responder = new RecordingResponder();
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
    );

    expect(duplicate.duplicate).toBe(true);
    await worker.tick();
    expect(responder.calls).toEqual(["event-1"]);
    expect(context.requests.ack(first.id)).toMatchObject({
      status: "sent",
      providerResultId: "result-event-1",
    });
  });

  it("preserves durable store order", async () => {
    const context = fixture();
    const first = context.accept("event-1");
    const second = context.accept("event-2");
    context.db
      .prepare("UPDATE ack_outbox SET created_at = ? WHERE id = ?")
      .run("2026-01-01", first.id);
    context.db
      .prepare("UPDATE ack_outbox SET created_at = ? WHERE id = ?")
      .run("2026-01-02", second.id);
    const responder = new RecordingResponder();
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
    );

    await worker.tick();
    expect(responder.calls).toEqual(["event-1", "event-2"]);
  });

  it("resets crash-left sending jobs when the independent worker starts", async () => {
    const context = fixture();
    const ack = context.accept("event-1");
    context.requests.markAckSending(ack.id);
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([new RecordingResponder()])),
      { tickMs: 60_000 },
    );

    expect(worker.start()).toBe(1);
    expect(context.requests.ack(ack.id)?.status).toBe("pending");
    await worker.stop();
  });

  it("aborts and awaits active acknowledgments during shutdown", async () => {
    const context = fixture();
    const ack = context.accept("event-1");
    let releaseSend: () => void = () => {};
    let markStarted: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const responder: AckResponder = {
      provider: "slack",
      async send(_job, signal) {
        receivedSignal = signal;
        markStarted();
        await sendGate;
        signal?.throwIfAborted();
        return { providerResultId: "too-late" };
      },
    };
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
    );

    const ticking = worker.tick();
    await started;
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    releaseSend();
    await stopping;
    await ticking;

    expect(stopped).toBe(true);
    expect(context.requests.ack(ack.id)?.status).toBe("held");
  });

  it("holds failures with capped backoff and retries when due", async () => {
    const context = fixture();
    const ack = context.accept("event-1");
    const responder = new RecordingResponder();
    responder.error = new Error("Slack unavailable");
    let now = new Date("2026-07-27T00:00:00.000Z");
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
      { initialBackoffMs: 100, backoffCapMs: 100, now: () => now },
    );

    await worker.tick();
    expect(context.requests.ack(ack.id)).toMatchObject({
      status: "held",
      attemptCount: 1,
      nextAttemptAt: "2026-07-27T00:00:00.100Z",
    });
    now = new Date("2026-07-27T00:00:00.050Z");
    await worker.tick();
    expect(responder.calls).toEqual(["event-1"]);

    responder.error = null;
    now = new Date("2026-07-27T00:00:00.100Z");
    await worker.tick();
    expect(responder.calls).toEqual(["event-1", "event-1"]);
    expect(context.requests.ack(ack.id)?.status).toBe("sent");
  });

  it("fails permanent errors once instead of retrying forever", async () => {
    const context = fixture();
    const ack = context.accept("event-1");
    const responder = new RecordingResponder();
    responder.error = new PermanentAckError("Slack token is not configured");
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
    );

    await worker.tick();
    expect(context.requests.ack(ack.id)).toMatchObject({
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: null,
      error: "Slack token is not configured",
    });

    await worker.tick();
    expect(responder.calls).toEqual(["event-1"]);
  });

  it("isolates acknowledgments when one provider call hangs", async () => {
    const context = fixture();
    const hung = context.accept("event-1");
    const healthy = context.accept("event-2");
    const calls: string[] = [];
    const responder: AckResponder = {
      provider: "slack",
      async send(job) {
        calls.push(job.providerDeliveryId);
        if (job.id === hung.id) return new Promise(() => undefined);
        return { providerResultId: "healthy-result" };
      },
    };
    const worker = new AckWorker(
      context.requests,
      new AckDispatcher(new AckResponderRegistry([responder])),
      { sendTimeoutMs: 5, initialBackoffMs: 100 },
    );

    await worker.tick();

    expect(calls).toEqual(["event-1", "event-2"]);
    expect(context.requests.ack(hung.id)).toMatchObject({
      status: "held",
      error: "acknowledgment timed out after 5ms",
    });
    expect(context.requests.ack(healthy.id)).toMatchObject({
      status: "sent",
      providerResultId: "healthy-result",
    });
  });
});
