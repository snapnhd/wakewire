import { isDeepStrictEqual } from "node:util";
import type { DispatcherDefaultAgent } from "../config.js";
import type { WakeEvent } from "../core/event.js";
import type { Database } from "../db/db.js";
import type { Logger } from "../logging.js";
import type { Person } from "../people/schema.js";
import type { PeopleStore } from "../people/store.js";
import type { AgentAdapter } from "../sinks/types.js";
import { DeliveryNotSubmittedError, SubmittedDeliveryInterruptedError } from "../sinks/types.js";
import { isAuthenticatedSlackHumanMessage } from "../sources/slack/normalize.js";
import { buildAckSpec } from "./ack.js";
import {
  CLAUDE_PROXY_HELD_RELEASE_RESPONSE,
  type ClaudeProxySession,
  type ClaudeProxyStore,
  type ClaudeProxyTurn,
} from "./claude-proxy-store.js";
import {
  type ClaudeProxyAdapterMode,
  isClaudeProxyExitDirective,
  parseClaudeProxyDirective,
  parseCodexOverrideDirective,
} from "./claude-trigger.js";
import { PROGRESS_ACK_DELAY_MS } from "./coordinator.js";
import {
  type EffectivePolicy,
  effectivePolicy,
  isEnforceableDesktopOwner,
  PolicyConfigurationError,
} from "./policy.js";
import { buildClaudeProxyReplySpec } from "./reply.js";
import {
  buildClaudeSafetyWrappedPrompt,
  PlaceholderLocalSafetyScreener,
  SafetyAssessmentSchema,
  type SafetyScreener,
  type SafetyScreenInput,
} from "./safety.js";
import { SNAP_ROOT } from "./snap-workspace.js";
import type { AgentRequest, AgentRequestStore, WorkItem, WorkItemStore } from "./store.js";
import {
  type ChipIdentityConfig,
  DEFAULT_CHIP_IDENTITIES,
  isChipAddressed,
  requestText,
} from "./targeting.js";
import { buildWorkItemTitle } from "./thread-title.js";

export interface ClaudeProxyAcceptance {
  claimed: boolean;
  accepted: boolean;
  duplicate?: boolean | undefined;
  requestId?: string | undefined;
  sessionId?: string | undefined;
  replyQueued?: boolean | undefined;
  codexOverride?: boolean | undefined;
  reason?: string | undefined;
}

export interface ClaudeProxyCoordinatorOptions {
  cwd?: string | undefined;
  defaultAgent?: DispatcherDefaultAgent | (() => DispatcherDefaultAgent) | undefined;
  now?: (() => Date) | undefined;
  progressAckDelayMs?: number | undefined;
}

/**
 * Slack-only ingress gate for Claude proxy sessions. Initial turns still need
 * normal Chip addressing plus either the narrow trigger grammar or the
 * configured Claude RC default. Once bound, human replies from the same
 * immutable principal and conversation bypass Codex unless an anchored
 * one-message Codex/GPT override is present.
 */
export class ClaudeProxyCoordinator {
  private readonly defaultCwd: string;
  private readonly defaultAgent: () => DispatcherDefaultAgent;
  private readonly now: () => Date;
  private readonly progressAckDelayMs: number;

  constructor(
    private readonly db: Database,
    private readonly people: PeopleStore,
    private readonly workItems: WorkItemStore,
    private readonly requests: AgentRequestStore,
    private readonly proxy: ClaudeProxyStore,
    private readonly chip: ChipIdentityConfig = DEFAULT_CHIP_IDENTITIES,
    options: ClaudeProxyCoordinatorOptions = {},
  ) {
    this.defaultCwd = options.cwd ?? SNAP_ROOT;
    const configuredDefault = options.defaultAgent;
    this.defaultAgent =
      typeof configuredDefault === "function"
        ? configuredDefault
        : () => configuredDefault ?? "codex";
    this.now = options.now ?? (() => new Date());
    this.progressAckDelayMs = options.progressAckDelayMs ?? PROGRESS_ACK_DELAY_MS;
    if (!Number.isSafeInteger(this.progressAckDelayMs) || this.progressAckDelayMs < 0) {
      throw new TypeError("progressAckDelayMs must be a non-negative safe integer");
    }
  }

