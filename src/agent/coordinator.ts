import { createHash } from "node:crypto";
import path from "node:path";
import type { WakeEvent } from "../core/event.js";
import type { Logger } from "../logging.js";
import type { Person } from "../people/schema.js";
import type { PeopleStore } from "../people/store.js";
import type { AgentAdapter } from "../sinks/types.js";
import { BusyError, PermanentError } from "../sinks/types.js";
import { isPrivilegedLinearAgentSessionEvent } from "../sources/linear/agent-session.js";
import { isPrivilegedLinearUserEvent } from "../sources/linear/user-event.js";
import { isAuthenticatedSlackHumanMessage } from "../sources/slack/normalize.js";
import { buildAckSpec, InvalidAckEventError, UnsupportedAckEventError } from "./ack.js";
import {
  type CanonicalConversation,
  type CorrelationInput,
  correlateConversation,
  type ResolvedLinearIssue,
  UnresolvedLinearReferenceError,
} from "./correlation.js";
import {
  DEFAULT_EXECUTION_PROFILE,
  type ExecutionProfile,
  type ExecutionReasoningEffort,
  parseExecutionProfile,
} from "./execution-profile.js";
import type {
  GithubReviewArtifactExpectation,
  GithubReviewBodyUpdate,
  GithubReviewStatusPhase,
  GithubReviewTestState,
} from "./github-review-status.js";
import { chipReviewCoversHead, type ChipReviewCommit } from "./github-review-head.js";
import { buildHermesSessionOptions, hermesTargetFromEvent } from "./hermes-identity.js";
import {
  decideHermesSessionReuse,
  type HermesReuseDecision,
  type HermesSessionLookup,
  type HermesWorkRef,
  loadHermesSessionIdentity,
  workRefFromTarget,
  workRefIsEmpty,
} from "./hermes-session-reuse.js";
import type { LinearIssueDirectory } from "./linear-directory.js";
import { ParentReportFence } from "./parent-report-fence.js";
import {
  chipDispatchDenied,
  type EffectivePolicy,
  effectivePolicy,
  PolicyConfigurationError,
} from "./policy.js";
import {
  extractLinearReferences,
  githubItemUrlsInText,
  normalizeEmailSubject,
  primaryLinearIdentifierForGithubPr,
  uniqueLinearIdentifiers,
} from "./references.js";
import {
  buildFinalReplySpec,
  buildGithubReviewProgressReplySpec,
  InvalidSourceReplyEventError,
  UnsupportedSourceReplyEventError,
} from "./reply.js";
import {
  buildSafetyWrappedPrompt,
  buildSeparateTaskPrompts,
  PlaceholderLocalSafetyScreener,
  type SafetyAssessment,
  SafetyAssessmentSchema,
  type SafetyScreener,
  type SafetyScreenInput,
  type SafetyWrappedPromptInput,
} from "./safety.js";
import {
  runSnapReviewPreflight,
  SNAP_REVIEW_PROJECTS,
  type SnapReviewProject,
  type SnapReviewTestResult,
} from "./snap-review-preflight.js";
import {
  InvalidSnapWorkspaceInputError,
  type ResolvedSnapWorkspace,
  resolveSnapWorkspace,
  SNAP_ROOT,
  SNAP_WORKSPACES_ROOT,
  SnapWorkspaceCommandError,
  type SnapWorkspaceInput,
  type SnapWorkspaceResolverOptions,
  SnapWorkspaceValidationError,
} from "./snap-workspace.js";
import {
  extractSystemPrSpecialistProof,
  SYSTEM_PR_SPECIALIST_PROOF_MARKER,
  type SystemPrSpecialistProofLookup,
} from "./specialist-proof.js";
import {
  type AgentRequest,
  type AgentRequestStore,
  SourceReplyConflictError,
  type WorkItem,
  WorkItemConflictError,
  type WorkItemKind,
  type WorkItemStore,
} from "./store.js";
import {
  type ChipIdentityConfig,
  DEFAULT_CHIP_IDENTITIES,
  exactPingPongReply,
  hasChipGithubMention,
  isChipAddressed,
  isChipMaintainedPrFeedback,
  isChipPrincipal,
  isChipReviewThreadReply,
  requestText,
} from "./targeting.js";
import { buildWorkItemTitle } from "./thread-title.js";

class RequestAuthorizationError extends Error {}

export const PROGRESS_ACK_DELAY_MS = 10_000;
export const MAINTAINED_PR_FEEDBACK_DEBOUNCE_MS = 30_000;

export interface AgentCoordinatorOptions {
  now?: (() => Date) | undefined;
  progressAckDelayMs?: number | undefined;
  /** Sink adapter name (`hermes` skips the Desktop owner-only gate). */
  sinkAdapterName?: string | undefined;
}

export interface AgentAcceptance {
  addressed: boolean;
  accepted: boolean;
  duplicate?: boolean;
  requestId?: string;
  reason?: string;
}

/**
 * Synchronous ingress gate. It performs only local checks and durable SQLite
 * writes before the provider transport is acknowledged.
 */
export class AgentCoordinator {
  private readonly now: () => Date;
  private readonly progressAckDelayMs: number;
  private readonly sinkAdapterName: string | undefined;

  constructor(
    private readonly people: PeopleStore,
    private readonly workItems: WorkItemStore,
    private readonly requests: AgentRequestStore,
    private readonly chip: ChipIdentityConfig = DEFAULT_CHIP_IDENTITIES,
    options: AgentCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.progressAckDelayMs = options.progressAckDelayMs ?? PROGRESS_ACK_DELAY_MS;
    this.sinkAdapterName = options.sinkAdapterName;
    if (!Number.isSafeInteger(this.progressAckDelayMs) || this.progressAckDelayMs < 0) {
      throw new TypeError("progressAckDelayMs must be a non-negative safe integer");
    }
  }

  accept(event: WakeEvent): AgentAcceptance {
    return this.acceptAddressed(event, this.isAddressed(event));
  }

  /**
   * Mentions, review requests, and Chip-authored PR feedback are sufficient.
   * An unmentioned reply in a review thread only addresses Chip when Chip
   * already has a GitHub work item for that PR.
   */
  private isAddressed(event: WakeEvent): boolean {
    if (isChipAddressed(event, this.chip)) return true;
    if (event.source === "github" && event.kind === "pull_request.synchronize") {
      const author = stringPayload(event, "author").trim().toLowerCase();
      const state = stringPayload(event, "state").trim().toLowerCase();
      if (
        author === this.chip.githubHandle.trim().toLowerCase() ||
        state === "closed" ||
        event.payload.merged === true
      ) {
        return false;
      }
      return this.hasGithubPrWorkItem(event);
    }
    return isChipReviewThreadReply(event) && this.hasGithubPrWorkItem(event);
  }

  private hasGithubPrWorkItem(event: WakeEvent): boolean {
    return correlationAliases(event, "").some(
      (alias) => this.workItems.findByAlias("correlation", alias.kind, alias.key) !== null,
    );
  }

  /**
   * Accept an anchored, dispatcher-owned Codex/GPT override from Slack. This
   * skips only the repeat @Chip mention required in channel threads; provider
   * authentication, principal enrollment, policy, reply target, and dedup are
   * all checked by the same ordinary Codex path below.
   */
  acceptSlackDispatcherOverride(event: WakeEvent): AgentAcceptance {
    return this.acceptAddressed(event, isAuthenticatedSlackHumanMessage(event));
  }

