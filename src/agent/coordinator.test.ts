import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import { desktopCorrelationMarker } from "../sinks/codex-desktop.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "../sinks/types.js";
import { CompletionWorker } from "./completion-worker.js";
import {
  AgentCoordinator,
  AgentDispatchWorker,
  type AgentDispatchWorkerOptions,
} from "./coordinator.js";
import type { GithubReviewBodyUpdate } from "./github-review-status.js";
import type { LinearIssueDirectory } from "./linear-directory.js";
import { ParentReportFence } from "./parent-report-fence.js";
import { PR_ROLE_POLICY } from "./policy.js";
import { SAFETY_POLICY_VERSION, type SafetyAssessment, type SafetyScreener } from "./safety.js";
import { SnapWorkspaceCommandError, type SnapWorkspaceInput } from "./snap-workspace.js";
import { AgentRequestStore, PROGRESS_ACK_SUPPRESSED_REASON, WorkItemStore } from "./store.js";

class FakeDesktop implements AgentAdapter {
  readonly name: string = "codex-desktop";
  calls: Array<{
    kind: "start" | "resume";
    threadId?: string;
    prompt: string;
    opts: DeliveryOptions;
  }> = [];
  interrupts: string[] = [];
  titles: Array<{ threadId: string; title: string }> = [];
  prepared: Array<{ threadId: string; opts: DeliveryOptions }> = [];
  private readonly preparedByKey = new Map<string, string>();

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, opts });
    return fakeDesktopResult(threadId, prompt, opts);
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ kind: "start", prompt, opts });
    return fakeDesktopResult("desktop-thread-1", prompt, opts);
  }

  async prepareThread(
    opts: DeliveryOptions & { cwd: string; idempotencyKey: string },
  ): Promise<{ threadId: string }> {
    const existing = this.preparedByKey.get(opts.idempotencyKey);
    if (existing) return { threadId: existing };
    const threadId = `prepared-thread-${this.prepared.length + 1}`;
    this.prepared.push({ threadId, opts });
    this.preparedByKey.set(opts.idempotencyKey, threadId);
    return { threadId };
  }

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    this.titles.push({ threadId, title });
  }

  async readThreadTitle(threadId: string): Promise<string | null> {
    return this.titles.findLast((entry) => entry.threadId === threadId)?.title ?? null;
  }

  async interruptThread(threadId: string): Promise<{ threadId: string }> {
    this.interrupts.push(threadId);
    return { threadId };
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

class FakeImmediateAdapter implements AgentAdapter {
  readonly name = "codex-exec";
  readonly calls: Array<{ threadId?: string; prompt: string; opts: DeliveryOptions }> = [];

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ threadId, prompt, opts });
    return { threadId, turnId: "turn-immediate", finalResponse: "Done immediately" };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ prompt, opts });
    return {
      threadId: "thread-immediate",
      turnId: "turn-immediate",
      finalResponse: "Done immediately",
    };
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

class DeferredDesktop implements AgentAdapter {
  readonly name = "codex-desktop";
  readonly interrupts: string[] = [];
  readonly deliveryStarted: Promise<void>;
  private signalDeliveryStarted: () => void = () => {};
  private releaseDelivery: () => void = () => {};
  private readonly deliveryReleased: Promise<void>;

  constructor() {
    this.deliveryStarted = new Promise((resolve) => {
      this.signalDeliveryStarted = resolve;
    });
    this.deliveryReleased = new Promise((resolve) => {
      this.releaseDelivery = resolve;
    });
  }

  finishDelivery(): void {
    this.releaseDelivery();
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.signalDeliveryStarted();
    await this.deliveryReleased;
    return fakeDesktopResult(threadId, prompt, opts);
  }

  async startThread(): Promise<DeliveryResult> {
    throw new Error("unexpected new task");
  }

  async interruptThread(threadId: string): Promise<{ threadId: string }> {
    this.interrupts.push(threadId);
    return { threadId };
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

class DeferredParentReportDesktop implements AgentAdapter {
  readonly name = "codex-desktop";
  readonly interrupts: string[] = [];
  readonly calls: Array<{ threadId: string; prompt: string; opts: DeliveryOptions }> = [];
  readonly reportStarted: Promise<void>;
  inFlight = 0;
  private signalReportStarted: () => void = () => {};

  constructor() {
    this.reportStarted = new Promise((resolve) => {
      this.signalReportStarted = resolve;
    });
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ threadId, prompt, opts });
    this.inFlight++;
    this.signalReportStarted();
    try {
      const signal = opts.signal;
      if (!signal) throw new Error("parent report signal is required");
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          reject(
            signal.reason instanceof Error ? signal.reason : new Error("parent report aborted"),
          );
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      throw new Error("parent report unexpectedly completed");
    } finally {
      this.inFlight--;
    }
  }

  async startThread(): Promise<DeliveryResult> {
    throw new Error("unexpected new task");
  }

  async interruptThread(threadId: string): Promise<{ threadId: string }> {
    this.interrupts.push(threadId);
    return { threadId };
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

class FakeHermes implements AgentAdapter {
  readonly name = "hermes";
  calls: Array<{
    kind: "start" | "resume";
    threadId?: string;
    prompt: string;
    opts: DeliveryOptions;
  }> = [];
  titles: Array<{ threadId: string; title: string }> = [];

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, opts });
    return { threadId, finalResponse: "plan drafted" };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ kind: "start", prompt, opts });
    return { threadId: "hermes-thread-1", finalResponse: "plan drafted" };
  }

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    this.titles.push({ threadId, title });
  }

  async readThreadTitle(threadId: string): Promise<string | null> {
    return this.titles.findLast((entry) => entry.threadId === threadId)?.title ?? null;
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

class HeadMoveHermes extends FakeHermes {
  readonly firstDeliveryStarted: Promise<void>;
  firstSignal: AbortSignal | undefined;
  private signalFirstDeliveryStarted: () => void = () => {};
  private releaseFirstDelivery: () => void = () => {};

  constructor() {
    super();
    this.firstDeliveryStarted = new Promise((resolve) => {
      this.signalFirstDeliveryStarted = resolve;
    });
  }

  releaseFirst(): void {
    this.releaseFirstDelivery();
  }

  override async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, opts });
    if (this.calls.length > 1) return { threadId, finalResponse: "reviewed new head" };
    this.firstSignal = opts.signal;
    this.signalFirstDeliveryStarted();
    await new Promise<void>((resolve, reject) => {
      this.releaseFirstDelivery = resolve;
      const onAbort = (): void => reject(opts.signal?.reason ?? new Error("aborted"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    });
    return { threadId, finalResponse: "reviewed old head" };
  }
}

class FinalResponseHermes extends FakeHermes {
  constructor(private readonly response: string) {
    super();
  }

  override async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, opts });
    return { threadId, finalResponse: this.responseFor(prompt) };
  }

  override async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ kind: "start", prompt, opts });
    return { threadId: "hermes-thread-1", finalResponse: this.responseFor(prompt) };
  }

  private responseFor(prompt: string): string {
    const invocationId = prompt.match(/"invocationId": "([0-9a-f]{64})"/u)?.[1];
    return invocationId
      ? this.response.replace("<wakewire-invocation-id>", invocationId)
      : this.response;
  }
}

function specialistProofResponse(
  reviewKey: string,
  headSha: string,
  status: "PASS" | "REPAIR" | "ESCALATE" = "PASS",
): string {
  return [
    "review complete",
    "<!-- wakewire-specialist-proof:v1",
    JSON.stringify(
      {
        reviewKey,
        headSha,
        invocationId: "<wakewire-invocation-id>",
        digest: "b".repeat(64),
        status,
      },
      null,
      2,
    ),
    "-->",
  ].join("\n");
}

class FailingTitleDesktop extends FakeDesktop {
  titleAttempts = 0;

  override async setThreadTitle(): Promise<void> {
    this.titleAttempts++;
    throw new Error("metadata app-server unavailable");
  }
}

class DeferredNewDesktop implements AgentAdapter {
  readonly name = "codex-desktop";
  readonly interrupts: string[] = [];
  readonly creationStarted: Promise<void>;
  private signalCreationStarted: () => void = () => {};
  private releaseCreation: () => void = () => {};
  private readonly creationReleased: Promise<void>;

  constructor() {
    this.creationStarted = new Promise((resolve) => {
      this.signalCreationStarted = resolve;
    });
    this.creationReleased = new Promise((resolve) => {
      this.releaseCreation = resolve;
    });
  }

  finishCreation(): void {
    this.releaseCreation();
  }

  async deliverToThread(): Promise<DeliveryResult> {
    throw new Error("unexpected existing task");
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.signalCreationStarted();
    await this.creationReleased;
    return fakeDesktopResult("desktop-thread-created-during-stop", prompt, opts);
  }