  accept(event: WakeEvent): ClaudeProxyAcceptance {
    if (event.source !== "slack") {
      return { claimed: false, accepted: false };
    }
    const sourceId = event.sourceId?.trim() ?? "";
    if (!sourceId) return { claimed: false, accepted: false };

    const replay = this.requests.findByDelivery(sourceId, event.deliveryId);
    const replayTurn = replay ? this.proxy.getTurn(replay.id) : null;
    // The durable delivery identity is checked before privileged shape
    // validation so a mutated replay cannot escape into ordinary route
    // matching merely by corrupting its Slack metadata.
    if (replay && !isDeepStrictEqual(replay.event, event)) {
      return {
        claimed: true,
        accepted: false,
        reason: replayTurn
          ? "Claude proxy delivery id was replayed with different event content"
          : "Codex dispatcher delivery id was replayed with different event content",
      };
    }
    if (!isAuthenticatedSlackHumanMessage(event)) {
      return { claimed: false, accepted: false };
    }
    const conversationKey = claudeConversationKey(event);
    if (!conversationKey) return { claimed: false, accepted: false };

    const text = requestText(event);
    const recipientUser = stringPayload(event, "recipientUser");
    const codexOverride = parseCodexOverrideDirective(text, recipientUser);
    if (replay && replayTurn) {
      return {
        claimed: true,
        accepted: true,
        duplicate: true,
        requestId: replay.id,
        sessionId: replayTurn.sessionId,
      };
    }

    // A delivery already accepted by the ordinary Codex coordinator must
    // never become a new Claude turn after a config change or daemon restart.
    if (replay) {
      // Preserve the one-message override disposition on exact provider
      // retries, even if its active Claude session closed after first accept.
      return {
        claimed: false,
        accepted: false,
        ...(codexOverride ? { codexOverride: true } : {}),
      };
    }

    const exitRequested = isClaudeProxyExitDirective(text, recipientUser);
    let active = this.proxy.findActiveSession(sourceId, "slack", conversationKey);
    if (!active && exitRequested) {
      // Versions before migration 21 bound every one-to-one Slack message to
      // one DM-wide key. Never route ordinary traffic back into that legacy
      // session, but preserve an explicit escape hatch for an in-flight or
      // held or recently drained session that could not be retired safely
      // during migration.
      const legacyConversationKey = legacyClaudeDmConversationKey(event);
      const legacy = legacyConversationKey
        ? this.proxy.findActiveSession(sourceId, "slack", legacyConversationKey)
        : null;
      if (legacy) active = legacy;
    }
    if (codexOverride) {
      // In an already-bound channel thread, follow-ups do not need another
      // @Chip mention. Preserve that convenience for a one-message Codex/GPT
      // override, but only for the immutable principal that owns the session.
      const activeOwner = active ? samePrincipal(event, active) : false;
      if (isChipAddressed(event, this.chip) || activeOwner) {
        return { claimed: false, accepted: false, codexOverride: true };
      }
      return { claimed: false, accepted: false };
    }

    if (active) return this.acceptFollowup(event, active);

    if (!isChipAddressed(event, this.chip)) return { claimed: false, accepted: false };
    let directive = parseClaudeProxyDirective(text, recipientUser);
    if (!directive && exitRequested) {
      return { claimed: false, accepted: false };
    }
    if (!directive && this.defaultAgent() === "claude-rc") {
      const prompt = text.trim();
      if (prompt) directive = { matched: true, prompt, adapterMode: "rc-tmux" };
    }
    if (!directive) return { claimed: false, accepted: false };

    const authorization = this.authorize(event);
    if ("reason" in authorization) {
      return { claimed: true, accepted: false, reason: authorization.reason };
    }

    try {
      // Freeze the provider target before accepting any work.
      buildClaudeProxyReplySpec(event, "Claude proxy target validation");
      const principal = requiredSlackPrincipal(event);
      const item = this.provisionalSlackWorkItem(event, authorization.person);
      const cwd = this.sessionCwd(item);
      const progressAck = this.progressAck(event, authorization.person);
      const accepted = this.proxy.acceptEventTurn({
        session: {
          sourceId,
          provider: "slack",
          conversationKey,
          principalProvider: principal.provider,
          principalTenantId: principal.tenantId,
          principalSubjectId: principal.subjectId,
          personId: authorization.person.id,
          workItemId: item.id,
          cwd,
          adapterMode: directive.adapterMode,
        },
        event,
        requestText: directive.prompt,
        ...progressAck,
      });
      return {
        claimed: true,
        accepted: true,
        duplicate: accepted.duplicate,
        requestId: accepted.request.id,
        sessionId: accepted.session.id,
      };
    } catch (error) {
      return {
        claimed: true,
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private acceptFollowup(event: WakeEvent, session: ClaudeProxySession): ClaudeProxyAcceptance {
    if (!samePrincipal(event, session)) {
      // This authenticated message belongs to someone else. It is not part of
      // the proxy and must remain eligible for ordinary Chip/route handling.
      return { claimed: false, accepted: false };
    }
    if (session.closeAfterOrdinal !== null) {
      // The exit barrier was committed at ingress. Messages arriving after it
      // are no longer Claude proxy traffic, even while older turns drain.
      return { claimed: false, accepted: false };
    }
    const text = requestText(event).trim();
    if (!text) {
      return {
        claimed: true,
        accepted: false,
        sessionId: session.id,
        reason: "Claude proxy follow-up must not be empty",
      };
    }
    const exitRequested = isClaudeProxyExitDirective(text, stringPayload(event, "recipientUser"));
    const authorization = this.authorize(event);
    if ("reason" in authorization) {
      return {
        claimed: true,
        accepted: false,
        sessionId: session.id,
        reason: authorization.reason,
      };
    }
    if (authorization.person.id !== session.personId) {
      return {
        claimed: false,
        accepted: false,
        sessionId: session.id,
        reason: "principal does not own the active Claude proxy session",
      };
    }
    if (session.status === "held" && !exitRequested) {
      return {
        claimed: true,
        accepted: false,
        sessionId: session.id,
        reason: session.error ?? "Claude proxy session is held for operator reconciliation",
      };
    }
    try {
      buildClaudeProxyReplySpec(event, "Claude proxy target validation");
      const progressAck = this.progressAck(event, authorization.person);
      const accept = this.db.transaction(() => {
        const accepted = this.proxy.acceptEventTurn({
          session: {
            sourceId: session.sourceId,
            provider: session.provider,
            conversationKey: session.conversationKey,
            principalProvider: session.principalProvider,
            principalTenantId: session.principalTenantId,
            principalSubjectId: session.principalSubjectId,
            personId: session.personId,
            workItemId: session.workItemId,
            cwd: session.cwd,
            adapterMode: session.adapterMode,
          },
          event,
          requestText: text,
          ...progressAck,
          ...(exitRequested ? { closeRequested: true } : {}),
        });
        if (session.status === "held") {
          const spec = buildClaudeProxyReplySpec(event, CLAUDE_PROXY_HELD_RELEASE_RESPONSE);
          this.proxy.completeHeldReleaseWithReply(
            accepted.request.id,
            CLAUDE_PROXY_HELD_RELEASE_RESPONSE,
            spec,
          );
        }
        return accepted;
      });
      const accepted = accept.immediate();
      return {
        claimed: true,
        accepted: true,
        duplicate: accepted.duplicate,
        requestId: accepted.request.id,
        sessionId: accepted.session.id,
        ...(session.status === "held" ? { replyQueued: true } : {}),
      };
    } catch (error) {
      return {
        claimed: true,
        accepted: false,
        sessionId: session.id,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private progressAck(
    event: WakeEvent,
    person: Person,
  ): {
    ack: ReturnType<typeof buildAckSpec>;
    ackNotBefore: string;
  } {
    return {
      ack: buildAckSpec(event, person.nickname),
      ackNotBefore: new Date(this.now().getTime() + this.progressAckDelayMs).toISOString(),
    };
  }

  private authorize(
    event: WakeEvent,
  ): { person: Person; policy: EffectivePolicy } | { reason: string } {
    const principal = event.principal;
    if (principal?.provider !== "slack") return { reason: "principal-not-enrolled" };
    const person = this.people.resolveIdentity(
      principal.provider,
      principal.tenantId,
      principal.subjectId,
    )?.person;
    if (!person) return { reason: "principal-not-enrolled" };
    try {
      const policy = effectivePolicy(this.people, person.id);
      if (!policy?.authorized || !canWrite(policy.policy.capabilities.sourceReplies)) {
        return { reason: "policy-denied" };
      }
      if (!isEnforceableDesktopOwner(policy)) {
        return { reason: "desktop-policy-not-enforceable" };
      }
      return { person, policy };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private provisionalSlackWorkItem(event: WakeEvent, person: Person): WorkItem {
    const rootKey = event.conversation?.rootKey;
    if (!rootKey) throw new Error("Claude proxy requires a stable Slack conversation root");
    const key = `slack:${rootKey}`;
    let item = this.workItems.findByAlias("correlation", "slack", key);
    if (!item) {
      item = this.workItems.getOrCreate({
        kind: "slack",
        key,
        title: buildWorkItemTitle(event, person),
        cwd: this.defaultCwd,
      });
    }
    this.workItems.attachAlias(item.id, {
      provider: "correlation",
      scope: "slack",
      nativeKey: key,
    });
    return this.workItems.get(item.id) ?? item;
  }

  private sessionCwd(item: WorkItem): string {
    if (item.cwd) return item.cwd;
    if (item.canonicalKind === "linear") {
      throw new Error(`Linear work item ${item.canonicalKey} has no prepared workspace`);
    }
    this.workItems.setWorkspace(item.id, this.defaultCwd);
    return this.defaultCwd;
  }
}

export interface ClaudeProxyWorkerOptions {
  tickMs?: number | undefined;
  maxConcurrentSessions?: number | undefined;
  safetyScreener?: SafetyScreener | undefined;
  onReplyQueued?: (() => void) | undefined;
}

export type ClaudeProxyAdapterRegistry = Readonly<Record<ClaudeProxyAdapterMode, AgentAdapter>>;

/** Runs durable Claude turns without ever handing their messages to a GPT adapter. */
export class ClaudeProxyWorker {
  private readonly tickMs: number;
  private readonly maxConcurrentSessions: number;
  private readonly safetyScreener: SafetyScreener;
  private readonly onReplyQueued: () => void;
  private readonly adapters: ClaudeProxyAdapterRegistry;
  private readonly active = new Map<string, { operation: Promise<void>; abort: AbortController }>();
  private pendingRecoveries: ClaudeProxyTurn[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopping = false;

  constructor(
    private readonly db: Database,
    private readonly people: PeopleStore,
    private readonly workItems: WorkItemStore,
    private readonly requests: AgentRequestStore,
    private readonly proxy: ClaudeProxyStore,
    adapters: ClaudeProxyAdapterRegistry,
    private readonly logger: Logger,
    options: ClaudeProxyWorkerOptions = {},
  ) {
    this.adapters = adapters;
    this.tickMs = options.tickMs ?? 250;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? 4;
    if (!Number.isSafeInteger(this.tickMs) || this.tickMs < 1) {
      throw new TypeError("tickMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxConcurrentSessions) || this.maxConcurrentSessions < 1) {
      throw new TypeError("maxConcurrentSessions must be a positive safe integer");
    }
    this.safetyScreener = options.safetyScreener ?? new PlaceholderLocalSafetyScreener();
    this.onReplyQueued = options.onReplyQueued ?? (() => {});
  }

  start(): ReturnType<ClaudeProxyStore["recoverInFlight"]> {
    if (this.timer) {
      return { sessionsHeld: 0, turnsHeld: [], submittedTurns: [], turnsReleased: [] };
    }
    this.stopping = false;
    const recovered = this.proxy.recoverInFlight();
    this.pendingRecoveries = [...recovered.submittedTurns];
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    this.pumpRecoveries();
    void this.tick();
    return recovered;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pendingRecoveries = [];
    for (const current of this.active.values()) current.abort.abort();
    await Promise.allSettled([...this.active.values()].map(({ operation }) => operation));
  }

  wake(): void {
    if (!this.stopping) {
      this.pumpRecoveries();
      void this.tick();
    }
  }

  async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      this.pumpRecoveries();
      while (this.active.size < this.maxConcurrentSessions) {
        const turn = this.proxy.claimNextTurn();
        if (!turn) break;
        this.launch(turn);
      }
    } finally {
      this.ticking = false;
    }
  }

  private launch(turn: ClaudeProxyTurn): void {
    const abort = new AbortController();
    const operation = this.process(turn, abort.signal)
      .catch((error) => {
        this.logger.error(
          {
            request: turn.agentRequestId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Claude proxy worker persistence failure",
        );
      })
      .finally(() => {
        this.active.delete(turn.agentRequestId);
        if (!this.stopping) {
          this.pumpRecoveries();
          void this.tick();
        }
      });
    this.active.set(turn.agentRequestId, { operation, abort });
  }

  private pumpRecoveries(): void {
    while (
      !this.stopping &&
      this.pendingRecoveries.length > 0 &&
      this.active.size < this.maxConcurrentSessions
    ) {
      const turn = this.pendingRecoveries.shift();
      if (turn) this.launchRecovery(turn);
    }
  }

  private launchRecovery(turn: ClaudeProxyTurn): void {
    const abort = new AbortController();
    const operation = this.recoverSubmitted(turn, abort.signal)
      .catch((error) => {
        this.logger.error(
          {
            request: turn.agentRequestId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Claude proxy recovery persistence failure; submitted turn remains held",
        );
      })
      .finally(() => {
        this.active.delete(turn.agentRequestId);
        if (!this.stopping) {
          this.pumpRecoveries();
          void this.tick();
        }
      });
    this.active.set(turn.agentRequestId, { operation, abort });
  }

  private async recoverSubmitted(turn: ClaudeProxyTurn, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const request = requiredRequest(this.requests, turn.agentRequestId);
      const session = requiredSession(this.proxy, turn.sessionId);
      const current = this.proxy.getTurn(turn.agentRequestId);
      if (
        !current ||
        current.correlationMarker !== turn.correlationMarker ||
        (current.stage !== "held" && current.stage !== "submitted") ||
        current.submittedAt === null
      ) {
        this.logger.warn(
          { request: turn.agentRequestId, session: turn.sessionId },
          "Claude proxy submitted recovery candidate changed and remains untouched",
        );
        return;
      }
      const adapter = this.adapters[session.adapterMode];
      if (!adapter.recoverSubmittedTurn) {
        this.logger.warn(
          { request: request.id, session: session.id, adapterMode: session.adapterMode },
          "Claude proxy adapter cannot observe submitted recovery; turn remains held",
        );
        return;
      }
      const result = await adapter.recoverSubmittedTurn(session.claudeSessionId, {
        requestId: request.id,
        correlationMarker: current.correlationMarker,
        cwd: session.cwd,
        signal,
      });
      signal.throwIfAborted();
      if (!result) {
        this.logger.warn(
          { request: request.id, session: session.id, adapterMode: session.adapterMode },
          "Claude proxy submitted recovery remains ambiguous and held",
        );
        return;
      }
      if (result.threadId !== session.claudeSessionId) {
        throw new Error("Claude recovery returned a different durable session id");
      }
      if (typeof result.finalResponse !== "string" || !result.finalResponse.trim()) {
        throw new Error("Claude recovery did not return a final response");
      }
      const spec = buildClaudeProxyReplySpec(request.event, result.finalResponse);
      const complete = this.db.transaction(() => {
        this.proxy.completeRecoveredTurnAndResume(
          request.id,
          current.correlationMarker,
          result.finalResponse as string,
        );
        this.requests.bindSubmittedCompletion({
          requestId: request.id,
          codexThreadId: session.claudeSessionId,
          correlationMarker: current.correlationMarker,
        });
        this.requests.enqueueFinalReply({ requestId: request.id, spec });
      });
      complete.immediate();
      this.onReplyQueued();
      this.logger.info(
        {
          request: request.id,
          session: session.id,
          claudeSessionId: session.claudeSessionId,
          adapterMode: session.adapterMode,
          ordinal: current.ordinal,
        },
        "recovered submitted Claude proxy turn and queued its source reply",
      );
    } catch (error) {
      if (error instanceof SubmittedDeliveryInterruptedError) {
        this.failInterruptedTurn(turn, error.message, error.sourceReply);
        return;
      }
      this.logger.warn(
        {
          request: turn.agentRequestId,
          session: turn.sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Claude proxy submitted recovery was inconclusive and remains held",
      );
    }
  }

  private async process(turn: ClaudeProxyTurn, signal: AbortSignal): Promise<void> {
    let submissionRecorded = false;
    try {
      signal.throwIfAborted();
      const request = requiredRequest(this.requests, turn.agentRequestId);
      const session = requiredSession(this.proxy, turn.sessionId);
      const adapter = this.adapters[session.adapterMode];
      const authorization = authorizeDispatch(this.people, request, session);

      if (session.closeAfterOrdinal === turn.ordinal) {
        this.closeSessionWithReply(request, session, turn);
        this.onReplyQueued();
        this.logger.info(
          { request: request.id, session: session.id },
          "closed authenticated Claude proxy session",
        );
        return;
      }

      const screenInput = safetyScreenInput(request, authorization.person, session, this.workItems);
      const assessment = SafetyAssessmentSchema.parse(
        await this.safetyScreener.screen(screenInput, { signal }),
      );
      signal.throwIfAborted();
      if (assessment.decision !== "allow") {
        const decision = assessment.decision === "hold" ? "held" : "denied";
        throw new PreSubmissionError(
          `safety screen ${decision} request (${assessment.reasonCodes.join(", ") || "no reason"})`,
        );
      }
      const item = this.workItems.get(session.workItemId);
      if (!item) throw new PreSubmissionError(`work item ${session.workItemId} disappeared`);
      const prompt = buildClaudeSafetyWrappedPrompt({
        ...screenInput,
        requestId: request.id,
        correlationMarker: turn.correlationMarker,
        rolePolicy: authorization.policy.policy,
        assessment,
        presentation: {
          title: item.title,
          description: buildWorkItemTitle(request.event, authorization.person),
        },
      });

      // Record the stable marker before spawning. Any error after this point is
      // ambiguous and is held for reconciliation rather than automatically replayed.
      this.proxy.markTurnSubmitted(request.id, turn.correlationMarker);
      submissionRecorded = true;
      const options = {
        sandbox: sandboxForPolicy(authorization.policy),
        cwd: session.cwd,
        idempotencyKey: session.claudeSessionId,
        signal,
      } as const;
      const result =
        turn.ordinal === 1
          ? await adapter.startThread(prompt, options)
          : await adapter.deliverToThread(session.claudeSessionId, prompt, options);
      if (result.threadId !== session.claudeSessionId) {
        throw new Error("Claude returned a different durable session id");
      }
      if (typeof result.finalResponse !== "string" || !result.finalResponse.trim()) {
        throw new Error("Claude did not return a final response");
      }
      const spec = buildClaudeProxyReplySpec(request.event, result.finalResponse);
      const stage = this.db.transaction(() => {
        this.proxy.completeTurn(request.id, turn.correlationMarker, result.finalResponse as string);
        this.requests.bindSubmittedCompletion({
          requestId: request.id,
          codexThreadId: session.claudeSessionId,
          correlationMarker: turn.correlationMarker,
        });
        this.requests.enqueueFinalReply({ requestId: request.id, spec });
      });
      stage.immediate();
      this.onReplyQueued();
      this.logger.info(
        {
          request: request.id,
          session: session.id,
          claudeSessionId: session.claudeSessionId,
          adapterMode: session.adapterMode,
          ordinal: turn.ordinal,
        },
        "Claude proxy turn completed and queued its source reply",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SubmittedDeliveryInterruptedError && submissionRecorded) {
        this.failInterruptedTurn(turn, message, error.sourceReply);
        return;
      }
      if (error instanceof DeliveryNotSubmittedError) {
        if (signal.aborted) {
          this.proxy.releaseTurnBeforeSubmission(turn.agentRequestId);
          return;
        }
        this.failBeforeSubmission(turn, message);
        return;
      }
      if (submissionRecorded) {
        this.proxy.holdTurn(turn.agentRequestId, message);
        this.releaseQueuedCloseAfterHold(turn.sessionId);
        this.logger.warn(
          { request: turn.agentRequestId, err: message },
          "Claude proxy submission is ambiguous and was held without replay",
        );
        return;
      }
      if (signal.aborted) {
        this.proxy.releaseTurnBeforeSubmission(turn.agentRequestId);
        return;
      }
      this.failBeforeSubmission(turn, message);
    }
  }

  private releaseQueuedCloseAfterHold(sessionId: string): void {
    const closeTurn = this.proxy.getPendingCloseTurn(sessionId);
    if (!closeTurn) return;
    const request = requiredRequest(this.requests, closeTurn.agentRequestId);
    const spec = buildClaudeProxyReplySpec(request.event, CLAUDE_PROXY_HELD_RELEASE_RESPONSE);
    this.proxy.completeHeldReleaseWithReply(request.id, CLAUDE_PROXY_HELD_RELEASE_RESPONSE, spec);
    this.onReplyQueued();
    this.logger.info(
      { request: request.id, session: sessionId },
      "released Claude proxy routing after an earlier ambiguous turn",
    );
  }

  private failInterruptedTurn(turn: ClaudeProxyTurn, error: string, response: string): void {
    const request = requiredRequest(this.requests, turn.agentRequestId);
    const spec = buildClaudeProxyReplySpec(request.event, response);
    const fail = this.db.transaction(() => {
      this.requests.stageTerminalFailureReply({ requestId: request.id, error, spec });
      this.proxy.failSubmittedInterruptionAndResume(request.id, turn.correlationMarker, error);
    });
    fail.immediate();
    this.onReplyQueued();
    this.logger.warn(
      { request: request.id, session: turn.sessionId, err: error },
      "Claude proxy turn ended after an exact permission interruption",
    );
  }

  private closeSessionWithReply(
    request: AgentRequest,
    session: ClaudeProxySession,
    turn: ClaudeProxyTurn,
  ): void {
    const response = "Claude proxy closed. New messages will go back through Chip.";
    const spec = buildClaudeProxyReplySpec(request.event, response);
    const close = this.db.transaction(() => {
      this.proxy.markTurnSubmitted(request.id, turn.correlationMarker);
      this.proxy.completeTurn(request.id, turn.correlationMarker, response);
      this.requests.bindSubmittedCompletion({
        requestId: request.id,
        codexThreadId: session.claudeSessionId,
        correlationMarker: turn.correlationMarker,
      });
      this.requests.enqueueFinalReply({ requestId: request.id, spec });
      this.proxy.closeSession(session.id);
    });
    close.immediate();
  }

  private failBeforeSubmission(turn: ClaudeProxyTurn, message: string): void {
    const request = this.requests.get(turn.agentRequestId);
    if (!request) {
      this.proxy.pauseAfterPreSubmissionFailure(turn.agentRequestId, message);
      return;
    }
    const response =
      "I couldn't send this turn to Claude, so no Claude turn was started. " +
      `WakeWire request: ${request.id}. ${message}`;
    try {
      const spec = buildClaudeProxyReplySpec(request.event, response);
      const fail = this.db.transaction(() => {
        this.requests.stageTerminalFailureReply({ requestId: request.id, error: message, spec });
        this.proxy.pauseAfterPreSubmissionFailure(request.id, message);
      });
      fail.immediate();
      this.onReplyQueued();
    } catch (replyError) {
      this.proxy.pauseAfterPreSubmissionFailure(
        request.id,
        `${message}; could not queue source failure reply: ${replyError instanceof Error ? replyError.message : String(replyError)}`,
      );
    }
    this.logger.warn(
      { request: request.id, err: message },
      "Claude proxy turn failed before submission",
    );
  }
}

class PreSubmissionError extends Error {}

function authorizeDispatch(
  people: PeopleStore,
  request: AgentRequest,
  session: ClaudeProxySession,
): { person: Person; policy: EffectivePolicy } {
  const principal = request.event.principal;
  if (
    principal?.provider !== "slack" ||
    !isAuthenticatedSlackHumanMessage(request.event) ||
    !matchesClaudeConversation(request.event, session.conversationKey)
  ) {
    throw new PreSubmissionError(
      "request no longer matches its authenticated Slack conversation binding",
    );
  }
  if (
    principal.provider !== session.principalProvider ||
    principal.tenantId !== session.principalTenantId ||
    principal.subjectId !== session.principalSubjectId
  ) {
    throw new PreSubmissionError(
      "request principal no longer matches the immutable Claude proxy principal",
    );
  }
  const person = people.resolveIdentity(
    principal.provider,
    principal.tenantId,
    principal.subjectId,
  )?.person;
  if (!person?.enabled || person.id !== request.personId || person.id !== session.personId) {
    throw new PreSubmissionError("person is no longer authorized for this Claude proxy session");
  }
  let policy: EffectivePolicy | null;
  try {
    policy = effectivePolicy(people, person.id);
  } catch (error) {
    if (error instanceof PolicyConfigurationError) throw new PreSubmissionError(error.message);
    throw error;
  }
  if (!policy?.authorized || !canWrite(policy.policy.capabilities.sourceReplies)) {
    throw new PreSubmissionError("person is no longer authorized for source replies");
  }
  if (!isEnforceableDesktopOwner(policy)) {
    throw new PreSubmissionError("person's role cannot be enforced for the Claude proxy");
  }
  if (request.sourceId !== session.sourceId || request.workItemId !== session.workItemId) {
    throw new PreSubmissionError("request no longer matches its immutable Claude proxy binding");
  }
  return { person, policy };
}

function safetyScreenInput(
  request: AgentRequest,
  person: Person,
  session: ClaudeProxySession,
  workItems: WorkItemStore,
): SafetyScreenInput {
  const item = workItems.get(session.workItemId);
  if (!item) throw new PreSubmissionError(`work item ${session.workItemId} disappeared`);
  return {
    principal: { id: person.id, nickname: person.nickname, roleName: person.roleName },
    source: request.event.source,
    sourceDeliveryId: request.sourceDeliveryId,
    canonicalWorkItem: item.canonicalKey,
    requestText: request.requestText,
    providerContext: { summary: request.event.summary, payload: request.event.payload },
  };
}

function claudeConversationKey(event: WakeEvent): string {
  return event.conversation?.rootKey?.trim() ?? "";
}

function legacyClaudeDmConversationKey(event: WakeEvent): string {
  if (stringPayload(event, "channelType") !== "im") return "";
  const team = stringPayload(event, "team");
  const channel = stringPayload(event, "channel");
  return team && channel ? `slack-dm:${team}:${channel}` : "";
}

function matchesClaudeConversation(event: WakeEvent, conversationKey: string): boolean {
  return (
    claudeConversationKey(event) === conversationKey ||
    legacyClaudeDmConversationKey(event) === conversationKey
  );
}

function requiredRequest(requests: AgentRequestStore, id: string): AgentRequest {
  const request = requests.get(id);
  if (!request) throw new PreSubmissionError(`agent request ${id} disappeared`);
  return request;
}

function requiredSession(proxy: ClaudeProxyStore, id: string): ClaudeProxySession {
  const session = proxy.getSession(id);
  if (!session) throw new PreSubmissionError(`Claude proxy session ${id} disappeared`);
  return session;
}

function sandboxForPolicy(policy: EffectivePolicy): "read-only" | "workspace-write" {
  const { filesystem, shell } = policy.policy.capabilities;
  return filesystem === "write" || filesystem === "full" || shell === "write" || shell === "full"
    ? "workspace-write"
    : "read-only";
}

function canWrite(level: "none" | "read" | "write" | "full"): boolean {
  return level === "write" || level === "full";
}

function stringPayload(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function samePrincipal(event: WakeEvent, session: ClaudeProxySession): boolean {
  const principal = event.principal;
  return (
    principal?.provider === session.principalProvider &&
    principal.tenantId === session.principalTenantId &&
    principal.subjectId === session.principalSubjectId
  );
}

function requiredSlackPrincipal(event: WakeEvent): NonNullable<WakeEvent["principal"]> {
  const principal = event.principal;
  if (principal?.provider !== "slack") {
    throw new Error("Claude proxy requires an authenticated Slack principal");
  }
  return principal;
}
