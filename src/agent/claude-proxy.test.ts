import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import type {
  AgentAdapter,
  DeliveryOptions,
  DeliveryResult,
  SubmittedDeliveryRecoveryOptions,
} from "../sinks/types.js";
import { DeliveryNotSubmittedError, SubmittedDeliveryInterruptedError } from "../sinks/types.js";
import { ClaudeProxyCoordinator, ClaudeProxyWorker } from "./claude-proxy.js";
import { ClaudeProxyStore } from "./claude-proxy-store.js";
import { AgentCoordinator } from "./coordinator.js";
import { SAFETY_POLICY_VERSION, type SafetyScreener } from "./safety.js";
import { AgentRequestStore, WorkItemStore } from "./store.js";

const TEAM = "T-SNAP";
const USER = "UCJ";
const CHIP = "UCHIP";
const SOURCE = "slack-chip";
const DM = "D-CJ-CHIP";

function slackDm(text: string, ts: string, user = USER, threadTs?: string): WakeEvent {
  return {
    source: "slack",
    sourceId: SOURCE,
    kind: "message",
    deliveryId: `Ev-${ts}-${user}`,
    occurredAt: "2026-08-01T12:00:00.000Z",
    summary: `Slack PM: ${text}`,
    payload: {
      team: TEAM,
      channel: DM,
      channelType: "im",
      user,
      recipientUser: CHIP,
      ts,
      ...(threadTs ? { threadTs } : {}),
      text,
    },
    principal: { provider: "slack", tenantId: TEAM, subjectId: user },
    conversation: {
      nativeKey: `${TEAM}:${DM}:${ts}`,
      rootKey: `${TEAM}:${DM}:${threadTs ?? ts}`,
      replyTarget: `${DM}:${ts}`,
    },
    targetMentions: [{ kind: "direct-message", value: CHIP }],
  };
}

function slackThread(text: string, ts: string, rootTs: string, addressed = false): WakeEvent {
  return {
    source: "slack",
    sourceId: SOURCE,
    kind: "message",
    deliveryId: `Ev-${ts}`,
    occurredAt: "2026-08-01T12:00:00.000Z",
    summary: `Slack channel message: ${text}`,
    payload: {
      team: TEAM,
      channel: "C-DEV",
      channelType: "channel",
      user: USER,
      recipientUser: CHIP,
      ts,
      ...(ts === rootTs ? {} : { threadTs: rootTs }),
      text,
    },
    principal: { provider: "slack", tenantId: TEAM, subjectId: USER },
    conversation: {
      nativeKey: `${TEAM}:C-DEV:${ts}`,
      rootKey: `${TEAM}:C-DEV:${rootTs}`,
      replyTarget: `C-DEV:${ts}`,
    },
    ...(addressed ? { targetMentions: [{ kind: "slack-user" as const, value: CHIP }] } : {}),
  };
}

class RecordingClaude implements AgentAdapter {
  readonly calls: Array<{
    kind: "start" | "resume";
    threadId?: string;
    prompt: string;
    options: DeliveryOptions;
  }> = [];
  readonly recoveryCalls: Array<{
    threadId: string;
    options: SubmittedDeliveryRecoveryOptions;
  }> = [];
  error: Error | null = null;
  readonly queuedErrors: Error[] = [];
  readonly queuedRecoveryOutcomes: Array<DeliveryResult | null | Error> = [];

  constructor(readonly name = "claude-cli") {}