  async interruptThread(threadId: string): Promise<{ threadId: string }> {
    this.interrupts.push(threadId);
    return { threadId };
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

class BoundedDeferredDesktop implements AgentAdapter {
  readonly name: string = "codex-desktop";
  readonly calls: Array<{
    kind: "start" | "resume";
    prompt: string;
    threadId?: string;
  }> = [];
  inFlight = 0;
  maxInFlight = 0;
  private releases: Array<() => void> = [];

  releaseAll(): void {
    for (const release of this.releases.splice(0)) release();
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    await this.defer({ kind: "resume", prompt, threadId });
    return fakeDesktopResult(threadId, prompt, opts);
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const ordinal = this.calls.length + 1;
    await this.defer({ kind: "start", prompt });
    return fakeDesktopResult(`desktop-thread-${ordinal}`, prompt, opts);
  }

  async probe(): Promise<boolean> {
    return true;
  }

  private async defer(call: {
    kind: "start" | "resume";
    prompt: string;
    threadId?: string;
  }): Promise<void> {
    this.calls.push(call);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise<void>((resolve) => this.releases.push(resolve));
    this.inFlight--;
  }
}

class BoundedDeferredHermes extends BoundedDeferredDesktop {
  override readonly name = "hermes";
}

function fakeDesktopResult(
  threadId: string,
  prompt: string,
  opts: DeliveryOptions,
): DeliveryResult {
  return {
    threadId,
    correlationMarker: desktopCorrelationMarker({
      prompt,
      cwd: opts.cwd ?? process.cwd(),
      idempotencyKey: opts.idempotencyKey,
    }),
  };
}

function slackEvent(text: string, deliveryId = "Ev1"): WakeEvent {
  const ts = deliveryId === "Ev1" ? "1.0" : "2.0";
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId,
    occurredAt: "2026-07-27T00:00:00.000Z",
    summary: "CJ mentioned Chip",
    payload: {
      team: "T1",
      channel: "C1",
      channelType: "channel",
      user: "U-CJ",
      recipientUser: "UCHIP",
      ts,
      text,
    },
    principal: {
      provider: "slack",
      tenantId: "T1",
      subjectId: "U-CJ",
      displayName: "CJ Lazell",
    },
    conversation: {
      nativeKey: `T1:C1:${ts}`,
      rootKey: `T1:C1:${ts}`,
      replyTarget: `C1:${ts}`,
    },
    targetMentions: [{ kind: "slack-user", value: "UCHIP" }],
  };
}

function githubReviewRequestedEvent(deliveryId = "gh-rr-1"): WakeEvent {
  return {
    source: "github",
    sourceId: "github-snapnhd-system",
    kind: "pull_request.review_requested",
    deliveryId,
    occurredAt: "2026-08-20T19:02:42.000Z",
    summary: "cswoods6 requested review from chipbyte-snap",
    payload: {
      repo: "snapnhd/system",
      repositoryId: 981891254,
      number: 1097,
      action: "review_requested",
      author: "cswoods6",
      senderLogin: "cswoods6",
      senderId: 42786886,
    },
    principal: {
      provider: "github",
      tenantId: "github.com",
      subjectId: "42786886",
      handle: "cswoods6",
      displayName: "cswoods6",
    },
    conversation: {
      nativeKey: "snapnhd/system:1097",
      rootKey: "snapnhd/system:1097",
      replyTarget: "snapnhd/system:1097",
    },
    targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
  };
}

function githubPrCommentEvent(deliveryId = "gh-pr-comment-1"): WakeEvent {
  const event = githubReviewRequestedEvent(deliveryId);
  event.kind = "issue_comment.created";
  event.summary = "Comment created on snapnhd/system#1058";
  event.payload = {
    repo: "snapnhd/system",
    repositoryId: 981891254,
    number: 1058,
    title: "feat(fraud): canonicalize participant role keys to uppercase (FRA-2889)",
    body: "@chipbyte-snap rereview",
    isPullRequest: true,
    pullRequestAuthorLogin: "cswoods6",
    commentId: 5375264387,
    senderLogin: "cswoods6",
    senderId: 42786886,
  };
  event.conversation = {
    nativeKey: "981891254:1058:comment:5375264387",
    rootKey: "981891254:1058",
    replyTarget: "981891254:comment:5375264387",
  };
  return event;
}

function fakeResolvedSnapWorkspace(ticket: string, headSha = "f".repeat(40)) {
  const normalized = ticket.toLowerCase();
  return {
    ticket: normalized,
    cwd: `/Users/chip/Snap/workspaces/${normalized}`,
    headSha,
    urls: {
      app: `https://${normalized}.ws.chipbyte.dev`,
      data: `https://data-${normalized}.ws.chipbyte.dev`,
      snapcorp: `https://snapcorp-${normalized}.ws.chipbyte.dev`,
    },
  };
}

function passingSnapReviewPreflight(headSha = "f".repeat(40)) {
  return {
    headSha,
    passed: true,
    suites: {
      app: "passed" as const,
      data: "passed" as const,
      snapcorp: "passed" as const,
      windmill: "passed" as const,
    },
    diagnosticTail: "All test suites passed!",
  };
}

function slackThreadEvent(text: string, deliveryId: string, rootTs: string): WakeEvent {
  const event = slackEvent(text, deliveryId);
  event.payload.ts = deliveryId;
  if (deliveryId !== rootTs) event.payload.threadTs = rootTs;
  event.conversation = {
    nativeKey: `T1:C1:${deliveryId}`,
    rootKey: `T1:C1:${rootTs}`,
    replyTarget: `C1:${deliveryId}`,
  };
  return event;
}

function slackDirectMessage(text: string, deliveryId = "Ev-DM"): WakeEvent {
  return {
    source: "slack",
    sourceId: "slack-snap",
    kind: "message",
    deliveryId,
    occurredAt: "2026-07-27T00:00:00.000Z",
    summary: "Slack PM from CJ",
    payload: {
      team: "T1",
      channel: "D-CJ-CHIP",
      channelType: "im",
      user: "U-CJ",
      recipientUser: "UCHIP",
      ts: "3.0",
      text,
    },
    principal: {
      provider: "slack",
      tenantId: "T1",
      subjectId: "U-CJ",
      displayName: "CJ Lazell",
    },
    conversation: {
      nativeKey: "T1:D-CJ-CHIP:3.0",
      rootKey: "T1:D-CJ-CHIP:3.0",
      replyTarget: "D-CJ-CHIP:3.0",
    },
    targetMentions: [{ kind: "direct-message", value: "UCHIP" }],
  };
}

function linearStopEvent(deliveryId = "stop-1"): WakeEvent {
  return {
    source: "webhook",
    sourceId: "linear",
    kind: "AgentSessionEvent.prompted",
    deliveryId,
    occurredAt: "2026-07-27T00:00:00.000Z",
    summary: "CJ stopped Chip on ENG-4610",
    payload: {
      provider: "linear",
      action: "prompted",
      appUserId: "chip-app-user",
      agentSessionId: "session-1",
      agentSignal: "stop",
      organizationId: "org-1",
      issueId: "issue-1",
      identifier: "ENG-4610",
    },
    principal: {
      provider: "linear",
      tenantId: "org-1",
      subjectId: "cj-linear",
    },
    conversation: {
      nativeKey: `session-1:activity:${deliveryId}`,
      rootKey: "org-1:issue-1",
      replyTarget: "session-1",
    },
    targetMentions: [{ kind: "agent-session", value: "chip-app-user" }],
  };
}

function linearPromptEvent(deliveryId = "linear-prompt-1"): WakeEvent {
  const event = linearStopEvent(deliveryId);
  event.kind = "AgentSessionEvent.created";
  event.summary = "CJ mentioned Chip on ENG-4610";
  delete event.payload.agentSignal;
  event.payload.action = "created";
  event.payload.body = "@Chip Byte handle this";
  event.payload.branchName = "eng-4610-fix-it";
  return event;
}

function gmailEvent(subject: string, body = "@Chip Please take care of this"): WakeEvent {
  return {
    source: "gmail",
    sourceId: "gmail-chip",
    kind: "email",
    deliveryId: "<message-1@example.com>",
    occurredAt: "2026-07-27T00:00:00.000Z",
    summary: `Email from CJ: ${subject}`,
    payload: {
      fromEmail: "cj@snapcorp.com",
      subject,
      body,
      authoredBody: body,
      authenticated: true,
      rfcMessageId: "<message-1@example.com>",
    },
    principal: {
      provider: "gmail",
      tenantId: "chip@snapcorp.com",
      subjectId: "cj@snapcorp.com",
      email: "cj@snapcorp.com",
    },
    conversation: {
      nativeKey: "<message-1@example.com>",
      rootKey: "<message-1@example.com>",
      replyTarget: "<message-1@example.com>",
    },
    targetMentions: [
      { kind: "email", value: "chip@snapcorp.com" },
      { kind: "handle", value: "chip" },
    ],
  };
}

describe("AgentCoordinator", () => {
  it("silently rejects an unenrolled principal and persists an authorized request", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    expect(coordinator.accept(slackEvent("<@UCHIP> do it"))).toMatchObject({
      addressed: true,
      accepted: false,
      reason: "principal-not-enrolled",
    });
    expect(requests.listAcksReady()).toHaveLength(0);

    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
      displayName: "CJ Lazell",
    });
    const accepted = coordinator.accept(slackEvent("<@UCHIP> do it"));
    expect(accepted).toMatchObject({ addressed: true, accepted: true, duplicate: false });
    expect(requests.listAcksReady()).toHaveLength(0);
    expect(requests.listReady()).toHaveLength(1);
    expect(coordinator.accept(slackEvent("<@UCHIP> do it"))).toMatchObject({ duplicate: true });
  });

  it("accepts synchronize for an enrolled PR work item after Chip is no longer requested", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const zack = people.add({ nickname: "Zack", roleName: "owner" });
    people.attachIdentity({
      personId: zack.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "17470",
      handle: "zadams",
    });
    const synchronize = (deliveryId: string, payload: Record<string, unknown> = {}): WakeEvent => ({
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request.synchronize",
      deliveryId,
      occurredAt: "2026-09-02T14:00:00.000Z",
      summary: "PR #1124 synchronized on snapnhd/system",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1124,
        isPullRequest: true,
        author: "zadams",
        requestedReviewerLogins: [],
        headSha: "1234567890abcdef1234567890abcdef12345678",
        ...payload,
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17470",
        handle: "zadams",
      },
      conversation: {
        nativeKey: "101:1124",
        rootKey: "101:1124",
        replyTarget: "101:1124",
      },
    });

    expect(coordinator.accept(synchronize("sync-without-work-item"))).toMatchObject({
      addressed: false,
      accepted: false,
    });

    const item = work.getOrCreate({
      kind: "github",
      key: "github:101:pull-request:1124",
      title: "GitHub PR snapnhd/system#1124",
    });
    work.attachAlias(item.id, {
      provider: "correlation",
      scope: "github",
      nativeKey: "github:101:pull-request:1124",
    });

    expect(coordinator.accept(synchronize("sync-with-work-item"))).toMatchObject({
      addressed: true,
      accepted: true,
    });
    expect(
      coordinator.accept(synchronize("sync-chip-authored", { author: "chipbyte-snap" })),
    ).toMatchObject({ addressed: false, accepted: false });
    expect(
      coordinator.accept(synchronize("sync-closed", { state: "closed" })),
    ).toMatchObject({ addressed: false, accepted: false });
    expect(coordinator.accept(synchronize("sync-merged", { merged: true }))).toMatchObject({
      addressed: false,
      accepted: false,
    });
  });

  it("debounces synchronize bursts per PR using the latest head", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    let now = new Date("2026-09-02T14:00:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => now,
      sinkAdapterName: "hermes",
    });
    const zack = people.add({ nickname: "Zack", roleName: "owner" });
    people.attachIdentity({
      personId: zack.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "17470",
      handle: "zadams",
    });
    const item = work.getOrCreate({
      kind: "github",
      key: "github:101:pull-request:1124",
      title: "GitHub PR snapnhd/system#1124",
    });
    work.attachAlias(item.id, {
      provider: "correlation",
      scope: "github",
      nativeKey: "github:101:pull-request:1124",
    });
    const synchronize = (deliveryId: string, headSha: string): WakeEvent => ({
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request.synchronize",
      deliveryId,
      occurredAt: now.toISOString(),
      summary: "PR #1124 synchronized on snapnhd/system",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1124,
        isPullRequest: true,
        author: "zadams",
        requestedReviewerLogins: [],
        headSha,
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17470",
        handle: "zadams",
      },
      conversation: {
        nativeKey: "101:1124",
        rootKey: "101:1124",
        replyTarget: "101:1124",
      },
    });
    const firstHead = "1234567890abcdef1234567890abcdef12345678";
    const latestHead = "abcdef1234567890abcdef1234567890abcdef12";

    const first = coordinator.accept(synchronize("sync-burst-1", firstHead));
    now = new Date("2026-09-02T14:00:10.000Z");
    const latest = coordinator.accept(synchronize("sync-burst-2", latestHead));

    expect(first).toMatchObject({ addressed: true, accepted: true, duplicate: false });
    expect(latest).toMatchObject({ addressed: true, accepted: true, duplicate: true });
    expect(latest.requestId).toBe(first.requestId);
    expect(requests.get(first.requestId ?? "")).toMatchObject({
      coalesceKey: "github-pr-head-move:101#1124",
      nextAttemptAt: "2026-09-02T14:00:40.000Z",
      event: { payload: { headSha: latestHead } },
    });
    expect(requests.listReady("2026-09-02T14:00:39.999Z")).toEqual([]);
    expect(requests.listReady("2026-09-02T14:00:40.000Z")).toHaveLength(1);
  });

  it("skips a synchronize already covered by Chip and resumes an uncovered requested head", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const zack = people.add({ nickname: "Zack", roleName: "pr" });
    people.attachIdentity({
      personId: zack.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "17470",
      handle: "zadams",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    let now = new Date("2026-09-02T14:00:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => now,
      sinkAdapterName: "hermes",
    });
    const item = work.getOrCreate({
      kind: "github",
      key: "github:101:pull-request:1124",
      title: "GitHub PR snapnhd/system#1124",
    });
    work.attachAlias(item.id, {
      provider: "correlation",
      scope: "github",
      nativeKey: "github:101:pull-request:1124",
    });
    work.setCodexThread(item.id, "wakewire-pr-1124");
    work.setWorkspace(item.id, "/Users/chip/Snap");
    const headSha = "1234567890abcdef1234567890abcdef12345678";
    const synchronize = (deliveryId: string, requested: boolean): WakeEvent => ({
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request.synchronize",
      deliveryId,
      occurredAt: "2026-09-02T14:00:00.000Z",
      summary: "PR #1124 synchronized on snapnhd/system",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1124,
        isPullRequest: true,
        author: "zadams",
        requestedReviewerLogins: requested ? ["chipbyte-snap"] : [],
        headSha,
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17470",
        handle: "zadams",
      },
      conversation: {
        nativeKey: "101:1124",
        rootKey: "101:1124",
        replyTarget: "101:1124",
      },
    });
    let reviewEvidence: null | {
      lastChipReviewSha: string;
      lastChipReviewState: string;
      lastChipReviewBody: string;
    } = {
      lastChipReviewSha: headSha,
      lastChipReviewState: "APPROVED",
      lastChipReviewBody: "",
    };
    const hermes = new FakeHermes();
    const reviewCommitLookup = vi.fn(async () => reviewEvidence);
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        now: () => now,
        reviewCommitLookup,
        hermesSessionLookup: () => ({ hits: [], runningIds: new Set(), cmdlineBusy: false }),
      },
    );

    const covered = coordinator.accept(synchronize("sync-covered", false));
    now = new Date(now.getTime() + 31_000);
    await worker.tick();
    expect(reviewCommitLookup).toHaveBeenCalledTimes(1);
    expect(hermes.calls).toHaveLength(0);
    expect(requests.get(covered.requestId ?? "")?.status).toBe("completed");

    reviewEvidence = {
      lastChipReviewSha: headSha,
      lastChipReviewState: "COMMENTED",
      lastChipReviewBody:
        "Exact-head local verification did not produce a retrievable aggregate result.",
    };
    const processMiss = coordinator.accept(synchronize("sync-process-miss", true));
    now = new Date(now.getTime() + 31_000);
    await worker.tick();
    expect(hermes.calls).toEqual([
      expect.objectContaining({ kind: "resume", threadId: "wakewire-pr-1124" }),
    ]);

    reviewEvidence = null;
    const unrequested = coordinator.accept(synchronize("sync-no-review", false));
    now = new Date(now.getTime() + 31_000);
    await worker.tick();
    expect(hermes.calls).toHaveLength(1);
    expect(requests.get(unrequested.requestId ?? "")?.status).toBe("completed");
  });

  it("debounces unmentioned enrolled feedback on a Chip-authored pull request", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    let now = new Date("2026-08-25T15:27:32.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => now,
      sinkAdapterName: "hermes",
    });
    const feedback = (
      deliveryId: string,
      commentId: number,
      repo = "snapnhd/system",
    ): WakeEvent => ({
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request_review_comment.created",
      deliveryId,
      occurredAt: now.toISOString(),
      summary: "Review feedback on snapnhd/system#1117",
      payload: {
        repo,
        repositoryId: 101,
        number: 1117,
        isPullRequest: true,
        pullRequestAuthorLogin: "chipbyte-snap",
        senderAuthoredFeedback: true,
        senderType: "User",
        senderLogin: "zadams",
        commentId,
        body: "Unmentioned inline feedback",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17470",
        handle: "zadams",
      },
      conversation: {
        nativeKey: `101:1117:comment:${commentId}`,
        rootKey: "101:1117",
        replyTarget: `101:comment:${commentId}`,
      },
    });

    expect(coordinator.accept(feedback("review-comment-1", 501))).toMatchObject({
      addressed: true,
      accepted: false,
      reason: "principal-not-enrolled",
    });

    const zack = people.add({ nickname: "Zack", roleName: "owner" });
    people.attachIdentity({
      personId: zack.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "17470",
      handle: "zadams",
    });
    const first = coordinator.accept(feedback("review-comment-1", 501));
    now = new Date("2026-08-25T15:27:45.000Z");
    const second = coordinator.accept(feedback("review-comment-2", 502, "snapnhd/renamed-system"));

    expect(first).toMatchObject({ addressed: true, accepted: true, duplicate: false });
    expect(second).toMatchObject({ addressed: true, accepted: true, duplicate: true });
    expect(second.requestId).toBe(first.requestId);
    expect(requests.get(first.requestId ?? "")).toMatchObject({
      coalesceKey: "github-maintained-pr-feedback:101#1117",
      nextAttemptAt: "2026-08-25T15:28:15.000Z",
      executionProfile: { reasoningEffort: "high" },
    });
    expect(requests.listReady("2026-08-25T15:28:14.999Z")).toEqual([]);
    expect(requests.listReady("2026-08-25T15:28:15.000Z")).toHaveLength(1);
    expect(requests.get(first.requestId ?? "")?.requestText).toContain(
      "fetch every unresolved review thread and top-level comment",
    );
  });

  it("debounces unmentioned review-thread replies on a PR Chip already joined", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    let now = new Date("2026-09-01T18:22:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => now,
      sinkAdapterName: "hermes",
    });
    const misael = people.add({ nickname: "Misael", roleName: "owner" });
    people.attachIdentity({
      personId: misael.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "17471",
      handle: "misaelsnap",
    });

    const reviewRequested: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request.review_requested",
      deliveryId: "gh-rr-1140",
      occurredAt: now.toISOString(),
      summary: "Review requested from chipbyte-snap",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1140,
        isPullRequest: true,
        senderType: "User",
        senderLogin: "misaelsnap",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17471",
        handle: "misaelsnap",
      },
      conversation: {
        nativeKey: "101:1140",
        rootKey: "101:1140",
        replyTarget: "101:1140",
      },
      targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
    };
    expect(coordinator.accept(reviewRequested)).toMatchObject({
      addressed: true,
      accepted: true,
    });

    const reply = (deliveryId: string, commentId: number, inReplyToId: number): WakeEvent => ({
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request_review_comment.created",
      deliveryId,
      occurredAt: now.toISOString(),
      summary: "Review comment on snapnhd/system#1140",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1140,
        isPullRequest: true,
        pullRequestAuthorLogin: "misaelsnap",
        senderAuthoredFeedback: true,
        senderType: "User",
        senderLogin: "misaelsnap",
        commentId,
        inReplyToId,
        body: "Taking you up on the rescope path.",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17471",
        handle: "misaelsnap",
      },
      conversation: {
        nativeKey: `101:1140:comment:${commentId}`,
        rootKey: "101:1140",
        replyTarget: `101:comment:${commentId}`,
      },
    });

    const first = coordinator.accept(reply("thread-1", 3907066898, 3904845832));
    now = new Date("2026-09-01T18:22:02.000Z");
    const second = coordinator.accept(reply("thread-2", 3907067264, 3904845853));
    expect(first).toMatchObject({ addressed: true, accepted: true, duplicate: false });
    expect(second).toMatchObject({ addressed: true, accepted: true, duplicate: true });
    expect(second.requestId).toBe(first.requestId);
    expect(requests.get(first.requestId ?? "")).toMatchObject({
      coalesceKey: "github-review-thread-reply:101#1140",
      nextAttemptAt: "2026-09-01T18:22:32.000Z",
    });
    expect(requests.get(first.requestId ?? "")?.requestText).toContain("without mentioning Chip");
  });

  it("ignores unmentioned review-thread replies on PRs Chip has never joined", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const misael = people.add({ nickname: "Misael", roleName: "owner" });
    people.attachIdentity({
      personId: misael.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "17471",
      handle: "misaelsnap",
    });
    const reply: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request_review_comment.created",
      deliveryId: "thread-orphan",
      occurredAt: "2026-09-01T18:22:00.000Z",
      summary: "Review comment on snapnhd/system#9999",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 9999,
        isPullRequest: true,
        pullRequestAuthorLogin: "misaelsnap",
        senderAuthoredFeedback: true,
        senderType: "User",
        commentId: 1,
        inReplyToId: 2,
        body: "please look",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "17471",
        handle: "misaelsnap",
      },
      conversation: {
        nativeKey: "101:9999:comment:1",
        rootKey: "101:9999",
        replyTarget: "101:comment:1",
      },
    };
    expect(coordinator.accept(reply)).toMatchObject({ addressed: false, accepted: false });
    expect(requests.listReady()).toHaveLength(0);
  });

  it("accepts an empty APPROVED review on a Chip-authored pull request", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const approval: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request_review.submitted",
      deliveryId: "gh-empty-approval-1158",
      occurredAt: "2026-09-01T13:21:10.000Z",
      summary: "Review submitted on snapnhd/system#1158",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1158,
        isPullRequest: true,
        pullRequestAuthorLogin: "chipbyte-snap",
        senderAuthoredFeedback: false,
        senderType: "User",
        senderLogin: "cj",
        body: "",
        reviewState: "approved",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "1819",
        handle: "cj",
      },
      conversation: {
        nativeKey: "101:1158",
        rootKey: "101:1158",
        replyTarget: "101:1158",
      },
    };

    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "1819",
      handle: "cj",
    });
    const accepted = coordinator.accept(approval);
    expect(accepted).toMatchObject({ addressed: true, accepted: true, duplicate: false });
    expect(requests.get(accepted.requestId ?? "")).toMatchObject({
      coalesceKey: "github-maintained-pr-feedback:101#1158",
    });
    expect(requests.get(accepted.requestId ?? "")?.requestText).toContain(
      "approved Chip-authored PR snapnhd/system#1158 with no review text",
    );
  });

  it("accepts an enrolled one-to-one Slack PM without queuing an ingress reaction", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, new WorkItemStore(db), requests);

    expect(coordinator.accept(slackDirectMessage("please handle this"))).toMatchObject({
      addressed: true,
      accepted: true,
      duplicate: false,
    });
    expect(requests.listAcksReady()).toEqual([]);
    expect(requests.listReady()[0]?.requestText).toBe("please handle this");
  });

  it("uses at least high reasoning for GitHub PR follow-ups", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const event = githubPrCommentEvent("github-pr-high-reasoning");
    event.payload.repo = "other/repository";
    event.payload.body =
      "> This dispatch remained fixed to low reasoning despite the high-reasoning request.\n\n@chipbyte-snap Why did this happen? Please fix it so it doesn't happen again. And run this PR with the fix";

    const accepted = coordinator.accept(event);

    expect(requests.get(accepted.requestId ?? "")?.executionProfile).toMatchObject({
      reasoningEffort: "high",
      source: "default",
    });

    const hermes = new FakeHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
    );
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.opts).toMatchObject({ reasoningEffort: "high" });
    expect(hermes.calls[0]?.prompt).toContain('"reasoningEffort": "high"');
    expect(hermes.calls[0]?.prompt).not.toContain("WAKEWIRE SEPARATE TASK ORCHESTRATION");
  });

  it("resumes a maintained PR session without preparing its already-running workspace", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cj",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const acceptedAt = new Date("2026-08-30T06:00:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => acceptedAt,
      sinkAdapterName: "hermes",
    });
    const event = githubPrCommentEvent("github-maintained-pr-resume");
    event.kind = "pull_request_review_comment.created";
    event.summary = "Review feedback on snapnhd/system#1150";
    event.payload = {
      ...event.payload,
      number: 1150,
      title: "Scope Neon credentials to trusted provisioning (ENG-4711)",
      body: 'This should be "system development"',
      pullRequestAuthorLogin: "chipbyte-snap",
      senderAuthoredFeedback: true,
      senderType: "User",
      senderLogin: "cj",
      commentId: 3888115312,
    };
    event.conversation = {
      nativeKey: "981891254:1150:comment:3888115312",
      rootKey: "981891254:1150",
      replyTarget: "981891254:comment:3888115312",
    };

    const accepted = coordinator.accept(event);
    const request = requests.get(accepted.requestId ?? "");
    if (!request) throw new Error("accepted request missing");
    work.setCodexThread(request.workItemId, "existing-pr-1150-session");
    work.setWorkspace(request.workItemId, "/Users/chip/Snap/workspaces/eng-4711");
    const resolveWorkspace = vi.fn(async () => {
      throw new Error("an existing PR session must not reprovision its workspace");
    });
    const hermes = new FakeHermes();
    const issue = {
      organizationId: "org-1",
      issueId: "issue-4711",
      identifier: "ENG-4711",
      title: "Scope Neon credentials to trusted provisioning",
      branchName: "eng-4711",
    };
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => issue,
        issuesForUrl: async () => [issue],
      },
      hermes,
      pino({ level: "silent" }),
      {
        now: () => new Date(acceptedAt.getTime() + 31_000),
        resolveWorkspace,
        hermesSessionLookup: () => ({ hits: [], runningIds: new Set(), cmdlineBusy: false }),
      },
    );

    await worker.tick();

    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(hermes.calls).toEqual([
      expect.objectContaining({ kind: "resume", threadId: "existing-pr-1150-session" }),
    ]);
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap/workspaces/eng-4711");
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("submitted");
  });

  it("authorizes a formal review after an author replies to a review thread", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const zack = people.add({ nickname: "Zack", roleName: "owner" });
    people.attachIdentity({
      personId: zack.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const event = githubPrCommentEvent("github-review-thread-fixed");
    event.payload.repo = "other/repository";
    event.kind = "pull_request_review_comment.created";
    event.payload.pullRequestAuthorLogin = "zadams";
    event.payload.senderAuthoredFeedback = true;
    event.payload.senderType = "User";
    event.payload.body = "@chipbyte-snap Fixed in a706e360c.";

    expect(coordinator.accept(event)).toMatchObject({ addressed: true, accepted: true });

    const hermes = new FakeHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
    );
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.prompt).toContain("authorizes one full review");
    expect(hermes.calls[0]?.prompt).not.toContain(
      "Do not use Slack, Gmail, Linear, GitHub, email, browser, or other connector tools",
    );
  });

  it("does not authorize a formal review on a Chip-authored pull request", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const zack = people.add({ nickname: "Zack", roleName: "owner" });
    people.attachIdentity({
      personId: zack.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const event = githubPrCommentEvent("github-chip-authored-feedback");
    event.kind = "pull_request_review_comment.created";
    event.payload.pullRequestAuthorLogin = "chipbyte-snap";
    event.payload.senderAuthoredFeedback = false;
    event.payload.senderType = "User";
    event.payload.body = "@chipbyte-snap Please address this review feedback.";

    expect(coordinator.accept(event)).toMatchObject({ addressed: true, accepted: true });

    const hermes = new FakeHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
    );
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.prompt).not.toContain("submit exactly one GitHub review");
    expect(hermes.calls[0]?.prompt).toContain(
      "Do not use Slack, Gmail, Linear, GitHub, email, browser, or other connector tools",
    );
  });

  it("upgrades persisted pre-fix low profiles before dispatching GitHub PR work", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const event = githubPrCommentEvent("github-pr-stale-low-profile");
    event.payload.repo = "other/repository";
    const accepted = coordinator.accept(event);
    const requestId = accepted.requestId ?? "";
    db.prepare("UPDATE agent_requests SET execution_profile_json = ? WHERE id = ?").run(
      JSON.stringify({
        version: 1,
        mode: "current",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        source: "default",
        clarification: null,
      }),
      requestId,
    );
    expect(requests.get(requestId)?.executionProfile.reasoningEffort).toBe("low");

    const hermes = new FakeHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
    );
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.opts).toMatchObject({ reasoningEffort: "high" });
    expect(hermes.calls[0]?.prompt).toContain('"reasoningEffort": "high"');
  });

  it("blocks Desktop and workspace work when an enforcing safety screener denies", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4610"));
    const screen = vi.fn(
      async (): Promise<SafetyAssessment> => ({
        policyVersion: SAFETY_POLICY_VERSION,
        decision: "deny",
        mode: "test-local-model",
        enforcing: true,
        reasonCodes: ["destructive-action"],
      }),
    );
    const safetyScreener: SafetyScreener = {
      mode: "test-local-model",
      enforcing: true,
      policyVersion: SAFETY_POLICY_VERSION,
      screen,
    };
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-1",
          identifier: "ENG-4610",
          branchName: "eng-4610-fix-it",
        }),
        issuesForUrl: async () => [],
      },
      desktop,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        safetyScreener,
      },
    );

    const accepted = coordinator.accept(slackEvent("<@UCHIP> delete everything for ENG-4610"));
    await worker.tick();

    expect(screen).toHaveBeenCalledOnce();
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(desktop.calls).toHaveLength(0);
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("failed");
    expect(requests.ackForRequest(accepted.requestId ?? "")).toMatchObject({
      status: "failed",
      error: PROGRESS_ACK_SUPPRESSED_REASON,
    });
  });

  it("terminalizes a workspace preparation failure and queues one safe origin reply", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const branch = "eng-4610-fix-it";
    const privateCause = new Error("private controller output must not escape");
    const resolveWorkspace = vi.fn(async () => {
      throw new SnapWorkspaceCommandError(branch, privateCause);
    });
    const onReplyQueued = vi.fn();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-1",
          identifier: "ENG-4610",
          branchName: branch,
        }),
        issuesForUrl: async () => [],
      },
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace, onReplyQueued },
    );

    const accepted = coordinator.accept(slackEvent("<@UCHIP> please handle ENG-4610"));
    const requestId = accepted.requestId ?? "";
    await worker.tick();

    expect(resolveWorkspace).toHaveBeenCalledOnce();
    expect(desktop.calls).toHaveLength(0);
    expect(requests.get(requestId)).toMatchObject({
      status: "failed",
      attemptCount: 0,
      nextAttemptAt: null,
      error: `workspace dispatcher could not prepare ${branch}`,
      codexThreadId: null,
      codexTurnId: null,
      correlationMarker: null,
    });
    expect(requests.get(requestId)?.error).not.toContain(privateCause.message);
    expect(requests.ackForRequest(requestId)).toMatchObject({
      status: "failed",
      error: PROGRESS_ACK_SUPPRESSED_REASON,
    });
    expect(requests.sourceReplyForRequest(requestId)).toMatchObject({
      requestOutcome: "failed",
      provider: "slack",
      replyKind: "thread-reply",
      destination: "T1:C1:1.0",
      status: "pending",
      payload: {
        channel: "C1",
        threadTs: "1.0",
        text:
          "I couldn't start this request because its Snap workspace could not be prepared. " +
          `No agent task was started. WakeWire request: ${requestId}. ` +
          "Fix the local Snap controller environment, then send the request again.",
      },
    });
    expect(JSON.stringify(requests.sourceReplyForRequest(requestId))).not.toContain(
      privateCause.message,
    );
    expect(onReplyQueued).toHaveBeenCalledOnce();

    await worker.tick();
    expect(resolveWorkspace).toHaveBeenCalledOnce();
  });

  it("durably schedules the exact provider acknowledgment ten seconds after acceptance", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const acceptedAt = new Date("2026-07-28T12:00:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => acceptedAt,
    });
    const desktop = new FakeDesktop();
    let requestId = "";
    const resolveWorkspace = vi.fn(async () => {
      expect(requests.ackForRequest(requestId)).toMatchObject({ status: "pending" });
      return fakeResolvedSnapWorkspace("ENG-4610");
    });
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-1",
          identifier: "ENG-4610",
          branchName: "eng-4610-fix-it",
        }),
        issuesForUrl: async () => [],
      },
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    const accepted = coordinator.accept(slackEvent("<@UCHIP> please handle ENG-4610"));
    requestId = accepted.requestId ?? "";
    expect(requests.ackForRequest(requestId)).toMatchObject({
      provider: "slack",
      ackKind: "eyes-reaction",
      destination: "C1:1.0",
      status: "pending",
      nextAttemptAt: "2026-07-28T12:00:10.000Z",
      payload: { channel: "C1", timestamp: "1.0", reaction: "eyes" },
    });
    expect(requests.listAcksReady("2026-07-28T12:00:09.999Z")).toEqual([]);

    await worker.tick();

    expect(resolveWorkspace).toHaveBeenCalledOnce();
    expect(requests.listAcksReady("2026-07-28T12:00:10.000Z")).toHaveLength(1);
    expect(desktop.calls).toHaveLength(1);
  });

  it("continues dispatch while a Slack PM acknowledgment waits for its deadline", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
    );

    const accepted = coordinator.accept(slackDirectMessage("please handle this"));
    await worker.tick();

    expect(requests.ackForRequest(accepted.requestId ?? "")).toMatchObject({
      status: "pending",
      provider: "slack",
      ackKind: "eyes-reaction",
    });
    expect(requests.listAcksReady()).toEqual([]);
    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]?.prompt).toContain(`WakeWire request ID: ${accepted.requestId ?? ""}`);
    expect(desktop.calls[0]?.prompt).toContain('"displayTitle": "Slack — handle this"');
    expect(desktop.calls[0]?.prompt).toContain('"taskDescription": "Slack — handle this"');
    expect(desktop.titles).toEqual([
      { threadId: "desktop-thread-1", title: "Slack — handle this" },
    ]);
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("submitted");
  });

  it("durably stages an inline adapter result for exactly-once provider delivery", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const adapter = new FakeImmediateAdapter();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      adapter,
      pino({ level: "silent" }),
    );

    const accepted = coordinator.accept(slackDirectMessage("please handle this"));
    await worker.tick();

    expect(adapter.calls).toHaveLength(1);
    expect(requests.get(accepted.requestId ?? "")).toMatchObject({
      status: "submitted",
      codexThreadId: "thread-immediate",
      codexTurnId: "turn-immediate",
      correlationMarker: `wakewire:immediate:v1:${accepted.requestId ?? ""}`,
    });
    expect(requests.sourceReplyForRequest(accepted.requestId ?? "")).toMatchObject({
      provider: "slack",
      replyKind: "thread-reply",
      destination: "T1:D-CJ-CHIP:3.0",
      status: "pending",
      payload: {
        channel: "D-CJ-CHIP",
        threadTs: "3.0",
        text: "Done immediately",
      },
    });
    expect(requests.listSubmittedAwaitingCompletion()).toEqual([]);

    await worker.tick();
    expect(adapter.calls).toHaveLength(1);
  });

  it("freezes per-request profiles, resets defaults, and coordinates separate tasks", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
    );

    const first = coordinator.accept(
      slackDirectMessage("model: Terra; effort: high; investigate this", "profile-1"),
    );
    expect(requests.get(first.requestId ?? "")?.executionProfile).toMatchObject({
      mode: "current",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      source: "explicit",
    });
    await worker.tick();

    // The host creates empty parent/child tasks, then sends only the child work
    // with the exact requested profile through Desktop IPC.
    expect(desktop.prepared).toHaveLength(2);
    expect(desktop.prepared[0]?.opts).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
    expect(desktop.prepared[1]?.opts).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
    expect(desktop.calls[0]?.opts).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
    expect(desktop.calls[0]?.prompt).toContain(
      "WAKEWIRE HOST-CONTROLLED CHILD TASK - OPERATOR CONTROLLED",
    );
    expect(requests.orchestrationForRequest(first.requestId ?? "")).toMatchObject({
      stage: "child_submitted",
      parentThreadId: "prepared-thread-1",
      childThreadId: "prepared-thread-2",
    });

    const ultracode = coordinator.accept(
      slackDirectMessage("uLtRaCoDe inspect one more thing", "profile-2"),
    );
    expect(requests.get(ultracode.requestId ?? "")?.executionProfile).toMatchObject({
      mode: "current",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      source: "ultracode",
    });
    await worker.tick();
    expect(desktop.calls[1]?.opts).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    expect(desktop.calls[1]?.prompt).not.toContain("WAKEWIRE SEPARATE TASK ORCHESTRATION");

    coordinator.accept(slackDirectMessage("summarize where this stands", "profile-3"));
    await worker.tick();
    expect(desktop.calls[2]?.opts).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });

    const separate = coordinator.accept(
      slackDirectMessage(
        "Please use a seperate chat; model: Terra; effort: max; investigate independently",
        "profile-4",
      ),
    );
    expect(requests.get(separate.requestId ?? "")?.executionProfile).toMatchObject({
      mode: "separate",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    });
    await worker.tick();
    expect(desktop.prepared).toHaveLength(3);
    expect(desktop.prepared[2]?.opts).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    });
    expect(desktop.calls[3]?.opts).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    });
    expect(desktop.calls[3]?.prompt).toContain(
      "WAKEWIRE HOST-CONTROLLED CHILD TASK - OPERATOR CONTROLLED",
    );
    expect(requests.orchestrationForRequest(separate.requestId ?? "")).toMatchObject({
      stage: "child_submitted",
      parentThreadId: "prepared-thread-1",
      childThreadId: "prepared-thread-3",
    });
  });

  it.each(["parent_ready", "child_ready"] as const)(
    "resumes a nondefault first-task delegation after a crash in %s",
    async (stage) => {
      const db = openDatabase(":memory:");
      const people = new PeopleStore(db);
      const cj = people.add({ nickname: "CJ", roleName: "owner" });
      people.attachIdentity({
        personId: cj.id,
        provider: "slack",
        tenantId: "T1",
        externalId: "U-CJ",
      });
      const work = new WorkItemStore(db);
      const requests = new AgentRequestStore(db);
      const coordinator = new AgentCoordinator(people, work, requests);
      const desktop = new FakeDesktop();
      const worker = new AgentDispatchWorker(
        people,
        work,
        requests,
        { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
        desktop,
        pino({ level: "silent" }),
      );

      const accepted = coordinator.accept(
        slackDirectMessage("model: Terra; effort: high; investigate this", `retry-${stage}`),
      );
      const requestId = accepted.requestId ?? "";
      const request = requests.get(requestId);
      expect(request).not.toBeNull();

      // Simulate a daemon crash after the parent task was written to the work
      // item, with an optional prepared child, but before child submission.
      requests.setStatus(requestId, "dispatching");
      requests.beginOrchestration({
        requestId,
        cwd: "/Users/chip/Snap",
        sandbox: "workspace-write",
        childPrompt: "frozen child prompt",
        childTitle: "Slack child",
        reportPromptPrefix: "frozen report prefix",
        reportPromptSuffix: "frozen report suffix",
      });
      work.setWorkspace(request?.workItemId ?? "", "/Users/chip/Snap");
      work.setCodexThread(request?.workItemId ?? "", "prepared-parent");
      requests.setOrchestrationParent(requestId, "prepared-parent");
      if (stage === "child_ready") {
        requests.setOrchestrationChild(requestId, "prepared-child");
      }
      requests.setStatus(requestId, "acknowledged");

      await worker.tick();

      const childThreadId = stage === "parent_ready" ? "prepared-thread-1" : "prepared-child";
      expect(desktop.prepared).toHaveLength(stage === "parent_ready" ? 1 : 0);
      expect(desktop.calls).toHaveLength(1);
      expect(desktop.calls[0]).toMatchObject({
        kind: "resume",
        threadId: childThreadId,
        prompt: "frozen child prompt",
        opts: {
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
          idempotencyKey: `${requestId}:child-turn`,
        },
      });
      expect(requests.orchestrationForRequest(requestId)).toMatchObject({
        stage: "child_submitted",
        parentThreadId: "prepared-parent",
        childThreadId,
      });
      expect(requests.get(requestId)?.status).toBe("submitted");
    },
  );

  it("uses the frozen orchestration cwd when a Linear workspace resolver drifts after a crash", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4610"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );
    const event = linearPromptEvent("linear-cwd-retry");
    event.payload.body = "@Chip Byte model: Terra; effort: high; investigate this";
    const accepted = coordinator.accept(event);
    const requestId = accepted.requestId ?? "";
    const request = requests.get(requestId);
    const frozenCwd = "/Users/chip/Snap/eng-4610-fix-it";

    requests.setStatus(requestId, "dispatching");
    requests.beginOrchestration({
      requestId,
      cwd: frozenCwd,
      sandbox: "workspace-write",
      childPrompt: "frozen Linear child prompt",
      childTitle: "Linear child",
      reportPromptPrefix: "frozen report prefix",
      reportPromptSuffix: "frozen report suffix",
    });
    work.setWorkspace(request?.workItemId ?? "", frozenCwd);
    work.setCodexThread(request?.workItemId ?? "", "prepared-parent");
    requests.setOrchestrationParent(requestId, "prepared-parent");
    requests.setStatus(requestId, "acknowledged");

    await worker.tick();

    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(desktop.prepared[0]?.opts.cwd).toBe(frozenCwd);
    expect(desktop.calls[0]).toMatchObject({
      kind: "resume",
      prompt: "frozen Linear child prompt",
      opts: { cwd: frozenCwd },
    });
    expect(work.get(request?.workItemId ?? "")?.cwd).toBe(frozenCwd);
    expect(requests.orchestrationForRequest(requestId)).toMatchObject({
      stage: "child_submitted",
      cwd: frozenCwd,
    });
  });

  it("keeps a submitted turn successful when cosmetic title synchronization fails", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FailingTitleDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
    );

    const accepted = coordinator.accept(slackDirectMessage("please handle this"));
    await worker.tick();

    expect(desktop.calls).toHaveLength(1);
    expect(desktop.titleAttempts).toBe(1);
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("submitted");
    expect(
      work.get(requests.get(accepted.requestId ?? "")?.workItemId ?? "")?.codexThreadTitle,
    ).toBeNull();
  });

  it("reasserts the Linear request title on Hermes so the wrapper is not the sidebar name", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const hermes = new FakeHermes();
    const directory: LinearIssueDirectory = {
      resolveIdentifier: vi.fn(async () => ({
        organizationId: "org-1",
        issueId: "issue-4673",
        identifier: "ENG-4673",
        title: "Fix EPC transactions stuck in EPC_SYNCING after completed upload",
        branchName: "eng-4673-epc-syncing",
      })),
      issuesForUrl: vi.fn(async () => []),
    };
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4673"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      hermes,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    const mention: WakeEvent = {
      source: "webhook",
      sourceId: "webhook-linear",
      kind: "LinearUserEvent.mention",
      deliveryId: "lin-4673",
      occurredAt: "2026-08-18T15:04:01.000Z",
      summary: "CJ mentioned Chip on ENG-4673",
      payload: {
        provider: "linear",
        action: "create",
        linearTrigger: "mention",
        chipUserId: "chip-user",
        organizationId: "org-1",
        issueId: "issue-4673",
        identifier: "ENG-4673",
        title: "Fix EPC transactions stuck in EPC_SYNCING after completed upload",
        commentId: "comment-4673",
        body: "@chip create an implementation plan",
        actorId: "cj-linear",
        actorEmail: "cj@snapcorp.com",
        actorName: "CJ Lazell",
      },
      principal: {
        provider: "linear",
        tenantId: "org-1",
        subjectId: "cj-linear",
        email: "cj@snapcorp.com",
        displayName: "CJ Lazell",
      },
      conversation: {
        nativeKey: "org-1:issue-4673:comment:comment-4673",
        rootKey: "org-1:issue-4673",
        replyTarget: "issue-4673",
      },
      targetMentions: [{ kind: "linear-user", value: "chip-user" }],
    };
    const accepted = coordinator.accept(mention);
    expect(accepted).toMatchObject({ accepted: true });
    expect(requests.listReady().length).toBeGreaterThan(0);
    await worker.tick();

    expect(hermes.calls.map((c) => c.kind)).toEqual(["start"]);
    expect(hermes.calls[0]?.prompt).toMatch(/^WAKEWIRE TASK PRESENTATION - OPERATOR CONTROLLED/);
    expect(hermes.titles).toHaveLength(1);
    expect(hermes.titles[0]).toMatchObject({ threadId: "hermes-thread-1" });
    expect(hermes.titles[0]?.title).toBe("Linear ENG-4673 — create an implementation plan");
    expect(hermes.titles[0]?.title).not.toMatch(/WAKEWIRE TASK PRESENTATION/);
  });

  it("reuses one Linear-linked Desktop task across Slack and GitHub", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "99",
      handle: "cj",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const directory: LinearIssueDirectory = {
      resolveIdentifier: vi.fn(async () => ({
        organizationId: "org-1",
        issueId: "issue-1",
        identifier: "ENG-4610",
        title: "Fix local workspace naming",
        branchName: "eng-4610-fix-it",
      })),
      issuesForUrl: vi.fn(async () => []),
    };
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4610"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    expect(coordinator.accept(slackEvent("<@UCHIP> handle ENG-4610"))).toMatchObject({
      accepted: true,
    });
    await worker.tick();
    expect(desktop.calls[0]).toMatchObject({ kind: "start" });
    expect(desktop.calls[0]?.prompt).toMatch(/^WAKEWIRE TASK PRESENTATION - OPERATOR CONTROLLED/);
    expect(desktop.calls[0]?.prompt).toContain("PLACEHOLDER ONLY: no local model is configured");
    expect(desktop.titles).toEqual([
      { threadId: "desktop-thread-1", title: "Linear ENG-4610 — Fix local workspace naming" },
    ]);
    expect(resolveWorkspace).toHaveBeenCalledWith(
      { authoritativeLinearInput: "ENG-4610" },
      { signal: expect.any(AbortSignal) },
    );

    const followUp = slackEvent("<@UCHIP> one more thing", "Ev2");
    if (!followUp.conversation) throw new Error("test event is missing conversation data");
    followUp.payload.threadTs = "1.0";
    followUp.conversation.rootKey = "T1:C1:1.0";
    expect(coordinator.accept(followUp)).toMatchObject({ accepted: true });
    await worker.tick();
    expect(desktop.calls[1]).toMatchObject({
      kind: "resume",
      threadId: "desktop-thread-1",
      opts: { cwd: "/Users/chip/Snap/workspaces/eng-4610" },
    });
    expect(desktop.calls[1]?.prompt).toMatch(/^WAKEWIRE TASK PRESENTATION - OPERATOR CONTROLLED/);
    expect(resolveWorkspace).toHaveBeenCalledTimes(2);
    expect(work.findCanonical("linear", "linear:org-1:issue-1")?.cwd).toBe(
      "/Users/chip/Snap/workspaces/eng-4610",
    );

    const github: WakeEvent = {
      source: "github",
      sourceId: "github-system",
      kind: "issue_comment.created",
      deliveryId: "gh-1",
      occurredAt: "2026-07-27T00:00:01.000Z",
      summary: "GitHub comment",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 42,
        commentId: 500,
        body: "@chipbyte-snap same ENG-4610 task",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "99",
        handle: "cj",
      },
      conversation: {
        nativeKey: "101:42:comment:500",
        rootKey: "101:42",
        replyTarget: "101:comment:500",
      },
      targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
    };
    expect(coordinator.accept(github)).toMatchObject({ accepted: true });
    await worker.tick();
    expect(desktop.calls[2]).toMatchObject({
      kind: "resume",
      threadId: "desktop-thread-1",
    });
    expect(desktop.titles).toEqual([
      { threadId: "desktop-thread-1", title: "Linear ENG-4610 — Fix local workspace naming" },
    ]);
    expect(work.findCanonical("linear", "linear:org-1:issue-1")?.codexThreadId).toBe(
      "desktop-thread-1",
    );
  });

  it("uses a GitHub URL's Linear attachment to reuse one task across sources", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "99",
      handle: "cj",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const linkedIssue = {
      organizationId: "org-1",
      issueId: "issue-1",
      identifier: "ENG-4610",
      branchName: "eng-4610-fix-it",
    };
    const directory: LinearIssueDirectory = {
      resolveIdentifier: vi.fn(async () => linkedIssue),
      issuesForUrl: vi.fn(async (url) =>
        url === "https://github.com/snapnhd/system/pull/42" ? [linkedIssue] : [],
      ),
    };
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4610"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    expect(
      coordinator.accept(
        slackEvent("<@UCHIP> please take https://github.com/snapnhd/system/pull/42"),
      ),
    ).toMatchObject({ accepted: true });
    await worker.tick();
    expect(desktop.calls[0]).toMatchObject({ kind: "start" });
    expect(resolveWorkspace).toHaveBeenCalledWith(
      { authoritativeLinearInput: "ENG-4610" },
      { signal: expect.any(AbortSignal) },
    );

    const github: WakeEvent = {
      source: "github",
      sourceId: "github-system",
      kind: "pull_request_review_comment.created",
      deliveryId: "gh-linked-1",
      occurredAt: "2026-07-27T00:00:01.000Z",
      summary: "GitHub review comment",
      payload: {
        repo: "other/repository",
        repositoryId: 101,
        number: 42,
        isPullRequest: true,
        commentId: 501,
        pullRequestUrl: "https://github.com/snapnhd/system/pull/42",
        body: "@chipbyte-snap please continue",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "99",
        handle: "cj",
      },
      conversation: {
        nativeKey: "101:42:review-comment:501",
        rootKey: "101:42",
        replyTarget: "101:review-comment:501",
      },
      targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
    };
    expect(coordinator.accept(github)).toMatchObject({ accepted: true });
    await worker.tick();

    expect(directory.issuesForUrl).toHaveBeenCalledWith(
      "https://github.com/snapnhd/system/pull/42",
    );
    expect(desktop.calls[1]).toMatchObject({
      kind: "resume",
      threadId: "desktop-thread-1",
    });
    expect(work.findCanonical("linear", "linear:org-1:issue-1")?.codexThreadId).toBe(
      "desktop-thread-1",
    );
  });

  it("fails closed when direct and GitHub attachment evidence identify different tickets", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-1",
          identifier: "ENG-1",
          branchName: "eng-1-direct",
        }),
        issuesForUrl: async () => [
          {
            organizationId: "org-1",
            issueId: "issue-2",
            identifier: "ENG-2",
            branchName: "eng-2-attached",
          },
        ],
      },
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    const accepted = coordinator.accept(
      slackEvent("<@UCHIP> handle ENG-1 using https://github.com/snapnhd/system/pull/42"),
    );
    await worker.tick();

    expect(requests.get(accepted.requestId ?? "")?.status).toBe("failed");
    expect(requests.get(accepted.requestId ?? "")?.error).toMatch(
      /multiple Linear issues: ENG-1, ENG-2/,
    );
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(desktop.calls).toHaveLength(0);
  });

  it("binds a GitHub PR comment to the PR's one Linear ticket when the thread cites extras", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const primary = {
      organizationId: "org-1",
      issueId: "issue-4663",
      identifier: "ENG-4663",
      branchName: "routing-of-system-communications-when-loan-processor-eng-4663",
    };
    const referenced = {
      organizationId: "org-1",
      issueId: "issue-3859",
      identifier: "ENG-3859",
      branchName: "eng-3859-opening-processor",
    };
    const directory: LinearIssueDirectory = {
      resolveIdentifier: vi.fn(async (identifier: string) =>
        identifier === "ENG-4663" ? primary : identifier === "ENG-3859" ? referenced : null,
      ),
      issuesForUrl: vi.fn(async () => [primary, referenced]),
    };
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4663"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      desktop,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight: async () => passingSnapReviewPreflight(),
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
      },
    );

    const github: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request_review_comment.created",
      deliveryId: "gh-1097-reply",
      occurredAt: "2026-08-20T21:54:55.000Z",
      summary: "GitHub review comment",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 1097,
        title: "feat(orders): route system communications to EPC contact types (ENG-4663)",
        branch: "routing-of-system-communications-when-loan-processor-eng-4663",
        isPullRequest: true,
        pullRequestAuthorLogin: "system-pr-author",
        commentId: 3825659741,
        pullRequestUrl: "https://github.com/snapnhd/system/pull/1097",
        body: "@chipbyte-snap This seems to be different than FRA-2409 but matches flood. ENG-3859?",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "42786886",
        handle: "cswoods6",
      },
      conversation: {
        nativeKey: "101:1097:review-comment:3825659741",
        rootKey: "101:1097",
        replyTarget: "101:review-comment:3825659741",
      },
      targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
    };

    const accepted = coordinator.accept(github);
    expect(accepted).toMatchObject({ accepted: true });
    await worker.tick();
    expect(requests.get(accepted.requestId ?? "")).toMatchObject({
      status: "held",
      error: "system PR review completion requires an immediate host-verifiable final response",
    });
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(desktop.calls).toHaveLength(1);
  });

  it("binds a Linear mention to the comment's ticket when the title cites another issue", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const native = {
      organizationId: "org-1",
      issueId: "issue-3039",
      identifier: "FRA-3039",
      title: "Sync app/package-lock.json with vitest/jsdom added in FRA-3017 (deploy blocker)",
      branchName: "sync-apppackage-lockjson-with-vitestjsdom-added-in-fra-3017-fra-3039",
    };
    const referenced = {
      organizationId: "org-1",
      issueId: "issue-3017",
      identifier: "FRA-3017",
      title: "Add a globe-icon dev-host selector",
      branchName: "fra-3017-dev-host-selector",
    };
    const directory: LinearIssueDirectory = {
      resolveIdentifier: vi.fn(async (identifier: string) =>
        identifier === "FRA-3039" ? native : identifier === "FRA-3017" ? referenced : null,
      ),
      issuesForUrl: vi.fn(async () => []),
    };
    const hermes = new FakeHermes();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("FRA-3039"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      hermes,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    const mention: WakeEvent = {
      source: "webhook",
      sourceId: "webhook-linear",
      kind: "LinearUserEvent.mention",
      deliveryId: "lin-3039",
      occurredAt: "2026-09-01T14:54:30.748Z",
      summary: "CJ mentioned Chip on FRA-3039",
      payload: {
        provider: "linear",
        action: "create",
        linearTrigger: "mention",
        chipUserId: "chip-user",
        organizationId: "org-1",
        issueId: "issue-3039",
        identifier: "FRA-3039",
        title: native.title,
        url: "https://linear.app/snapcorp/issue/FRA-3039/sync-apppackage-lockjson-with-vitestjsdom-added-in-fra-3017-deploy",
        commentId: "comment-3039",
        body: "@chip please review this plan",
        actorId: "cj-linear",
        actorEmail: "cj@snapcorp.com",
        actorName: "CJ Lazell",
      },
      principal: {
        provider: "linear",
        tenantId: "org-1",
        subjectId: "cj-linear",
        email: "cj@snapcorp.com",
        displayName: "CJ Lazell",
      },
      conversation: {
        nativeKey: "org-1:issue-3039:comment:comment-3039",
        rootKey: "org-1:issue-3039",
        replyTarget: "issue-3039",
      },
      targetMentions: [{ kind: "linear-user", value: "chip-user" }],
    };

    const accepted = coordinator.accept(mention);
    expect(accepted).toMatchObject({ accepted: true });
    await worker.tick();

    const stored = requests.get(accepted.requestId ?? "");
    expect(stored?.status).not.toBe("failed");
    expect(String(stored?.error ?? "")).not.toMatch(/multiple Linear issues/);
    expect(resolveWorkspace).toHaveBeenCalledWith(
      { authoritativeLinearInput: "FRA-3039" },
      { signal: expect.any(AbortSignal) },
    );
    expect(hermes.calls).toHaveLength(1);
    expect(work.findCanonical("linear", "linear:org-1:issue-3039")).toMatchObject({
      canonicalKey: "linear:org-1:issue-3039",
    });
  });

  it("ignores an authenticated enrolled Gmail sender unless the current message @mentions Chip", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, new WorkItemStore(db), requests);
    const unmentioned = gmailEvent("FYI only", "No action needed");
    unmentioned.payload.authoredBody = "No action needed";
    unmentioned.targetMentions = [{ kind: "email", value: "chip@snapcorp.com" }];

    expect(coordinator.accept(unmentioned)).toEqual({ addressed: false, accepted: false });
    expect(requests.listReady()).toEqual([]);
  });

  it("rejects an addressed Gmail message without a real RFC Message-ID", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, new WorkItemStore(db), requests);
    const event = gmailEvent("Missing Message-ID");
    delete event.payload.rfcMessageId;
    event.deliveryId = "gmail-chip:1:42";
    event.conversation = {
      nativeKey: "gmail-chip:1:42",
      rootKey: "gmail-chip:1:42",
      replyTarget: "gmail-chip:1:42",
    };

    expect(coordinator.accept(event)).toEqual({
      addressed: true,
      accepted: false,
      reason: "Gmail addressed request requires payload.rfcMessageId",
    });
    expect(requests.listReady()).toEqual([]);
  });

  it("treats a Linear identifier in an authenticated @chip email subject as a workspace reference", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const directory: LinearIssueDirectory = {
      resolveIdentifier: vi.fn(async () => ({
        organizationId: "org-1",
        issueId: "issue-1",
        identifier: "ENG-4610",
        branchName: "eng-4610-fix-it",
      })),
      issuesForUrl: vi.fn(async () => []),
    };
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4610"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    expect(coordinator.accept(gmailEvent("ENG-4610 regression"))).toMatchObject({
      accepted: true,
    });
    await worker.tick();

    expect(directory.resolveIdentifier).toHaveBeenCalledWith("ENG-4610");
    expect(resolveWorkspace).toHaveBeenCalledWith(
      { authoritativeLinearInput: "ENG-4610" },
      { signal: expect.any(AbortSignal) },
    );
    expect(desktop.calls[0]).toMatchObject({
      kind: "start",
      opts: { cwd: "/Users/chip/Snap/workspaces/eng-4610" },
    });
  });

  it("deduplicates one Gmail Message-ID across labels without changing reply credentials", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com", "cjlazell@gmail.com"],
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);

    const inbox = gmailEvent("Shared label request");
    inbox.sourceId = "gmail-inbox";
    inbox.payload.label = "INBOX";
    const chipLabel = gmailEvent("Shared label request");
    chipLabel.sourceId = "gmail-chip-label";
    chipLabel.payload.label = "Chip";

    const first = coordinator.accept(inbox);
    const duplicate = coordinator.accept(chipLabel);

    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(duplicate).toMatchObject({
      accepted: true,
      duplicate: true,
      requestId: first.requestId,
    });
    expect(requests.listReady()).toHaveLength(1);
    expect(requests.listAcksReady()).toEqual([]);
    expect(requests.get(first.requestId ?? "")?.sourceId).toBe("gmail-inbox");
  });

  it("bounds unrelated dispatches while keeping each work item FIFO", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new BoundedDeferredDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
      { maxConcurrentRequests: 2 },
    );

    const firstA = coordinator.accept(slackThreadEvent("<@UCHIP> first-a", "Ev-A1", "1.0"));
    const followA = coordinator.accept(slackThreadEvent("<@UCHIP> follow-a", "Ev-A2", "1.0"));
    coordinator.accept(slackThreadEvent("<@UCHIP> other-b", "Ev-B1", "2.0"));
    coordinator.accept(slackThreadEvent("<@UCHIP> other-c", "Ev-C1", "3.0"));

    const firstPass = worker.tick();
    await vi.waitFor(() => expect(desktop.calls).toHaveLength(2));
    expect(desktop.maxInFlight).toBe(2);
    expect(desktop.calls.map(({ prompt }) => prompt)).toEqual([
      expect.stringContaining("first-a"),
      expect.stringContaining("other-b"),
    ]);
    expect(requests.get(followA.requestId ?? "")?.status).toBe("acknowledged");
    await worker.tick();
    expect(desktop.calls).toHaveLength(2);

    desktop.releaseAll();
    await firstPass;
    expect(requests.get(firstA.requestId ?? "")?.status).toBe("submitted");

    const secondPass = worker.tick();
    await vi.waitFor(() => expect(desktop.calls).toHaveLength(4));
    expect(desktop.maxInFlight).toBe(2);
    expect(desktop.calls.slice(2).map(({ prompt }) => prompt)).toEqual([
      expect.stringContaining("follow-a"),
      expect.stringContaining("other-c"),
    ]);
    expect(desktop.calls[2]?.kind).toBe("resume");
    desktop.releaseAll();
    await secondPass;
  });

  it("reports the current PR status instead of launching a concurrent rereview", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const reviewer = people.add({
      nickname: "Chris",
      roleName: "owner",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new BoundedDeferredHermes();
    const reviewStatusLookup = vi.fn(async () => ({
      summary: "📝 reviewing the diff",
      url: "https://github.com/snapnhd/system/pull/1058#issuecomment-1",
    }));
    const onReplyQueued = vi.fn();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      { reviewStatusLookup, onReplyQueued },
    );

    const firstEvent = githubPrCommentEvent("rereview-running-1");
    firstEvent.payload.repo = "other/repository";
    const first = coordinator.accept(firstEvent);
    const firstPass = worker.tick();
    while (hermes.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));

    const secondEvent = githubPrCommentEvent("rereview-running-2");
    secondEvent.payload.repo = "other/repository";
    const second = coordinator.accept(secondEvent);
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(reviewStatusLookup).toHaveBeenCalledOnce();
    expect(requests.get(second.requestId ?? "")?.status).toBe("submitted");
    expect(requests.sourceReplyForRequest(second.requestId ?? "")).toMatchObject({
      provider: "github",
      replyKind: "issue-comment",
      payload: {
        repo: "other/repository",
        number: "1058",
        text: expect.stringContaining("📝 reviewing the diff"),
      },
    });
    expect(onReplyQueued).toHaveBeenCalledOnce();

    hermes.releaseAll();
    await firstPass;
    expect(requests.get(first.requestId ?? "")?.status).toBe("submitted");
  });

  it("completes an already-running system PR request without a second provider reply", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const reviewer = people.add({ nickname: "Chris", roleName: "owner" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new BoundedDeferredHermes();
    const reviewStatusLookup = vi.fn(async () => ({ summary: "reviewing" }));
    const onReplyQueued = vi.fn();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("FRA-2889"),
        runReviewPreflight: async () => passingSnapReviewPreflight(),
        reviewStatusLookup,
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        onReplyQueued,
      },
    );

    const first = coordinator.accept(githubPrCommentEvent("system-rereview-running-1"));
    const firstPass = worker.tick();
    while (hermes.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));

    const second = coordinator.accept(githubPrCommentEvent("system-rereview-running-2"));
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(reviewStatusLookup).not.toHaveBeenCalled();
    expect(requests.get(second.requestId ?? "")?.status).toBe("completed");
    expect(requests.sourceReplyForRequest(second.requestId ?? "")).toBeNull();
    expect(onReplyQueued).not.toHaveBeenCalled();

    hermes.releaseAll();
    await firstPass;
    expect(requests.get(first.requestId ?? "")).toMatchObject({
      status: "held",
      error: "system PR review completion requires an immediate host-verifiable final response",
    });
  });

  it("launches a later work item while another dispatch is still in flight", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new BoundedDeferredDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
      { maxConcurrentRequests: 2 },
    );

    coordinator.accept(slackThreadEvent("<@UCHIP> first", "Ev-A1", "1.0"));
    const firstPass = worker.tick();
    await vi.waitFor(() => expect(desktop.calls).toHaveLength(1));

    coordinator.accept(slackThreadEvent("<@UCHIP> later", "Ev-B1", "2.0"));
    const laterPass = worker.tick();
    await vi.waitFor(() => expect(desktop.calls).toHaveLength(2));
    expect(desktop.calls.map(({ prompt }) => prompt)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("later"),
    ]);

    desktop.releaseAll();
    await firstPass;
    await laterPass;
  });

  it("serializes different source aliases after they merge to one Linear item", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "99",
      handle: "cj",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const issue = {
      organizationId: "org-1",
      issueId: "issue-1",
      identifier: "ENG-4610",
      branchName: "eng-4610-fix-it",
    };
    const resolveIdentifier = vi.fn(async () => issue);
    const directory: LinearIssueDirectory = {
      resolveIdentifier,
      issuesForUrl: vi.fn(async () => []),
    };
    const desktop = new BoundedDeferredDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      directory,
      desktop,
      pino({ level: "silent" }),
      {
        maxConcurrentRequests: 2,
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("ENG-4610"),
      },
    );

    const github: WakeEvent = {
      source: "github",
      sourceId: "github-system",
      kind: "issue_comment.created",
      deliveryId: "gh-concurrent-merge",
      occurredAt: "2026-07-27T00:00:01.000Z",
      summary: "GitHub comment",
      payload: {
        repo: "snapnhd/system",
        repositoryId: 101,
        number: 42,
        commentId: 500,
        body: "@chipbyte-snap continue ENG-4610",
      },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "99",
        handle: "cj",
      },
      conversation: {
        nativeKey: "101:42:comment:500",
        rootKey: "101:42",
        replyTarget: "101:comment:500",
      },
      targetMentions: [{ kind: "handle", value: "chipbyte-snap" }],
    };
    coordinator.accept(slackEvent("<@UCHIP> begin ENG-4610"));
    coordinator.accept(github);

    const pass = worker.tick();
    await vi.waitFor(() => {
      expect(resolveIdentifier).toHaveBeenCalledTimes(2);
      expect(db.prepare("SELECT COUNT(*) AS count FROM work_items").get()).toEqual({
        count: 1,
      });
      expect(desktop.calls).toHaveLength(1);
    });
    expect(desktop.calls[0]?.kind).toBe("start");

    desktop.releaseAll();
    await vi.waitFor(() => expect(desktop.calls).toHaveLength(2));
    expect(desktop.calls[1]).toMatchObject({
      kind: "resume",
      threadId: "desktop-thread-1",
    });
    desktop.releaseAll();
    await pass;

    expect(work.findCanonical("linear", "linear:org-1:issue-1")?.codexThreadId).toBe(
      "desktop-thread-1",
    );
  });

  it("cancels active workspace provisioning and drains before shutdown returns", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    let provisioningStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      provisioningStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const resolveWorkspace = vi.fn(
      async (
        _input: SnapWorkspaceInput,
        options?: { signal?: AbortSignal | undefined },
      ): Promise<never> => {
        receivedSignal = options?.signal;
        provisioningStarted();
        await new Promise<void>((_resolve, reject) => {
          if (options?.signal?.aborted) reject(options.signal.reason);
          else
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
        });
        throw new Error("unreachable");
      },
    );
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-1",
          identifier: "ENG-4610",
          branchName: "eng-4610-fix-it",
        }),
        issuesForUrl: async () => [],
      },
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    const accepted = coordinator.accept(slackEvent("<@UCHIP> prepare ENG-4610"));
    const ticking = worker.tick();
    await started;
    await worker.stop();
    await ticking;

    expect(receivedSignal?.aborted).toBe(true);
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("acknowledged");
    expect(desktop.calls).toHaveLength(0);
  });

  it("fails closed for a restricted role that Desktop cannot enforce", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("reader", {
      version: 1,
      capabilities: {
        machine: "read",
        desktop: "read",
        filesystem: "read",
        shell: "read",
        network: "read",
        browser: "none",
        computerUse: "none",
        connectedApps: "read",
        sourceReplies: "write",
        git: "read",
        deployments: "none",
      },
      secrets: { use: false, disclose: false },
      policyAdmin: false,
      destructiveActions: "deny",
    });
    const reader = people.add({
      nickname: "Reader",
      roleName: "reader",
      emails: ["reader@snapcorp.com"],
    });
    people.attachIdentity({
      personId: reader.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    expect(coordinator.accept(slackEvent("<@UCHIP> summarize this"))).toMatchObject({
      addressed: true,
      accepted: false,
      reason: "desktop-policy-not-enforceable",
    });
    expect(requests.listAcksReady()).toHaveLength(0);
    expect(requests.listReady()).toHaveLength(0);
    expect(desktop.calls).toHaveLength(0);
  });

  it("accepts an enrolled GitHub pr principal on the Hermes sink", () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const desktopCoordinator = new AgentCoordinator(people, work, requests);
    expect(desktopCoordinator.accept(githubReviewRequestedEvent())).toMatchObject({
      addressed: true,
      accepted: false,
      reason: "desktop-policy-not-enforceable",
    });
    const hermesCoordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    expect(hermesCoordinator.accept(githubReviewRequestedEvent("gh-rr-2"))).toMatchObject({
      addressed: true,
      accepted: true,
      duplicate: false,
    });
    expect(requests.listReady()).toHaveLength(1);
  });

  it("permanently fails an accepted command when its person is revoked", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
    );

    const accepted = coordinator.accept(slackEvent("<@UCHIP> do this later"));
    expect(accepted).toMatchObject({ accepted: true });
    people.disable(cj.id);
    await worker.tick();

    expect(requests.get(accepted.requestId ?? "")?.status).toBe("failed");
    expect(requests.listReady()).toHaveLength(0);
    people.enable(cj.id);
    await worker.tick();
    expect(desktop.calls).toHaveLength(0);
  });

  it("interrupts a Linear task before releasing the deferred stop response", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const item = work.getOrCreate({
      kind: "linear",
      key: "linear:org-1:issue-1",
      title: "ENG-4610",
    });
    work.setCodexThread(item.id, "desktop-thread-1");
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
    );
    const accepted = coordinator.accept(linearStopEvent());
    expect(accepted).toMatchObject({ accepted: true });
    expect(requests.ackForRequest(accepted.requestId ?? "")?.status).toBe("held");
    expect(requests.listAcksReady()).toEqual([]);

    await worker.tick();

    expect(desktop.interrupts).toEqual(["desktop-thread-1"]);
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
    expect(requests.listAcksReady()[0]).toMatchObject({
      status: "pending",
      payload: {
        target: "session-1",
        text: "Stopped, CJ.",
        contentType: "response",
        ephemeral: false,
      },
    });
  });

  it("does not submit an older cross-source request after Linear confirms stop", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T1",
      externalId: "U-CJ",
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("ENG-4610"));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-1",
          identifier: "ENG-4610",
          branchName: "eng-4610-fix-it",
        }),
        issuesForUrl: async () => [],
      },
      desktop,
      pino({ level: "silent" }),
      { resolveWorkspace },
    );

    const ordinary = coordinator.accept(slackEvent("<@UCHIP> handle ENG-4610"));
    const stop = coordinator.accept(linearStopEvent("stop-after-slack"));
    expect(ordinary.accepted).toBe(true);
    expect(stop.accepted).toBe(true);

    await worker.tick();

    expect(desktop.calls).toHaveLength(0);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(requests.get(stop.requestId ?? "")?.status).toBe("completed");
    expect(requests.get(ordinary.requestId ?? "")?.status).toBe("failed");
    expect(requests.ackForRequest(ordinary.requestId ?? "")).toMatchObject({
      status: "failed",
      error: "superseded by a later authenticated stop request",
    });
  });

  it("lets a Linear stop interrupt an in-flight Desktop delivery before confirming", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const item = work.getOrCreate({
      kind: "linear",
      key: "linear:org-1:issue-1",
      title: "ENG-4610",
    });
    work.setWorkspace(item.id, "/Users/chip/Snap/eng-4610-fix-it");
    work.setCodexThread(item.id, "desktop-thread-1");
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new DeferredDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("ENG-4610"),
      },
    );

    const ordinary = coordinator.accept(linearPromptEvent());
    const ordinaryPass = worker.tick();
    await desktop.deliveryStarted;

    const stop = coordinator.accept(linearStopEvent("stop-during-delivery"));
    const stopPass = worker.tick();
    await vi.waitFor(() => expect(desktop.interrupts).toEqual(["desktop-thread-1"]));
    expect(requests.ackForRequest(stop.requestId ?? "")?.status).toBe("held");

    desktop.finishDelivery();
    await Promise.all([ordinaryPass, stopPass]);

    expect(desktop.interrupts).toEqual(["desktop-thread-1", "desktop-thread-1"]);
    expect(requests.get(ordinary.requestId ?? "")?.status).toBe("failed");
    expect(requests.get(stop.requestId ?? "")?.status).toBe("completed");
    expect(requests.ackForRequest(stop.requestId ?? "")?.status).toBe("pending");
  });

  it("stops a submitted host child and its persisted parent before confirming", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new FakeDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
    );

    const ordinary = coordinator.accept(linearPromptEvent("separate-before-stop"));
    const requestId = ordinary.requestId ?? "";
    const request = requests.get(requestId);
    expect(request).not.toBeNull();
    work.setWorkspace(request?.workItemId ?? "", "/Users/chip/Snap/eng-4610-fix-it");
    work.setCodexThread(request?.workItemId ?? "", "parent-thread");
    requests.setStatus(requestId, "dispatching");
    requests.beginOrchestration({
      requestId,
      cwd: "/Users/chip/Snap/eng-4610-fix-it",
      sandbox: "workspace-write",
      childPrompt: "safe child prompt",
      childTitle: "Linear ENG-4610 — child",
      reportPromptPrefix: "safe prefix",
      reportPromptSuffix: "safe suffix",
    });
    requests.setOrchestrationParent(requestId, "parent-thread");
    requests.setOrchestrationChild(requestId, "child-thread");
    requests.bindChildSubmission({
      requestId,
      childThreadId: "child-thread",
      correlationMarker: `wakewire:event:v1:${"d".repeat(64)}`,
    });

    const stop = coordinator.accept(linearStopEvent("stop-submitted-child"));
    await worker.tick();

    expect(desktop.interrupts).toEqual(["parent-thread", "child-thread"]);
    expect(requests.get(requestId)).toMatchObject({
      status: "failed",
      error: "superseded by a later authenticated stop request",
    });
    expect(requests.get(stop.requestId ?? "")?.status).toBe("completed");
    expect(requests.ackForRequest(stop.requestId ?? "")?.status).toBe("pending");
  });

  it("aborts and drains a racing parent report before confirming a Linear stop", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({ nickname: "CJ", roleName: "owner" });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new DeferredParentReportDesktop();
    const parentReportFence = new ParentReportFence();

    const ordinary = coordinator.accept(linearPromptEvent("report-before-stop"));
    const requestId = ordinary.requestId ?? "";
    const request = requests.get(requestId);
    expect(request).not.toBeNull();
    work.setWorkspace(request?.workItemId ?? "", "/Users/chip/Snap/eng-4610-fix-it");
    work.setCodexThread(request?.workItemId ?? "", "parent-thread");
    requests.setStatus(requestId, "dispatching");
    requests.beginOrchestration({
      requestId,
      cwd: "/Users/chip/Snap/eng-4610-fix-it",
      sandbox: "workspace-write",
      childPrompt: "safe child prompt",
      childTitle: "Linear ENG-4610 — child",
      reportPromptPrefix: "safe prefix",
      reportPromptSuffix: "safe suffix",
    });
    requests.setOrchestrationParent(requestId, "parent-thread");
    requests.setOrchestrationChild(requestId, "child-thread");
    requests.bindChildSubmission({
      requestId,
      childThreadId: "child-thread",
      correlationMarker: `wakewire:event:v1:${"e".repeat(64)}`,
    });
    requests.markChildCompleted(requestId, "child finished");

    const completion = new CompletionWorker(
      requests,
      {
        read: async () => {
          throw new Error("unexpected completion read");
        },
      },
      pino({ level: "silent" }),
      () => {},
      { adapter: desktop, parentReportFence },
    );
    const dispatch = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
      { parentReportFence },
    );

    const completionPass = completion.tick();
    await desktop.reportStarted;
    expect(desktop.inFlight).toBe(1);

    const stop = coordinator.accept(linearStopEvent("stop-during-parent-report"));
    await dispatch.tick();
    await completionPass;

    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]?.opts.signal?.aborted).toBe(true);
    expect(desktop.inFlight).toBe(0);
    expect(desktop.interrupts).toEqual([
      "parent-thread",
      "child-thread",
      "parent-thread",
      "child-thread",
    ]);
    expect(requests.get(requestId)).toMatchObject({
      status: "failed",
      error: "superseded by a later authenticated stop request",
    });
    expect(requests.get(stop.requestId ?? "")?.status).toBe("completed");
    expect(requests.ackForRequest(stop.requestId ?? "")?.status).toBe("pending");
    expect(requests.sourceReplyForRequest(requestId)).toBeNull();

    await completion.tick();
    expect(desktop.calls).toHaveLength(1);
  });

  it("persists and interrupts a new Desktop task created while a later stop waits", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    const cj = people.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    people.attachIdentity({
      personId: cj.id,
      provider: "linear",
      tenantId: "org-1",
      externalId: "cj-linear",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests);
    const desktop = new DeferredNewDesktop();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      desktop,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("ENG-4610"),
      },
    );

    const ordinary = coordinator.accept(linearPromptEvent("create-before-stop"));
    const ordinaryPass = worker.tick();
    await desktop.creationStarted;

    const stop = coordinator.accept(linearStopEvent("stop-during-create"));
    const stopPass = worker.tick();
    expect(requests.ackForRequest(stop.requestId ?? "")?.status).toBe("held");

    desktop.finishCreation();
    await Promise.all([ordinaryPass, stopPass]);

    const item = work.findCanonical("linear", "linear:org-1:issue-1");
    expect(item?.codexThreadId).toBe("desktop-thread-created-during-stop");
    expect(desktop.interrupts).toEqual(["desktop-thread-created-during-stop"]);
    expect(requests.get(ordinary.requestId ?? "")?.status).toBe("failed");
    expect(requests.get(stop.requestId ?? "")?.status).toBe("completed");
    expect(requests.ackForRequest(stop.requestId ?? "")?.status).toBe("pending");
  });

  it("ignores a GitHub review_requested when a Hermes session for that PR is already running", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new FakeHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        hermesSessionLookup: () => ({
          hits: [
            {
              id: "20260820_151904_399713",
              source: "cli",
              title: "Review snapnhd/system#1097 as chipbyte-snap…",
              sessionKey: null,
              chatId: null,
              endedAt: null,
              startedAt: 1,
            },
          ],
          runningIds: new Set(["20260820_151904_399713"]),
          cmdlineBusy: false,
        }),
        reviewStatusLookup: async () => ({
          summary: "🧪 GitHub checks before sign-off",
          url: "https://github.com/snapnhd/system/pull/1097#issuecomment-1",
        }),
      },
    );

    const accepted = coordinator.accept(githubReviewRequestedEvent("gh-rr-running"));
    expect(accepted).toMatchObject({ accepted: true });
    await worker.tick();

    expect(hermes.calls).toHaveLength(0);
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
    expect(requests.sourceReplyForRequest(accepted.requestId ?? "")).toBeNull();
  });

  it("aborts only the old PR request and resumes the same session when HEAD moves", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    let now = new Date("2026-09-02T14:00:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => now,
      sinkAdapterName: "hermes",
    });
    const oldHead = "a".repeat(40);
    const newHead = "b".repeat(40);
    const initialEvent = githubReviewRequestedEvent("gh-running-old-head");
    initialEvent.payload = { ...initialEvent.payload, isPullRequest: true, headSha: oldHead };
    const initial = coordinator.accept(initialEvent);
    const initialRequest = requests.get(initial.requestId ?? "");
    if (!initialRequest) throw new Error("initial request missing");
    work.setCodexThread(initialRequest.workItemId, "canonical-pr-1097-session");
    work.setWorkspace(initialRequest.workItemId, "/Users/chip/Snap");

    const hermes = new HeadMoveHermes();
    let reportRunning = false;
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        now: () => now,
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewCommitLookup: async () => ({
          lastChipReviewSha: oldHead,
          lastChipReviewState: "APPROVED",
          lastChipReviewBody: "",
        }),
        hermesSessionLookup: () => ({
          hits: [
            {
              id: "canonical-pr-1097-session",
              source: "github",
              title: "Review snapnhd/system#1097",
              sessionKey: "wakewire:github:snapnhd/system#1097",
              chatId: "wakewire:github:snapnhd/system#1097",
              endedAt: null,
              startedAt: 1,
              firstUserMatchesRef: true,
              firstUserRequestsReview: true,
            },
          ],
          runningIds:
            reportRunning && !hermes.firstSignal?.aborted
              ? new Set(["canonical-pr-1097-session"])
              : new Set<string>(),
          cmdlineBusy: false,
        }),
      },
    );

    const initialPass = worker.tick();
    await hermes.firstDeliveryStarted;
    reportRunning = true;
    const synchronize: WakeEvent = {
      ...githubReviewRequestedEvent("gh-running-new-head"),
      kind: "pull_request.synchronize",
      payload: {
        ...initialEvent.payload,
        action: "synchronize",
        beforeSha: oldHead,
        headSha: newHead,
        requestedReviewerLogins: ["chipbyte-snap"],
      },
      targetMentions: undefined,
    };
    const restarted = coordinator.accept(synchronize);
    now = new Date(now.getTime() + 31_000);
    const restartPass = worker.tick();

    try {
      await vi.waitFor(() => expect(hermes.calls).toHaveLength(2));
      expect(hermes.firstSignal?.aborted).toBe(true);
      expect(hermes.calls.map((call) => call.threadId)).toEqual([
        "canonical-pr-1097-session",
        "canonical-pr-1097-session",
      ]);
      expect(requests.get(initial.requestId ?? "")).toMatchObject({
        status: "failed",
        error: expect.stringContaining("superseded by PR HEAD"),
      });
      expect(requests.get(restarted.requestId ?? "")?.status).toBe("completed");
    } finally {
      hermes.releaseFirst();
      await Promise.allSettled([initialPass, restartPass]);
    }
  });

  it("does not abort or submit a second turn for a duplicate same-HEAD synchronize", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    let now = new Date("2026-09-02T14:00:00.000Z");
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      now: () => now,
      sinkAdapterName: "hermes",
    });
    const headSha = "a".repeat(40);
    const initialEvent = githubReviewRequestedEvent("gh-running-same-head");
    initialEvent.payload = { ...initialEvent.payload, isPullRequest: true, headSha };
    const initial = coordinator.accept(initialEvent);
    const initialRequest = requests.get(initial.requestId ?? "");
    if (!initialRequest) throw new Error("initial request missing");
    work.setCodexThread(initialRequest.workItemId, "canonical-pr-1097-session");
    work.setWorkspace(initialRequest.workItemId, "/Users/chip/Snap");
    const hermes = new HeadMoveHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      { now: () => now, reviewStatusEnsure: async () => ({ summary: "pickup" }) },
    );

    const initialPass = worker.tick();
    await hermes.firstDeliveryStarted;
    const synchronize: WakeEvent = {
      ...githubReviewRequestedEvent("gh-running-same-head-sync"),
      kind: "pull_request.synchronize",
      payload: {
        ...initialEvent.payload,
        action: "synchronize",
        beforeSha: headSha,
        headSha,
        requestedReviewerLogins: ["chipbyte-snap"],
      },
      targetMentions: undefined,
    };
    const duplicate = coordinator.accept(synchronize);
    now = new Date(now.getTime() + 31_000);
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(hermes.firstSignal?.aborted).not.toBe(true);
    expect(requests.get(duplicate.requestId ?? "")?.status).toBe("completed");
    hermes.releaseFirst();
    await initialPass;
  });

  it("holds a timed-out review retry while its prior process is still running", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new FakeHermes();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        hermesSessionLookup: () => ({
          hits: [],
          runningIds: new Set(),
          cmdlineBusy: true,
        }),
      },
    );

    const accepted = coordinator.accept(githubReviewRequestedEvent("gh-rr-timeout-retry"));
    const requestId = accepted.requestId ?? "";
    requests.hold(requestId, "prior runner timed out", new Date(0).toISOString());
    await worker.tick();

    expect(hermes.calls).toHaveLength(0);
    expect(requests.get(requestId)).toMatchObject({
      status: "held",
      error: "hermes session unbound-running in flight",
    });
  });

  it("orders pickup, ticket workspace, exact-head tests, then the full system PR review", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const headSha = "a".repeat(40);
    const hermes = new FinalResponseHermes(specialistProofResponse("snapnhd/system#1097", headSha));
    const order: string[] = [];
    const statusUpdates: GithubReviewBodyUpdate[] = [];
    const resolveWorkspace = vi.fn(async () => {
      order.push("workspace");
      return fakeResolvedSnapWorkspace("FRA-2889", headSha);
    });
    const runReviewPreflight = vi.fn(async () => {
      order.push("tests");
      return passingSnapReviewPreflight(headSha);
    });
    const reviewStatusEnsure = vi.fn(async () => {
      order.push("pickup");
      return { summary: "👀 picked up", url: "https://github.com/snapnhd/system/pull/1097" };
    });
    const reviewStatusUpdate: NonNullable<
      AgentDispatchWorkerOptions["reviewStatusUpdate"]
    > = async (_event, update) => {
      order.push(update.status.phase);
      statusUpdates.push(update);
      return { summary: update.status.phase, url: "https://github.com/snapnhd/system/pull/1097" };
    };
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-2889",
          identifier: "FRA-2889",
          title: "Canonicalize participant role keys",
          branchName: "canonicalize-participant-role-keys-to-encompass-form-fra-2889",
        }),
        issuesForUrl: async () => [],
      },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight,
        reviewStatusEnsure,
        reviewStatusUpdate,
        specialistProofLookup: async () => true,
        reviewArtifactLookup: async () => true,
      },
    );

    const event = githubReviewRequestedEvent("gh-review-preflight-order");
    event.payload.title = "Canonicalize participant role keys (FRA-2889)";
    event.payload.pullRequestUrl = "https://github.com/snapnhd/system/pull/9999";
    const accepted = coordinator.accept(event);
    await worker.tick();

    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(runReviewPreflight).not.toHaveBeenCalled();
    expect(order).toEqual(["pickup"]);
    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
  });

  it("holds a full system PR review comment when the exact-head specialist proof is missing", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new FinalResponseHermes("review complete");
    const headSha = "a".repeat(40);
    const phases: string[] = [];
    const specialistProofLookup = vi.fn(async () => true);
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("FRA-2889", headSha),
        runReviewPreflight: async () => passingSnapReviewPreflight(headSha),
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => {
          phases.push(update.status.phase);
          return { summary: update.status.phase };
        },
        specialistProofLookup,
      },
    );
    const accepted = coordinator.accept(githubPrCommentEvent("gh-comment-missing-proof"));

    await worker.tick();

    expect(specialistProofLookup).not.toHaveBeenCalled();
    expect(requests.get(accepted.requestId ?? "")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(phases).not.toContain("specialists-incomplete");
  });

  it("holds a full system PR review when no review artifact can be verified", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const headSha = "a".repeat(40);
    const hermes = new FinalResponseHermes(specialistProofResponse("snapnhd/system#1097", headSha));
    const phases: string[] = [];
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("FRA-2889", headSha),
        runReviewPreflight: async () => passingSnapReviewPreflight(headSha),
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => {
          phases.push(update.status.phase);
          return { summary: update.status.phase };
        },
        specialistProofLookup: async () => true,
        reviewArtifactLookup: async () => false,
      },
    );
    const accepted = coordinator.accept(githubReviewRequestedEvent("gh-review-missing-artifact"));

    await worker.tick();

    expect(requests.get(accepted.requestId ?? "")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(phases).not.toContain("review-incomplete");
  });

  it.each([
    ["REPAIR" as const, "specialist changes required"],
    ["ESCALATE" as const, "specialist reconciliation required"],
  ])("leaves a trusted %s specialist verdict visibly waiting", async (status, _detail) => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const headSha = "a".repeat(40);
    const hermes = new FinalResponseHermes(
      specialistProofResponse("snapnhd/system#1097", headSha, status),
    );
    const updates: GithubReviewBodyUpdate[] = [];
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("FRA-2889", headSha),
        runReviewPreflight: async () => passingSnapReviewPreflight(headSha),
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => {
          updates.push(update);
          return { summary: update.status.phase };
        },
        specialistProofLookup: async () => true,
        reviewArtifactLookup: async () => true,
      },
    );
    const accepted = coordinator.accept(githubReviewRequestedEvent(`gh-review-${status}`));

    await worker.tick();

    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
    expect(updates.some((update) => update.status.phase === "specialists-waiting")).toBe(false);
  });

  it("recovers a held proof attempt without submitting a duplicate GitHub review", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const headSha = "a".repeat(40);
    const hermes = new FinalResponseHermes(specialistProofResponse("snapnhd/system#1097", headSha));
    const reviewArtifactLookup = vi.fn(async () => true);
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        now: () => new Date("2026-08-27T20:00:00.000Z"),
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("FRA-2889", headSha),
        runReviewPreflight: async () => passingSnapReviewPreflight(headSha),
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        specialistProofLookup: async () => true,
        reviewArtifactLookup,
      },
    );
    const accepted = coordinator.accept(githubReviewRequestedEvent("gh-review-proof-recovery"));
    requests.hold(
      accepted.requestId ?? "",
      "system PR review did not produce a trusted exact-head specialist proof",
      "2026-08-27T19:59:59.000Z",
    );

    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(reviewArtifactLookup).not.toHaveBeenCalled();
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
  });

  it.each([undefined, "chipbyte-snap"])(
    "does not enter system review preflight with PR author %s",
    async (author) => {
      const db = openDatabase(":memory:");
      const people = new PeopleStore(db);
      people.setRole("pr", PR_ROLE_POLICY);
      const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
      people.attachIdentity({
        personId: reviewer.id,
        provider: "github",
        tenantId: "github.com",
        externalId: "42786886",
      });
      const work = new WorkItemStore(db);
      const requests = new AgentRequestStore(db);
      const coordinator = new AgentCoordinator(people, work, requests, undefined, {
        sinkAdapterName: "hermes",
      });
      const hermes = new FakeHermes();
      const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("FRA-2889"));
      const runReviewPreflight = vi.fn(async () => passingSnapReviewPreflight());
      const worker = new AgentDispatchWorker(
        people,
        work,
        requests,
        { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
        hermes,
        pino({ level: "silent" }),
        {
          resolveWorkspace,
          runReviewPreflight,
          reviewStatusEnsure: async () => ({ summary: "pickup" }),
          reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        },
      );
      const event = githubReviewRequestedEvent(`gh-review-author-${author ?? "missing"}`);
      if (author === undefined) delete event.payload.author;
      else event.payload.author = author;

      const accepted = coordinator.accept(event);
      await worker.tick();

      expect(resolveWorkspace).not.toHaveBeenCalled();
      expect(runReviewPreflight).not.toHaveBeenCalled();
      expect(hermes.calls).toHaveLength(1);
      expect(hermes.calls[0]?.prompt).not.toContain("authorizes one full review");
      expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
    },
  );

  it("dispatches only limited COMMENTED triage when one local suite fails", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new FakeHermes();
    const headSha = "b".repeat(40);
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("FRA-2889", headSha));
    const runReviewPreflight = vi.fn(async () => ({
      headSha,
      passed: true,
      suites: {
        app: "test-failed" as const,
        data: "passed" as const,
        snapcorp: "passed" as const,
        windmill: "passed" as const,
      },
      diagnosticTail: "app: TEST FAILED (exit code 1)",
    }));
    const specialistProofLookup = vi.fn(async () => false);
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-2889",
          identifier: "FRA-2889",
        }),
        issuesForUrl: async () => [],
      },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight,
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        reviewArtifactLookup: async () => true,
        specialistProofLookup,
      },
    );
    const event = githubReviewRequestedEvent("gh-review-preflight-failed");
    event.payload.title = "Canonicalize participant role keys (FRA-2889)";

    const accepted = coordinator.accept(event);
    await worker.tick();

    expect(runReviewPreflight).not.toHaveBeenCalled();
    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
    expect(specialistProofLookup).not.toHaveBeenCalled();
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
  });

  it("rejects a frozen full-review child after a fresh preflight fails", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    class HermesDesktop extends FakeDesktop {
      override readonly name = "hermes";
    }
    const desktop = new HermesDesktop();
    const headSha = "9".repeat(40);
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-2889",
          identifier: "FRA-2889",
        }),
        issuesForUrl: async () => [],
      },
      desktop,
      pino({ level: "silent" }),
      {
        resolveWorkspace: async () => fakeResolvedSnapWorkspace("FRA-2889", headSha),
        runReviewPreflight: async () => ({
          headSha,
          passed: false,
          suites: {
            app: "test-failed",
            data: "passed",
            snapcorp: "passed",
            windmill: "passed",
          },
          diagnosticTail: "app: TEST FAILED",
        }),
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
      },
    );
    const event = githubReviewRequestedEvent("gh-review-stale-orchestration");
    event.payload.title = "Canonicalize participant role keys (FRA-2889)";
    event.payload.body = "Use a separate task for this review.";
    const accepted = coordinator.accept(event);
    expect(accepted).toMatchObject({ accepted: true });
    const requestId = accepted.requestId ?? "";
    const request = requests.get(requestId);
    if (!request) throw new Error("request was not created");
    requests.setStatus(requestId, "dispatching");
    requests.beginOrchestration({
      requestId,
      cwd: "/Users/chip/Snap/workspaces/fra-2889",
      sandbox: "read-only",
      childPrompt: "FULL-REVIEW at stale HEAD",
      childTitle: "stale child",
      reportPromptPrefix: "stale report prefix",
      reportPromptSuffix: "stale report suffix",
    });
    requests.setStatus(requestId, "acknowledged");

    await worker.tick();

    expect(desktop.prepared).toHaveLength(0);
    expect(desktop.calls).toHaveLength(0);
    expect(requests.get(requestId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("already has different separate-task orchestration"),
    });
  });

  it("does not run Snap workspace or local-test preflight for a non-system PR", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new FakeHermes();
    const resolveWorkspace = vi.fn();
    const runReviewPreflight = vi.fn();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight,
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
      },
    );
    const event = githubReviewRequestedEvent("gh-non-system-review");
    event.payload.repo = "other/repository";
    event.conversation = {
      nativeKey: "other/repository:1097",
      rootKey: "other/repository:1097",
      replyTarget: "other/repository:1097",
    };

    coordinator.accept(event);
    await worker.tick();

    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(runReviewPreflight).not.toHaveBeenCalled();
    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
  });

  it("does not boot a managed workspace or stamp workspace-failed for a system PR review", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const reviewer = people.add({ nickname: "Chris", roleName: "pr" });
    people.attachIdentity({
      personId: reviewer.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const hermes = new FakeHermes();
    const phases: string[] = [];
    const resolveWorkspace = vi.fn(async () => {
      throw new Error("root Makefile could not prepare workspace fra-2950");
    });
    const runReviewPreflight = vi.fn();
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-2950",
          identifier: "FRA-2950",
        }),
        issuesForUrl: async () => [],
      },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight,
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => {
          phases.push(update.status.phase);
          return { summary: update.status.phase };
        },
      },
    );
    const event = githubReviewRequestedEvent("gh-system-review-no-workspace");
    event.payload.title = "fix(fraud): REO owner-search alerts (FRA-2950)";

    const accepted = coordinator.accept(event);
    await worker.tick();

    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(runReviewPreflight).not.toHaveBeenCalled();
    expect(phases).not.toContain("workspace-starting");
    expect(phases).not.toContain("workspace-failed");
    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
  });

  it("revalidates the exact workspace and tests before resuming a matching PR session", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const headSha = "c".repeat(40);
    const hermes = new FinalResponseHermes(specialistProofResponse("snapnhd/system#1058", headSha));
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("FRA-2889", headSha));
    const runReviewPreflight = vi.fn(async () => passingSnapReviewPreflight(headSha));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => ({
          organizationId: "org-1",
          issueId: "issue-2889",
          identifier: "FRA-2889",
          title: "Canonicalize participant role keys",
          branchName: "canonicalize-participant-role-keys-to-encompass-form-fra-2889",
        }),
        issuesForUrl: async () => [],
      },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight,
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        specialistProofLookup: async () => true,
        reviewArtifactLookup: async () => true,
        hermesSessionLookup: () => ({
          hits: [
            {
              id: "incidental-report-session",
              source: "github",
              title: "snapnhd/system#1058 · retitled report session",
              sessionKey: "wakewire:github:snapnhd/system#1058",
              chatId: "wakewire:github:snapnhd/system#1058",
              endedAt: null,
              startedAt: 0,
              firstUserMatchesRef: false,
            },
            {
              id: "20260821_125620_1a8606",
              source: "cli",
              title: "snapnhd/system#1058 · feat(fraud): canonicalize participant role keys",
              sessionKey: null,
              chatId: null,
              endedAt: 1,
              startedAt: 1,
              firstUserMatchesRef: true,
            },
          ],
          runningIds: new Set(),
          cmdlineBusy: false,
        }),
      },
    );

    const accepted = coordinator.accept(githubPrCommentEvent("gh-rereview-resume"));
    const acceptedRequest = requests.get(accepted.requestId ?? "");
    if (!acceptedRequest) throw new Error("accepted request missing");
    work.setCodexThread(acceptedRequest.workItemId, "incidental-report-session");
    await worker.tick();

    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(runReviewPreflight).not.toHaveBeenCalled();
    expect(hermes.calls).toEqual([
      expect.objectContaining({ kind: "resume", threadId: "20260821_125620_1a8606" }),
    ]);
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
    expect(requests.sourceReplyForRequest(accepted.requestId ?? "")).toBeNull();
  });

  it("resumes the existing Hermes session instead of starting a second review", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const headSha = "d".repeat(40);
    const hermes = new FinalResponseHermes(specialistProofResponse("snapnhd/system#1097", headSha));
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("FRA-2889", headSha));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      { resolveIdentifier: async () => null, issuesForUrl: async () => [] },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight: async () => passingSnapReviewPreflight(headSha),
        reviewStatusEnsure: async () => ({ summary: "pickup" }),
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        specialistProofLookup: async () => true,
        reviewArtifactLookup: async () => true,
        hermesSessionLookup: () => ({
          hits: [
            {
              id: "20260820_151904_399713",
              source: "cli",
              title: "Review snapnhd/system#1097 as chipbyte-snap…",
              sessionKey: null,
              chatId: null,
              endedAt: null,
              startedAt: 1,
            },
          ],
          runningIds: new Set(),
          cmdlineBusy: false,
        }),
      },
    );

    const accepted = coordinator.accept(githubReviewRequestedEvent("gh-rr-resume"));
    expect(accepted).toMatchObject({ accepted: true });
    await worker.tick();

    expect(hermes.calls).toEqual([
      expect.objectContaining({ kind: "resume", threadId: "20260820_151904_399713" }),
    ]);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
    expect(requests.get(accepted.requestId ?? "")?.codexThreadId).toBe("20260820_151904_399713");
  });

  it("dispatches a GitHub review when Linear credentials are missing", async () => {
    const db = openDatabase(":memory:");
    const people = new PeopleStore(db);
    people.setRole("pr", PR_ROLE_POLICY);
    const chris = people.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    people.attachIdentity({
      personId: chris.id,
      provider: "github",
      tenantId: "github.com",
      externalId: "42786886",
      handle: "cswoods6",
    });
    const work = new WorkItemStore(db);
    const requests = new AgentRequestStore(db);
    const coordinator = new AgentCoordinator(people, work, requests, undefined, {
      sinkAdapterName: "hermes",
    });
    const reviewStatusEnsure = vi.fn(async () => ({
      summary: "👀 picked up",
      url: "https://github.com/snapnhd/system/pull/1110",
    }));
    const headSha = "e".repeat(40);
    const hermes = new FinalResponseHermes(specialistProofResponse("snapnhd/system#1110", headSha));
    const resolveWorkspace = vi.fn(async () => fakeResolvedSnapWorkspace("FRA-2872", headSha));
    const worker = new AgentDispatchWorker(
      people,
      work,
      requests,
      {
        resolveIdentifier: async () => {
          throw new Error("renewable Linear app credentials are not configured for webhook-linear");
        },
        issuesForUrl: async () => {
          throw new Error("renewable Linear app credentials are not configured for webhook-linear");
        },
      },
      hermes,
      pino({ level: "silent" }),
      {
        resolveWorkspace,
        runReviewPreflight: async () => passingSnapReviewPreflight(headSha),
        reviewArtifactLookup: async () => true,
        reviewStatusEnsure: reviewStatusEnsure,
        reviewStatusUpdate: async (_event, update) => ({ summary: update.status.phase }),
        specialistProofLookup: async () => true,
      },
    );
    const event = githubReviewRequestedEvent("gh-rr-linear-down");
    event.payload.title = "feat(fraud): hierarchical check codes (FRA-2872)";
    event.payload.number = 1110;
    event.conversation = {
      nativeKey: "snapnhd/system:1110",
      rootKey: "snapnhd/system:1110",
      replyTarget: "snapnhd/system:1110",
    };
    const accepted = coordinator.accept(event);
    expect(accepted).toMatchObject({ accepted: true });
    await worker.tick();

    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0]?.kind).toBe("start");
    expect(reviewStatusEnsure).toHaveBeenCalledOnce();
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(hermes.calls[0]?.opts.cwd).toBe("/Users/chip/Snap");
    expect(requests.get(accepted.requestId ?? "")?.status).toBe("completed");
    expect(requests.sourceReplyForRequest(accepted.requestId ?? "")).toBeNull();
  });
});