  private acceptAddressed(event: WakeEvent, addressed: boolean): AgentAcceptance {
    if (!addressed) return { addressed: false, accepted: false };
    if (isChipPrincipal(event, this.chip)) {
      return { addressed: true, accepted: false, reason: "self-event" };
    }
    if (event.source === "gmail" && !stringPayload(event, "rfcMessageId")) {
      return {
        addressed: true,
        accepted: false,
        reason: "Gmail addressed request requires payload.rfcMessageId",
      };
    }
    const person = this.resolvePerson(event);
    if (!person) return { addressed: true, accepted: false, reason: "principal-not-enrolled" };
    const policy = effectivePolicy(this.people, person.id);
    const denied = chipDispatchDenied(policy, this.sinkAdapterName);
    if (denied) {
      return { addressed: true, accepted: false, reason: denied };
    }
    const text = requestText(event);
    const executionProfile = enforceGithubPrReviewEffort(event, parseExecutionProfile(text));
    const maintainedPrFeedback = isChipMaintainedPrFeedback(event, this.chip);
    const unmentionedThreadReply =
      isChipReviewThreadReply(event) &&
      !maintainedPrFeedback &&
      !hasChipGithubMention(event, this.chip);
    const debounceFeedback = maintainedPrFeedback || unmentionedThreadReply;
    const acceptedAt = this.now();
    let ackSpec: ReturnType<typeof buildAckSpec>;
    try {
      // Validate and freeze the exact provider response target before accept.
      // Supported reactions remain dormant until the ten-second deadline.
      ackSpec = buildAckSpec(event, person.nickname);
    } catch (error) {
      if (error instanceof InvalidAckEventError || error instanceof UnsupportedAckEventError) {
        return { addressed: true, accepted: false, reason: error.message };
      }
      throw error;
    }
    let item: WorkItem;
    try {
      item = this.provisionalWorkItem(event, person);
    } catch (error) {
      return {
        addressed: true,
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const deferAck = isLinearStopRequest(event);
    const delayedProgressAck = !deferAck && supportsProgressAck(event);
    const progressAckNotBefore = delayedProgressAck
      ? new Date(acceptedAt.getTime() + this.progressAckDelayMs).toISOString()
      : undefined;
    const requestNotBefore = debounceFeedback
      ? new Date(acceptedAt.getTime() + MAINTAINED_PR_FEEDBACK_DEBOUNCE_MS).toISOString()
      : undefined;
    const accepted = this.requests.accept({
      sourceId: event.sourceId ?? `${event.source}:default`,
      event,
      personId: person.id,
      workItemId: item.id,
      requestText: text,
      executionProfile,
      dedup: requestDedupKey(event),
      ...(debounceFeedback
        ? {
            coalesceKey: maintainedPrFeedback
              ? maintainedPrFeedbackKey(event)
              : reviewThreadReplyKey(event),
            requestNotBefore,
          }
        : {}),
      ...(deferAck
        ? { ack: ackSpec, deferAck: true }
        : delayedProgressAck
          ? { ack: ackSpec, ackNotBefore: progressAckNotBefore }
          : {}),
    });
    return {
      addressed: true,
      accepted: true,
      duplicate: accepted.duplicate,
      requestId: accepted.request.id,
    };
  }

  private resolvePerson(event: WakeEvent): Person | null {
    const principal = event.principal;
    if (!principal) return null;
    if (event.source === "gmail") {
      // An arbitrary From header is not authorization. Gmail must report a
      // passing aligned DMARC result before an enrolled email alias is used.
      if (event.payload.authenticated !== true || !principal.email) return null;
      return this.people.resolveEmail(principal.email);
    }
    return (
      this.people.resolveIdentity(principal.provider, principal.tenantId, principal.subjectId)
        ?.person ?? null
    );
  }

  private provisionalWorkItem(event: WakeEvent, person: Person): WorkItem {
    const aliases = correlationAliases(event, person.id);
    const matches = new Map<string, WorkItem>();
    for (const alias of aliases) {
      const item = this.workItems.findByAlias("correlation", alias.kind, alias.key);
      if (item) matches.set(item.id, item);
    }
    if (matches.size > 1) {
      throw new WorkItemConflictError("source aliases point at different work items");
    }
    let item = matches.values().next().value;
    if (!item) {
      const nativeLinear = linearIssueFromEvent(event);
      const first = nativeLinear
        ? {
            kind: "linear" as const,
            key: linearKey(nativeLinear),
            title: nativeLinear.identifier,
          }
        : aliases[0];
      if (!first) throw new Error("event has no stable conversation identity");
      item = this.workItems.getOrCreate({
        kind: workItemKind(first.kind),
        key: first.key,
        title: buildWorkItemTitle(event, person, nativeLinear),
      });
    }
    for (const alias of aliases) bindAlias(this.workItems, item.id, alias);
    return item;
  }
}

export interface GithubReviewStatus {
  summary: string;
  url?: string | undefined;
}

export type SystemPrPreflight =
  | {
      mode: "full-review";
      workspace: ResolvedSnapWorkspace;
      tests: SnapReviewTestResult;
      priorReviewArtifact: boolean;
    }
  | {
      mode: "test-failure-only";
      workspace: ResolvedSnapWorkspace;
      tests: SnapReviewTestResult;
      priorReviewArtifact: boolean;
    }
  | { mode: "workspace-failure"; reason: string };

export interface AgentDispatchWorkerOptions {
  tickMs?: number;
  /** Maximum number of unrelated work items submitted concurrently. */
  maxConcurrentRequests?: number;
  now?: () => Date;
  safetyScreener?: SafetyScreener;
  parentReportFence?: ParentReportFence;
  resolveWorkspace?: (
    input: SnapWorkspaceInput,
    options?: Pick<SnapWorkspaceResolverOptions, "signal">,
  ) => ReturnType<typeof resolveSnapWorkspace>;
  runReviewPreflight?: (
    workspace: Pick<ResolvedSnapWorkspace, "ticket" | "cwd">,
    options?: { signal?: AbortSignal | undefined },
  ) => Promise<SnapReviewTestResult>;
  onReplyQueued?: (() => void) | undefined;
  /**
   * Path D: find an existing Hermes session for this GitHub PR / Linear ticket.
   * Tests inject a stub. Production reads ~/.hermes/state.db + process list.
   */
  hermesSessionLookup?: (ref: HermesWorkRef) => HermesSessionLookup;
  /** Reads the existing PR-body status for duplicate GitHub rereview requests. */
  reviewStatusLookup?: (
    event: WakeEvent,
    signal?: AbortSignal | undefined,
  ) => Promise<GithubReviewStatus | null>;
  /** Creates or refreshes the PR-body pickup status. */
  reviewStatusEnsure?: (
    event: WakeEvent,
    signal?: AbortSignal | undefined,
  ) => Promise<GithubReviewStatus | null>;
  reviewStatusUpdate?: (
    event: WakeEvent,
    update: GithubReviewBodyUpdate,
    signal?: AbortSignal | undefined,
  ) => Promise<GithubReviewStatus | null>;
  /** Verifies that a formal review request produced a GitHub review or status artifact. */
  reviewArtifactLookup?: (
    event: WakeEvent,
    expectation: GithubReviewArtifactExpectation,
    signal?: AbortSignal | undefined,
  ) => Promise<boolean>;
  /** Returns Chip's latest submitted review for live-HEAD coverage decisions. */
  reviewCommitLookup?: (
    event: WakeEvent,
    signal?: AbortSignal | undefined,
  ) => Promise<ChipReviewCommit | null>;
  /** Verifies a full-review proof against the private specialist coordinator state. */
  specialistProofLookup?: SystemPrSpecialistProofLookup;
}

/** Correlates, provisions, and submits accepted requests independently of acknowledgments. */
export class AgentDispatchWorker {
  private readonly tickMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly now: () => Date;
  private readonly safetyScreener: SafetyScreener;
  private readonly workspaceResolver: NonNullable<AgentDispatchWorkerOptions["resolveWorkspace"]>;
  private readonly reviewPreflightRunner: NonNullable<
    AgentDispatchWorkerOptions["runReviewPreflight"]
  >;
  private readonly parentReportFence: ParentReportFence;
  private readonly onReplyQueued: () => void;
  private readonly hermesSessionLookup: (ref: HermesWorkRef) => HermesSessionLookup;
  private readonly reviewStatusLookup: NonNullable<
    AgentDispatchWorkerOptions["reviewStatusLookup"]
  >;
  private readonly reviewStatusEnsure: NonNullable<
    AgentDispatchWorkerOptions["reviewStatusEnsure"]
  >;
  private readonly reviewStatusUpdate: NonNullable<
    AgentDispatchWorkerOptions["reviewStatusUpdate"]
  >;
  private readonly reviewArtifactLookup: NonNullable<
    AgentDispatchWorkerOptions["reviewArtifactLookup"]
  >;
  private readonly reviewCommitLookup: NonNullable<
    AgentDispatchWorkerOptions["reviewCommitLookup"]
  >;
  private readonly specialistProofLookup: NonNullable<
    AgentDispatchWorkerOptions["specialistProofLookup"]
  >;
  private readonly activeWorkItems = new Set<string>();
  private readonly activeRequests = new Map<string, Promise<void>>();
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly supersedingWorkItems = new Set<string>();
  private readonly canonicalWorkItemLocks = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopTicking = false;
  private stopping = false;

  constructor(
    private readonly people: PeopleStore,
    private readonly workItems: WorkItemStore,
    private readonly requests: AgentRequestStore,
    private readonly directory: LinearIssueDirectory,
    private readonly adapter: AgentAdapter,
    private readonly logger: Logger,
    options: AgentDispatchWorkerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 250;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? 4;
    if (!Number.isSafeInteger(this.maxConcurrentRequests) || this.maxConcurrentRequests < 1) {
      throw new Error("maxConcurrentRequests must be a positive safe integer");
    }
    this.now = options.now ?? (() => new Date());
    this.safetyScreener = options.safetyScreener ?? new PlaceholderLocalSafetyScreener();
    this.workspaceResolver = options.resolveWorkspace ?? resolveSnapWorkspace;
    this.reviewPreflightRunner =
      options.runReviewPreflight ??
      ((workspace, preflightOptions) =>
        runSnapReviewPreflight(workspace, { signal: preflightOptions?.signal }));
    this.parentReportFence = options.parentReportFence ?? new ParentReportFence();
    this.onReplyQueued = options.onReplyQueued ?? (() => {});
    this.hermesSessionLookup =
      options.hermesSessionLookup ??
      (() => ({ hits: [], runningIds: new Set(), cmdlineBusy: false }));
    this.reviewStatusLookup = options.reviewStatusLookup ?? (async () => null);
    this.reviewStatusEnsure = options.reviewStatusEnsure ?? (async () => null);
    this.reviewStatusUpdate = options.reviewStatusUpdate ?? (async () => null);
    this.reviewArtifactLookup = options.reviewArtifactLookup ?? (async () => false);
    this.reviewCommitLookup = options.reviewCommitLookup ?? (async () => null);
    this.specialistProofLookup = options.specialistProofLookup ?? (async () => false);
  }

  start(): number {
    if (this.timer) return 0;
    this.stopping = false;
    const recovered = this.requests.resetInFlight();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    return recovered;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.activeAbortControllers.values()) controller.abort();
    await Promise.allSettled([...this.activeRequests.values()]);
  }

  wake(): void {
    if (this.stopping) return;
    // Stop signals have an independent lane so an unrelated slow workspace or
    // Desktop delivery cannot keep a user's halt request behind the main loop.
    void this.tickStops();
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    await this.tickStops();
    if (this.ticking) return;
    this.ticking = true;
    const launched: Array<Promise<void>> = [];
    try {
      const ready = this.requests.listReady(this.now().toISOString());
      const claimedWorkItems = new Set<string>();
      for (const request of ready) {
        if (isLinearStopRequest(request.event)) continue;
        const current = this.requests.get(request.id);
        if (!current || (current.status !== "acknowledged" && current.status !== "held")) {
          continue;
        }
        if (
          this.activeWorkItems.has(current.workItemId) &&
          isGithubReviewStartRequest(current.event)
        ) {
          if (this.supersedingWorkItems.has(current.workItemId)) continue;
          const active = this.activeRequestForWorkItem(current.workItemId, current.id);
          if (active && githubReviewHeadMoved(active.event, current.event)) {
            launched.push(this.launchHeadMoveSupersede(current, active));
          } else {
            launched.push(this.launchReviewAlreadyRunning(current));
          }
        }
      }

      const available = this.maxConcurrentRequests - this.activeWorkItems.size;
      let normalLaunched = 0;
      if (available > 0) {
        for (const request of ready) {
          if (isLinearStopRequest(request.event)) continue;
          const current = this.requests.get(request.id);
          if (!current || (current.status !== "acknowledged" && current.status !== "held")) {
            continue;
          }
          if (
            this.activeWorkItems.has(request.workItemId) ||
            claimedWorkItems.has(request.workItemId)
          ) {
            continue;
          }
          claimedWorkItems.add(request.workItemId);
          launched.push(this.launch(current, true));
          normalLaunched++;
          if (normalLaunched >= available) break;
        }
      }
    } finally {
      // Release before awaiting process() so a later accept can launch another
      // work item. Holding this lock across a Hermes turn serialized all Chip
      // work (ENG-4673 H1 list sat behind ENG-4586 for 20+ minutes).
      this.ticking = false;
    }
    await Promise.all(launched);
  }

  private async tickStops(): Promise<void> {
    if (this.stopping || this.stopTicking) return;
    this.stopTicking = true;
    const launched: Array<Promise<void>> = [];
    try {
      const ready = this.requests
        .listReady(this.now().toISOString())
        .filter((request) => isLinearStopRequest(request.event));
      for (const request of ready) {
        const current = this.requests.get(request.id);
        if (!current || (current.status !== "acknowledged" && current.status !== "held")) {
          continue;
        }
        launched.push(this.launch(current, false));
      }
    } finally {
      this.stopTicking = false;
    }
    await Promise.all(launched);
  }

  private launch(request: AgentRequest, serializeWorkItem: boolean): Promise<void> {
    const existing = this.activeRequests.get(request.id);
    if (existing) return existing;
    if (serializeWorkItem) this.activeWorkItems.add(request.workItemId);
    const controller = new AbortController();
    this.activeAbortControllers.set(request.id, controller);
    const operation = this.process(request, controller.signal).finally(() => {
      this.activeRequests.delete(request.id);
      this.activeAbortControllers.delete(request.id);
      if (serializeWorkItem) this.activeWorkItems.delete(request.workItemId);
    });
    this.activeRequests.set(request.id, operation);
    return operation;
  }

  private launchReviewAlreadyRunning(request: AgentRequest): Promise<void> {
    const existing = this.activeRequests.get(request.id);
    if (existing) return existing;
    const controller = new AbortController();
    this.activeAbortControllers.set(request.id, controller);
    const operation = this.processReviewAlreadyRunning(request, controller.signal).finally(() => {
      this.activeRequests.delete(request.id);
      this.activeAbortControllers.delete(request.id);
    });
    this.activeRequests.set(request.id, operation);
    return operation;
  }

  private activeRequestForWorkItem(workItemId: string, excludeRequestId: string): AgentRequest | null {
    for (const requestId of this.activeRequests.keys()) {
      if (requestId === excludeRequestId) continue;
      const request = this.requests.get(requestId);
      if (request?.workItemId === workItemId) return request;
    }
    return null;
  }

  private launchHeadMoveSupersede(request: AgentRequest, active: AgentRequest): Promise<void> {
    this.supersedingWorkItems.add(request.workItemId);
    return (async () => {
      const newHead = stringPayload(request.event, "headSha").trim().toLowerCase();
      const message = `superseded by PR HEAD ${newHead}`;
      this.requests.supersedeRequest(active.id, message);
      this.activeAbortControllers.get(active.id)?.abort(new Error(message));
      const activeOperation = this.activeRequests.get(active.id);
      if (activeOperation) await activeOperation;
      const current = this.requests.get(request.id);
      if (!current || (current.status !== "acknowledged" && current.status !== "held")) return;
      await this.launch(current, true);
    })().finally(() => this.supersedingWorkItems.delete(request.workItemId));
  }

  private async stageReviewAlreadyRunning(
    request: AgentRequest,
    item: WorkItem,
    signal: AbortSignal,
  ): Promise<void> {
    if (isSystemPrReviewEvent(request.event)) {
      this.requests.finalizeImmediateCompletion({
        requestId: request.id,
        codexThreadId: item.codexThreadId || `review-in-progress-${request.id}`,
        status: "completed",
      });
      this.logger.info(
        { request: request.id, workItem: item.id, session: item.codexThreadId },
        "ignored duplicate system PR review while the canonical parent is active",
      );
      return;
    }
    const status =
      (await this.reviewStatusLookup(request.event, signal).catch(() => null)) ??
      (await this.reviewStatusEnsure(request.event, signal).catch(() => null));
    signal.throwIfAborted();
    const summary = status?.summary.trim() || "review in progress";
    const url = status?.url?.trim() || githubPullRequestUrl(request.event);
    const sender = stringPayload(request.event, "senderLogin");
    const text = `${sender ? `@${sender} ` : ""}I’m already reviewing this PR. Current status: ${summary}${url ? `\n\n${url}` : ""}`;
    const spec = buildGithubReviewProgressReplySpec(request.event, text);
    this.requests.stageImmediateFinalReply({
      requestId: request.id,
      codexThreadId: item.codexThreadId || `review-in-progress-${request.id}`,
      spec,
    });
    this.onReplyQueued();
    this.logger.info(
      { request: request.id, workItem: item.id, session: item.codexThreadId },
      "reported already-running GitHub review",
    );
  }

  private async processReviewAlreadyRunning(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.requests.setStatus(request.id, "dispatching");
    try {
      signal.throwIfAborted();
      const item = this.workItems.get(request.workItemId);
      if (!item) throw new Error(`work item ${request.workItemId} disappeared`);
      await this.stageReviewAlreadyRunning(request, item, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.requests.setStatus(request.id, "failed", message);
      this.logger.warn({ request: request.id, err: message }, "review progress reply failed");
    }
  }

  private async process(request: AgentRequest, signal: AbortSignal): Promise<void> {
    this.requests.setStatus(request.id, "dispatching");
    try {
      signal.throwIfAborted();
      const person = this.people.get(request.personId);
      if (!person?.enabled) {
        throw new RequestAuthorizationError("person is no longer authorized");
      }
      const policy = effectivePolicy(this.people, person.id);
      const denied = chipDispatchDenied(policy, this.adapter.name);
      if (denied === "policy-denied") {
        throw new RequestAuthorizationError("person is no longer authorized for Codex Desktop");
      }
      if (denied) {
        throw new RequestAuthorizationError(
          "person's role cannot be enforced by the Codex Desktop adapter",
        );
      }
      if (!policy) {
        throw new RequestAuthorizationError("person is no longer authorized");
      }
      if (isLinearStopRequest(request.event)) {
        await this.processStop(request, signal);
        return;
      }
      const correlation = await this.correlate(request, person);
      signal.throwIfAborted();
      let item = this.workItems.get(request.workItemId);
      if (!item) throw new Error(`work item ${request.workItemId} disappeared`);
      if (correlation.canonical.kind === "linear") {
        item = this.workItems.promoteToLinear(
          item.id,
          correlation.canonical.key,
          correlation.linearIssue
            ? buildWorkItemTitle(request.event, person, correlation.linearIssue)
            : item.title,
        );
      }
      for (const key of correlation.aliases) {
        bindAlias(this.workItems, item.id, aliasFromKey(key));
      }
      await this.withCanonicalWorkItemLock(item.id, () =>
        this.dispatchCorrelatedRequest(
          request,
          person,
          policy,
          correlation.linearIssue,
          item.id,
          signal,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.requests.get(request.id);
      if (
        current?.status === "failed" &&
        current.error === "superseded by a later authenticated stop request"
      ) {
        return;
      }
      if (signal.aborted) {
        if (current?.status === "dispatching") {
          this.requests.setStatus(request.id, "acknowledged");
        }
        return;
      }
      const workspaceFailure = isTerminalWorkspaceFailure(error);
      if (
        error instanceof RequestAuthorizationError ||
        error instanceof PolicyConfigurationError ||
        error instanceof PermanentError ||
        error instanceof SourceReplyConflictError ||
        error instanceof WorkItemConflictError ||
        workspaceFailure
      ) {
        if (isLinearStopRequest(request.event)) {
          const ack = this.requests.ackForRequest(request.id);
          if (ack?.status !== "held") {
            throw new Error(`authenticated stop ${request.id} is missing its held acknowledgment`);
          }
          this.requests.finalizeDeferredRequest({
            requestId: request.id,
            status: "failed",
            error: message,
            payload: {
              ...ack.payload,
              text: "I couldn't confirm that the Codex Desktop task stopped.",
              contentType: "error",
              ephemeral: false,
            },
          });
        } else if (workspaceFailure) {
          try {
            const spec = buildFinalReplySpec(
              request.event,
              workspacePreparationFailureReply(request.id),
            );
            this.requests.stageTerminalFailureReply({
              requestId: request.id,
              error: message,
              spec,
            });
            this.onReplyQueued();
          } catch (replyError) {
            if (
              replyError instanceof UnsupportedSourceReplyEventError ||
              replyError instanceof InvalidSourceReplyEventError
            ) {
              this.requests.setStatus(request.id, "failed", message);
              this.logger.warn(
                {
                  request: request.id,
                  err: replyError.message,
                  provider: request.event.source,
                },
                "workspace failure has no valid provider reply target",
              );
            } else {
              throw replyError;
            }
          }
        } else {
          this.requests.setStatus(request.id, "failed", message);
        }
        this.logger.warn(
          {
            request: request.id,
            err: message,
            ...(error instanceof SnapWorkspaceCommandError
              ? {
                  workspaceCommand: {
                    code: error.diagnostics.code,
                    signal: error.diagnostics.signal,
                  },
                }
              : {}),
          },
          "request failed permanently",
        );
        return;
      }
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(request.attemptCount, 6));
      this.requests.hold(request.id, message, new Date(this.now().getTime() + delay).toISOString());
      this.logger.warn({ request: request.id, err: message, retryInMs: delay }, "request held");
    }
  }

  private async dispatchCorrelatedRequest(
    request: AgentRequest,
    person: Person,
    policy: EffectivePolicy,
    linearIssue: ResolvedLinearIssue | undefined,
    workItemId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let item = this.workItems.get(workItemId);
    if (!item) throw new Error(`work item ${workItemId} disappeared after correlation`);
    if (this.requests.hasLaterStop(request.id, item.id)) {
      this.requests.supersedeRequest(
        request.id,
        "superseded by a later authenticated stop request",
      );
      this.logger.info(
        { request: request.id, workItem: item.id },
        "request superseded before Codex Desktop submission",
      );
      return;
    }
    const systemPrReview = isSystemPrReviewEvent(request.event);
    const screenInput: SafetyScreenInput = {
      principal: {
        id: person.id,
        nickname: person.nickname,
        roleName: person.roleName,
      },
      source: request.event.source,
      sourceDeliveryId: request.sourceDeliveryId,
      canonicalWorkItem: item.canonicalKey,
      requestText: request.requestText,
      providerContext: {
        summary: request.event.summary,
        payload: request.event.payload,
      },
    };
    const assessment = SafetyAssessmentSchema.parse(
      await this.safetyScreener.screen(screenInput, { signal }),
    );
    signal.throwIfAborted();
    this.logger.info(
      {
        request: request.id,
        safetyPolicyVersion: assessment.policyVersion,
        safetyScreenMode: assessment.mode,
        safetyScreenEnforcing: assessment.enforcing,
        safetyDecision: assessment.decision,
        safetyReasonCodes: assessment.reasonCodes,
      },
      "safety screen completed",
    );
    if (assessment.decision === "deny") {
      throw new PermanentError(
        `safety screen denied request (${assessment.reasonCodes.join(", ") || "no reason"})`,
      );
    }
    if (assessment.decision === "hold") {
      throw new Error(
        `safety screen held request (${assessment.reasonCodes.join(", ") || "no reason"})`,
      );
    }
    const reuse = this.hermesReuseDecision(request, item, linearIssue);
    if (request.event.kind === "pull_request.synchronize") {
      const headSha = stringPayload(request.event, "headSha").trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/u.test(headSha)) {
        throw new Error("PR synchronize is missing one exact full HEAD SHA");
      }
      const review = await this.reviewCommitLookup(request.event, signal);
      signal.throwIfAborted();
      if (review && chipReviewCoversHead({ ...review, headSha })) {
        this.requests.finalizeImmediateCompletion({
          requestId: request.id,
          codexThreadId: item.codexThreadId ?? `review-head-covered-${request.id}`,
          status: "completed",
        });
        this.logger.info(
          { request: request.id, workItem: item.id, headSha },
          "ignored PR synchronize already covered by Chip",
        );
        return;
      }
      const requestedReviewerLogins = Array.isArray(
        request.event.payload.requestedReviewerLogins,
      )
        ? request.event.payload.requestedReviewerLogins
        : [];
      const chipStillRequested = requestedReviewerLogins.some(
        (login) =>
          typeof login === "string" &&
          login.trim().toLowerCase() === DEFAULT_CHIP_IDENTITIES.githubHandle,
      );
      const reviewInFlight = reuse?.action === "ignore" || reuse?.action === "hold";
      if (!review && !chipStillRequested && !reviewInFlight) {
        this.requests.finalizeImmediateCompletion({
          requestId: request.id,
          codexThreadId: item.codexThreadId ?? `review-head-unrequested-${request.id}`,
          status: "completed",
        });
        this.logger.info(
          { request: request.id, workItem: item.id, headSha },
          "ignored unrequested PR synchronize without prior Chip review",
        );
        return;
      }
    }
    if (reuse?.action === "ignore") {
      await this.stageReviewAlreadyRunning(request, item, signal);
      return;
    }
    if (reuse?.action === "hold") {
      throw new BusyError(`hermes session ${reuse.sessionId} in flight`);
    }
    if (request.event.kind === "pull_request.review_requested") {
      const status = await this.reviewStatusEnsure(request.event, signal);
      if (systemPrReview && !status) {
        throw new Error("system PR pickup status could not be verified in the pull request body");
      }
    }
    // Exact-head clone/tests belong to Hermes. Do not boot a managed workspace
    // or stamp workspace-failed before the review session starts.
    const systemPreflight = skippedSystemPrPreflight();
    const resumeId = reuse?.action === "resume" ? reuse.sessionId : item.codexThreadId;
    const existingOrchestration = this.requests.orchestrationForRequest(request.id);
    const resumeMaintainedPrSession =
      Boolean(resumeId) && isChipMaintainedPrFeedback(request.event);
    const cwd = systemPrReview
      ? SNAP_ROOT
      : existingOrchestration
        ? existingOrchestration.cwd
        : resumeMaintainedPrSession
          ? (item.cwd ?? SNAP_ROOT)
          : await this.resolveCwd(linearIssue, item, signal);
    if (systemPreflight && existingOrchestration && existingOrchestration.cwd !== cwd) {
      throw new WorkItemConflictError("persisted PR orchestration has a stale workspace identity");
    }
    signal.throwIfAborted();
    if (!existingOrchestration || systemPreflight) this.workItems.setWorkspace(item.id, cwd);
    item = this.workItems.get(item.id) ?? item;
    if (this.requests.hasLaterStop(request.id, item.id)) {
      this.requests.supersedeRequest(
        request.id,
        "superseded by a later authenticated stop request",
      );
      return;
    }
    const executionProfile = enforceGithubPrReviewEffort(request.event, request.executionProfile);
    const dispatchRequest =
      executionProfile === request.executionProfile ? request : { ...request, executionProfile };
    const execution = executionPlan(
      executionProfile,
      this.adapter.name === "codex-desktop" && !item.codexThreadId,
      item.title,
      Boolean(existingOrchestration),
    );
    const promptInput = authenticatedPromptInput(
      dispatchRequest,
      person,
      item,
      policy,
      assessment,
      execution,
      systemPreflight && systemPreflight.mode !== "workspace-failure" ? systemPreflight : undefined,
    );
    if (execution.delegateToSeparateTask) {
      await this.dispatchSeparateRequest(dispatchRequest, item, promptInput, cwd, policy, signal);
      return;
    }
    // Deterministic health check — never send ping through the agent (avoids
    // chatty model preambles like "Path D is up…").
    const pong = exactPingPongReply(request.requestText);
    if (pong !== null) {
      // Reply staging needs a thread id; never bind ping-* placeholders as the
      // WorkItem Hermes/Codex session (first non-ping turn owns the real bind).
      const threadId = item.codexThreadId ?? `ping-${request.id}`;
      try {
        const spec = buildFinalReplySpec(request.event, pong);
        this.requests.stageImmediateFinalReply({
          requestId: request.id,
          codexThreadId: threadId,
          spec,
        });
        this.onReplyQueued();
        this.logger.info(
          { request: request.id, provider: request.event.source, threadId },
          "answered ping with deterministic pong",
        );
      } catch (error) {
        if (error instanceof UnsupportedSourceReplyEventError) {
          this.requests.finalizeImmediateCompletion({
            requestId: request.id,
            codexThreadId: threadId,
            status: "completed",
          });
        } else if (error instanceof InvalidSourceReplyEventError) {
          this.requests.finalizeImmediateCompletion({
            requestId: request.id,
            codexThreadId: threadId,
            status: "failed",
            error: `cannot queue ping reply: ${error.message}`,
          });
        } else {
          throw error;
        }
      }
      return;
    }
    const prompt = buildSafetyWrappedPrompt(promptInput);
    const options = {
      sandbox: sandboxForPolicy(policy),
      cwd,
      model: execution.currentModel,
      reasoningEffort: execution.currentReasoningEffort,
      idempotencyKey: request.id,
      signal,
      ...(this.adapter.name === "hermes"
        ? {
            hermesSession: buildHermesSessionOptions({
              event: request.event,
              person,
              workItemId: item.id,
              workItemTitle: item.title,
              linearIdentifier: linearIssue?.identifier,
              linearTitle: linearIssue?.title,
            }),
          }
        : {}),
    };
    // Bind before awaiting the turn so a host reboot can resume this session
    // instead of minting a second review (session_key stamp is the other half).
    if (resumeId) this.workItems.setCodexThread(item.id, resumeId);
    const result = resumeId
      ? await this.adapter.deliverToThread(resumeId, prompt, options)
      : await this.adapter.startThread(prompt, options);
    this.workItems.setCodexThread(item.id, result.threadId);
    if (this.requests.hasLaterStop(request.id, item.id)) {
      this.requests.supersedeRequest(
        request.id,
        "superseded by a later authenticated stop request",
      );
      this.logger.info(
        { request: request.id, workItem: item.id, threadId: result.threadId },
        "submitted turn awaits the authenticated stop lane",
      );
      return;
    }
    signal.throwIfAborted();
    if (result.correlationMarker) {
      if (systemPrReview) {
        throw new Error(
          "system PR review completion requires an immediate host-verifiable final response",
        );
      }
      this.requests.bindSubmittedCompletion({
        requestId: request.id,
        codexThreadId: result.threadId,
        ...(result.turnId ? { codexTurnId: result.turnId } : {}),
        correlationMarker: result.correlationMarker,
      });
    } else if (result.finalResponse !== undefined) {
      let specialistStatus: "PASS" | "REPAIR" | "ESCALATE" | undefined;
      if (systemPrReview && systemPreflight?.mode === "full-review") {
        const expectation = {
          reviewKey: systemPrReviewKey(request.event),
          headSha: systemPreflight.tests.headSha,
          invocationId: systemPrInvocationId(request),
        };
        const proof = extractSystemPrSpecialistProof(result.finalResponse, expectation);
        const trusted = proof ? await this.specialistProofLookup(proof).catch(() => false) : false;
        if (!trusted) {
          await this.updateSystemPrCompletionStatus(
            request.event,
            systemPreflight,
            "specialists-incomplete",
            "specialist proof incomplete; retrying",
            signal,
            "system PR specialist hold status could not be verified",
          );
          throw new Error("system PR review did not produce a trusted exact-head specialist proof");
        }
        specialistStatus = proof?.status;
      }
      if (systemPrReview && systemPreflight && systemPreflight.mode !== "workspace-failure") {
        if (
          systemPreflight.mode === "test-failure-only" &&
          result.finalResponse.includes(SYSTEM_PR_SPECIALIST_PROOF_MARKER)
        ) {
          await this.updateSystemPrCompletionStatus(
            request.event,
            systemPreflight,
            "review-incomplete",
            "unexpected specialist proof in test-failure-only mode; retrying",
            signal,
            "system PR test-failure proof rejection status could not be verified",
          );
          throw new Error("test-failure-only review returned prohibited specialist evidence");
        }
        const hasReviewArtifact = await this.reviewArtifactLookup(
          request.event,
          reviewArtifactExpectation(request, systemPreflight, specialistStatus),
          signal,
        );
        if (!hasReviewArtifact) {
          await this.updateSystemPrCompletionStatus(
            request.event,
            systemPreflight,
            "review-incomplete",
            "GitHub review artifact missing; retrying",
            signal,
            "system PR review hold status could not be verified",
          );
          throw new Error("system PR review completed without a verified GitHub review artifact");
        }
        if (specialistStatus === "REPAIR" || specialistStatus === "ESCALATE") {
          await this.updateSystemPrCompletionStatus(
            request.event,
            systemPreflight,
            "specialists-waiting",
            specialistStatus === "REPAIR"
              ? "specialist changes required"
              : "specialist reconciliation required",
            signal,
            "system PR specialist verdict status could not be verified",
          );
        }
        this.requests.finalizeImmediateCompletion({
          requestId: request.id,
          codexThreadId: result.threadId,
          ...(result.turnId ? { codexTurnId: result.turnId } : {}),
          status: "completed",
        });
        this.logger.info(
          { request: request.id, threadId: result.threadId, hasReviewArtifact },
          "GitHub review request completed with a verified review artifact",
        );
      } else if (systemPrReview) {
        this.requests.finalizeImmediateCompletion({
          requestId: request.id,
          codexThreadId: result.threadId,
          ...(result.turnId ? { codexTurnId: result.turnId } : {}),
          status: "completed",
        });
      } else {
        try {
          const spec = buildFinalReplySpec(request.event, result.finalResponse);
          this.requests.stageImmediateFinalReply({
            requestId: request.id,
            codexThreadId: result.threadId,
            ...(result.turnId ? { codexTurnId: result.turnId } : {}),
            spec,
          });
        } catch (error) {
          if (error instanceof UnsupportedSourceReplyEventError) {
            this.requests.finalizeImmediateCompletion({
              requestId: request.id,
              codexThreadId: result.threadId,
              ...(result.turnId ? { codexTurnId: result.turnId } : {}),
              status: "completed",
            });
            this.logger.info(
              {
                request: request.id,
                provider: request.event.source,
                threadId: result.threadId,
                turnId: result.turnId,
              },
              "Codex request completed; final answer remains in Codex for this provider",
            );
          } else if (error instanceof InvalidSourceReplyEventError) {
            this.requests.finalizeImmediateCompletion({
              requestId: request.id,
              codexThreadId: result.threadId,
              ...(result.turnId ? { codexTurnId: result.turnId } : {}),
              status: "failed",
              error: `cannot queue final source reply: ${error.message}`,
            });
            this.logger.warn(
              { request: request.id, err: error.message },
              "completed Codex answer has no valid originating reply target",
            );
          } else {
            throw error;
          }
        }
      }
    } else {
      if (this.adapter.name === "codex-desktop") {
        throw new PermanentError("Codex Desktop did not return its durable correlation marker");
      }
      throw new PermanentError(`${this.adapter.name} did not return a final response`);
    }
    await this.syncThreadTitle(item.id, result.threadId);
    this.logger.info(
      {
        request: request.id,
        workItem: item.id,
        threadId: result.threadId,
        turnId: result.turnId,
        model: execution.currentModel,
        reasoningEffort: execution.currentReasoningEffort,
        delegatedToSeparateTask: execution.delegateToSeparateTask,
        completionBound: Boolean(result.correlationMarker || result.finalResponse !== undefined),
      },
      "authorized request submitted to Codex Desktop",
    );
  }

  private async dispatchSeparateRequest(
    request: AgentRequest,
    item: WorkItem,
    promptInput: SafetyWrappedPromptInput,
    cwd: string,
    policy: EffectivePolicy,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.adapter.prepareThread) {
      throw new PermanentError(`${this.adapter.name} cannot host a durable separate Codex task`);
    }
    const prompts = buildSeparateTaskPrompts(promptInput);
    const sandbox = sandboxForPolicy(policy);
    let orchestration = this.requests.beginOrchestration({
      requestId: request.id,
      cwd,
      sandbox,
      childPrompt: prompts.childPrompt,
      childTitle: promptInput.execution.childTitle ?? item.title,
      reportPromptPrefix: prompts.reportPromptPrefix,
      reportPromptSuffix: prompts.reportPromptSuffix,
    });
    if (
      promptInput.githubReviewPreflight &&
      (orchestration.childPrompt !== prompts.childPrompt ||
        orchestration.reportPromptPrefix !== prompts.reportPromptPrefix ||
        orchestration.reportPromptSuffix !== prompts.reportPromptSuffix)
    ) {
      throw new PermanentError(
        "stale system PR orchestration does not match fresh preflight proof",
      );
    }

    let parentThreadId = orchestration.parentThreadId ?? item.codexThreadId;
    if (!parentThreadId) {
      const prepared = await this.adapter.prepareThread({
        sandbox,
        cwd,
        model: promptInput.execution.currentModel,
        reasoningEffort: promptInput.execution.currentReasoningEffort,
        idempotencyKey: `${request.id}:parent-task`,
        signal,
      });
      parentThreadId = prepared.threadId;
    }
    this.workItems.setCodexThread(item.id, parentThreadId);
    orchestration = this.requests.setOrchestrationParent(request.id, parentThreadId);
    await this.syncThreadTitle(item.id, parentThreadId);
    signal.throwIfAborted();
    if (this.requests.hasLaterStop(request.id, item.id)) {
      this.requests.supersedeRequest(
        request.id,
        "superseded by a later authenticated stop request",
      );
      return;
    }

    let childThreadId = orchestration.childThreadId;
    if (!childThreadId) {
      const prepared = await this.adapter.prepareThread({
        sandbox,
        cwd,
        model: request.executionProfile.model,
        reasoningEffort: request.executionProfile.reasoningEffort,
        idempotencyKey: `${request.id}:child-task`,
        signal,
      });
      childThreadId = prepared.threadId;
    }
    orchestration = this.requests.setOrchestrationChild(request.id, childThreadId);
    signal.throwIfAborted();
    if (this.requests.hasLaterStop(request.id, item.id)) {
      this.requests.supersedeRequest(
        request.id,
        "superseded by a later authenticated stop request",
      );
      return;
    }

    const result = await this.adapter.deliverToThread(childThreadId, orchestration.childPrompt, {
      sandbox,
      cwd,
      model: request.executionProfile.model,
      reasoningEffort: request.executionProfile.reasoningEffort,
      idempotencyKey: `${request.id}:child-turn`,
      preparedThread: true,
      signal,
    });
    if (!result.correlationMarker) {
      throw new PermanentError(
        `${this.adapter.name} did not return a durable child correlation marker`,
      );
    }
    if (this.requests.hasLaterStop(request.id, item.id)) {
      this.requests.supersedeRequest(
        request.id,
        "superseded by a later authenticated stop request",
      );
      return;
    }
    signal.throwIfAborted();
    orchestration = this.requests.bindChildSubmission({
      requestId: request.id,
      childThreadId,
      ...(result.turnId ? { childTurnId: result.turnId } : {}),
      correlationMarker: result.correlationMarker,
    });
    // Desktop auto-names a task when its first turn begins, so the durable
    // child title must be asserted only after that turn is bound.
    await this.syncChildTitle(request.id, childThreadId, orchestration.childTitle);
    this.logger.info(
      {
        request: request.id,
        workItem: item.id,
        parentThreadId,
        childThreadId,
        childTurnId: result.turnId,
        model: request.executionProfile.model,
        reasoningEffort: request.executionProfile.reasoningEffort,
      },
      "authorized request submitted to a host-controlled child Codex task",
    );
  }

  private async syncChildTitle(requestId: string, threadId: string, title: string): Promise<void> {
    if (!this.adapter.setThreadTitle) return;
    try {
      await this.adapter.setThreadTitle(threadId, title);
      if (this.adapter.readThreadTitle) {
        const confirmedTitle = await this.adapter.readThreadTitle(threadId);
        if (confirmedTitle !== title) {
          throw new Error(
            `title readback mismatch (expected ${JSON.stringify(title)}, got ${JSON.stringify(confirmedTitle)})`,
          );
        }
        this.requests.confirmChildTitleSynchronized(requestId, threadId, title);
      }
    } catch (error) {
      this.logger.warn(
        {
          request: requestId,
          threadId,
          title,
          err: error instanceof Error ? error.message : String(error),
        },
        "child Codex task title synchronization failed; orchestration remains durable",
      );
    }
  }

  /**
   * Cosmetic metadata is intentionally outside turn delivery. A failed title
   * update remains unsynced for a later retry and can never resubmit a prompt.
   */
  private async syncThreadTitle(workItemId: string, threadId: string): Promise<void> {
    const item = this.workItems.get(workItemId);
    if (!item || item.codexThreadTitle === item.title || !this.adapter.setThreadTitle) return;
    try {
      // Reassert through Codex's metadata API before its own readback confirms
      // the persisted user-facing name. Visible renderer state is separate.
      await this.adapter.setThreadTitle(threadId, item.title);
      if (this.adapter.readThreadTitle) {
        const confirmedTitle = await this.adapter.readThreadTitle(threadId);
        if (confirmedTitle !== item.title) {
          throw new Error(
            `title readback mismatch (expected ${JSON.stringify(item.title)}, got ${JSON.stringify(confirmedTitle)})`,
          );
        }
      }
      if (!this.workItems.confirmCodexThreadTitle(item.id, threadId, item.title)) return;
      this.logger.info(
        { workItem: item.id, threadId, title: item.title },
        "Codex task title synchronized",
      );
    } catch (error) {
      this.logger.warn(
        {
          workItem: item.id,
          threadId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Codex task title synchronization failed; turn delivery remains successful",
      );
    }
  }

  private async withCanonicalWorkItemLock<T>(
    workItemId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.canonicalWorkItemLocks.get(workItemId) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.canonicalWorkItemLocks.set(workItemId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.canonicalWorkItemLocks.get(workItemId) === current) {
        this.canonicalWorkItemLocks.delete(workItemId);
      }
    }
  }

  private async processStop(request: AgentRequest, signal: AbortSignal): Promise<void> {
    let item = this.workItems.get(request.workItemId);
    if (!item) throw new PermanentError(`work item ${request.workItemId} disappeared`);
    const workItemId = item.id;
    const superseded = this.requests.supersedePendingBeforeStop(request.id, workItemId);
    const reportDrain = this.parentReportFence.block(superseded);
    for (const id of superseded) this.activeAbortControllers.get(id)?.abort();
    const interrupt = async (threadId: string): Promise<void> => {
      if (!this.adapter.interruptThread) {
        throw new PermanentError(
          `${this.adapter.name} cannot enforce an authenticated stop request`,
        );
      }
      await this.adapter.interruptThread(threadId);
    };
    const boundThreadIds = (): string[] => {
      const ids = new Set<string>();
      const currentItem = this.workItems.get(workItemId);
      if (currentItem?.codexThreadId) ids.add(currentItem.codexThreadId);
      for (const id of superseded) {
        const orchestration = this.requests.orchestrationForRequest(id);
        if (orchestration?.parentThreadId) ids.add(orchestration.parentThreadId);
        if (orchestration?.childThreadId) ids.add(orchestration.childThreadId);
      }
      return [...ids];
    };

    // Interrupt an existing turn immediately, then wait for any older request
    // that was already inside workspace/Desktop delivery. If that request was
    // starting a new task, reload its persisted id and interrupt it before
    // releasing Linear's stop confirmation.
    for (const threadId of boundThreadIds()) await interrupt(threadId);
    const active = superseded
      .map((id) => this.activeRequests.get(id))
      .filter((operation): operation is Promise<void> => Boolean(operation));
    await Promise.allSettled([...active, reportDrain.settled]);
    signal.throwIfAborted();
    item = this.workItems.get(item.id) ?? item;
    // A start-turn can race after the first interrupt. Repeat the stop after
    // every older in-flight delivery settles; Desktop's stop is idempotent.
    if (active.length > 0 || reportDrain.activeCount > 0) {
      for (const threadId of boundThreadIds()) await interrupt(threadId);
    }

    this.requests.finalizeDeferredRequest({ requestId: request.id, status: "completed" });
    this.logger.info(
      {
        request: request.id,
        workItem: item.id,
        threadIds: boundThreadIds(),
        superseded: superseded.length,
        drainedParentReports: reportDrain.activeCount,
      },
      "authenticated stop request applied",
    );
  }

  private async correlate(request: AgentRequest, person: Person) {
    const event = request.event;
    const references = extractLinearReferences({
      text: [
        request.requestText,
        stringPayload(event, "title"),
        stringPayload(event, "subject"),
        stringPayload(event, "body"),
      ]
        .filter(Boolean)
        .join("\n"),
      urls: [
        stringPayload(event, "url"),
        stringPayload(event, "pullRequestUrl"),
        stringPayload(event, "issueUrl"),
      ].filter(Boolean),
      branches: [stringPayload(event, "branch"), stringPayload(event, "branchName")].filter(
        Boolean,
      ),
    });
    const githubPrimary =
      event.source === "github"
        ? primaryLinearIdentifierForGithubPr({
            title: stringPayload(event, "title"),
            branch: stringPayload(event, "branch") || stringPayload(event, "branchName"),
          })
        : undefined;
    const linearMatches = new Map<string, ResolvedLinearIssue>();
    const addLinearMatch = (issue: ResolvedLinearIssue, evidence: string): void => {
      const key = `${issue.organizationId}\0${issue.issueId}`;
      const existing = linearMatches.get(key);
      if (
        existing &&
        (existing.identifier !== issue.identifier ||
          (existing.branchName && issue.branchName && existing.branchName !== issue.branchName))
      ) {
        throw new WorkItemConflictError(
          `conflicting Linear identity for ${evidence}: ${existing.identifier} vs ${issue.identifier}`,
        );
      }
      const merged: ResolvedLinearIssue = {
        organizationId: issue.organizationId,
        issueId: issue.issueId,
        identifier: issue.identifier,
      };
      const title = issue.title ?? existing?.title;
      if (title) merged.title = title;
      const branchName = issue.branchName ?? existing?.branchName;
      if (branchName) merged.branchName = branchName;
      linearMatches.set(key, merged);
    };

    const nativeLinear = linearIssueFromEvent(event);
    if (nativeLinear) addLinearMatch(nativeLinear, "native Linear event");
    // Linear-origin comments stay on the issue they were posted on. Extra
    // FRA/ENG ids in the title or body are references, not more work items.
    if (!nativeLinear) {
      for (const identifier of uniqueLinearIdentifiers(references)) {
        if (event.source === "github" && githubPrimary && identifier !== githubPrimary) continue;
        const resolved = await this.lookupLinearIssue(identifier, event);
        if (!resolved) {
          if (event.source === "github") continue;
          throw new UnresolvedLinearReferenceError(identifier);
        }
        addLinearMatch(resolved, identifier);
      }
    }
    if (nativeLinear && !nativeLinear.branchName) {
      const resolved = await this.lookupLinearIssue(nativeLinear.identifier, event);
      if (resolved) addLinearMatch(resolved, nativeLinear.identifier);
    }

    const providerUrls = [
      stringPayload(event, "pullRequestUrl"),
      stringPayload(event, "issueUrl"),
      stringPayload(event, "url"),
    ].filter((url) => /^https:\/\/github\.com\//i.test(url));
    const mentionedUrls = githubItemUrlsInText(
      [
        request.requestText,
        stringPayload(event, "title"),
        stringPayload(event, "subject"),
        stringPayload(event, "body"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    for (const url of new Set([...providerUrls, ...mentionedUrls])) {
      for (const issue of await this.lookupLinearIssuesForUrl(url, event)) {
        if (event.source === "github" && githubPrimary && issue.identifier !== githubPrimary) {
          continue;
        }
        if (nativeLinear && issue.identifier !== nativeLinear.identifier) continue;
        addLinearMatch(issue, url);
      }
    }
    if (event.source === "github" && linearMatches.size > 1) {
      if (githubPrimary) {
        for (const [key, issue] of [...linearMatches.entries()]) {
          if (issue.identifier !== githubPrimary) linearMatches.delete(key);
        }
      } else {
        linearMatches.clear();
      }
    }
    if (nativeLinear && linearMatches.size > 1) {
      for (const [key, issue] of [...linearMatches.entries()]) {
        if (issue.identifier !== nativeLinear.identifier) linearMatches.delete(key);
      }
    }
    if (linearMatches.size > 1) {
      throw new WorkItemConflictError(
        `message resolves to multiple Linear issues: ${[...linearMatches.values()]
          .map((issue) => issue.identifier)
          .sort()
          .join(", ")}`,
      );
    }
    const linear = linearMatches.values().next().value;
    const input: CorrelationInput = {
      ...(linear ? { linear } : {}),
      ...correlationInputForEvent(event, person.id),
    };
    return correlateConversation(input, {
      resolveLinearIdentifier: (identifier) => this.directory.resolveIdentifier(identifier),
      findByAlias: async (aliasKey) => {
        const alias = aliasFromKey(aliasKey);
        const found = this.workItems.findByAlias("correlation", alias.kind, alias.key);
        return found ? canonicalForWorkItem(found) : null;
      },
    });
  }

  /**
   * GitHub review/mention must not wait on Linear OAuth or API. Ticket attach
   * is best-effort; a reboot that loses Linear app credentials used to hold
   * PR reviews forever (incident 2026-08-21 #1110). Linear-origin events still
   * fail closed.
   */
  private async lookupLinearIssue(
    identifier: string,
    event: WakeEvent,
  ): Promise<ResolvedLinearIssue | null> {
    try {
      return await this.directory.resolveIdentifier(identifier);
    } catch (error) {
      if (event.source !== "github") throw error;
      this.logger.warn(
        { identifier, err: error instanceof Error ? error.message : String(error) },
        "Linear directory failed; GitHub request continues without ticket attach",
      );
      return null;
    }
  }

  private async lookupLinearIssuesForUrl(
    url: string,
    event: WakeEvent,
  ): Promise<ResolvedLinearIssue[]> {
    try {
      return await this.directory.issuesForUrl(url);
    } catch (error) {
      if (event.source !== "github") throw error;
      this.logger.warn(
        { url, err: error instanceof Error ? error.message : String(error) },
        "Linear URL lookup failed; GitHub request continues without ticket attach",
      );
      return [];
    }
  }

  private hermesReuseDecision(
    request: AgentRequest,
    item: WorkItem,
    linearIssue: ResolvedLinearIssue | undefined,
  ): HermesReuseDecision | null {
    if (this.adapter.name !== "hermes") return null;
    const ref = workRefFromTarget(
      hermesTargetFromEvent(request.event, {
        workItemId: item.id,
        linearIdentifier: linearIssue?.identifier,
      }),
    );
    if (workRefIsEmpty(ref) && !item.codexThreadId) return null;
    let lookup: HermesSessionLookup;
    try {
      lookup = this.hermesSessionLookup(ref);
    } catch {
      lookup = { hits: [], runningIds: new Set(), cmdlineBusy: false };
    }
    const identity = item.codexThreadId ? loadHermesSessionIdentity(item.codexThreadId) : null;
    return decideHermesSessionReuse({
      ref,
      boundSessionId: item.codexThreadId,
      ...(identity ? { boundSessionKey: identity.sessionKey, boundChatId: identity.chatId } : {}),
      hits: lookup.hits,
      runningIds: lookup.runningIds,
      cmdlineBusy: lookup.cmdlineBusy,
      // A fresh duplicate review request is safely ignored while its session is
      // running. A crash/timeout retry must hold instead, then resume when the
      // old process exits; marking that retry complete would lose the review.
      reviewRequest: isGithubReviewStartRequest(request.event) && request.attemptCount === 0,
      headMoved: githubSynchronizeHeadMoved(request.event),
    });
  }

  // Host-managed workspace preflight is retired. Left uncalled so Path D cannot
  // stamp workspace-failed over a live review.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: retired stamp path
  private async prepareSystemPrReview(
    event: WakeEvent,
    linear: ResolvedLinearIssue | undefined,
    priorReviewArtifact: boolean,
    signal: AbortSignal,
  ): Promise<SystemPrPreflight> {
    const updatedAt = (): string => this.now().toISOString();
    const updateStatus = async (update: GithubReviewBodyUpdate): Promise<void> => {
      const result = await this.reviewStatusUpdate(event, update, signal);
      if (!result) throw new Error("system PR status update could not be verified");
    };
    await updateStatus({
      links: null,
      status: { phase: "workspace-starting", updatedAt: updatedAt() },
    });

    let workspace: ResolvedSnapWorkspace;
    try {
      const pullRequestUrl = systemPullRequestUrl(event);
      if (!pullRequestUrl) throw new SnapWorkspaceValidationError("system PR URL is missing");
      workspace = await this.workspaceResolver(
        {
          ...(linear ? { authoritativeLinearInput: linear.identifier } : {}),
          pullRequestUrl,
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      await updateStatus({
        links: null,
        status: { phase: "workspace-failed", updatedAt: updatedAt() },
      });
      return { mode: "workspace-failure", reason: "system PR workspace preflight failed" };
    }

    await updateStatus({
      links: workspace.urls,
      expectedHeadSha: workspace.headSha,
      status: { phase: "workspace-ready", updatedAt: updatedAt(), headSha: workspace.headSha },
    });
    const pendingTests: Record<SnapReviewProject, GithubReviewTestState> = {
      app: "running",
      data: "pending",
      snapcorp: "pending",
      windmill: "pending",
    };
    await updateStatus({
      expectedHeadSha: workspace.headSha,
      status: {
        phase: "tests-running",
        updatedAt: updatedAt(),
        headSha: workspace.headSha,
        tests: pendingTests,
      },
    });

    let tests: SnapReviewTestResult;
    try {
      tests = await this.reviewPreflightRunner(workspace, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      tests = {
        headSha: workspace.headSha,
        passed: false,
        suites: { app: "missing", data: "missing", snapcorp: "missing", windmill: "missing" },
        diagnosticTail: "aggregate test runner failed before a complete summary",
      };
    }
    const exactPass =
      tests.passed === true &&
      tests.headSha === workspace.headSha &&
      /^[0-9a-f]{40}$/u.test(tests.headSha) &&
      SNAP_REVIEW_PROJECTS.every((project) => tests.suites[project] === "passed");
    await updateStatus({
      expectedHeadSha: workspace.headSha,
      status: {
        phase: exactPass ? "tests-passed" : "tests-failed",
        updatedAt: updatedAt(),
        headSha: tests.headSha,
        tests: tests.suites,
      },
    });
    return {
      mode: exactPass ? "full-review" : "test-failure-only",
      workspace,
      tests,
      priorReviewArtifact,
    };
  }

  private async updateSystemPrCompletionStatus(
    event: WakeEvent,
    preflight: Exclude<SystemPrPreflight, { mode: "workspace-failure" }> | undefined,
    phase: Extract<
      GithubReviewStatusPhase,
      "specialists-incomplete" | "review-incomplete" | "specialists-waiting"
    >,
    detail: string,
    signal: AbortSignal,
    verificationFailure: string,
  ): Promise<void> {
    const headSha = preflight?.tests.headSha;
    const status = await this.reviewStatusUpdate(
      event,
      {
        ...(headSha ? { expectedHeadSha: headSha } : {}),
        status: {
          phase,
          updatedAt: this.now().toISOString(),
          detail,
          ...(headSha ? { headSha } : {}),
          ...(preflight ? { tests: preflight.tests.suites } : {}),
        },
      },
      signal,
    );
    if (!status) throw new Error(verificationFailure);
  }

  private async resolveCwd(
    linear: ResolvedLinearIssue | undefined,
    item: WorkItem,
    signal: AbortSignal,
  ): Promise<string> {
    if (linear) {
      return (
        await this.workspaceResolver({ authoritativeLinearInput: linear.identifier }, { signal })
      ).cwd;
    }
    if (item.canonicalKind !== "linear") return SNAP_ROOT;

    if (!item.cwd || item.cwd === SNAP_ROOT) return SNAP_ROOT;
    if (path.dirname(item.cwd) !== SNAP_WORKSPACES_ROOT) {
      throw new WorkItemConflictError(
        `Linear work item ${item.canonicalKey} has no trusted Snap workspace`,
      );
    }
    const ticket = path.basename(item.cwd);
    const resolved = await this.workspaceResolver({ authoritativeLinearInput: ticket }, { signal });
    if (resolved.cwd !== item.cwd) {
      throw new WorkItemConflictError(
        `Linear work item ${item.canonicalKey} changed workspace identity`,
      );
    }
    return resolved.cwd;
  }
}

function requestDedupKey(event: WakeEvent): { scope: string; deliveryId: string } | undefined {
  if (event.source !== "gmail") return undefined;
  const mailbox = event.principal?.tenantId.trim().toLowerCase();
  if (!mailbox) return undefined;
  return {
    scope: `gmail-mailbox:${mailbox}`,
    deliveryId: event.deliveryId,
  };
}

interface CorrelationAlias {
  kind: string;
  key: string;
}

function correlationAliases(event: WakeEvent, personId: string): CorrelationAlias[] {
  const aliases: CorrelationAlias[] = [];
  const payload = event.payload;
  if (event.source === "github") {
    const repositoryId = identifier(payload.repositoryId) || stringPayload(event, "repo");
    const number = identifier(payload.number);
    if (repositoryId && number) {
      const type =
        payload.isPullRequest === true || event.kind.startsWith("pull_request")
          ? "pull-request"
          : "issue";
      aliases.push({ kind: "github", key: `github:${repositoryId}:${type}:${number}` });
    }
  }
  if (event.source === "slack" && event.conversation?.rootKey) {
    aliases.push({ kind: "slack", key: `slack:${event.conversation.rootKey}` });
  }
  if (event.source === "gmail") {
    const mailbox = event.principal?.tenantId.toLowerCase();
    const root = event.conversation?.rootKey;
    if (mailbox && root) {
      aliases.push({
        kind: "gmail-rfc",
        key: `gmail-rfc:${digest(`${mailbox}\0${stripAngles(root).toLowerCase()}`)}`,
      });
    }
    const subject = normalizeEmailSubject(stringPayload(event, "subject"));
    if (mailbox && subject) {
      aliases.push({
        kind: "email-subject",
        key: `email-subject:${digest(`${mailbox}\0${personId.toLowerCase()}\0${subject}`)}`,
      });
    }
  }
  const linear = linearIssueFromEvent(event);
  if (linear) aliases.unshift({ kind: "linear", key: linearKey(linear) });
  return deduplicate(aliases);
}

function correlationInputForEvent(event: WakeEvent, personId: string): Partial<CorrelationInput> {
  const payload = event.payload;
  if (event.source === "github") {
    const repositoryId = identifier(payload.repositoryId) || stringPayload(event, "repo");
    const itemId = identifier(payload.number);
    return repositoryId && itemId
      ? {
          github: {
            repositoryId,
            itemId,
            itemType:
              payload.isPullRequest === true || event.kind.startsWith("pull_request")
                ? "pull-request"
                : "issue",
          },
        }
      : {};
  }
  if (event.source === "slack") {
    const rootKey = event.conversation?.rootKey;
    const [teamId, channelId, rootTs] = rootKey ? rootKey.split(":") : [];
    return teamId && channelId && rootTs ? { slack: { teamId, channelId, rootTs } } : {};
  }
  if (event.source === "gmail") {
    const mailbox = event.principal?.tenantId;
    const rfcThreadId = event.conversation?.rootKey;
    const subject = stringPayload(event, "subject");
    return {
      ...(mailbox && rfcThreadId ? { gmail: { mailbox, rfcThreadId } } : {}),
      ...(mailbox && subject ? { email: { mailbox, personId, subject } } : {}),
    };
  }
  return {};
}

function linearIssueFromEvent(event: WakeEvent): ResolvedLinearIssue | undefined {
  if (event.principal?.provider !== "linear") return undefined;
  const organizationId = event.principal.tenantId;
  const issueId = stringPayload(event, "issueId");
  const identifierValue = stringPayload(event, "identifier");
  if (!organizationId || !issueId || !identifierValue) return undefined;
  const branchName = stringPayload(event, "branchName");
  const title = stringPayload(event, "title");
  return {
    organizationId,
    issueId,
    identifier: identifierValue.toUpperCase(),
    ...(title ? { title } : {}),
    ...(branchName ? { branchName } : {}),
  };
}

function linearKey(issue: ResolvedLinearIssue): string {
  return `linear:${encodeURIComponent(issue.organizationId)}:${encodeURIComponent(issue.issueId)}`;
}

function isTerminalWorkspaceFailure(error: unknown): boolean {
  return (
    error instanceof InvalidSnapWorkspaceInputError ||
    error instanceof SnapWorkspaceCommandError ||
    error instanceof SnapWorkspaceValidationError
  );
}

function workspacePreparationFailureReply(requestId: string): string {
  return (
    "I couldn't start this request because its Snap workspace could not be prepared. " +
    `No agent task was started. WakeWire request: ${requestId}. ` +
    "Fix the local Snap controller environment, then send the request again."
  );
}

function bindAlias(store: WorkItemStore, workItemId: string, alias: CorrelationAlias): void {
  store.attachAlias(workItemId, {
    provider: "correlation",
    scope: alias.kind,
    nativeKey: alias.key,
  });
}

function aliasFromKey(key: string): CorrelationAlias {
  const kind = key.slice(0, key.indexOf(":"));
  if (!kind) throw new Error(`invalid correlation key ${key}`);
  return { kind, key };
}

function canonicalForWorkItem(item: WorkItem): CanonicalConversation {
  return {
    key: item.canonicalKey,
    kind: aliasFromKey(item.canonicalKey).kind as CanonicalConversation["kind"],
  };
}

function workItemKind(kind: string): WorkItemKind {
  if (kind === "linear" || kind === "github" || kind === "slack") return kind;
  return "email";
}

function authenticatedPromptInput(
  request: AgentRequest,
  person: Person,
  item: WorkItem,
  policy: EffectivePolicy,
  assessment: SafetyAssessment,
  execution: SafetyWrappedPromptInput["execution"],
  systemPreflight?: Exclude<SystemPrPreflight, { mode: "workspace-failure" }>,
): SafetyWrappedPromptInput {
  const sourceAction = systemPreflight
    ? systemPreflight.mode === "test-failure-only"
      ? "github-pr-test-failure"
      : "github-pr-review"
    : hasGithubReviewSubmissionAuthority(request.event)
      ? "github-pr-review"
      : undefined;
  return {
    requestId: request.id,
    principal: {
      id: person.id,
      nickname: person.nickname,
      roleName: person.roleName,
    },
    source: request.event.source,
    ...(sourceAction ? { sourceAction } : {}),
    ...(systemPreflight
      ? {
          githubReviewPreflight: {
            mode: systemPreflight.mode,
            reviewKey: systemPrReviewKey(request.event),
            invocationId: systemPrInvocationId(request),
            priorReviewArtifact: systemPreflight.priorReviewArtifact,
            ticket: systemPreflight.workspace.ticket,
            headSha: systemPreflight.tests.headSha,
            suites: systemPreflight.tests.suites,
            diagnosticTail: systemPreflight.tests.diagnosticTail,
            urls: systemPreflight.workspace.urls,
          },
        }
      : {}),
    sourceDeliveryId: request.sourceDeliveryId,
    canonicalWorkItem: item.canonicalKey,
    requestText: request.requestText,
    providerContext: {
      summary: request.event.summary,
      payload: request.event.payload,
    },
    rolePolicy: policy.policy,
    assessment,
    execution,
    presentation: {
      title: item.title,
      description: buildWorkItemTitle(request.event, person),
    },
  };
}

function executionPlan(
  profile: ExecutionProfile,
  isNewDesktopTask: boolean,
  title: string,
  resumeDelegation = false,
): SafetyWrappedPromptInput["execution"] {
  const targetIsDefault =
    profile.source === "default" ||
    (profile.model === DEFAULT_EXECUTION_PROFILE.model &&
      profile.reasoningEffort === DEFAULT_EXECUTION_PROFILE.reasoningEffort);
  const delegateToSeparateTask =
    profile.clarification === null &&
    (resumeDelegation || profile.mode === "separate" || (isNewDesktopTask && !targetIsDefault));
  const delegationReason = delegateToSeparateTask
    ? profile.mode === "separate"
      ? "requested-separate"
      : "new-desktop-task-override"
    : null;
  const currentProfile = delegateToSeparateTask ? DEFAULT_EXECUTION_PROFILE : profile;
  return {
    currentModel: currentProfile.model,
    currentReasoningEffort: currentProfile.reasoningEffort,
    requestProfile: profile,
    delegateToSeparateTask,
    delegationReason,
    ...(delegateToSeparateTask ? { childTitle: executionChildTitle(title, profile) } : {}),
  };
}

function executionChildTitle(title: string, profile: ExecutionProfile): string {
  const model = executionModelLabel(profile.model);
  const suffix = ` — ${model} ${profile.reasoningEffort}`;
  const prefix = title.slice(0, Math.max(1, 60 - suffix.length)).trimEnd();
  return `${prefix}${suffix}`;
}

function executionModelLabel(model: ExecutionProfile["model"]): string {
  if (model === "gpt-5.6-luna") return "Luna";
  if (model === "gpt-5.6-terra") return "Terra";
  if (model === "gpt-5.6-sol") return "Sol";
  if (model === "gpt-5.4-mini") return "5.4 Mini";
  if (model === "gpt-5.3-codex-spark") return "Spark";
  return model.replace("gpt-", "");
}

function sandboxForPolicy(policy: EffectivePolicy): "read-only" | "workspace-write" {
  const { filesystem, shell } = policy.policy.capabilities;
  return filesystem === "write" || filesystem === "full" || shell === "write" || shell === "full"
    ? "workspace-write"
    : "read-only";
}

function isLinearStopRequest(event: WakeEvent): boolean {
  return isPrivilegedLinearAgentSessionEvent(event) && event.payload.agentSignal === "stop";
}

function isGithubPullRequestEvent(event: WakeEvent): boolean {
  return (
    event.source === "github" &&
    (event.payload.isPullRequest === true || event.kind.startsWith("pull_request"))
  );
}

function hasGithubReviewSubmissionAuthority(event: WakeEvent): boolean {
  const author =
    event.kind === "pull_request.review_requested" || event.kind === "pull_request.synchronize"
      ? stringPayload(event, "author")
      : event.kind === "issue_comment.created" || event.kind.startsWith("pull_request_review")
        ? stringPayload(event, "pullRequestAuthorLogin")
        : "";
  return (
    isGithubPullRequestEvent(event) &&
    author.length > 0 &&
    author.toLowerCase() !== DEFAULT_CHIP_IDENTITIES.githubHandle
  );
}

function skippedSystemPrPreflight(): SystemPrPreflight | undefined {
  return undefined;
}

function isSystemPrReviewEvent(event: WakeEvent): boolean {
  return (
    hasGithubReviewSubmissionAuthority(event) &&
    stringPayload(event, "repo").toLowerCase() === "snapnhd/system"
  );
}

const REVIEW_REASONING_EFFORTS: readonly ExecutionReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function enforceGithubPrReviewEffort(
  event: WakeEvent,
  profile: ExecutionProfile,
): ExecutionProfile {
  if (
    !isGithubPullRequestEvent(event) ||
    profile.clarification !== null ||
    REVIEW_REASONING_EFFORTS.indexOf(profile.reasoningEffort) >=
      REVIEW_REASONING_EFFORTS.indexOf("high")
  ) {
    return profile;
  }
  return { ...profile, reasoningEffort: "high" };
}

function isGithubReviewStartRequest(event: WakeEvent): boolean {
  if (!isGithubPullRequestEvent(event)) return false;
  if (
    event.kind === "pull_request.review_requested" ||
    event.kind === "pull_request.synchronize"
  ) {
    return true;
  }
  const body = stringPayload(event, "body")
    .replace(/@chipbyte-snap\b|@chip\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return /^(?:please\s+)?(?:review|rereview|re-review)(?:\s+(?:this|again|please))?[.!]?$/iu.test(
    body,
  );
}

function githubReviewHeadMoved(active: WakeEvent, incoming: WakeEvent): boolean {
  if (incoming.kind !== "pull_request.synchronize") return false;
  const frozenHead = githubEventHeadSha(active);
  const liveHead = githubEventHeadSha(incoming);
  return Boolean(frozenHead && liveHead && frozenHead !== liveHead);
}

function githubSynchronizeHeadMoved(event: WakeEvent): boolean {
  if (event.kind !== "pull_request.synchronize") return false;
  const beforeSha = stringPayload(event, "beforeSha").trim().toLowerCase();
  const headSha = githubEventHeadSha(event);
  return Boolean(/^[0-9a-f]{40}$/u.test(beforeSha) && headSha && beforeSha !== headSha);
}

function githubEventHeadSha(event: WakeEvent): string | null {
  const headSha = stringPayload(event, "headSha").trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(headSha) ? headSha : null;
}

function maintainedPrFeedbackKey(event: WakeEvent): string {
  const repositoryId = identifier(event.payload.repositoryId);
  const number = identifier(event.payload.number);
  if (!repositoryId || !number) {
    throw new Error("maintained PR feedback is missing repository id or PR number");
  }
  return `github-maintained-pr-feedback:${repositoryId}#${number}`;
}

function reviewThreadReplyKey(event: WakeEvent): string {
  const repositoryId = identifier(event.payload.repositoryId);
  const number = identifier(event.payload.number);
  if (!repositoryId || !number) {
    throw new Error("review thread reply is missing repository id or PR number");
  }
  return `github-review-thread-reply:${repositoryId}#${number}`;
}

function githubPullRequestUrl(event: WakeEvent): string {
  const explicit =
    stringPayload(event, "issueUrl") ||
    stringPayload(event, "pullRequestUrl") ||
    stringPayload(event, "url");
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:$|[#?])/u.test(explicit)) {
    return explicit.replace(/#.*$/u, "");
  }
  const repo = stringPayload(event, "repo");
  const number = identifier(event.payload.number);
  return repo && number ? `https://github.com/${repo}/pull/${number}` : "";
}

function systemPullRequestUrl(event: WakeEvent): string {
  const repo = stringPayload(event, "repo").toLowerCase();
  const number = identifier(event.payload.number);
  if (repo !== "snapnhd/system" || !/^[1-9][0-9]*$/u.test(number)) return "";
  return `https://github.com/snapnhd/system/pull/${number}`;
}

function systemPrReviewKey(event: WakeEvent): string {
  const url = systemPullRequestUrl(event);
  const number = url.match(/\/pull\/([1-9][0-9]*)$/u)?.[1];
  if (!number) throw new PermanentError("system PR specialist proof is missing its review key");
  return `snapnhd/system#${number}`;
}

function reviewArtifactExpectation(
  request: AgentRequest,
  preflight: Exclude<SystemPrPreflight, { mode: "workspace-failure" }> | undefined,
  specialistStatus?: "PASS" | "REPAIR" | "ESCALATE",
): GithubReviewArtifactExpectation {
  if (!preflight) throw new PermanentError("system PR review artifact is missing its preflight");
  return {
    since: request.event.occurredAt,
    expectedHeadSha: preflight.tests.headSha,
    allowedStates:
      preflight.mode === "test-failure-only"
        ? ["COMMENTED"]
        : specialistStatus === "REPAIR" || specialistStatus === "ESCALATE"
          ? ["CHANGES_REQUESTED", "COMMENTED"]
          : ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"],
  };
}

function systemPrInvocationId(request: AgentRequest): string {
  return createHash("sha256").update(`${request.id}\0${request.attemptCount}`).digest("hex");
}

function supportsProgressAck(event: WakeEvent): boolean {
  return (
    event.source === "slack" ||
    event.source === "github" ||
    isPrivilegedLinearAgentSessionEvent(event) ||
    isPrivilegedLinearUserEvent(event)
  );
}

function stringPayload(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function identifier(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function stripAngles(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1).trim() : value.trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deduplicate(aliases: CorrelationAlias[]): CorrelationAlias[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    if (seen.has(alias.key)) return false;
    seen.add(alias.key);
    return true;
  });
}