  async startThread(prompt: string, options: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ kind: "start", prompt, options });
    const error = this.queuedErrors.shift() ?? this.error;
    if (error) throw error;
    const threadId = options.idempotencyKey;
    if (!threadId) throw new Error("test Claude requires a session id");
    return { threadId, finalResponse: "Claude initial response" };
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    options: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, options });
    const error = this.queuedErrors.shift() ?? this.error;
    if (error) throw error;
    return { threadId, finalResponse: "Claude follow-up response" };
  }

  async recoverSubmittedTurn(
    threadId: string,
    options: SubmittedDeliveryRecoveryOptions,
  ): Promise<DeliveryResult | null> {
    this.recoveryCalls.push({ threadId, options });
    const outcome = this.queuedRecoveryOutcomes.shift() ?? null;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

function fixture(
  screener?: SafetyScreener,
  coordinatorOptions: ConstructorParameters<typeof ClaudeProxyCoordinator>[6] = {},
) {
  const db = openDatabase(":memory:");
  const people = new PeopleStore(db);
  const person = people.add({ nickname: "CJ", roleName: "owner" });
  people.attachIdentity({
    personId: person.id,
    provider: "slack",
    tenantId: TEAM,
    externalId: USER,
  });
  const work = new WorkItemStore(db);
  const requests = new AgentRequestStore(db);
  const proxy = new ClaudeProxyStore(db);
  const coordinator = new ClaudeProxyCoordinator(
    db,
    people,
    work,
    requests,
    proxy,
    undefined,
    coordinatorOptions,
  );
  const claude = new RecordingClaude();
  const worker = new ClaudeProxyWorker(
    db,
    people,
    work,
    requests,
    proxy,
    { print: claude, "rc-tmux": claude },
    pino({ level: "silent" }),
    { ...(screener ? { safetyScreener: screener } : {}), tickMs: 60_000 },
  );
  return { db, people, person, work, requests, proxy, coordinator, claude, worker };
}

async function runOne(worker: ClaudeProxyWorker, condition: () => unknown): Promise<void> {
  await worker.tick();
  await vi.waitFor(() => expect(condition()).toBeTruthy());
}

function legacyDmSessionBinding(context: ReturnType<typeof fixture>) {
  const item = context.work.getOrCreate({
    kind: "slack",
    key: `slack:${TEAM}:${DM}:legacy`,
    title: "Legacy Slack DM Claude proxy",
    cwd: "/Users/chip/Snap",
  });
  return {
    sourceId: SOURCE,
    provider: "slack",
    conversationKey: `slack-dm:${TEAM}:${DM}`,
    principalProvider: "slack",
    principalTenantId: TEAM,
    principalSubjectId: USER,
    personId: context.person.id,
    workItemId: item.id,
    cwd: "/Users/chip/Snap",
    adapterMode: "print" as const,
  };
}

describe("ClaudeProxyCoordinator", () => {
  it("persists one delayed eyes acknowledgment for every exact proxy turn", () => {
    const context = fixture(undefined, {
      now: () => new Date("2026-08-01T12:00:00.000Z"),
      progressAckDelayMs: 10_000,
    });
    const initialEvent = slackDm("run on Claude: inspect the retry path", "1.0");
    const initial = context.coordinator.accept(initialEvent);

    expect(context.requests.ackForRequest(initial.requestId ?? "")).toMatchObject({
      provider: "slack",
      ackKind: "eyes-reaction",
      destination: `${DM}:1.0`,
      payload: { channel: DM, timestamp: "1.0", reaction: "eyes" },
      status: "pending",
      nextAttemptAt: "2026-08-01T12:00:10.000Z",
    });

    const replay = context.coordinator.accept(initialEvent);
    expect(replay).toMatchObject({
      claimed: true,
      accepted: true,
      duplicate: true,
      requestId: initial.requestId,
    });
    expect(context.db.prepare("SELECT count(*) AS count FROM ack_outbox").get()).toMatchObject({
      count: 1,
    });

    const followup = context.coordinator.accept(
      slackDm("also inspect the queue", "1.1", USER, "1.0"),
    );
    expect(context.requests.ackForRequest(followup.requestId ?? "")).toMatchObject({
      destination: `${DM}:1.1`,
      payload: { channel: DM, timestamp: "1.1", reaction: "eyes" },
      nextAttemptAt: "2026-08-01T12:00:10.000Z",
    });
    expect(context.db.prepare("SELECT count(*) AS count FROM ack_outbox").get()).toMatchObject({
      count: 2,
    });
  });

  it("requires an anchored trigger, stores only its prompt, and hides it from Codex readiness", () => {
    const context = fixture();

    expect(context.coordinator.accept(slackDm("can WakeWire run on Claude?", "1.0"))).toEqual({
      claimed: false,
      accepted: false,
    });
    const accepted = context.coordinator.accept(
      slackDm("Please run this in Claude: inspect the retry path", "2.0"),
    );

    expect(accepted).toMatchObject({ claimed: true, accepted: true, duplicate: false });
    expect(context.requests.get(accepted.requestId ?? "")?.requestText).toBe(
      "inspect the retry path",
    );
    expect(context.requests.listReady()).toEqual([]);
    expect(context.proxy.getSession(accepted.sessionId ?? "")).toMatchObject({
      conversationKey: `${TEAM}:${DM}:2.0`,
      personId: context.person.id,
      adapterMode: "print",
      status: "ready",
    });
    expect(
      context.coordinator.accept(
        slackDm("Please run this in Claude: inspect the retry path", "2.0"),
      ),
    ).toMatchObject({
      claimed: true,
      accepted: true,
      duplicate: true,
      requestId: accepted.requestId,
      sessionId: accepted.sessionId,
    });
    expect(context.proxy.listTurns(accepted.sessionId ?? "")).toHaveLength(1);
  });

  it("starts a persistent RC session from an ordinary Slack request when configured as default", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const event = slackDm("inspect the retry path without a routing prefix", "3.0");
    const accepted = context.coordinator.accept(event);

    expect(accepted).toMatchObject({ claimed: true, accepted: true, duplicate: false });
    expect(context.requests.get(accepted.requestId ?? "")?.requestText).toBe(
      "inspect the retry path without a routing prefix",
    );
    expect(context.proxy.getSession(accepted.sessionId ?? "")).toMatchObject({
      adapterMode: "rc-tmux",
      conversationKey: `${TEAM}:${DM}:3.0`,
      status: "ready",
    });
  });

  it("keeps explicit Claude transport selection above the configured default", () => {
    const print = fixture(undefined, { defaultAgent: "claude-rc" });
    const printTurn = print.coordinator.accept(slackDm("run on Claude: inspect print", "3.1"));
    expect(print.proxy.getSession(printTurn.sessionId ?? "")?.adapterMode).toBe("print");

    const rc = fixture(undefined, { defaultAgent: "codex" });
    const rcTurn = rc.coordinator.accept(slackDm("run on Claude RC: inspect rc", "3.2"));
    expect(rc.proxy.getSession(rcTurn.sessionId ?? "")?.adapterMode).toBe("rc-tmux");
  });

  it("routes Codex and GPT overrides through ordinary dispatch for one message only", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const agent = new AgentCoordinator(context.people, context.work, context.requests);
    const initial = context.coordinator.accept(
      slackThread(`<@${CHIP}> inspect this in RC`, "4.0", "4.0", true),
    );

    for (const [index, text] of [
      "run on Codex: inspect the Desktop path",
      "run on GPT: inspect it once more",
    ].entries()) {
      const event = slackThread(text, `4.${index + 1}`, "4.0");
      const routing = context.coordinator.accept(event);
      expect(routing).toEqual({ claimed: false, accepted: false, codexOverride: true });

      const accepted = agent.acceptSlackDispatcherOverride(event);
      expect(accepted).toMatchObject({ addressed: true, accepted: true, duplicate: false });
      expect(context.requests.get(accepted.requestId ?? "")?.requestText).toBe(text);

      expect(context.coordinator.accept(event)).toEqual({
        claimed: false,
        accepted: false,
        codexOverride: true,
      });
      expect(agent.acceptSlackDispatcherOverride(event)).toMatchObject({
        addressed: true,
        accepted: true,
        duplicate: true,
        requestId: accepted.requestId,
      });
    }

    expect(context.proxy.listTurns(initial.sessionId ?? "")).toHaveLength(1);
    expect(context.proxy.getSession(initial.sessionId ?? "")).toMatchObject({
      adapterMode: "rc-tmux",
      status: "ready",
    });

    const followup = context.coordinator.accept(
      slackThread("continue in the original Claude session", "4.3", "4.0"),
    );
    expect(followup).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: initial.sessionId,
    });
    expect(context.proxy.listTurns(initial.sessionId ?? "")).toHaveLength(2);
  });

  it("claims an altered replay of an ordinary override before route matching", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const agent = new AgentCoordinator(context.people, context.work, context.requests);
    context.coordinator.accept(slackThread(`<@${CHIP}> start the RC session`, "4.0", "4.0", true));
    const original = slackThread("run on GPT: inspect this", "4.4", "4.0");

    expect(context.coordinator.accept(original)).toMatchObject({ codexOverride: true });
    expect(agent.acceptSlackDispatcherOverride(original)).toMatchObject({ accepted: true });

    const altered = slackThread("run on GPT: do something different", "4.4", "4.0");
    expect(context.coordinator.accept(altered)).toEqual({
      claimed: true,
      accepted: false,
      reason: "Codex dispatcher delivery id was replayed with different event content",
    });

    if (!original.conversation) throw new Error("fixture conversation missing");
    const malformed = {
      ...original,
      conversation: { ...original.conversation, rootKey: `${TEAM}:C-DEV:wrong-root` },
    };
    expect(context.coordinator.accept(malformed)).toEqual({
      claimed: true,
      accepted: false,
      reason: "Codex dispatcher delivery id was replayed with different event content",
    });
  });

  it("does not reclassify an ordinary Codex delivery as Claude after config drift", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const agent = new AgentCoordinator(context.people, context.work, context.requests);
    const event = slackDm("ordinary request already accepted by Codex", "4.5");

    expect(agent.accept(event)).toMatchObject({ addressed: true, accepted: true });
    expect(context.coordinator.accept(event)).toEqual({ claimed: false, accepted: false });
    expect(context.db.prepare("SELECT count(*) AS count FROM claude_proxy_sessions").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  it("does not open a default RC session for a stale close command", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });

    expect(context.coordinator.accept(slackDm("back to Chip", "4.6"))).toEqual({
      claimed: false,
      accepted: false,
    });
    expect(context.db.prepare("SELECT count(*) AS count FROM claude_proxy_sessions").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  it("persists explicit Claude RC selection and retains it for follow-ups", () => {
    const context = fixture();
    const initial = context.coordinator.accept(
      slackThread(`<@${CHIP}> run on Claude RC: inspect this`, "5.0", "5.0", true),
    );

    expect(initial).toMatchObject({ claimed: true, accepted: true });
    expect(context.proxy.getSession(initial.sessionId ?? "")).toMatchObject({
      adapterMode: "rc-tmux",
      conversationKey: `${TEAM}:C-DEV:5.0`,
    });

    const followup = context.coordinator.accept(
      slackThread("also inspect the retry boundary", "5.1", "5.0"),
    );
    expect(followup).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: initial.sessionId,
    });
    expect(context.proxy.getSession(followup.sessionId ?? "")?.adapterMode).toBe("rc-tmux");
  });

  it("does not switch an active proxy session when a follow-up resembles another trigger", () => {
    const context = fixture();
    const initial = context.coordinator.accept(slackDm("run on Claude: inspect print", "6.0"));
    const followup = context.coordinator.accept(
      slackDm("run on Claude RC: try the persistent transport", "6.1", USER, "6.0"),
    );

    expect(followup).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: initial.sessionId,
    });
    expect(context.proxy.getSession(followup.sessionId ?? "")?.adapterMode).toBe("print");
    expect(context.requests.get(followup.requestId ?? "")?.requestText).toBe(
      "run on Claude RC: try the persistent transport",
    );
  });

  it("creates one default RC session per Slack DM thread root", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const first = context.coordinator.accept(slackDm("first conversation", "8.0"));
    const second = context.coordinator.accept(slackDm("ping", "8.1"));

    expect(first).toMatchObject({ claimed: true, accepted: true });
    expect(second).toMatchObject({ claimed: true, accepted: true });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(context.proxy.getSession(first.sessionId ?? "")).toMatchObject({
      conversationKey: `${TEAM}:${DM}:8.0`,
      adapterMode: "rc-tmux",
    });
    expect(context.proxy.getSession(second.sessionId ?? "")).toMatchObject({
      conversationKey: `${TEAM}:${DM}:8.1`,
      adapterMode: "rc-tmux",
    });

    const firstFollowup = context.coordinator.accept(
      slackDm("continue first conversation", "8.2", USER, "8.0"),
    );
    expect(firstFollowup).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: first.sessionId,
    });
  });

  it("never routes an ordinary new DM root into a persisted legacy session", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const legacy = context.proxy.createOrReuseSession(legacyDmSessionBinding(context)).session;

    const accepted = context.coordinator.accept(slackDm("ping", "8.3"));

    expect(accepted).toMatchObject({ claimed: true, accepted: true });
    expect(accepted.sessionId).not.toBe(legacy.id);
    expect(context.proxy.getSession(accepted.sessionId ?? "")).toMatchObject({
      conversationKey: `${TEAM}:${DM}:8.3`,
      adapterMode: "rc-tmux",
    });
    expect(context.proxy.listTurns(legacy.id)).toEqual([]);
  });

  it("allows only an exact exit directive to release a held legacy DM session", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const legacy = context.proxy.createOrReuseSession(legacyDmSessionBinding(context)).session;
    context.proxy.holdSession(legacy.id, "ambiguous pre-upgrade provider outcome");

    const released = context.coordinator.accept(slackDm("back to Chip", "8.4"));

    expect(released).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: legacy.id,
      replyQueued: true,
    });
    expect(context.proxy.getSession(legacy.id)).toMatchObject({
      status: "paused",
      error: "ambiguous pre-upgrade provider outcome",
    });
    expect(context.requests.get(released.requestId ?? "")?.requestText).toBe("back to Chip");
  });

  it("lets a persisted legacy DM turn finish and then close from ready", async () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const oldTurn = context.proxy.acceptEventTurn({
      session: legacyDmSessionBinding(context),
      event: slackDm("old queued turn", "8.5"),
      requestText: "old queued turn",
    });

    await runOne(
      context.worker,
      () => context.proxy.getTurn(oldTurn.request.id)?.stage === "completed",
    );
    expect(context.claude.calls).toHaveLength(1);
    expect(context.proxy.getSession(oldTurn.session.id)?.status).toBe("ready");

    const exit = context.coordinator.accept(slackDm("back to Chip", "8.6"));
    expect(exit).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: oldTurn.session.id,
    });
    expect(context.proxy.getSession(oldTurn.session.id)?.closeAfterOrdinal).toBe(2);

    await runOne(
      context.worker,
      () => context.proxy.getSession(oldTurn.session.id)?.status === "closed",
    );
    expect(context.claude.calls).toHaveLength(1);
  });

  it("queues an exact exit behind a busy persisted legacy DM turn", () => {
    const context = fixture(undefined, { defaultAgent: "claude-rc" });
    const next = context.proxy.acceptEventTurn({
      session: legacyDmSessionBinding(context),
      event: slackDm("old in-flight turn", "8.7"),
      requestText: "old in-flight turn",
    });
    expect(context.proxy.claimNextTurn(next.session.id)?.agentRequestId).toBe(next.request.id);
    expect(context.proxy.getSession(next.session.id)?.status).toBe("busy");

    const exit = context.coordinator.accept(slackDm("back to Chip", "8.8"));
    expect(exit).toMatchObject({
      claimed: true,
      accepted: true,
      sessionId: next.session.id,
    });
    expect(context.proxy.getSession(next.session.id)?.closeAfterOrdinal).toBe(2);
    expect(context.proxy.getTurn(exit.requestId ?? "")).toMatchObject({
      sessionId: next.session.id,
      ordinal: 2,
      stage: "queued",
    });
  });

  it("binds channel follow-ups to one exact thread and principal", () => {
    const context = fixture();
    const initial = context.coordinator.accept(
      slackThread(`<@${CHIP}> run on Claude: inspect this`, "10.0", "10.0", true),
    );
    expect(initial).toMatchObject({ claimed: true, accepted: true });

    expect(
      context.coordinator.accept(slackThread("one more constraint", "10.1", "10.0")),
    ).toMatchObject({ claimed: true, accepted: true });
    expect(context.proxy.listTurns(initial.sessionId ?? "")).toHaveLength(2);

    expect(context.coordinator.accept(slackThread("different root", "11.0", "11.0"))).toEqual({
      claimed: false,
      accepted: false,
    });

    const other = context.people.add({ nickname: "Other", roleName: "owner" });
    context.people.attachIdentity({
      personId: other.id,
      provider: "slack",
      tenantId: TEAM,
      externalId: "UOTHER",
    });
    const forged = slackThread("take over", "10.2", "10.0");
    if (!forged.principal) throw new Error("fixture principal missing");
    forged.principal.subjectId = "UOTHER";
    forged.payload.user = "UOTHER";
    expect(context.coordinator.accept(forged)).toEqual({ claimed: false, accepted: false });

    context.people.attachIdentity({
      personId: context.person.id,
      provider: "slack",
      tenantId: TEAM,
      externalId: "UCJ-SECOND",
    });
    const samePersonDifferentPrincipal = slackThread("second identity", "10.3", "10.0");
    if (!samePersonDifferentPrincipal.principal) throw new Error("fixture principal missing");
    samePersonDifferentPrincipal.principal.subjectId = "UCJ-SECOND";
    samePersonDifferentPrincipal.payload.user = "UCJ-SECOND";
    expect(context.coordinator.accept(samePersonDifferentPrincipal)).toEqual({
      claimed: false,
      accepted: false,
    });
  });
});

