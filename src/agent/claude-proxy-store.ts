import crypto, { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WakeEvent } from "../core/event.js";
import type { Database } from "../db/db.js";
import type { AckSpec } from "./ack.js";
import type { ClaudeProxyAdapterMode } from "./claude-trigger.js";
import {
  DEFAULT_EXECUTION_PROFILE,
  type ExecutionProfile,
  ExecutionProfileSchema,
} from "./execution-profile.js";
import { buildClaudeProxyReplySpec, type SourceReplySpec } from "./reply.js";
import {
  type AckJob,
  type AgentRequest,
  type AgentRequestDedupKey,
  AgentRequestStore,
} from "./store.js";

export type ClaudeProxySessionStatus = "ready" | "busy" | "held" | "paused" | "closed" | "failed";

export type ClaudeProxyTurnStage =
  | "queued"
  | "dispatching"
  | "submitted"
  | "completed"
  | "held"
  | "failed";

export const CLAUDE_PROXY_HELD_RELEASE_RESPONSE =
  "Claude proxy routing released. The ambiguous Claude turn remains held for " +
  "operator review; new messages will go back through Chip.";

export interface ClaudeProxySession {
  id: string;
  sourceId: string;
  provider: string;
  conversationKey: string;
  principalProvider: string;
  principalTenantId: string;
  principalSubjectId: string;
  personId: string;
  workItemId: string;
  cwd: string;
  claudeSessionId: string;
  adapterMode: ClaudeProxyAdapterMode;
  status: ClaudeProxySessionStatus;
  closeAfterOrdinal: number | null;
  error: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaudeProxyTurn {
  agentRequestId: string;
  sessionId: string;
  ordinal: number;
  stage: ClaudeProxyTurnStage;
  correlationMarker: string;
  finalResponse: string | null;
  error: string | null;
  submittedAt: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClaudeProxySessionInput {
  sourceId: string;
  provider: string;
  conversationKey: string;
  principalProvider: string;
  principalTenantId: string;
  principalSubjectId: string;
  personId: string;
  workItemId: string;
  cwd: string;
  adapterMode: ClaudeProxyAdapterMode;
}

export interface AcceptClaudeProxyTurnInput {
  sessionId: string;
  agentRequestId: string;
  /** Recheck the provider-derived key rather than trusting possession of a session UUID. */
  conversationKey: string;
}

/**
 * The preferred ingress API. It writes the ordinary request and its proxy turn
 * in one SQLite transaction, so no dispatcher can observe a half-bound request.
 */
export interface AcceptClaudeProxyEventTurnInput {
  session: CreateClaudeProxySessionInput;
  event: WakeEvent;
  requestText: string;
  /** Freeze an ingress-time barrier so no later message can enter this session. */
  closeRequested?: boolean | undefined;
  executionProfile?: ExecutionProfile | undefined;
  ack?: AckSpec | undefined;
  dedup?: AgentRequestDedupKey | undefined;
  deferAck?: boolean | undefined;
  ackNotBefore?: string | undefined;
}

export interface AcceptClaudeProxyEventTurnResult {
  session: ClaudeProxySession;
  request: AgentRequest;
  ack: AckJob | null;
  turn: ClaudeProxyTurn;
  sessionDuplicate: boolean;
  requestDuplicate: boolean;
  turnDuplicate: boolean;
  /** True only when this exact event-to-turn binding already existed. */
  duplicate: boolean;
}

export interface ClaudeProxyRecoveryResult {
  sessionsHeld: number;
  turnsHeld: ClaudeProxyTurn[];
  submittedTurns: ClaudeProxyTurn[];
  turnsReleased: ClaudeProxyTurn[];
}

export interface ClaudeProxyStoreOptions {
  now?: (() => Date) | undefined;
  randomUUID?: (() => string) | undefined;
}

interface SessionRow {
  id: string;
  source_id: string;
  provider: string;
  conversation_key: string;
  principal_provider: string;
  principal_tenant_id: string;
  principal_subject_id: string;
  person_id: string;
  work_item_id: string;
  cwd: string;
  claude_session_id: string;
  adapter_mode: unknown;
  status: ClaudeProxySessionStatus;
  close_after_ordinal: number | null;
  error: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  agent_request_id: string;
  session_id: string;
  ordinal: number;
  stage: ClaudeProxyTurnStage;
  correlation_marker: string;
  final_response: string | null;
  error: string | null;
  submitted_at: string | null;
  terminal_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestBindingRow {
  source_id: string;
  person_id: string;
  work_item_id: string;
  status: string;
  event_json: string;
}

export class ClaudeProxyConflictError extends Error {}
export class ClaudeProxyNotFoundError extends Error {}
export class ClaudeProxyStateError extends Error {}

/** Durable state only; process spawning and provider replies remain separate workers. */
export class ClaudeProxyStore {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(
    private readonly db: Database,
    options: ClaudeProxyStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  }

  getSession(id: string): ClaudeProxySession | null {
    const row = this.db
      .prepare("SELECT * FROM claude_proxy_sessions WHERE id = ?")
      .get(required(id, "Claude proxy session id")) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  findActiveSession(
    sourceId: string,
    provider: string,
    conversationKey: string,
  ): ClaudeProxySession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM claude_proxy_sessions
         WHERE source_id = ? AND provider = ? AND conversation_key = ?
           AND status IN ('ready', 'busy', 'held')`,
      )
      .get(
        required(sourceId, "Claude proxy source id"),
        normalizedProvider(provider),
        required(conversationKey, "Claude proxy conversation key"),
      ) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  /** Reuse only an exact active binding; a changed principal/work item/cwd fails closed. */
  createOrReuseSession(input: CreateClaudeProxySessionInput): {
    session: ClaudeProxySession;
    duplicate: boolean;
  } {
    const binding = validatedSessionBinding(input);
    const run = this.db.transaction(() => {
      const existing = this.findActiveSession(
        binding.sourceId,
        binding.provider,
        binding.conversationKey,
      );
      if (existing) {
        assertSameSessionBinding(existing, binding);
        return { session: existing, duplicate: true };
      }

      const id = validUuid(this.randomUUID(), "Claude proxy session id");
      const claudeSessionId = validUuid(this.randomUUID(), "Claude session id");
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO claude_proxy_sessions
            (id, source_id, provider, conversation_key,
             principal_provider, principal_tenant_id, principal_subject_id,
             person_id, work_item_id, cwd, claude_session_id, adapter_mode,
             status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        )
        .run(
          id,
          binding.sourceId,
          binding.provider,
          binding.conversationKey,
          binding.principalProvider,
          binding.principalTenantId,
          binding.principalSubjectId,
          binding.personId,
          binding.workItemId,
          binding.cwd,
          claudeSessionId,
          binding.adapterMode,
          now,
          now,
        );
      return { session: this.requireSession(id), duplicate: false };
    });
    return run.immediate();
  }

  getTurn(agentRequestId: string): ClaudeProxyTurn | null {
    const row = this.db
      .prepare("SELECT * FROM claude_proxy_turns WHERE agent_request_id = ?")
      .get(required(agentRequestId, "agent request id")) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  listTurns(sessionId: string): ClaudeProxyTurn[] {
    return (
      this.db
        .prepare("SELECT * FROM claude_proxy_turns WHERE session_id = ? ORDER BY ordinal, rowid")
        .all(required(sessionId, "Claude proxy session id")) as TurnRow[]
    ).map(toTurn);
  }

  /** Return only the durable host close control that is still waiting in FIFO. */
  getPendingCloseTurn(sessionId: string): ClaudeProxyTurn | null {
    const id = required(sessionId, "Claude proxy session id");
    const row = this.db
      .prepare(
        `SELECT turn.* FROM claude_proxy_turns turn
         JOIN claude_proxy_sessions session ON session.id = turn.session_id
         WHERE session.id = ?
           AND session.close_after_ordinal = turn.ordinal
           AND turn.stage = 'queued'`,
      )
      .get(id) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  /**
   * Accept an initial or follow-up provider event and bind it before commit.
   * The ordinary Codex-ready query must also exclude rows present in
   * claude_proxy_turns; that worker-side query change is intentionally outside
   * this persistence module.
   */
  acceptEventTurn(input: AcceptClaudeProxyEventTurnInput): AcceptClaudeProxyEventTurnResult {
    const requestText = nonEmptyText(input.requestText, "Claude proxy request text");
    const expectedProfile = ExecutionProfileSchema.parse(
      input.executionProfile ?? DEFAULT_EXECUTION_PROFILE,
    );
    const run = this.db.transaction(() => {
      const sessionResult = this.createOrReuseSession(input.session);
      const requests = new AgentRequestStore(this.db);
      const accepted = requests.accept({
        sourceId: input.session.sourceId,
        event: input.event,
        personId: input.session.personId,
        workItemId: input.session.workItemId,
        requestText,
        executionProfile: expectedProfile,
        ...(input.ack ? { ack: input.ack } : {}),
        ...(input.dedup ? { dedup: input.dedup } : {}),
        ...(input.deferAck !== undefined ? { deferAck: input.deferAck } : {}),
        ...(input.ackNotBefore !== undefined ? { ackNotBefore: input.ackNotBefore } : {}),
      });
      if (accepted.duplicate) {
        assertSameAcceptedRequest(accepted.request, accepted.ack, input, expectedProfile);
      }
      const turnResult = this.acceptTurn({
        sessionId: sessionResult.session.id,
        agentRequestId: accepted.request.id,
        conversationKey: input.session.conversationKey,
      });
      if (input.closeRequested) {
        const current = this.requireSession(sessionResult.session.id);
        if (current.closeAfterOrdinal === null) {
          const now = this.timestamp();
          const update = this.db
            .prepare(
              `UPDATE claude_proxy_sessions
                 SET close_after_ordinal = ?, updated_at = ?
               WHERE id = ? AND close_after_ordinal IS NULL`,
            )
            .run(turnResult.turn.ordinal, now, current.id);
          if (update.changes !== 1) {
            throw new ClaudeProxyConflictError(
              `Claude proxy session ${current.id} changed while its close barrier was recorded`,
            );
          }
        } else if (current.closeAfterOrdinal !== turnResult.turn.ordinal) {
          throw new ClaudeProxyStateError(
            `Claude proxy session ${current.id} is already closing after turn ${current.closeAfterOrdinal}`,
          );
        }
      }
      return {
        session: this.requireSession(sessionResult.session.id),
        request: accepted.request,
        ack: accepted.ack,
        turn: turnResult.turn,
        sessionDuplicate: sessionResult.duplicate,
        requestDuplicate: accepted.duplicate,
        turnDuplicate: turnResult.duplicate,
        duplicate: accepted.duplicate && turnResult.duplicate,
      };
    });
    return run.immediate();
  }

  /**
   * Bind one already-deduplicated authenticated request to this proxy exactly
   * once. Call this inside the transaction that accepts a new request; otherwise
   * use acceptEventTurn so the ordinary dispatcher cannot observe a gap.
   */
  acceptTurn(input: AcceptClaudeProxyTurnInput): {
    turn: ClaudeProxyTurn;
    duplicate: boolean;
  } {
    const sessionId = required(input.sessionId, "Claude proxy session id");
    const agentRequestId = required(input.agentRequestId, "agent request id");
    const conversationKey = required(input.conversationKey, "Claude proxy conversation key");
    const run = this.db.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.conversationKey !== conversationKey) {
        throw new ClaudeProxyConflictError(
          `Claude proxy session ${session.id} belongs to a different provider conversation`,
        );
      }
      const existing = this.getTurn(agentRequestId);
      if (existing) {
        if (existing.sessionId !== session.id) {
          throw new ClaudeProxyConflictError(
            `agent request ${agentRequestId} is already bound to another Claude proxy session`,
          );
        }
        return { turn: existing, duplicate: true };
      }

      if (
        session.status === "paused" ||
        session.status === "closed" ||
        session.status === "failed"
      ) {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot accept a turn while ${session.status}`,
        );
      }
      if (session.closeAfterOrdinal !== null) {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} is closing and cannot accept another turn`,
        );
      }

      const request = this.requestBinding(agentRequestId);
      if (
        request.source_id !== session.sourceId ||
        request.person_id !== session.personId ||
        request.work_item_id !== session.workItemId
      ) {
        throw new ClaudeProxyConflictError(
          `agent request ${agentRequestId} does not match Claude proxy session ${session.id}`,
        );
      }
      if (session.provider === "slack" && eventSource(request.event_json) !== "slack") {
        throw new ClaudeProxyConflictError(
          `agent request ${agentRequestId} is not an authenticated Slack event`,
        );
      }
      if (request.status !== "acknowledged") {
        throw new ClaudeProxyStateError(
          `agent request ${agentRequestId} cannot enter Claude proxy mode from ${request.status}`,
        );
      }

      const ordinal = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
             FROM claude_proxy_turns WHERE session_id = ?`,
          )
          .get(session.id) as { ordinal: number }
      ).ordinal;
      const marker = claudeCorrelationMarker(session.id, agentRequestId);
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO claude_proxy_turns
            (agent_request_id, session_id, ordinal, stage, correlation_marker,
             created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(agentRequestId, session.id, ordinal, marker, now, now);
      return { turn: this.requireTurn(agentRequestId), duplicate: false };
    });
    return run.immediate();
  }

  /** Atomically claim one FIFO turn. A busy/held session cannot claim another. */
  claimNextTurn(sessionId?: string): ClaudeProxyTurn | null {
    const target = sessionId ? required(sessionId, "Claude proxy session id") : null;
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT turn.*
             FROM claude_proxy_turns turn
             JOIN claude_proxy_sessions session ON session.id = turn.session_id
            WHERE session.status = 'ready'
              AND turn.stage = 'queued'
              AND (? IS NULL OR turn.session_id = ?)
              AND NOT EXISTS (
                SELECT 1 FROM claude_proxy_turns earlier
                 WHERE earlier.session_id = turn.session_id
                   AND earlier.ordinal < turn.ordinal
                   AND earlier.stage NOT IN ('completed', 'failed')
              )
            ORDER BY turn.created_at, turn.session_id, turn.ordinal
            LIMIT 1`,
        )
        .get(target, target) as TurnRow | undefined;
      if (!row) return null;

      const now = this.timestamp();
      const sessionUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_sessions SET status = 'busy', updated_at = ?
           WHERE id = ? AND status = 'ready'`,
        )
        .run(now, row.session_id);
      const turnUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_turns SET stage = 'dispatching', updated_at = ?
           WHERE agent_request_id = ? AND stage = 'queued'`,
        )
        .run(now, row.agent_request_id);
      const requestUpdate = this.db
        .prepare(
          `UPDATE agent_requests SET status = 'dispatching', error = NULL,
             next_attempt_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'acknowledged'`,
        )
        .run(now, row.agent_request_id);
      if (sessionUpdate.changes !== 1 || turnUpdate.changes !== 1 || requestUpdate.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `Claude proxy turn ${row.agent_request_id} changed while it was being claimed`,
        );
      }
      return this.requireTurn(row.agent_request_id);
    });
    return run.immediate();
  }

  markTurnSubmitted(agentRequestId: string, correlationMarker: string): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const marker = required(correlationMarker, "Claude proxy correlation marker");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      assertMarker(turn, marker);
      if (turn.stage === "submitted") return turn;
      if (turn.stage !== "dispatching") {
        throw new ClaudeProxyStateError(
          `Claude proxy turn ${requestId} cannot be submitted from ${turn.stage}`,
        );
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "busy") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} is ${session.status}, not busy`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_turns SET stage = 'submitted', submitted_at = ?, updated_at = ?
           WHERE agent_request_id = ? AND stage = 'dispatching'`,
        )
        .run(now, now, requestId);
      const requestUpdate = this.db
        .prepare(
          `UPDATE agent_requests SET status = 'submitted', error = NULL,
             next_attempt_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'dispatching'`,
        )
        .run(now, requestId);
      if (requestUpdate.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `agent request ${requestId} changed while Claude submission was recorded`,
        );
      }
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  /** Persist the exact terminal Claude response; provider delivery is a later outbox effect. */
  completeTurn(
    agentRequestId: string,
    correlationMarker: string,
    finalResponse: string,
  ): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const marker = required(correlationMarker, "Claude proxy correlation marker");
    nonEmptyText(finalResponse, "Claude final response");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      assertMarker(turn, marker);
      if (turn.stage === "completed") {
        if (turn.finalResponse !== finalResponse) {
          throw new ClaudeProxyConflictError(
            `Claude proxy turn ${requestId} already has a different final response`,
          );
        }
        return turn;
      }
      if (turn.stage !== "submitted") {
        throw new ClaudeProxyStateError(
          `Claude proxy turn ${requestId} cannot complete from ${turn.stage}`,
        );
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "busy" && session.status !== "held") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot complete a turn while ${session.status}`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_turns
             SET stage = 'completed', final_response = ?, error = NULL,
                 terminal_at = ?, updated_at = ?
           WHERE agent_request_id = ? AND stage = 'submitted'`,
        )
        .run(finalResponse, now, now, requestId);
      if (session.status === "busy") {
        this.db
          .prepare(
            `UPDATE claude_proxy_sessions SET status = 'ready', updated_at = ?
             WHERE id = ? AND status = 'busy'`,
          )
          .run(now, session.id);
      }
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  /**
   * Commit a response recovered by observation of an already-submitted turn.
   * This method never requeues model work. Callers must bind the completion
   * and enqueue its exact source reply in the same surrounding transaction.
   */
  completeRecoveredTurnAndResume(
    agentRequestId: string,
    correlationMarker: string,
    finalResponse: string,
  ): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const marker = required(correlationMarker, "Claude proxy correlation marker");
    const response = nonEmptyText(finalResponse, "Claude recovered final response");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      assertMarker(turn, marker);
      if (turn.stage === "completed") {
        if (turn.finalResponse !== response) {
          throw new ClaudeProxyConflictError(
            `Claude proxy turn ${requestId} already has a different final response`,
          );
        }
        return turn;
      }
      if ((turn.stage !== "submitted" && turn.stage !== "held") || turn.submittedAt === null) {
        throw new ClaudeProxyStateError(
          `Claude proxy turn ${requestId} cannot recover a completion from ${turn.stage}`,
        );
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "busy" && session.status !== "held") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot recover a completion while ${session.status}`,
        );
      }
      const request = new AgentRequestStore(this.db).get(requestId);
      if (!request || (request.status !== "submitted" && request.status !== "held")) {
        throw new ClaudeProxyStateError(
          `agent request ${requestId} cannot recover a completion from ${request?.status ?? "missing"}`,
        );
      }
      const now = this.timestamp();
      const turnUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_turns
             SET stage = 'completed', final_response = ?, error = NULL,
                 terminal_at = ?, updated_at = ?
           WHERE agent_request_id = ? AND stage IN ('submitted', 'held')`,
        )
        .run(response, now, now, requestId);
      const requestUpdate = this.db
        .prepare(
          `UPDATE agent_requests SET status = 'submitted', error = NULL,
             next_attempt_at = NULL, updated_at = ?
           WHERE id = ? AND status IN ('submitted', 'held')`,
        )
        .run(now, requestId);
      const sessionUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_sessions
             SET status = 'ready', error = NULL, updated_at = ?
           WHERE id = ? AND status IN ('busy', 'held')`,
        )
        .run(now, session.id);
      if (turnUpdate.changes !== 1 || requestUpdate.changes !== 1 || sessionUpdate.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `Claude proxy recovered completion ${requestId} changed while it was committed`,
        );
      }
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  /**
   * Resolve an exact, durable post-submission interruption without replaying it.
   * The failed outbox row must be staged in the surrounding transaction first;
   * later FIFO turns may run only after this submitted turn becomes terminal.
   */
  failSubmittedInterruptionAndResume(
    agentRequestId: string,
    correlationMarker: string,
    error: string,
  ): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const marker = required(correlationMarker, "Claude proxy correlation marker");
    const reason = required(error, "Claude proxy interruption");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      assertMarker(turn, marker);
      if (turn.stage === "failed") {
        if (turn.error !== reason) {
          throw new ClaudeProxyConflictError(
            `Claude proxy turn ${requestId} already failed for another reason`,
          );
        }
        return turn;
      }
      if ((turn.stage !== "submitted" && turn.stage !== "held") || turn.submittedAt === null) {
        throw new ClaudeProxyStateError(
          `Claude proxy turn ${requestId} cannot resolve an interruption from ${turn.stage}`,
        );
      }
      const requests = new AgentRequestStore(this.db);
      const request = requests.get(requestId);
      const reply = requests.sourceReplyForRequest(requestId);
      if (
        request?.status !== "failed" ||
        request.error !== reason ||
        reply?.requestOutcome !== "failed"
      ) {
        throw new ClaudeProxyStateError(
          `Claude proxy interruption ${requestId} has no matching failed source reply`,
        );
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "busy" && session.status !== "held") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot resolve an interruption while ${session.status}`,
        );
      }
      const now = this.timestamp();
      const turnUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_turns
           SET stage = 'failed', final_response = NULL, error = ?, terminal_at = ?, updated_at = ?
           WHERE agent_request_id = ? AND stage IN ('submitted', 'held')`,
        )
        .run(reason, now, now, requestId);
      const sessionUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_sessions
             SET status = 'ready', error = NULL, updated_at = ?
           WHERE id = ? AND status IN ('busy', 'held')`,
        )
        .run(now, session.id);
      if (turnUpdate.changes !== 1 || sessionUpdate.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `Claude proxy interruption ${requestId} changed while it was resolved`,
        );
      }
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  holdTurn(agentRequestId: string, error: string): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const reason = required(error, "Claude proxy hold reason");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      if (turn.stage === "held") {
        if (turn.error !== reason) {
          throw new ClaudeProxyConflictError(
            `Claude proxy turn ${requestId} is already held for another reason`,
          );
        }
        return turn;
      }
      if (turn.stage !== "dispatching" && turn.stage !== "submitted") {
        throw new ClaudeProxyStateError(
          `Claude proxy turn ${requestId} cannot be held from ${turn.stage}`,
        );
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "busy" && session.status !== "held") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot hold a turn while ${session.status}`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_turns SET stage = 'held', error = ?, updated_at = ?
           WHERE agent_request_id = ? AND stage IN ('dispatching', 'submitted')`,
        )
        .run(reason, now, requestId);
      this.db
        .prepare(
          `UPDATE claude_proxy_sessions SET status = 'held', error = ?, updated_at = ?
           WHERE id = ? AND status = 'busy'`,
        )
        .run(reason, now, session.id);
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'held', error = ?, next_attempt_at = NULL,
             updated_at = ? WHERE id = ? AND status IN ('dispatching', 'submitted')`,
        )
        .run(reason, now, requestId);
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  failTurn(agentRequestId: string, error: string): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const reason = required(error, "Claude proxy failure");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      if (turn.stage === "failed") {
        if (turn.error !== reason) {
          throw new ClaudeProxyConflictError(
            `Claude proxy turn ${requestId} already failed for another reason`,
          );
        }
        return turn;
      }
      if (turn.stage === "completed") {
        throw new ClaudeProxyStateError(`completed Claude proxy turn ${requestId} cannot fail`);
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status === "closed" || session.status === "failed") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot fail a turn while ${session.status}`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_turns
             SET stage = 'failed', final_response = NULL, error = ?, terminal_at = ?, updated_at = ?
           WHERE agent_request_id = ? AND stage <> 'completed'`,
        )
        .run(reason, now, now, requestId);
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'failed', error = ?, next_attempt_at = NULL,
             updated_at = ? WHERE id = ?`,
        )
        .run(reason, now, requestId);
      if (session.status === "ready" || session.status === "busy") {
        this.db
          .prepare(
            `UPDATE claude_proxy_sessions SET status = 'held', error = ?, updated_at = ?
             WHERE id = ? AND status IN ('ready', 'busy')`,
          )
          .run(reason, now, session.id);
      }
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  /**
   * A failure proven to precede model submission is terminal for that one turn,
   * but must not strand already-accepted later messages or keep capturing the
   * provider conversation. Preserve those messages as held evidence and pause
   * only this routing session; a later explicit trigger may create a new one.
   */
  pauseAfterPreSubmissionFailure(agentRequestId: string, error: string): ClaudeProxySession {
    const requestId = required(agentRequestId, "agent request id");
    const reason = required(error, "Claude proxy failure");
    const run = this.db.transaction(() => {
      const failed = this.failTurn(requestId, reason);
      const session = this.requireSession(failed.sessionId);
      const now = this.timestamp();
      const queued = this.db
        .prepare(
          `SELECT agent_request_id FROM claude_proxy_turns
           WHERE session_id = ? AND ordinal > ? AND stage = 'queued'
           ORDER BY ordinal`,
        )
        .all(session.id, failed.ordinal) as Array<{ agent_request_id: string }>;
      for (const row of queued) {
        this.db
          .prepare(
            `UPDATE claude_proxy_turns SET stage = 'held', error = ?, updated_at = ?
             WHERE agent_request_id = ? AND stage = 'queued'`,
          )
          .run(reason, now, row.agent_request_id);
        this.db
          .prepare(
            `UPDATE agent_requests SET status = 'held', error = ?, next_attempt_at = NULL,
               updated_at = ? WHERE id = ? AND status = 'acknowledged'`,
          )
          .run(reason, now, row.agent_request_id);
      }
      const update = this.db
        .prepare(
          `UPDATE claude_proxy_sessions SET status = 'paused', error = ?, updated_at = ?
           WHERE id = ? AND status = 'held'`,
        )
        .run(reason, now, session.id);
      if (update.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `Claude proxy session ${session.id} changed while it was being paused`,
        );
      }
      return this.requireSession(session.id);
    });
    return run.immediate();
  }

  /** A cooperative stop proven to precede process spawn is safe to put back in FIFO. */
  releaseTurnBeforeSubmission(agentRequestId: string): ClaudeProxyTurn {
    const requestId = required(agentRequestId, "agent request id");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      if (turn.stage !== "dispatching" && turn.stage !== "submitted") {
        throw new ClaudeProxyStateError(
          `Claude proxy turn ${requestId} cannot be released from ${turn.stage}`,
        );
      }
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "busy") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} cannot release a turn while ${session.status}`,
        );
      }
      const now = this.timestamp();
      const turnUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_turns
             SET stage = 'queued', submitted_at = NULL, updated_at = ?
           WHERE agent_request_id = ? AND stage IN ('dispatching', 'submitted')`,
        )
        .run(now, requestId);
      const requestUpdate = this.db
        .prepare(
          `UPDATE agent_requests SET status = 'acknowledged', error = NULL,
             next_attempt_at = NULL, updated_at = ?
           WHERE id = ? AND status IN ('dispatching', 'submitted')`,
        )
        .run(now, requestId);
      const sessionUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_sessions SET status = 'ready', updated_at = ?
           WHERE id = ? AND status = 'busy'`,
        )
        .run(now, session.id);
      if (turnUpdate.changes !== 1 || requestUpdate.changes !== 1 || sessionUpdate.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `Claude proxy turn ${requestId} changed while it was being safely released`,
        );
      }
      return this.requireTurn(requestId);
    });
    return run.immediate();
  }

  /**
   * Exact exit while an ambiguous turn is held releases only conversation
   * routing. The held turn and its marker remain intact for operator evidence.
   */
  completeHeldReleaseWithReply(
    agentRequestId: string,
    response: string,
    spec: SourceReplySpec,
  ): { session: ClaudeProxySession; turn: ClaudeProxyTurn } {
    const requestId = required(agentRequestId, "agent request id");
    const finalResponse = nonEmptyText(response, "Claude proxy release response");
    const run = this.db.transaction(() => {
      const turn = this.requireTurn(requestId);
      const session = this.requireSession(turn.sessionId);
      if (session.status !== "held" || session.closeAfterOrdinal !== turn.ordinal) {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${session.id} is not awaiting this held-session release`,
        );
      }
      if (turn.stage !== "queued") {
        throw new ClaudeProxyStateError(
          `Claude proxy release turn ${requestId} cannot complete from ${turn.stage}`,
        );
      }
      const now = this.timestamp();
      const requests = new AgentRequestStore(this.db);
      const stranded = this.db
        .prepare(
          `SELECT * FROM claude_proxy_turns
           WHERE session_id = ? AND ordinal < ? AND stage = 'queued'
           ORDER BY ordinal`,
        )
        .all(session.id, turn.ordinal) as TurnRow[];
      for (const row of stranded) {
        const queuedRequest = requests.get(row.agent_request_id);
        if (!queuedRequest) {
          throw new ClaudeProxyNotFoundError(
            `agent request ${row.agent_request_id} for a queued Claude turn disappeared`,
          );
        }
        const failure =
          "This queued Claude turn was not sent because an earlier Claude turn has an " +
          `ambiguous outcome and proxy routing was released. WakeWire request: ${queuedRequest.id}.`;
        requests.stageTerminalFailureReply({
          requestId: queuedRequest.id,
          error: failure,
          spec: buildClaudeProxyReplySpec(queuedRequest.event, failure),
        });
        this.failTurn(queuedRequest.id, failure);
      }
      const turnUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_turns
             SET stage = 'completed', final_response = ?, submitted_at = ?, terminal_at = ?,
                 updated_at = ?
           WHERE agent_request_id = ? AND stage = 'queued'`,
        )
        .run(finalResponse, now, now, now, requestId);
      const requestUpdate = this.db
        .prepare(
          `UPDATE agent_requests SET status = 'submitted', error = NULL,
             next_attempt_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'acknowledged'`,
        )
        .run(now, requestId);
      const sessionUpdate = this.db
        .prepare(
          `UPDATE claude_proxy_sessions SET status = 'paused', updated_at = ?
           WHERE id = ? AND status = 'held'`,
        )
        .run(now, session.id);
      if (turnUpdate.changes !== 1 || requestUpdate.changes !== 1 || sessionUpdate.changes !== 1) {
        throw new ClaudeProxyConflictError(
          `Claude proxy held-session release ${requestId} changed while it was committed`,
        );
      }
      requests.bindSubmittedCompletion({
        requestId,
        codexThreadId: session.claudeSessionId,
        correlationMarker: turn.correlationMarker,
      });
      requests.enqueueFinalReply({ requestId, spec });
      return { session: this.requireSession(session.id), turn: this.requireTurn(requestId) };
    });
    return run.immediate();
  }

  holdSession(sessionId: string, error: string): ClaudeProxySession {
    const id = required(sessionId, "Claude proxy session id");
    const reason = required(error, "Claude proxy hold reason");
    const run = this.db.transaction(() => {
      const session = this.requireSession(id);
      if (session.status === "held") {
        if (session.error !== reason) {
          throw new ClaudeProxyConflictError(
            `Claude proxy session ${id} is already held for another reason`,
          );
        }
        return session;
      }
      if (session.status !== "ready") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${id} cannot be held while ${session.status}`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_sessions SET status = 'held', error = ?, updated_at = ?
           WHERE id = ? AND status = 'ready'`,
        )
        .run(reason, now, id);
      return this.requireSession(id);
    });
    return run.immediate();
  }

  resumeSession(sessionId: string): ClaudeProxySession {
    const id = required(sessionId, "Claude proxy session id");
    const run = this.db.transaction(() => {
      const session = this.requireSession(id);
      if (session.status === "ready") return session;
      if (session.status !== "held") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${id} cannot resume while ${session.status}`,
        );
      }
      if (this.hasUnresolvedTurn(id)) {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${id} still has an unresolved in-flight turn`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_sessions
             SET status = 'ready', error = NULL, updated_at = ?
           WHERE id = ? AND status = 'held'`,
        )
        .run(now, id);
      return this.requireSession(id);
    });
    return run.immediate();
  }

  closeSession(sessionId: string): ClaudeProxySession {
    return this.terminalizeSession(sessionId, "closed");
  }

  failSession(sessionId: string, error: string): ClaudeProxySession {
    return this.terminalizeSession(sessionId, "failed", required(error, "Claude proxy failure"));
  }

  /**
   * On startup, never resend an ambiguous turn. Dispatching and submitted turns
   * become held; submitted turns retain their marker and timestamp for an
   * observation-only adapter recovery pass. Host-only close controls are safe
   * to resume or complete because they never invoke Claude.
   */
  recoverInFlight(
    error = "WakeWire restarted while the Claude proxy turn was in flight",
  ): ClaudeProxyRecoveryResult {
    const reason = required(error, "Claude proxy recovery reason");
    const run = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM claude_proxy_turns
           WHERE stage IN ('dispatching', 'submitted')
           ORDER BY session_id, ordinal`,
        )
        .all() as TurnRow[];
      const safeCloseControls = rows.filter((row) => {
        if (row.stage !== "dispatching") return false;
        const session = this.requireSession(row.session_id);
        return session.closeAfterOrdinal === row.ordinal;
      });
      const safeCloseIds = new Set(safeCloseControls.map((row) => row.agent_request_id));
      const ambiguousRows = rows.filter((row) => !safeCloseIds.has(row.agent_request_id));
      const sessions = new Set(ambiguousRows.map((row) => row.session_id));
      const now = this.timestamp();

      for (const row of safeCloseControls) {
        this.db
          .prepare(
            `UPDATE claude_proxy_turns SET stage = 'queued', updated_at = ?
             WHERE agent_request_id = ? AND stage = 'dispatching'`,
          )
          .run(now, row.agent_request_id);
        this.db
          .prepare(
            `UPDATE agent_requests SET status = 'acknowledged', error = NULL,
               next_attempt_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'dispatching'`,
          )
          .run(now, row.agent_request_id);
        this.db
          .prepare(
            `UPDATE claude_proxy_sessions SET status = 'ready', updated_at = ?
             WHERE id = ? AND status = 'busy'`,
          )
          .run(now, row.session_id);
      }
      let sessionsHeld = 0;
      for (const sessionId of sessions) {
        sessionsHeld += this.db
          .prepare(
            `UPDATE claude_proxy_sessions
               SET status = 'held', error = ?, updated_at = ?
             WHERE id = ? AND status IN ('ready', 'busy')`,
          )
          .run(reason, now, sessionId).changes;
      }

      const dispatching = ambiguousRows.filter((row) => row.stage === "dispatching");
      for (const row of ambiguousRows) {
        this.db
          .prepare(
            `UPDATE claude_proxy_turns SET stage = 'held', error = ?, updated_at = ?
             WHERE agent_request_id = ? AND stage IN ('dispatching', 'submitted')`,
          )
          .run(reason, now, row.agent_request_id);
        this.db
          .prepare(
            `UPDATE agent_requests SET status = 'held', error = ?, next_attempt_at = NULL,
               updated_at = ?
             WHERE id = ? AND status IN ('acknowledged', 'dispatching', 'submitted', 'held')`,
          )
          .run(reason, now, row.agent_request_id);
      }

      const submitted = this.db
        .prepare(
          `SELECT turn.* FROM claude_proxy_turns turn
           JOIN claude_proxy_sessions session ON session.id = turn.session_id
           WHERE turn.stage = 'held'
             AND turn.submitted_at IS NOT NULL
             AND session.status = 'held'
           ORDER BY turn.created_at, turn.session_id, turn.ordinal`,
        )
        .all() as TurnRow[];

      const heldCloseControls = this.db
        .prepare(
          `SELECT turn.* FROM claude_proxy_turns turn
           JOIN claude_proxy_sessions session ON session.id = turn.session_id
           WHERE session.status = 'held'
             AND session.close_after_ordinal = turn.ordinal
             AND turn.stage = 'queued'
           ORDER BY turn.created_at, turn.session_id, turn.ordinal`,
        )
        .all() as TurnRow[];
      const requests = new AgentRequestStore(this.db);
      for (const row of heldCloseControls) {
        const request = requests.get(row.agent_request_id);
        if (!request) {
          throw new ClaudeProxyNotFoundError(
            `agent request ${row.agent_request_id} for a close control disappeared`,
          );
        }
        this.completeHeldReleaseWithReply(
          request.id,
          CLAUDE_PROXY_HELD_RELEASE_RESPONSE,
          buildClaudeProxyReplySpec(request.event, CLAUDE_PROXY_HELD_RELEASE_RESPONSE),
        );
      }

      return {
        sessionsHeld,
        turnsHeld: dispatching.map((row) => this.requireTurn(row.agent_request_id)),
        submittedTurns: submitted.map((row) => this.requireTurn(row.agent_request_id)),
        turnsReleased: [...safeCloseControls, ...heldCloseControls].map((row) =>
          this.requireTurn(row.agent_request_id),
        ),
      };
    });
    return run.immediate();
  }

  private terminalizeSession(
    sessionId: string,
    status: "closed" | "failed",
    error?: string,
  ): ClaudeProxySession {
    const id = required(sessionId, "Claude proxy session id");
    const run = this.db.transaction(() => {
      const session = this.requireSession(id);
      if (session.status === status) {
        if (status === "failed" && session.error !== error) {
          throw new ClaudeProxyConflictError(
            `Claude proxy session ${id} already failed for another reason`,
          );
        }
        return session;
      }
      if (session.status === "closed" || session.status === "failed") {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${id} is already terminal (${session.status})`,
        );
      }
      if (this.hasPendingTurn(id)) {
        throw new ClaudeProxyStateError(
          `Claude proxy session ${id} cannot become ${status} with pending turns`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE claude_proxy_sessions
             SET status = ?, error = ?, closed_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('ready', 'held')`,
        )
        .run(status, status === "failed" ? error : null, now, now, id);
      return this.requireSession(id);
    });
    return run.immediate();
  }

  private hasPendingTurn(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM claude_proxy_turns
           WHERE session_id = ? AND stage IN ('queued', 'dispatching', 'submitted', 'held')
           LIMIT 1`,
        )
        .get(sessionId),
    );
  }

  private hasUnresolvedTurn(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM claude_proxy_turns
           WHERE session_id = ? AND stage IN ('dispatching', 'submitted', 'held')
           LIMIT 1`,
        )
        .get(sessionId),
    );
  }

  private requireSession(id: string): ClaudeProxySession {
    const session = this.getSession(id);
    if (!session) throw new ClaudeProxyNotFoundError(`Claude proxy session ${id} does not exist`);
    return session;
  }

  private requireTurn(agentRequestId: string): ClaudeProxyTurn {
    const turn = this.getTurn(agentRequestId);
    if (!turn) {
      throw new ClaudeProxyNotFoundError(
        `Claude proxy turn for agent request ${agentRequestId} does not exist`,
      );
    }
    return turn;
  }

  private requestBinding(agentRequestId: string): RequestBindingRow {
    const row = this.db
      .prepare(
        `SELECT source_id, person_id, work_item_id, status, event_json
         FROM agent_requests WHERE id = ?`,
      )
      .get(agentRequestId) as RequestBindingRow | undefined;
    if (!row) {
      throw new ClaudeProxyNotFoundError(`agent request ${agentRequestId} does not exist`);
    }
    return row;
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new TypeError("Claude proxy clock returned an invalid date");
    }
    return date.toISOString();
  }
}

