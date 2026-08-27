import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import {
  ClaudeProxyConflictError,
  ClaudeProxyStateError,
  ClaudeProxyStore,
  type CreateClaudeProxySessionInput,
} from "./claude-proxy-store.js";
import { buildClaudeProxyReplySpec } from "./reply.js";
import { AgentRequestStore, WorkItemStore } from "./store.js";

function slackEvent(deliveryId: string, text: string): WakeEvent {
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId,
    occurredAt: "2026-08-01T12:00:00.000Z",
    summary: text,
    payload: {
      team: "T1",
      channel: "C1",
      channelType: "channel",
      user: "U1",
      recipientUser: "UCHIP",
      ts: deliveryId,
      threadTs: "1700000000.000001",
      text,
    },
    principal: {
      provider: "slack",
      tenantId: "T1",
      subjectId: "U1",
      handle: "cj",
    },
    conversation: {
      nativeKey: `T1:C1:${deliveryId}`,
      rootKey: "T1:C1:1700000000.000001",
      replyTarget: `C1:${deliveryId}`,
    },
  };
}

function fixture() {
  const db = openDatabase(":memory:");
  const people = new PeopleStore(db);
  const person = people.add({ nickname: "CJ", roleName: "owner" });
  const work = new WorkItemStore(db).getOrCreate({
    kind: "slack",
    key: "T1:C1:1700000000.000001",
    title: "Slack Claude proxy",
    cwd: "/Users/chip/Snap",
  });
  let uuid = 0;
  let tick = 0;
  const proxy = new ClaudeProxyStore(db, {
    randomUUID: () => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}`,
    now: () => new Date(Date.parse("2026-08-01T12:00:00.000Z") + tick++ * 1_000),
  });
  const session: CreateClaudeProxySessionInput = {
    sourceId: "slack-snap",
    provider: "slack",
    conversationKey: "T1:C1:1700000000.000001",
    principalProvider: "slack",
    principalTenantId: "T1",
    principalSubjectId: "U1",
    personId: person.id,
    workItemId: work.id,
    cwd: "/Users/chip/Snap",
    adapterMode: "print",
  };
  const ack = (deliveryId: string) => ({
    provider: "slack",
    kind: "eyes-reaction",
    destination: `C1:${deliveryId}`,
    payload: { channel: "C1", timestamp: deliveryId, reaction: "eyes" },
  });
  const accept = (deliveryId: string, text = `message ${deliveryId}`) =>
    proxy.acceptEventTurn({
      session,
      event: slackEvent(deliveryId, text),
      requestText: text,
      ack: ack(deliveryId),
    });
  return {
    db,
    people,
    person,
    work,
    proxy,
    requests: new AgentRequestStore(db),
    session,
    ack,
    accept,
  };
}

describe("ClaudeProxyStore", () => {
  it("reuses only an exact active conversation binding", () => {
    const context = fixture();
    const first = context.proxy.createOrReuseSession(context.session);
    const replay = context.proxy.createOrReuseSession(context.session);

    expect(first.duplicate).toBe(false);
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay.session.id).toBe(first.session.id);
    expect(replay.session.claudeSessionId).toBe(first.session.claudeSessionId);
    expect(replay.session.adapterMode).toBe("print");
    expect(() =>
      context.proxy.createOrReuseSession({ ...context.session, cwd: "/Users/chip" }),
    ).toThrow(ClaudeProxyConflictError);
    expect(() =>
      context.proxy.createOrReuseSession({ ...context.session, adapterMode: "rc-tmux" }),
    ).toThrow(ClaudeProxyConflictError);

    expect(context.proxy.closeSession(first.session.id)).toMatchObject({
      status: "closed",
      error: null,
    });
    const reopened = context.proxy.createOrReuseSession({
      ...context.session,
      adapterMode: "rc-tmux",
    });
    expect(reopened.duplicate).toBe(false);
    expect(reopened.session.id).not.toBe(first.session.id);
    expect(reopened.session.claudeSessionId).not.toBe(first.session.claudeSessionId);
    expect(reopened.session.adapterMode).toBe("rc-tmux");
  });

  it("validates the adapter mode at the store boundary", () => {
    const context = fixture();
    expect(() =>
      context.proxy.createOrReuseSession({
        ...context.session,
        adapterMode: "unsupported" as "print",
      }),
    ).toThrow("Claude proxy adapter mode must be print or rc-tmux");
  });

  it("atomically accepts and binds initial or follow-up Slack events", () => {
    const context = fixture();
    const input = {
      session: context.session,
      event: slackEvent("1700000001.000001", "run this in Claude"),
      requestText: "run this in Claude",
      ack: context.ack("1700000001.000001"),
    };

    const first = context.proxy.acceptEventTurn(input);
    const replay = context.proxy.acceptEventTurn(input);

    expect(first).toMatchObject({
      sessionDuplicate: false,
      requestDuplicate: false,
      turnDuplicate: false,
      duplicate: false,
      turn: { ordinal: 1, stage: "queued" },
    });
    expect(replay).toMatchObject({
      sessionDuplicate: true,
      requestDuplicate: true,
      turnDuplicate: true,
      duplicate: true,
    });
    expect(replay.request.id).toBe(first.request.id);
    expect(replay.turn.agentRequestId).toBe(first.request.id);
    expect(context.proxy.listTurns(first.session.id)).toHaveLength(1);

    expect(() =>
      context.proxy.acceptEventTurn({ ...input, requestText: "different replay" }),
    ).toThrow(ClaudeProxyConflictError);
    expect(context.proxy.listTurns(first.session.id)).toHaveLength(1);
  });

  it("rolls back the request and session if a provider binding is invalid", () => {
    const context = fixture();
    const event = {
      ...slackEvent("1700000002.000001", "invalid provider"),
      source: "gmail" as const,
    };
    expect(() =>
      context.proxy.acceptEventTurn({
        session: { ...context.session, conversationKey: "T1:C1:bad-provider" },
        event,
        requestText: "invalid provider",
      }),
    ).toThrow(ClaudeProxyConflictError);

    expect(context.requests.findByDelivery("slack-snap", event.deliveryId)).toBeNull();
    expect(context.proxy.findActiveSession("slack-snap", "slack", "T1:C1:bad-provider")).toBeNull();
  });

  it("claims one turn at a time in FIFO order", () => {
    const context = fixture();
    const first = context.accept("1700000003.000001", "first");
    const second = context.accept("1700000004.000001", "second");

    const claimedFirst = context.proxy.claimNextTurn(first.session.id);
    expect(claimedFirst).toMatchObject({
      agentRequestId: first.request.id,
      ordinal: 1,
      stage: "dispatching",
    });
    expect(context.proxy.claimNextTurn(first.session.id)).toBeNull();
    expect(context.requests.get(first.request.id)?.status).toBe("dispatching");

    const submitted = context.proxy.markTurnSubmitted(
      first.request.id,
      first.turn.correlationMarker,
    );
    expect(submitted.stage).toBe("submitted");
    expect(context.requests.get(first.request.id)?.status).toBe("submitted");
    context.proxy.completeTurn(first.request.id, first.turn.correlationMarker, "first response");

    const claimedSecond = context.proxy.claimNextTurn(first.session.id);
    expect(claimedSecond).toMatchObject({
      agentRequestId: second.request.id,
      ordinal: 2,
      stage: "dispatching",
    });
  });

  it("fails closed on illegal transitions, marker mismatches, and changed completion", () => {
    const context = fixture();
    const accepted = context.accept("1700000005.000001");
    expect(() =>
      context.proxy.markTurnSubmitted(accepted.request.id, accepted.turn.correlationMarker),
    ).toThrow(ClaudeProxyStateError);

    context.proxy.claimNextTurn(accepted.session.id);
    expect(() => context.proxy.markTurnSubmitted(accepted.request.id, "wrong-marker")).toThrow(
      ClaudeProxyConflictError,
    );
    context.proxy.markTurnSubmitted(accepted.request.id, accepted.turn.correlationMarker);
    const completed = context.proxy.completeTurn(
      accepted.request.id,
      accepted.turn.correlationMarker,
      "Claude response",
    );
    expect(completed).toMatchObject({ stage: "completed", finalResponse: "Claude response" });
    expect(
      context.proxy.completeTurn(
        accepted.request.id,
        accepted.turn.correlationMarker,
        "Claude response",
      ),
    ).toEqual(completed);
    expect(() =>
      context.proxy.completeTurn(
        accepted.request.id,
        accepted.turn.correlationMarker,
        "changed response",
      ),
    ).toThrow(ClaudeProxyConflictError);
  });

  it("safely releases a recorded submission intent after process spawn is disproven", () => {
    const context = fixture();
    const accepted = context.accept("1700000005.500001");
    context.proxy.claimNextTurn(accepted.session.id);
    context.proxy.markTurnSubmitted(accepted.request.id, accepted.turn.correlationMarker);

    expect(context.proxy.releaseTurnBeforeSubmission(accepted.request.id)).toMatchObject({
      stage: "queued",
      submittedAt: null,
    });
    expect(context.proxy.getSession(accepted.session.id)?.status).toBe("ready");
    expect(context.requests.get(accepted.request.id)?.status).toBe("acknowledged");
  });

  it("keeps a claimed Claude turn out of the ordinary reset without an automatic requeue", () => {
    const context = fixture();
    const accepted = context.accept("1700000006.000001");
    context.proxy.claimNextTurn(accepted.session.id);
    expect(context.requests.resetInFlight()).toBe(0);
    expect(context.requests.get(accepted.request.id)?.status).toBe("dispatching");

    const recovery = context.proxy.recoverInFlight("restart reconciliation required");
    expect(recovery.sessionsHeld).toBe(1);
    expect(recovery.turnsHeld).toHaveLength(1);
    expect(recovery.turnsHeld[0]).toMatchObject({
      agentRequestId: accepted.request.id,
      stage: "held",
      submittedAt: null,
    });
    expect(context.requests.get(accepted.request.id)).toMatchObject({
      status: "held",
      error: "restart reconciliation required",
    });
    expect(context.proxy.claimNextTurn(accepted.session.id)).toBeNull();
    expect(context.proxy.recoverInFlight()).toMatchObject({
      sessionsHeld: 0,
      turnsHeld: [],
      submittedTurns: [],
    });

    expect(context.proxy.getTurn(accepted.request.id)).toMatchObject({
      stage: "held",
      correlationMarker: accepted.turn.correlationMarker,
    });
    expect(context.proxy.claimNextTurn(accepted.session.id)).toBeNull();
  });

  it("keeps a turn already recorded as submitted held until its response is recovered", () => {
    const context = fixture();
    const accepted = context.accept("1700000007.000001");
    context.proxy.claimNextTurn(accepted.session.id);
    context.proxy.markTurnSubmitted(accepted.request.id, accepted.turn.correlationMarker);

    const recovery = context.proxy.recoverInFlight("inspect Claude transcript");
    expect(recovery.turnsHeld).toEqual([]);
    expect(recovery.submittedTurns).toHaveLength(1);
    expect(recovery.submittedTurns[0]?.stage).toBe("held");
    expect(context.proxy.getSession(accepted.session.id)?.status).toBe("held");
    expect(context.proxy.claimNextTurn(accepted.session.id)).toBeNull();

    const response = "response recovered from Claude";
    const complete = context.db.transaction(() => {
      context.proxy.completeRecoveredTurnAndResume(
        accepted.request.id,
        accepted.turn.correlationMarker,
        response,
      );
      context.requests.bindSubmittedCompletion({
        requestId: accepted.request.id,
        codexThreadId: accepted.session.claudeSessionId,
        correlationMarker: accepted.turn.correlationMarker,
      });
      context.requests.enqueueFinalReply({
        requestId: accepted.request.id,
        spec: buildClaudeProxyReplySpec(accepted.request.event, response),
      });
    });
    complete.immediate();
    expect(context.proxy.getSession(accepted.session.id)?.status).toBe("ready");
    expect(context.requests.sourceReplyForRequest(accepted.request.id)).toMatchObject({
      requestOutcome: "completed",
      payload: { text: response },
    });
  });

  it("fails an exact submitted interruption once and releases the next FIFO turn", () => {
    const context = fixture();
    const first = context.accept("1700000007.010001", "first interrupted turn");
    const second = context.accept("1700000007.020001", "second queued turn");
    context.proxy.claimNextTurn(first.session.id);
    context.proxy.markTurnSubmitted(first.request.id, first.turn.correlationMarker);
    context.proxy.recoverInFlight("restart reconciliation required");
    const error = "exact permission interruption";
    const response = "The tool required approval and was not run.";
    const spec = buildClaudeProxyReplySpec(first.request.event, response);

    context.requests.stageTerminalFailureReply({ requestId: first.request.id, error, spec });
    const failed = context.proxy.failSubmittedInterruptionAndResume(
      first.request.id,
      first.turn.correlationMarker,
      error,
    );

    expect(failed).toMatchObject({
      stage: "failed",
      error,
      submittedAt: expect.any(String),
      terminalAt: expect.any(String),
    });
    expect(context.proxy.getSession(first.session.id)).toMatchObject({
      status: "ready",
      error: null,
    });
    expect(context.requests.sourceReplyForRequest(first.request.id)).toMatchObject({
      requestOutcome: "failed",
      payload: { text: response },
    });
    expect(
      context.proxy.failSubmittedInterruptionAndResume(
        first.request.id,
        first.turn.correlationMarker,
        error,
      ),
    ).toEqual(failed);
    expect(context.db.prepare("SELECT count(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 1,
    });
    expect(context.proxy.claimNextTurn(first.session.id)).toMatchObject({
      agentRequestId: second.request.id,
      ordinal: 2,
      stage: "dispatching",
    });
  });

  it("resolves an exact interruption after shutdown already held the submitted turn", () => {
    const context = fixture();
    const accepted = context.accept("1700000007.030001", "interrupted during shutdown");
    context.proxy.claimNextTurn(accepted.session.id);
    context.proxy.markTurnSubmitted(accepted.request.id, accepted.turn.correlationMarker);
    context.proxy.holdTurn(accepted.request.id, "daemon stopped while turn was active");
    const error = "exact permission interruption";
    const response = "The tool required approval and was not run.";
    const spec = buildClaudeProxyReplySpec(accepted.request.event, response);

    context.requests.stageTerminalFailureReply({ requestId: accepted.request.id, error, spec });
    expect(
      context.proxy.failSubmittedInterruptionAndResume(
        accepted.request.id,
        accepted.turn.correlationMarker,
        error,
      ),
    ).toMatchObject({ stage: "failed", error, submittedAt: expect.any(String) });
    expect(context.proxy.getSession(accepted.session.id)).toMatchObject({
      status: "ready",
      error: null,
    });
  });

  it("safely requeues a host-only close control interrupted by restart", () => {
    const context = fixture();
    const first = context.accept("1700000007.100001", "first");
    context.proxy.claimNextTurn(first.session.id);
    context.proxy.markTurnSubmitted(first.request.id, first.turn.correlationMarker);
    context.proxy.completeTurn(first.request.id, first.turn.correlationMarker, "first response");
    const close = context.proxy.acceptEventTurn({
      session: context.session,
      event: slackEvent("1700000007.200001", "back to Chip"),
      requestText: "back to Chip",
      closeRequested: true,
    });
    expect(context.proxy.claimNextTurn(first.session.id)?.agentRequestId).toBe(close.request.id);

    const recovered = context.proxy.recoverInFlight();

    expect(recovered).toMatchObject({
      sessionsHeld: 0,
      turnsHeld: [],
      submittedTurns: [],
      turnsReleased: [{ agentRequestId: close.request.id, stage: "queued" }],
    });
    expect(context.proxy.getSession(first.session.id)).toMatchObject({
      status: "ready",
      closeAfterOrdinal: 2,
    });
    expect(context.requests.get(close.request.id)?.status).toBe("acknowledged");
  });

  it("completes a queued close when restart holds an earlier ambiguous submission", () => {
    const context = fixture();
    const first = context.accept("1700000007.300001", "first");
    context.proxy.claimNextTurn(first.session.id);
    context.proxy.markTurnSubmitted(first.request.id, first.turn.correlationMarker);
    const close = context.proxy.acceptEventTurn({
      session: context.session,
      event: slackEvent("1700000007.400001", "back to Chip"),
      requestText: "back to Chip",
      closeRequested: true,
    });

    const recovered = context.proxy.recoverInFlight("ambiguous first turn");

    expect(recovered.turnsReleased).toEqual([
      expect.objectContaining({ agentRequestId: close.request.id, stage: "completed" }),
    ]);
    expect(context.proxy.getTurn(first.request.id)?.stage).toBe("held");
    expect(context.proxy.getSession(first.session.id)?.status).toBe("paused");
    expect(context.requests.sourceReplyForRequest(close.request.id)?.payload.text).toContain(
      "routing released",
    );
  });

  it("requires pending turns to be resolved before closing a session", () => {
    const context = fixture();
    const accepted = context.accept("1700000008.000001");
    expect(() => context.proxy.closeSession(accepted.session.id)).toThrow(ClaudeProxyStateError);

    expect(context.proxy.failTurn(accepted.request.id, "operator rejected turn")).toMatchObject({
      stage: "failed",
      error: "operator rejected turn",
    });
    expect(context.proxy.resumeSession(accepted.session.id).status).toBe("ready");
    expect(context.proxy.closeSession(accepted.session.id).status).toBe("closed");
  });

  it("enforces immutable session and request bindings in SQLite", () => {
    const context = fixture();
    const accepted = context.accept("1700000009.000001");
    const other = context.people.add({ nickname: "Other", roleName: "owner" });

    expect(() =>
      context.db
        .prepare("UPDATE claude_proxy_sessions SET cwd = ? WHERE id = ?")
        .run("/Users/chip", accepted.session.id),
    ).toThrow(/binding is immutable/);
    expect(() =>
      context.db
        .prepare("UPDATE claude_proxy_sessions SET adapter_mode = ? WHERE id = ?")
        .run("rc-tmux", accepted.session.id),
    ).toThrow(/adapter mode is immutable/);
    expect(() =>
      context.db
        .prepare("UPDATE agent_requests SET person_id = ? WHERE id = ?")
        .run(other.id, accepted.request.id),
    ).toThrow(/request binding is immutable/);
    expect(() =>
      context.db
        .prepare("UPDATE agent_requests SET request_text = ? WHERE id = ?")
        .run("tampered prompt", accepted.request.id),
    ).toThrow(/request binding is immutable/);
    expect(() =>
      context.db
        .prepare("UPDATE agent_requests SET event_json = ? WHERE id = ?")
        .run(JSON.stringify(slackEvent("tampered", "tampered target")), accepted.request.id),
    ).toThrow(/request binding is immutable/);
  });
});