describe("ClaudeProxyWorker", () => {
  it("routes each persisted proxy session through its selected adapter", async () => {
    const context = fixture();
    const printAdapter = new RecordingClaude("claude-cli");
    const rcAdapter = new RecordingClaude("claude-rc-tmux");
    const worker = new ClaudeProxyWorker(
      context.db,
      context.people,
      context.work,
      context.requests,
      context.proxy,
      { print: printAdapter, "rc-tmux": rcAdapter },
      pino({ level: "silent" }),
      { tickMs: 60_000, maxConcurrentSessions: 1 },
    );
    const printTurn = context.coordinator.accept(
      slackThread(`<@${CHIP}> run on Claude: inspect print`, "15.0", "15.0", true),
    );
    const rcTurn = context.coordinator.accept(
      slackThread(`<@${CHIP}> run on Claude RC: inspect rc`, "16.0", "16.0", true),
    );

    await runOne(worker, () => context.requests.sourceReplyForRequest(rcTurn.requestId ?? ""));

    expect(context.proxy.getSession(printTurn.sessionId ?? "")?.adapterMode).toBe("print");
    expect(context.proxy.getSession(rcTurn.sessionId ?? "")?.adapterMode).toBe("rc-tmux");
    expect(printAdapter.calls).toHaveLength(1);
    expect(printAdapter.calls[0]?.prompt).toContain(
      "WAKEWIRE SAFETY POLICY no-destructive-v1 - OPERATOR CONTROLLED",
    );
    expect(rcAdapter.calls).toHaveLength(1);
    expect(rcAdapter.calls[0]?.prompt).toContain(
      "WAKEWIRE SAFETY POLICY no-destructive-v1 - OPERATOR CONTROLLED",
    );
    await worker.stop();
  });

  it("wraps every turn, resumes Claude directly, replies durably, and exits without a model call", async () => {
    const context = fixture();
    const first = context.coordinator.accept(
      slackDm("run on Claude: inspect the retry path", "20.0"),
    );
    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(first.requestId ?? ""),
    );

    expect(context.claude.calls).toHaveLength(1);
    expect(context.claude.calls[0]).toMatchObject({ kind: "start" });
    expect(context.claude.calls[0]?.prompt).toContain(
      "WAKEWIRE SAFETY POLICY no-destructive-v1 - OPERATOR CONTROLLED",
    );
    expect(context.claude.calls[0]?.prompt).toContain('"text": "inspect the retry path"');
    expect(context.claude.calls[0]?.prompt).not.toContain("WAKEWIRE EXECUTION PROFILE");
    expect(context.requests.sourceReplyForRequest(first.requestId ?? "")).toMatchObject({
      provider: "slack",
      replyKind: "thread-reply",
      destination: `${TEAM}:${DM}:20.0`,
      payload: { channel: DM, threadTs: "20.0", text: "Claude initial response" },
    });

    const second = context.coordinator.accept(
      slackDm("also inspect the queue", "20.1", USER, "20.0"),
    );
    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(second.requestId ?? ""),
    );
    expect(context.claude.calls).toHaveLength(2);
    expect(context.claude.calls[1]).toMatchObject({
      kind: "resume",
      threadId: context.proxy.getSession(first.sessionId ?? "")?.claudeSessionId,
    });
    expect(context.claude.calls[1]?.prompt).toContain('"text": "also inspect the queue"');
    expect(context.claude.calls[1]?.prompt).toContain(
      "Never drop, truncate, reset, purge, force-push, rewrite history",
    );
    expect(context.requests.sourceReplyForRequest(second.requestId ?? "")).toMatchObject({
      replyKind: "thread-reply",
      destination: `${TEAM}:${DM}:20.0`,
      payload: { channel: DM, threadTs: "20.0", text: "Claude follow-up response" },
    });

    const close = context.coordinator.accept(slackDm("back to Chip", "20.2", USER, "20.0"));
    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(close.requestId ?? ""),
    );
    expect(context.claude.calls).toHaveLength(2);
    expect(context.requests.sourceReplyForRequest(close.requestId ?? "")?.payload.text).toBe(
      "Claude proxy closed. New messages will go back through Chip.",
    );
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("closed");
    expect(context.coordinator.accept(slackDm("normal Chip request", "20.3"))).toEqual({
      claimed: false,
      accepted: false,
    });
    await context.worker.stop();
  });

  it("commits the exit barrier at ingress so a later message cannot enter the proxy", async () => {
    const context = fixture();
    const first = context.coordinator.accept(slackDm("run on Claude: first", "25.0"));
    const close = context.coordinator.accept(slackDm("back to Chip", "25.1", USER, "25.0"));

    expect(close).toMatchObject({ claimed: true, accepted: true });
    expect(context.proxy.getSession(first.sessionId ?? "")?.closeAfterOrdinal).toBe(2);
    expect(context.coordinator.accept(slackDm("this is for Chip", "25.2", USER, "25.0"))).toEqual({
      claimed: false,
      accepted: false,
    });
    expect(context.proxy.listTurns(first.sessionId ?? "")).toHaveLength(2);

    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(close.requestId ?? ""),
    );
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("closed");
    expect(context.claude.calls).toHaveLength(1);
    await context.worker.stop();
  });

  it("holds an ambiguous CLI failure and never automatically replays it", async () => {
    const context = fixture();
    context.claude.error = new Error("connection closed after spawn");
    const accepted = context.coordinator.accept(slackDm("Claude: inspect this", "30.0"));

    await runOne(
      context.worker,
      () => context.proxy.getTurn(accepted.requestId ?? "")?.stage === "held",
    );
    expect(context.claude.calls).toHaveLength(1);
    expect(context.proxy.getSession(accepted.sessionId ?? "")).toMatchObject({
      status: "held",
      error: "connection closed after spawn",
    });
    expect(context.requests.get(accepted.requestId ?? "")?.status).toBe("held");
    await context.worker.tick();
    expect(context.claude.calls).toHaveLength(1);
    expect(context.coordinator.accept(slackDm("try again", "30.1", USER, "30.0"))).toMatchObject({
      claimed: true,
      accepted: false,
      reason: "connection closed after spawn",
    });

    const release = context.coordinator.accept(slackDm("back to Chip", "30.2", USER, "30.0"));
    expect(release).toMatchObject({ claimed: true, accepted: true, replyQueued: true });
    expect(context.proxy.getSession(accepted.sessionId ?? "")?.status).toBe("paused");
    expect(context.proxy.getTurn(accepted.requestId ?? "")?.stage).toBe("held");
    expect(context.requests.sourceReplyForRequest(release.requestId ?? "")?.payload.text).toContain(
      "ambiguous Claude turn remains held",
    );
    expect(context.coordinator.accept(slackDm("normal Chip message", "30.3"))).toEqual({
      claimed: false,
      accepted: false,
    });
    const restarted = context.coordinator.accept(
      slackDm("run on Claude: start a fresh proxy", "30.4"),
    );
    expect(restarted).toMatchObject({ claimed: true, accepted: true });
    expect(restarted.sessionId).not.toBe(accepted.sessionId);
    await context.worker.stop();
  });

  it("fails a proven permission interruption visibly and continues the FIFO once", async () => {
    const context = fixture();
    const response =
      "I couldn't finish that turn because a tool required interactive approval. The tool was not run.";
    context.claude.queuedErrors.push(
      new SubmittedDeliveryInterruptedError("exact permission interruption", response),
    );
    const first = context.coordinator.accept(slackDm("run on Claude: inspect this", "31.0"));
    const second = context.coordinator.accept(
      slackDm("answer the follow-up", "31.1", USER, "31.0"),
    );

    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(second.requestId ?? ""),
    );

    expect(context.proxy.getTurn(first.requestId ?? "")).toMatchObject({
      stage: "failed",
      error: "exact permission interruption",
      submittedAt: expect.any(String),
    });
    expect(context.requests.sourceReplyForRequest(first.requestId ?? "")).toMatchObject({
      requestOutcome: "failed",
      payload: { text: response },
    });
    expect(context.proxy.getTurn(second.requestId ?? "")?.stage).toBe("completed");
    expect(context.requests.sourceReplyForRequest(second.requestId ?? "")).toMatchObject({
      requestOutcome: "completed",
      payload: { text: "Claude follow-up response" },
    });
    expect(context.claude.calls.map((call) => call.kind)).toEqual(["start", "resume"]);
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("ready");
    await context.worker.stop();
  });

  it("recovers a pre-held submitted interruption without replay and resumes the FIFO", async () => {
    const context = fixture();
    const response =
      "I couldn't finish that turn because a tool required interactive approval. The tool was not run.";
    const first = context.coordinator.accept(slackDm("run on Claude: inspect this", "31.2"));
    const second = context.coordinator.accept(
      slackDm("answer the follow-up", "31.3", USER, "31.2"),
    );
    const claimed = context.proxy.claimNextTurn(first.sessionId ?? "");
    expect(claimed?.agentRequestId).toBe(first.requestId);
    context.proxy.markTurnSubmitted(first.requestId ?? "", claimed?.correlationMarker ?? "");
    context.proxy.holdTurn(first.requestId ?? "", "daemon stopped while turn was active");
    context.claude.queuedRecoveryOutcomes.push(
      new SubmittedDeliveryInterruptedError("exact recovered interruption", response),
    );

    const recovered = context.worker.start();
    expect(recovered.submittedTurns).toEqual([
      expect.objectContaining({ agentRequestId: first.requestId, stage: "held" }),
    ]);
    await vi.waitFor(() =>
      expect(context.requests.sourceReplyForRequest(second.requestId ?? "")).not.toBeNull(),
    );

    const session = context.proxy.getSession(first.sessionId ?? "");
    expect(context.claude.recoveryCalls).toHaveLength(1);
    expect(context.claude.recoveryCalls[0]).toMatchObject({
      threadId: session?.claudeSessionId,
      options: {
        requestId: first.requestId,
        correlationMarker: claimed?.correlationMarker,
        cwd: "/Users/chip/Snap",
      },
    });
    expect(context.claude.recoveryCalls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(context.proxy.getTurn(first.requestId ?? "")).toMatchObject({
      stage: "failed",
      error: "exact recovered interruption",
      submittedAt: expect.any(String),
    });
    expect(context.requests.sourceReplyForRequest(first.requestId ?? "")).toMatchObject({
      requestOutcome: "failed",
      payload: { text: response },
    });
    expect(context.proxy.getTurn(second.requestId ?? "")?.stage).toBe("completed");
    expect(context.claude.calls.map((call) => call.kind)).toEqual(["resume"]);
    expect(
      context.db
        .prepare("SELECT count(*) AS count FROM source_reply_outbox WHERE request_id = ?")
        .get(first.requestId),
    ).toEqual({ count: 1 });
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("ready");
    await context.worker.stop();
  });

  it("commits a recovered submitted completion without replay and resumes the FIFO", async () => {
    const context = fixture();
    const first = context.coordinator.accept(slackDm("run on Claude: inspect this", "31.4"));
    const second = context.coordinator.accept(
      slackDm("answer the follow-up", "31.5", USER, "31.4"),
    );
    const session = context.proxy.getSession(first.sessionId ?? "");
    const claimed = context.proxy.claimNextTurn(first.sessionId ?? "");
    context.proxy.markTurnSubmitted(first.requestId ?? "", claimed?.correlationMarker ?? "");
    context.claude.queuedRecoveryOutcomes.push({
      threadId: session?.claudeSessionId ?? "",
      correlationMarker: claimed?.correlationMarker,
      finalResponse: "Recovered Claude response",
    });

    const recovered = context.worker.start();
    expect(recovered.submittedTurns).toEqual([
      expect.objectContaining({ agentRequestId: first.requestId, stage: "held" }),
    ]);
    await vi.waitFor(() =>
      expect(context.requests.sourceReplyForRequest(second.requestId ?? "")).not.toBeNull(),
    );

    expect(context.claude.recoveryCalls).toHaveLength(1);
    expect(context.requests.sourceReplyForRequest(first.requestId ?? "")).toMatchObject({
      requestOutcome: "completed",
      payload: { text: "Recovered Claude response" },
    });
    expect(context.proxy.getTurn(first.requestId ?? "")).toMatchObject({
      stage: "completed",
      finalResponse: "Recovered Claude response",
      submittedAt: expect.any(String),
    });
    expect(context.proxy.getTurn(second.requestId ?? "")?.stage).toBe("completed");
    expect(context.claude.calls.map((call) => call.kind)).toEqual(["resume"]);
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("ready");
    await context.worker.stop();
  });

  it("keeps an ambiguous submitted recovery held without replaying later turns", async () => {
    const context = fixture();
    const first = context.coordinator.accept(slackDm("run on Claude: inspect this", "31.6"));
    const second = context.coordinator.accept(
      slackDm("answer the follow-up", "31.7", USER, "31.6"),
    );
    const claimed = context.proxy.claimNextTurn(first.sessionId ?? "");
    context.proxy.markTurnSubmitted(first.requestId ?? "", claimed?.correlationMarker ?? "");
    context.claude.queuedRecoveryOutcomes.push(null);

    context.worker.start();
    await vi.waitFor(() => expect(context.claude.recoveryCalls).toHaveLength(1));

    expect(context.proxy.getTurn(first.requestId ?? "")).toMatchObject({
      stage: "held",
      submittedAt: expect.any(String),
    });
    expect(context.requests.sourceReplyForRequest(first.requestId ?? "")).toBeNull();
    expect(context.proxy.getTurn(second.requestId ?? "")?.stage).toBe("queued");
    expect(context.requests.sourceReplyForRequest(second.requestId ?? "")).toBeNull();
    expect(context.claude.calls).toEqual([]);
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("held");
    await context.worker.stop();
  });

  it("honors a close already queued behind a turn that later becomes ambiguous", async () => {
    const context = fixture();
    context.claude.error = new Error("connection closed after spawn");
    const first = context.coordinator.accept(slackDm("Claude: inspect this", "32.0"));
    const close = context.coordinator.accept(slackDm("back to Chip", "32.1", USER, "32.0"));

    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(close.requestId ?? ""),
    );

    expect(context.proxy.getTurn(first.requestId ?? "")?.stage).toBe("held");
    expect(context.proxy.getTurn(close.requestId ?? "")?.stage).toBe("completed");
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("paused");
    expect(context.requests.sourceReplyForRequest(close.requestId ?? "")?.payload.text).toContain(
      "routing released",
    );
    expect(context.coordinator.accept(slackDm("normal Chip message", "32.2"))).toEqual({
      claimed: false,
      accepted: false,
    });
    await context.worker.stop();
  });

  it("fails queued proxy follow-ups visibly when a held session is released", async () => {
    const context = fixture();
    context.claude.error = new Error("connection closed after spawn");
    const first = context.coordinator.accept(slackDm("Claude: inspect this", "33.0"));
    const queued = context.coordinator.accept(slackDm("also inspect this", "33.1", USER, "33.0"));
    await runOne(
      context.worker,
      () => context.proxy.getTurn(first.requestId ?? "")?.stage === "held",
    );

    const release = context.coordinator.accept(slackDm("back to Chip", "33.2", USER, "33.0"));

    expect(release).toMatchObject({ claimed: true, accepted: true, replyQueued: true });
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("paused");
    expect(context.proxy.getTurn(queued.requestId ?? "")?.stage).toBe("failed");
    expect(context.requests.get(queued.requestId ?? "")?.status).toBe("failed");
    expect(context.requests.sourceReplyForRequest(queued.requestId ?? "")).toMatchObject({
      requestOutcome: "failed",
      payload: { text: expect.stringContaining("queued Claude turn was not sent") },
    });
    await context.worker.stop();
  });

  it("fails visibly and releases routing when the adapter proves no submission occurred", async () => {
    const context = fixture();
    context.claude.error = new DeliveryNotSubmittedError("Claude executable was not found");
    const accepted = context.coordinator.accept(slackDm("Claude: inspect this", "35.0"));

    await runOne(
      context.worker,
      () => context.proxy.getTurn(accepted.requestId ?? "")?.stage !== "dispatching",
    );
    expect(context.proxy.getTurn(accepted.requestId ?? "")?.stage).toBe("failed");
    expect(context.proxy.getSession(accepted.sessionId ?? "")?.status).toBe("paused");
    expect(context.requests.sourceReplyForRequest(accepted.requestId ?? "")).toMatchObject({
      requestOutcome: "failed",
      payload: { text: expect.stringContaining("no Claude turn was started") },
    });
    expect(context.coordinator.accept(slackDm("normal Chip message", "35.1"))).toEqual({
      claimed: false,
      accepted: false,
    });
    await context.worker.stop();
  });

  it("fails a denied safety screen before Claude and queues an exact source failure", async () => {
    const deny: SafetyScreener = {
      mode: "test",
      enforcing: true,
      policyVersion: SAFETY_POLICY_VERSION,
      async screen() {
        return {
          policyVersion: SAFETY_POLICY_VERSION,
          decision: "deny",
          mode: "test",
          enforcing: true,
          reasonCodes: ["destructive"],
        };
      },
    };
    const context = fixture(deny);
    const accepted = context.coordinator.accept(
      slackDm("run on Claude: delete everything", "40.0"),
    );

    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(accepted.requestId ?? ""),
    );
    expect(context.claude.calls).toHaveLength(0);
    expect(context.proxy.getTurn(accepted.requestId ?? "")?.stage).toBe("failed");
    expect(context.requests.sourceReplyForRequest(accepted.requestId ?? "")).toMatchObject({
      requestOutcome: "failed",
      replyKind: "thread-reply",
      destination: `${TEAM}:${DM}:40.0`,
    });
    await context.worker.stop();
  });

  it("preserves later queued messages and releases routing after a pre-submission denial", async () => {
    const deny: SafetyScreener = {
      mode: "test",
      enforcing: true,
      policyVersion: SAFETY_POLICY_VERSION,
      async screen() {
        return {
          policyVersion: SAFETY_POLICY_VERSION,
          decision: "deny",
          mode: "test",
          enforcing: true,
          reasonCodes: ["destructive"],
        };
      },
    };
    const context = fixture(deny);
    const first = context.coordinator.accept(slackDm("run on Claude: unsafe", "45.0"));
    const later = context.coordinator.accept(slackDm("already queued", "45.1", USER, "45.0"));

    await runOne(context.worker, () =>
      context.requests.sourceReplyForRequest(first.requestId ?? ""),
    );
    expect(context.proxy.getSession(first.sessionId ?? "")?.status).toBe("paused");
    expect(context.proxy.getTurn(later.requestId ?? "")).toMatchObject({
      stage: "held",
      error: expect.stringContaining("safety screen denied"),
    });
    expect(context.requests.get(later.requestId ?? "")?.status).toBe("held");
    expect(context.coordinator.accept(slackDm("back through Chip", "45.2"))).toEqual({
      claimed: false,
      accepted: false,
    });
    await context.worker.stop();
  });

  it("safely requeues a turn when shutdown interrupts the safety screen before submission", async () => {
    const waiting: SafetyScreener = {
      mode: "test",
      enforcing: true,
      policyVersion: SAFETY_POLICY_VERSION,
      screen(_input, options) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const context = fixture(waiting);
    const accepted = context.coordinator.accept(slackDm("run on Claude: wait", "50.0"));

    await context.worker.tick();
    await vi.waitFor(() =>
      expect(context.proxy.getTurn(accepted.requestId ?? "")?.stage).toBe("dispatching"),
    );
    await context.worker.stop();

    expect(context.proxy.getTurn(accepted.requestId ?? "")?.stage).toBe("queued");
    expect(context.proxy.getSession(accepted.sessionId ?? "")?.status).toBe("ready");
    expect(context.requests.get(accepted.requestId ?? "")?.status).toBe("acknowledged");
    expect(context.claude.calls).toHaveLength(0);
  });
});