function toSession(row: SessionRow): ClaudeProxySession {
  return {
    id: row.id,
    sourceId: row.source_id,
    provider: row.provider,
    conversationKey: row.conversation_key,
    principalProvider: row.principal_provider,
    principalTenantId: row.principal_tenant_id,
    principalSubjectId: row.principal_subject_id,
    personId: row.person_id,
    workItemId: row.work_item_id,
    cwd: row.cwd,
    claudeSessionId: row.claude_session_id,
    adapterMode: validatedAdapterMode(row.adapter_mode),
    status: row.status,
    closeAfterOrdinal: row.close_after_ordinal,
    error: row.error,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTurn(row: TurnRow): ClaudeProxyTurn {
  return {
    agentRequestId: row.agent_request_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    stage: row.stage,
    correlationMarker: row.correlation_marker,
    finalResponse: row.final_response,
    error: row.error,
    submittedAt: row.submitted_at,
    terminalAt: row.terminal_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatedSessionBinding(input: CreateClaudeProxySessionInput) {
  const cwd = required(input.cwd, "Claude proxy cwd");
  if (!path.isAbsolute(cwd)) throw new TypeError("Claude proxy cwd must be absolute");
  return {
    sourceId: required(input.sourceId, "Claude proxy source id"),
    provider: normalizedProvider(input.provider),
    conversationKey: required(input.conversationKey, "Claude proxy conversation key"),
    principalProvider: normalizedProvider(input.principalProvider),
    principalTenantId: required(input.principalTenantId, "Claude proxy principal tenant id"),
    principalSubjectId: required(input.principalSubjectId, "Claude proxy principal subject id"),
    personId: required(input.personId, "Claude proxy person id"),
    workItemId: required(input.workItemId, "Claude proxy work item id"),
    cwd,
    adapterMode: validatedAdapterMode(input.adapterMode),
  };
}

function assertSameSessionBinding(
  session: ClaudeProxySession,
  binding: ReturnType<typeof validatedSessionBinding>,
): void {
  if (
    session.sourceId !== binding.sourceId ||
    session.provider !== binding.provider ||
    session.conversationKey !== binding.conversationKey ||
    session.principalProvider !== binding.principalProvider ||
    session.principalTenantId !== binding.principalTenantId ||
    session.principalSubjectId !== binding.principalSubjectId ||
    session.personId !== binding.personId ||
    session.workItemId !== binding.workItemId ||
    session.cwd !== binding.cwd ||
    session.adapterMode !== binding.adapterMode
  ) {
    throw new ClaudeProxyConflictError(
      `provider conversation ${binding.conversationKey} already has a different Claude proxy binding`,
    );
  }
}

function validatedAdapterMode(value: unknown): ClaudeProxyAdapterMode {
  if (value === "print" || value === "rc-tmux") return value;
  throw new TypeError("Claude proxy adapter mode must be print or rc-tmux");
}

function assertMarker(turn: ClaudeProxyTurn, marker: string): void {
  if (turn.correlationMarker !== marker) {
    throw new ClaudeProxyConflictError(
      `Claude proxy turn ${turn.agentRequestId} has a different correlation marker`,
    );
  }
}

function assertSameAcceptedRequest(
  request: AgentRequest,
  ack: AckJob | null,
  input: AcceptClaudeProxyEventTurnInput,
  executionProfile: ExecutionProfile,
): void {
  if (
    request.sourceId !== input.session.sourceId ||
    request.personId !== input.session.personId ||
    request.workItemId !== input.session.workItemId ||
    request.requestText !== input.requestText ||
    !isDeepStrictEqual(request.executionProfile, executionProfile) ||
    !isDeepStrictEqual(request.event, input.event)
  ) {
    throw new ClaudeProxyConflictError(
      `provider delivery ${input.event.deliveryId} already identifies a different agent request`,
    );
  }
  if (!input.ack && !ack) return;
  if (
    !input.ack ||
    !ack ||
    ack.sourceId !== input.session.sourceId ||
    ack.providerDeliveryId !== input.event.deliveryId ||
    ack.provider !== input.ack.provider ||
    ack.ackKind !== input.ack.kind ||
    ack.destination !== input.ack.destination ||
    !isDeepStrictEqual(ack.payload, input.ack.payload)
  ) {
    throw new ClaudeProxyConflictError(
      `provider delivery ${input.event.deliveryId} already has a different acknowledgment`,
    );
  }
}

function claudeCorrelationMarker(sessionId: string, agentRequestId: string): string {
  return `wakewire:claude:v1:${createHash("sha256")
    .update(`${sessionId}\0${agentRequestId}`)
    .digest("hex")}`;
}

function eventSource(eventJson: string): string {
  try {
    const event = JSON.parse(eventJson) as { source?: unknown };
    return typeof event.source === "string" ? event.source : "";
  } catch {
    return "";
  }
}

function normalizedProvider(value: string): string {
  return required(value, "Claude proxy provider").toLocaleLowerCase("en-US");
}

function nonEmptyText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must not be empty`);
  return value;
}

function required(value: string, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty and have no outer whitespace`);
  }
  return value;
}

function validUuid(value: string, label: string): string {
  const uuid = required(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return uuid.toLowerCase();
}
