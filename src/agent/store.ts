import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Database } from "better-sqlite3";
import type { WakeEvent } from "../core/event.js";
import type { AckSpec } from "./ack.js";
import {
  DEFAULT_EXECUTION_PROFILE,
  type ExecutionProfile,
  ExecutionProfileSchema,
} from "./execution-profile.js";
import type { SourceReplySpec } from "./reply.js";

export type WorkItemKind = "linear" | "github" | "slack" | "email";

export interface WorkItem {
  id: string;
  canonicalKind: WorkItemKind;
  canonicalKey: string;
  title: string;
  cwd: string | null;
  codexThreadId: string | null;
  /** Last user-facing name verified through the adapter's persisted metadata path. */
  codexThreadTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemAlias {
  workItemId: string;
  provider: string;
  scope: string;
  nativeKey: string;
  createdAt: string;
}

export type AgentRequestStatus =
  | "acknowledged"
  | "dispatching"
  | "submitted"
  | "completed"
  | "held"
  | "failed";

export interface AgentRequest {
  id: string;
  sourceId: string;
  sourceDeliveryId: string;
  personId: string;
  workItemId: string;
  requestText: string;
  executionProfile: ExecutionProfile;
  event: WakeEvent;
  coalesceKey: string | null;
  codexThreadId: string | null;
  codexTurnId: string | null;
  correlationMarker: string | null;
  status: AgentRequestStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRequestDedupKey {
  scope: string;
  deliveryId: string;
}

export type AgentRequestOrchestrationStage =
  | "planned"
  | "parent_ready"
  | "child_ready"
  | "child_submitted"
  | "child_completed"
  | "report_submitted";

/** Durable host-owned state for one requested separate Codex task. */
export interface AgentRequestOrchestration {
  requestId: string;
  stage: AgentRequestOrchestrationStage;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  childPrompt: string;
  childTitle: string;
  reportPromptPrefix: string;
  reportPromptSuffix: string;
  parentThreadId: string | null;
  childThreadId: string | null;
  childTurnId: string | null;
  childCorrelationMarker: string | null;
  childFinalResponse: string | null;
  childTitleSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AckStatus = "pending" | "sending" | "sent" | "held" | "failed";
export const PROGRESS_ACK_SUPPRESSED_REASON =
  "suppressed:request-resolved-before-progress-deadline";
export type SourceReplyStatus = "pending" | "sending" | "sent" | "held" | "failed";
export type SourceReplyRequestOutcome = "completed" | "failed";

export interface AckJob {
  id: string;
  requestId: string;
  sourceId: string;
  provider: string;
  providerDeliveryId: string;
  ackKind: string;
  destination: string;
  payload: Record<string, unknown>;
  status: AckStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  providerResultId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceReplyJob {
  id: string;
  requestId: string;
  sourceId: string;
  provider: string;
  replyKind: string;
  destination: string;
  payload: Record<string, unknown>;
  requestOutcome: SourceReplyRequestOutcome;
  status: SourceReplyStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  providerResultId: string | null;
  error: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A durable delivery lease returned only to the worker that owns it. */
export interface SourceReplyClaim extends SourceReplyJob {
  leaseOwner: string;
  leaseExpiresAt: string;
  claimIsRecovery: boolean;
  deliveryAttempt: number;
}

export interface ClaimSourceRepliesOptions {
  leaseOwner: string;
  at: string;
  leaseExpiresAt: string;
  limit?: number | undefined;
}

interface WorkItemRow {
  id: string;
  canonical_kind: WorkItemKind;
  canonical_key: string;
  title: string;
  cwd: string | null;
  codex_thread_id: string | null;
  codex_thread_title: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: string;
  source_id: string;
  source_delivery_id: string;
  person_id: string;
  work_item_id: string;
  request_text: string;
  execution_profile_json: string;
  event_json: string;
  coalesce_key: string | null;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  correlation_marker: string | null;
  status: AgentRequestStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface OrchestrationRow {
  request_id: string;
  stage: AgentRequestOrchestrationStage;
  cwd: string;
  sandbox_policy: "read-only" | "workspace-write";
  child_prompt: string;
  child_title: string;
  report_prompt_prefix: string;
  report_prompt_suffix: string;
  parent_thread_id: string | null;
  child_thread_id: string | null;
  child_turn_id: string | null;
  child_correlation_marker: string | null;
  child_final_response: string | null;
  child_title_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AckRow {
  id: string;
  request_id: string;
  source_id: string;
  provider: string;
  provider_delivery_id: string;
  ack_kind: string;
  destination: string;
  payload_json: string;
  status: AckStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  provider_result_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceReplyRow {
  id: string;
  request_id: string;
  source_id: string;
  provider: string;
  reply_kind: string;
  destination: string;
  payload_json: string;
  request_outcome: SourceReplyRequestOutcome;
  status: SourceReplyStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  provider_result_id: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class WorkItemStore {
  constructor(private readonly db: Database) {}

  list(): WorkItem[] {
    return (
      this.db.prepare("SELECT * FROM work_items ORDER BY created_at, id").all() as WorkItemRow[]
    ).map(toWorkItem);
  }

  listTitleSyncCandidates(limit = 50): WorkItem[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("title sync candidate limit must be a positive integer");
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM work_items
            WHERE codex_thread_id IS NOT NULL
              AND (codex_thread_title IS NULL OR codex_thread_title <> title)
            ORDER BY updated_at, id
            LIMIT ?`,
        )
        .all(limit) as WorkItemRow[]
    ).map(toWorkItem);
  }

  get(id: string): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
      | WorkItemRow
      | undefined;
    return row ? toWorkItem(row) : null;
  }

  findCanonical(kind: WorkItemKind, key: string): WorkItem | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE canonical_kind = ? AND canonical_key = ?")
      .get(kind, key) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  findByAlias(provider: string, scope: string, nativeKey: string): WorkItem | null {
    const row = this.db
      .prepare(
        `SELECT w.* FROM work_items w
         JOIN work_item_aliases a ON a.work_item_id = w.id
         WHERE a.provider = ? AND a.scope = ? AND a.native_key = ?`,
      )
      .get(provider, scope, nativeKey) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  getOrCreate(args: {
    kind: WorkItemKind;
    key: string;
    title: string;
    cwd?: string | undefined;
  }): WorkItem {
    const existing = this.findCanonical(args.kind, args.key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO work_items
            (id, canonical_kind, canonical_key, title, cwd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, args.kind, args.key, args.title, args.cwd ?? null, now, now);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const created = this.findCanonical(args.kind, args.key);
    if (!created) throw new Error("work item insert failed");
    return created;
  }

  attachAlias(workItemId: string, alias: Omit<WorkItemAlias, "workItemId" | "createdAt">): void {
    const existing = this.findByAlias(alias.provider, alias.scope, alias.nativeKey);
    if (existing && existing.id !== workItemId) {
      throw new WorkItemConflictError(
        `alias ${alias.provider}:${alias.scope}:${alias.nativeKey} belongs to ${existing.id}`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO work_item_aliases
          (work_item_id, provider, scope, native_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workItemId, alias.provider, alias.scope, alias.nativeKey, nowIso());
  }

  aliases(workItemId: string): WorkItemAlias[] {
    return (
      this.db
        .prepare(
          `SELECT work_item_id, provider, scope, native_key, created_at
           FROM work_item_aliases WHERE work_item_id = ? ORDER BY created_at`,
        )
        .all(workItemId) as Array<{
        work_item_id: string;
        provider: string;
        scope: string;
        native_key: string;
        created_at: string;
      }>
    ).map((row) => ({
      workItemId: row.work_item_id,
      provider: row.provider,
      scope: row.scope,
      nativeKey: row.native_key,
      createdAt: row.created_at,
    }));
  }

  setWorkspace(id: string, cwd: string): void {
    this.db
      .prepare("UPDATE work_items SET cwd = ?, updated_at = ? WHERE id = ?")
      .run(cwd, nowIso(), id);
  }

  setCodexThread(id: string, threadId: string): void {
    this.db
      .prepare(
        `UPDATE work_items SET
           codex_thread_title = CASE
             WHEN codex_thread_id IS ? THEN codex_thread_title
             ELSE NULL
           END,
           codex_thread_id = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(threadId, threadId, nowIso(), id);
  }

  setCodexThreadTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE work_items SET codex_thread_title = ?, updated_at = ? WHERE id = ?")
      .run(title, nowIso(), id);
  }

  confirmCodexThreadTitle(id: string, threadId: string, title: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE work_items SET codex_thread_title = ?, updated_at = ?
            WHERE id = ? AND codex_thread_id = ? AND title = ?`,
        )
        .run(title, nowIso(), id, threadId, title).changes === 1
    );
  }

  markCodexThreadTitleDirty(id: string, threadId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE work_items SET codex_thread_title = NULL, updated_at = ?
            WHERE id = ? AND codex_thread_id = ?`,
        )
        .run(nowIso(), id, threadId).changes === 1
    );
  }

  updateTitle(id: string, title: string): boolean {
    if (!title.trim()) throw new TypeError("work item title must not be empty");
    return (
      this.db
        .prepare(
          `UPDATE work_items SET
             codex_thread_title = CASE WHEN title = ? THEN codex_thread_title ELSE NULL END,
             title = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(title, title, nowIso(), id).changes === 1
    );
  }

  /**
   * Upgrade a native work item to a Linear canonical identity. If that Linear
   * item already exists, merge aliases/requests into it. Conflicting Desktop
   * task ids fail closed because silently abandoning either task loses context.
   */
  promoteToLinear(workItemId: string, linearKey: string, title: string): WorkItem {
    const run = this.db.transaction(() => {
      const source = this.get(workItemId);
      if (!source) throw new Error(`unknown work item ${workItemId}`);
      if (source.canonicalKind === "linear" && source.canonicalKey !== linearKey) {
        throw new WorkItemConflictError(
          `cannot retarget Linear work item ${source.canonicalKey} to ${linearKey}`,
        );
      }
      const target = this.findCanonical("linear", linearKey);
      if (!target || target.id === source.id) {
        this.db
          .prepare(
            `UPDATE work_items SET canonical_kind = 'linear', canonical_key = ?, title = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(linearKey, title, nowIso(), source.id);
        return this.get(source.id) as WorkItem;
      }
      if (
        source.codexThreadId &&
        target.codexThreadId &&
        source.codexThreadId !== target.codexThreadId
      ) {
        throw new WorkItemConflictError(
          `cannot merge work items with Desktop tasks ${source.codexThreadId} and ${target.codexThreadId}`,
        );
      }
      this.db
        .prepare("UPDATE work_item_aliases SET work_item_id = ? WHERE work_item_id = ?")
        .run(target.id, source.id);
      this.db
        .prepare("UPDATE agent_requests SET work_item_id = ? WHERE work_item_id = ?")
        .run(target.id, source.id);
      this.db
        .prepare(
          `UPDATE work_items SET
             cwd = COALESCE(cwd, ?),
             codex_thread_id = COALESCE(codex_thread_id, ?),
             codex_thread_title = COALESCE(codex_thread_title, ?),
             updated_at = ?
           WHERE id = ?`,
        )
        .run(source.cwd, source.codexThreadId, source.codexThreadTitle, nowIso(), target.id);
      this.db.prepare("DELETE FROM work_items WHERE id = ?").run(source.id);
      return this.get(target.id) as WorkItem;
    });
    return run();
  }
}

export class AgentRequestStore {
  constructor(private readonly db: Database) {}

  /** Atomically records an authorized request and any required lifecycle response. */
  accept(args: {
    sourceId: string;
    event: WakeEvent;
    personId: string;
    workItemId: string;
    requestText: string;
    executionProfile?: ExecutionProfile | undefined;
    ack?: AckSpec | undefined;
    /** Provider-wide identity; sourceId remains the credential/reply route. */
    dedup?: AgentRequestDedupKey | undefined;
    /** Pending requests with the same key collapse into one delayed turn. */
    coalesceKey?: string | undefined;
    /** Earliest time this request may enter dispatch. */
    requestNotBefore?: string | undefined;
    /** Stop acknowledgments are released only after Desktop confirms interruption. */
    deferAck?: boolean;
    /** Earliest delivery time for a normal progress acknowledgment. */
    ackNotBefore?: string | undefined;
  }): { request: AgentRequest; ack: AckJob | null; duplicate: boolean } {
    const run = this.db.transaction(() => {
      if (args.deferAck && !args.ack) {
        throw new Error("a deferred acknowledgment requires an acknowledgment specification");
      }
      if (args.ackNotBefore && !args.ack) {
        throw new Error("ackNotBefore requires an acknowledgment specification");
      }
      if (args.deferAck && args.ackNotBefore) {
        throw new Error("a deferred acknowledgment cannot also have ackNotBefore");
      }
      const requestNotBefore = args.requestNotBefore
        ? requiredIsoTimestamp(args.requestNotBefore, "request not-before time")
        : null;
      const coalesceKey = args.coalesceKey
        ? requiredNonEmpty(args.coalesceKey, "request coalesce key")
        : null;
      if (coalesceKey && !requestNotBefore) {
        throw new Error("a coalesced request requires requestNotBefore");
      }
      const ackNotBefore = args.ackNotBefore
        ? requiredIsoTimestamp(args.ackNotBefore, "acknowledgment not-before time")
        : null;
      const dedup = args.dedup ?? {
        scope: `source:${args.sourceId}`,
        deliveryId: args.event.deliveryId,
      };
      const existing = this.findByDedup(dedup);
      if (existing) {
        const ack = this.ackForRequest(existing.id);
        return { request: existing, ack, duplicate: true };
      }
      const executionProfile = ExecutionProfileSchema.parse(
        args.executionProfile ?? DEFAULT_EXECUTION_PROFILE,
      );
      const pending = coalesceKey ? this.findPendingByCoalesceKey(coalesceKey) : null;
      if (pending) {
        const now = nowIso();
        this.db
          .prepare(
            `INSERT INTO agent_request_dedup_keys
              (dedup_scope, dedup_delivery_id, request_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(dedup.scope, dedup.deliveryId, pending.id, now);
        this.db
          .prepare(
            `UPDATE agent_requests
             SET source_id = ?, source_delivery_id = ?, person_id = ?, work_item_id = ?,
                 request_text = ?, execution_profile_json = ?, event_json = ?,
                 next_attempt_at = ?, updated_at = ?
             WHERE id = ? AND status = 'acknowledged'`,
          )
          .run(
            args.sourceId,
            args.event.deliveryId,
            args.personId,
            args.workItemId,
            args.requestText,
            JSON.stringify(executionProfile),
            JSON.stringify(args.event),
            requestNotBefore,
            now,
            pending.id,
          );
        const refreshed = this.get(pending.id);
        if (!refreshed) throw new Error(`coalesced request ${pending.id} disappeared`);
        return { request: refreshed, ack: this.ackForRequest(refreshed.id), duplicate: true };
      }
      const id = crypto.randomUUID();
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO agent_requests
            (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
             execution_profile_json, event_json, coalesce_key, status, next_attempt_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acknowledged', ?, ?, ?)`,
        )
        .run(
          id,
          args.sourceId,
          args.event.deliveryId,
          args.personId,
          args.workItemId,
          args.requestText,
          JSON.stringify(executionProfile),
          JSON.stringify(args.event),
          coalesceKey,
          requestNotBefore,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO agent_request_dedup_keys
            (dedup_scope, dedup_delivery_id, request_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(dedup.scope, dedup.deliveryId, id, now);
      let ack: AckJob | null = null;
      if (args.ack) {
        const ackId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO ack_outbox
              (id, request_id, source_id, provider, provider_delivery_id, ack_kind,
               destination, payload_json, status, next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ackId,
            id,
            args.sourceId,
            args.ack.provider,
            args.event.deliveryId,
            args.ack.kind,
            args.ack.destination,
            JSON.stringify(args.ack.payload),
            args.deferAck ? "held" : "pending",
            args.deferAck ? "9999-12-31T23:59:59.999Z" : ackNotBefore,
            now,
            now,
          );
        ack = this.ack(ackId);
      }
      const request = this.get(id);
      if (!request || (args.ack && !ack)) throw new Error("agent request insert failed");
      return { request, ack, duplicate: false };
    });
    return run();
  }

  /**
   * Atomically creates one provider-only child for a registered scheduled
   * follow-up. The child is already submitted and already owns its reply job,
   * so neither the Codex dispatch worker nor completion scanner can pick it up.
   */
  enqueueScheduledSourceReply(args: {
    sourceId: string;
    event: WakeEvent;
    personId: string;
    workItemId: string;
    requestText: string;
    executionProfile: ExecutionProfile;
    dedup: AgentRequestDedupKey;
    codexThreadId: string;
    correlationMarker: string;
    spec: SourceReplySpec;
  }): { request: AgentRequest; reply: SourceReplyJob; duplicate: boolean } {
    const run = this.db.transaction(() => {
      const accepted = this.accept({
        sourceId: args.sourceId,
        event: args.event,
        personId: args.personId,
        workItemId: args.workItemId,
        requestText: args.requestText,
        executionProfile: args.executionProfile,
        dedup: args.dedup,
      });

      if (accepted.duplicate) {
        const request = accepted.request;
        if (
          request.sourceId !== args.sourceId ||
          request.personId !== args.personId ||
          request.workItemId !== args.workItemId ||
          request.requestText !== args.requestText ||
          request.codexThreadId !== args.codexThreadId ||
          request.correlationMarker !== args.correlationMarker ||
          !isDeepStrictEqual(request.executionProfile, args.executionProfile) ||
          !isDeepStrictEqual(request.event, args.event)
        ) {
          throw new SourceReplyConflictError(
            `scheduled reply dedup key ${args.dedup.scope}:${args.dedup.deliveryId} has different content`,
          );
        }
        const reply = this.sourceReplyForRequest(request.id);
        if (!reply) {
          throw new SourceReplyConflictError(
            `scheduled reply request ${request.id} has no durable source reply`,
          );
        }
        assertSameSourceReply(request.id, reply, args.spec, "completed");
        return { request, reply, duplicate: true };
      }

      this.setStatus(accepted.request.id, "dispatching");
      this.bindSubmittedCompletion({
        requestId: accepted.request.id,
        codexThreadId: args.codexThreadId,
        correlationMarker: args.correlationMarker,
      });
      const reply = this.enqueueFinalReply({
        requestId: accepted.request.id,
        spec: args.spec,
      });
      const request = this.get(accepted.request.id);
      if (!request) throw new Error(`scheduled reply request ${accepted.request.id} disappeared`);
      return { request, reply, duplicate: false };
    });
    return run();
  }

  /** Durably adds an exact acknowledgment later without ever retargeting it. */
  enqueueAckForRequest(requestId: string, spec: AckSpec): AckJob {
    const run = this.db.transaction(() => {
      const request = this.get(requestId);
      if (!request) throw new Error(`request ${requestId} does not exist`);
      const existing = this.ackForRequest(requestId);
      if (existing) {
        if (
          existing.provider !== spec.provider ||
          existing.ackKind !== spec.kind ||
          existing.destination !== spec.destination ||
          !isDeepStrictEqual(existing.payload, spec.payload)
        ) {
          throw new AckConflictError(
            `request ${requestId} already has a different acknowledgment job`,
          );
        }
        return existing;
      }

      const id = crypto.randomUUID();
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO ack_outbox
            (id, request_id, source_id, provider, provider_delivery_id, ack_kind,
             destination, payload_json, status, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          id,
          request.id,
          request.sourceId,
          spec.provider,
          request.sourceDeliveryId,
          spec.kind,
          spec.destination,
          JSON.stringify(spec.payload),
          now,
          now,
        );
      const created = this.ack(id);
      if (!created) throw new Error(`acknowledgment insert failed for request ${requestId}`);
      return created;
    });
    return run();
  }

  /**
   * Persist the exact Desktop identity before a request enters the submitted
   * state. Replays may fill in a previously unknown turn id, but can never
   * retarget the request to another task, turn, or correlation marker.
   */
  bindSubmittedCompletion(args: {
    requestId: string;
    codexThreadId: string;
    codexTurnId?: string | undefined;
    correlationMarker: string;
  }): AgentRequest {
    const threadId = requiredNonEmpty(args.codexThreadId, "Codex thread id");
    const turnId = optionalNonEmpty(args.codexTurnId, "Codex turn id");
    const marker = requiredNonEmpty(args.correlationMarker, "correlation marker");
    const run = this.db.transaction(() => {
      const request = this.get(args.requestId);
      if (!request) throw new Error(`request ${args.requestId} does not exist`);
      if (request.status !== "dispatching" && request.status !== "submitted") {
        throw new SourceReplyConflictError(
          `request ${args.requestId} must be dispatching or submitted before completion binding`,
        );
      }
      if (request.codexThreadId && request.codexThreadId !== threadId) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is already bound to Codex task ${request.codexThreadId}`,
        );
      }
      if (request.correlationMarker && request.correlationMarker !== marker) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is already bound to a different correlation marker`,
        );
      }
      if (turnId && request.codexTurnId && request.codexTurnId !== turnId) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is already bound to Codex turn ${request.codexTurnId}`,
        );
      }
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'submitted', codex_thread_id = ?,
             codex_turn_id = COALESCE(codex_turn_id, ?), correlation_marker = ?,
             error = NULL, next_attempt_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(threadId, turnId, marker, nowIso(), request.id);
      const bound = this.get(request.id);
      if (!bound) throw new Error(`request ${request.id} disappeared during completion binding`);
      return bound;
    });
    return run();
  }

  beginOrchestration(args: {
    requestId: string;
    cwd: string;
    sandbox: "read-only" | "workspace-write";
    childPrompt: string;
    childTitle: string;
    reportPromptPrefix: string;
    reportPromptSuffix: string;
  }): AgentRequestOrchestration {
    const requestId = requiredNonEmpty(args.requestId, "request id");
    const cwd = requiredNonEmpty(args.cwd, "orchestration cwd");
    const childPrompt = requiredNonEmpty(args.childPrompt, "child prompt");
    const childTitle = requiredNonEmpty(args.childTitle, "child title");
    if (!args.reportPromptPrefix || !args.reportPromptSuffix) {
      throw new TypeError("parent report prompt parts must not be empty");
    }
    const run = this.db.transaction(() => {
      const request = this.get(requestId);
      if (!request) throw new Error(`request ${requestId} does not exist`);
      const existing = this.orchestrationForRequest(requestId);
      if (existing) {
        if (existing.cwd !== cwd || existing.sandbox !== args.sandbox) {
          throw new SourceReplyConflictError(
            `request ${requestId} already has different separate-task orchestration`,
          );
        }
        // Prompt text and presentation are frozen on first write. A daemon
        // upgrade must never reinterpret an already-planned child on retry.
        return existing;
      }
      if (request.status !== "dispatching") {
        throw new SourceReplyConflictError(
          `request ${requestId} must be dispatching before orchestration is planned`,
        );
      }
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO agent_request_orchestrations
            (request_id, stage, cwd, sandbox_policy, child_prompt, child_title,
             report_prompt_prefix, report_prompt_suffix, created_at, updated_at)
           VALUES (?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          cwd,
          args.sandbox,
          childPrompt,
          childTitle,
          args.reportPromptPrefix,
          args.reportPromptSuffix,
          now,
          now,
        );
      return this.requireOrchestration(requestId);
    });
    return run();
  }

  orchestrationForRequest(requestId: string): AgentRequestOrchestration | null {
    const row = this.db
      .prepare("SELECT * FROM agent_request_orchestrations WHERE request_id = ?")
      .get(requestId) as OrchestrationRow | undefined;
    return row ? toOrchestration(row) : null;
  }

  setOrchestrationParent(requestId: string, parentThreadId: string): AgentRequestOrchestration {
    const threadId = requiredNonEmpty(parentThreadId, "parent Codex task id");
    const run = this.db.transaction(() => {
      const orchestration = this.requireOrchestration(requestId);
      if (orchestration.parentThreadId && orchestration.parentThreadId !== threadId) {
        throw new SourceReplyConflictError(
          `request ${requestId} is already bound to parent task ${orchestration.parentThreadId}`,
        );
      }
      if (orchestration.stage !== "planned" && orchestration.stage !== "parent_ready") {
        if (orchestration.parentThreadId === threadId) return orchestration;
        throw new SourceReplyConflictError(
          `request ${requestId} cannot bind a parent task during ${orchestration.stage}`,
        );
      }
      this.db
        .prepare(
          `UPDATE agent_request_orchestrations
             SET stage = 'parent_ready', parent_thread_id = ?, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(threadId, nowIso(), requestId);
      return this.requireOrchestration(requestId);
    });
    return run();
  }

  setOrchestrationChild(requestId: string, childThreadId: string): AgentRequestOrchestration {
    const threadId = requiredNonEmpty(childThreadId, "child Codex task id");
    const run = this.db.transaction(() => {
      const orchestration = this.requireOrchestration(requestId);
      if (orchestration.childThreadId && orchestration.childThreadId !== threadId) {
        throw new SourceReplyConflictError(
          `request ${requestId} is already bound to child task ${orchestration.childThreadId}`,
        );
      }
      if (!orchestration.parentThreadId) {
        throw new SourceReplyConflictError(`request ${requestId} has no parent task`);
      }
      if (orchestration.stage !== "parent_ready" && orchestration.stage !== "child_ready") {
        if (orchestration.childThreadId === threadId) return orchestration;
        throw new SourceReplyConflictError(
          `request ${requestId} cannot bind a child task during ${orchestration.stage}`,
        );
      }
      this.db
        .prepare(
          `UPDATE agent_request_orchestrations
             SET stage = 'child_ready', child_thread_id = ?, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(threadId, nowIso(), requestId);
      return this.requireOrchestration(requestId);
    });
    return run();
  }

  bindChildSubmission(args: {
    requestId: string;
    childThreadId: string;
    childTurnId?: string | undefined;
    correlationMarker: string;
  }): AgentRequestOrchestration {
    const childThreadId = requiredNonEmpty(args.childThreadId, "child Codex task id");
    const childTurnId = optionalNonEmpty(args.childTurnId, "child Codex turn id");
    const marker = requiredNonEmpty(args.correlationMarker, "child correlation marker");
    const run = this.db.transaction(() => {
      const request = this.get(args.requestId);
      if (!request) throw new Error(`request ${args.requestId} does not exist`);
      const orchestration = this.requireOrchestration(args.requestId);
      if (orchestration.childThreadId !== childThreadId) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} child task does not match its durable orchestration`,
        );
      }
      if (orchestration.childCorrelationMarker && orchestration.childCorrelationMarker !== marker) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is already bound to a different child marker`,
        );
      }
      if (childTurnId && orchestration.childTurnId && orchestration.childTurnId !== childTurnId) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is already bound to child turn ${orchestration.childTurnId}`,
        );
      }
      if (orchestration.stage !== "child_ready" && orchestration.stage !== "child_submitted") {
        if (orchestration.childCorrelationMarker === marker) return orchestration;
        throw new SourceReplyConflictError(
          `request ${args.requestId} cannot submit a child during ${orchestration.stage}`,
        );
      }
      if (orchestration.stage === "child_ready" && request.status !== "dispatching") {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is no longer dispatching its child task`,
        );
      }
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE agent_request_orchestrations
             SET stage = 'child_submitted', child_turn_id = COALESCE(child_turn_id, ?),
                 child_correlation_marker = ?, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(childTurnId, marker, now, args.requestId);
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'submitted', error = NULL,
             next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, args.requestId);
      return this.requireOrchestration(args.requestId);
    });
    return run();
  }

  listChildAwaitingCompletion(): AgentRequest[] {
    return this.listRequestsForOrchestrationStage("child_submitted");
  }

  listChildCompletedAwaitingReport(): AgentRequest[] {
    return this.listRequestsForOrchestrationStage("child_completed");
  }

  listChildTitleSyncCandidates(limit = 50): AgentRequestOrchestration[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("child title sync candidate limit must be a positive integer");
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_request_orchestrations
           WHERE child_thread_id IS NOT NULL
             AND child_title_synced_at IS NULL
             AND stage IN ('child_submitted', 'child_completed', 'report_submitted')
           ORDER BY updated_at, request_id
           LIMIT ?`,
        )
        .all(limit) as OrchestrationRow[]
    ).map(toOrchestration);
  }

  confirmChildTitleSynchronized(
    requestId: string,
    childThreadId: string,
    childTitle: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_request_orchestrations
         SET child_title_synced_at = ?, updated_at = ?
         WHERE request_id = ? AND child_thread_id = ? AND child_title = ?`,
      )
      .run(nowIso(), nowIso(), requestId, childThreadId, childTitle);
    return result.changes === 1;
  }

  markChildCompleted(requestId: string, finalResponse: string): AgentRequestOrchestration {
    if (!finalResponse.trim()) throw new TypeError("child final response must not be empty");
    const run = this.db.transaction(() => {
      const orchestration = this.requireOrchestration(requestId);
      if (orchestration.stage === "child_completed") {
        if (orchestration.childFinalResponse !== finalResponse) {
          throw new SourceReplyConflictError(
            `request ${requestId} already has a different child final response`,
          );
        }
        return orchestration;
      }
      if (orchestration.stage !== "child_submitted") {
        throw new SourceReplyConflictError(
          `request ${requestId} cannot complete a child during ${orchestration.stage}`,
        );
      }
      this.db
        .prepare(
          `UPDATE agent_request_orchestrations
             SET stage = 'child_completed', child_final_response = ?,
                 child_title_synced_at = NULL, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(finalResponse, nowIso(), requestId);
      return this.requireOrchestration(requestId);
    });
    return run();
  }

  bindParentReport(args: {
    requestId: string;
    parentThreadId: string;
    parentTurnId?: string | undefined;
    correlationMarker: string;
  }): AgentRequest {
    const parentThreadId = requiredNonEmpty(args.parentThreadId, "parent Codex task id");
    const parentTurnId = optionalNonEmpty(args.parentTurnId, "parent Codex turn id");
    const marker = requiredNonEmpty(args.correlationMarker, "parent report correlation marker");
    const run = this.db.transaction(() => {
      const request = this.get(args.requestId);
      if (!request) throw new Error(`request ${args.requestId} does not exist`);
      const orchestration = this.requireOrchestration(args.requestId);
      if (orchestration.parentThreadId !== parentThreadId) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} parent task does not match its durable orchestration`,
        );
      }
      if (orchestration.stage === "report_submitted") {
        if (
          request.codexThreadId !== parentThreadId ||
          request.correlationMarker !== marker ||
          (parentTurnId && request.codexTurnId && request.codexTurnId !== parentTurnId)
        ) {
          throw new SourceReplyConflictError(
            `request ${args.requestId} is already bound to a different parent report`,
          );
        }
        return request;
      }
      if (orchestration.stage !== "child_completed") {
        throw new SourceReplyConflictError(
          `request ${args.requestId} cannot submit its parent report during ${orchestration.stage}`,
        );
      }
      if (request.status !== "submitted") {
        throw new SourceReplyConflictError(
          `request ${args.requestId} is no longer awaiting its parent report`,
        );
      }
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'submitted', codex_thread_id = ?,
             codex_turn_id = ?, correlation_marker = ?, error = NULL,
             next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(parentThreadId, parentTurnId, marker, now, args.requestId);
      this.db
        .prepare(
          `UPDATE agent_request_orchestrations
             SET stage = 'report_submitted', updated_at = ? WHERE request_id = ?`,
        )
        .run(now, args.requestId);
      const bound = this.get(args.requestId);
      if (!bound) throw new Error(`request ${args.requestId} disappeared`);
      return bound;
    });
    return run();
  }

  /**
   * Atomically records a completion returned inline by a blocking adapter and
   * creates its provider outbox job. The synthetic marker is never scanned as
   * a Desktop rollout marker: the reply row committed beside it proves that
   * completion has already been observed and prevents redispatch after restart.
   */
  stageImmediateFinalReply(args: {
    requestId: string;
    codexThreadId: string;
    codexTurnId?: string | undefined;
    spec: SourceReplySpec;
  }): SourceReplyJob {
    const correlationMarker = `wakewire:immediate:v1:${requiredNonEmpty(args.requestId, "request id")}`;
    const run = this.db.transaction(() => {
      this.bindSubmittedCompletion({
        requestId: args.requestId,
        codexThreadId: args.codexThreadId,
        ...(args.codexTurnId ? { codexTurnId: args.codexTurnId } : {}),
        correlationMarker,
      });
      return this.enqueueFinalReply({
        requestId: args.requestId,
        ...(args.codexTurnId ? { codexTurnId: args.codexTurnId } : {}),
        spec: args.spec,
      });
    });
    return run();
  }

  /**
   * Atomically terminalize a host-owned control without invoking a model and
   * queue its fixed provider reply. The synthetic completion binding keeps the
   * normal durable reply lifecycle and makes replays independently auditable.
   */
  stageHostControlReply(args: {
    requestId: string;
    controlKind: string;
    spec: SourceReplySpec;
  }): SourceReplyJob {
    const requestId = requiredNonEmpty(args.requestId, "request id");
    const controlKind = requiredNonEmpty(args.controlKind, "control kind");
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(controlKind)) {
      throw new TypeError("control kind contains unsupported characters");
    }
    const threadId = `wakewire-host-control:${controlKind}:${requestId}`;
    const correlationMarker = `wakewire:host-control:v1:${controlKind}:${requestId}`;
    const run = this.db.transaction(() => {
      const request = this.get(requestId);
      if (!request) throw new Error(`request ${requestId} does not exist`);
      const existing = this.sourceReplyForRequest(requestId);
      if (existing) {
        if (request.correlationMarker !== correlationMarker) {
          throw new SourceReplyConflictError(
            `request ${requestId} is already bound to a different completion`,
          );
        }
        assertSameSourceReply(requestId, existing, args.spec, "completed");
        return existing;
      }
      if (request.status !== "acknowledged") {
        throw new SourceReplyConflictError(
          `request ${requestId} must be acknowledged before a host control reply is queued`,
        );
      }
      this.setStatus(requestId, "dispatching");
      this.bindSubmittedCompletion({
        requestId,
        codexThreadId: threadId,
        correlationMarker,
      });
      return this.enqueueFinalReply({ requestId, spec: args.spec });
    });
    return run();
  }

  /** Persist an inline completion even when that provider has no final-reply transport. */
  finalizeImmediateCompletion(args: {
    requestId: string;
    codexThreadId: string;
    codexTurnId?: string | undefined;
    status: "completed" | "failed";
    error?: string | undefined;
  }): AgentRequest {
    const correlationMarker = `wakewire:immediate:v1:${requiredNonEmpty(args.requestId, "request id")}`;
    const run = this.db.transaction(() => {
      this.bindSubmittedCompletion({
        requestId: args.requestId,
        codexThreadId: args.codexThreadId,
        ...(args.codexTurnId ? { codexTurnId: args.codexTurnId } : {}),
        correlationMarker,
      });
      if (this.sourceReplyForRequest(args.requestId)) {
        throw new SourceReplyConflictError(
          `request ${args.requestId} already has a durable source reply`,
        );
      }
      this.suppressUnsentProgressAck(args.requestId);
      this.setStatus(args.requestId, args.status, args.error);
      const finalized = this.get(args.requestId);
      if (!finalized) throw new Error(`request ${args.requestId} disappeared during completion`);
      return finalized;
    });
    return run();
  }

  /**
   * Durably records one final provider reply after the bound Codex turn
   * completes. The request remains submitted until the reply worker confirms
   * the provider accepted the message.
   */
  enqueueFinalReply(args: {
    requestId: string;
    spec: SourceReplySpec;
    codexTurnId?: string | undefined;
  }): SourceReplyJob {
    const turnId = optionalNonEmpty(args.codexTurnId, "Codex turn id");
    const run = this.db.transaction(() => {
      const request = this.get(args.requestId);
      if (!request) throw new Error(`request ${args.requestId} does not exist`);
      const existing = this.sourceReplyForRequest(request.id);
      if (existing) {
        assertSameSourceReply(request.id, existing, args.spec, "completed");
        if (turnId && request.codexTurnId && request.codexTurnId !== turnId) {
          throw new SourceReplyConflictError(
            `request ${request.id} is already bound to Codex turn ${request.codexTurnId}`,
          );
        }
        return existing;
      }
      if (request.status !== "submitted") {
        throw new SourceReplyConflictError(
          `request ${request.id} must be submitted before its final reply is queued`,
        );
      }
      if (!request.codexThreadId || !request.correlationMarker) {
        throw new SourceReplyConflictError(
          `request ${request.id} has no durable Codex completion binding`,
        );
      }
      if (turnId && request.codexTurnId && request.codexTurnId !== turnId) {
        throw new SourceReplyConflictError(
          `request ${request.id} is already bound to Codex turn ${request.codexTurnId}`,
        );
      }

      const id = crypto.randomUUID();
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO source_reply_outbox
            (id, request_id, source_id, provider, reply_kind, destination, payload_json,
             request_outcome, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'pending', ?, ?)`,
        )
        .run(
          id,
          request.id,
          request.sourceId,
          requiredNonEmpty(args.spec.provider, "source reply provider"),
          requiredNonEmpty(args.spec.kind, "source reply kind"),
          requiredNonEmpty(args.spec.destination, "source reply destination"),
          JSON.stringify(args.spec.payload),
          now,
          now,
        );
      if (turnId && !request.codexTurnId) {
        this.db
          .prepare("UPDATE agent_requests SET codex_turn_id = ?, updated_at = ? WHERE id = ?")
          .run(turnId, now, request.id);
      }
      // Answer is ready to post — do not show 👀 unless work is still running past the
      // progress deadline. Suppressing here (not only after provider delivery) matches
      // "eyes only if the response takes longer than 10s".
      this.suppressUnsentProgressAck(request.id, now);
      const created = this.sourceReply(id);
      if (!created) throw new Error(`source reply insert failed for request ${request.id}`);
      return created;
    });
    return run();
  }

  /**
   * Atomically terminalizes a definitive failure and queues its exact source
   * response. A submitted Claude proxy turn is eligible only while its durable
   * turn row still proves the specialized failure boundary.
   */
  stageTerminalFailureReply(args: {
    requestId: string;
    error: string;
    spec: SourceReplySpec;
  }): SourceReplyJob {
    const requestId = requiredNonEmpty(args.requestId, "request id");
    const failure = requiredNonEmpty(args.error, "terminal failure error");
    const run = this.db.transaction(() => {
      const request = this.get(requestId);
      if (!request) throw new Error(`request ${requestId} does not exist`);
      const existing = this.sourceReplyForRequest(requestId);
      if (existing) {
        assertSameSourceReply(requestId, existing, args.spec, "failed");
        if (request.status !== "failed" || request.error !== failure) {
          throw new SourceReplyConflictError(
            `request ${requestId} already has a different terminal failure`,
          );
        }
        return existing;
      }
      const submittedClaudeProxyFailure =
        request.status === "submitted" &&
        Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM claude_proxy_turns
               WHERE agent_request_id = ? AND stage = 'submitted'
               LIMIT 1`,
            )
            .get(requestId),
        );
      if (
        request.status !== "acknowledged" &&
        request.status !== "held" &&
        request.status !== "dispatching" &&
        !submittedClaudeProxyFailure
      ) {
        throw new SourceReplyConflictError(
          `request ${requestId} cannot stage a terminal failure from ${request.status}`,
        );
      }
      if (request.codexThreadId || request.codexTurnId || request.correlationMarker) {
        throw new SourceReplyConflictError(
          `request ${requestId} already has a durable Codex completion binding`,
        );
      }

      const id = crypto.randomUUID();
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO source_reply_outbox
            (id, request_id, source_id, provider, reply_kind, destination, payload_json,
             request_outcome, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 'pending', ?, ?)`,
        )
        .run(
          id,
          request.id,
          request.sourceId,
          requiredNonEmpty(args.spec.provider, "source reply provider"),
          requiredNonEmpty(args.spec.kind, "source reply kind"),
          requiredNonEmpty(args.spec.destination, "source reply destination"),
          JSON.stringify(args.spec.payload),
          now,
          now,
        );
      const failed = this.db
        .prepare(
          `UPDATE agent_requests SET status = 'failed', error = ?, next_attempt_at = NULL,
             updated_at = ?
           WHERE id = ? AND (
             status IN ('acknowledged', 'held', 'dispatching')
             OR (
               status = 'submitted' AND EXISTS (
                 SELECT 1 FROM claude_proxy_turns
                 WHERE agent_request_id = agent_requests.id AND stage = 'submitted'
               )
             )
           )`,
        )
        .run(failure, now, request.id);
      if (failed.changes !== 1) {
        throw new SourceReplyConflictError(
          `request ${requestId} changed while staging its terminal failure`,
        );
      }
      this.suppressUnsentProgressAck(request.id, now);
      const created = this.sourceReply(id);
      if (!created) throw new Error(`source reply insert failed for request ${request.id}`);
      return created;
    });
    return run();
  }

  get(id: string): AgentRequest | null {
    const row = this.db.prepare("SELECT * FROM agent_requests WHERE id = ?").get(id) as
      | RequestRow
      | undefined;
    return row ? toRequest(row) : null;
  }

  findByDelivery(sourceId: string, sourceDeliveryId: string): AgentRequest | null {
    const row = this.db
      .prepare("SELECT * FROM agent_requests WHERE source_id = ? AND source_delivery_id = ?")
      .get(sourceId, sourceDeliveryId) as RequestRow | undefined;
    return row ? toRequest(row) : null;
  }

  private findByDedup(key: AgentRequestDedupKey): AgentRequest | null {
    const row = this.db
      .prepare(
        `SELECT request.* FROM agent_requests request
         JOIN agent_request_dedup_keys dedup ON dedup.request_id = request.id
         WHERE dedup.dedup_scope = ? AND dedup.dedup_delivery_id = ?`,
      )
      .get(key.scope, key.deliveryId) as RequestRow | undefined;
    return row ? toRequest(row) : null;
  }

  private findPendingByCoalesceKey(key: string): AgentRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_requests
         WHERE coalesce_key = ? AND status = 'acknowledged'
         ORDER BY created_at, rowid
         LIMIT 1`,
      )
      .get(key) as RequestRow | undefined;
    return row ? toRequest(row) : null;
  }

  listReady(at = nowIso()): AgentRequest[] {
    return (
      this.db
        .prepare(
          `SELECT request.* FROM agent_requests request
           WHERE request.status IN ('acknowledged', 'held')
             AND (request.next_attempt_at IS NULL OR request.next_attempt_at <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM claude_proxy_turns proxy
               WHERE proxy.agent_request_id = request.id
             )
           ORDER BY CASE
             WHEN json_extract(request.event_json, '$.payload.agentSignal') = 'stop' THEN 0
             ELSE 1
           END, request.created_at, request.rowid`,
        )
        .all(at) as RequestRow[]
    ).map(toRequest);
  }

  /** Provider requests with an exact Desktop binding still awaiting completion. */
  listSubmittedAwaitingCompletion(): AgentRequest[] {
    return (
      this.db
        .prepare(
          `SELECT request.* FROM agent_requests request
           WHERE request.status = 'submitted'
             AND request.codex_thread_id IS NOT NULL
             AND request.correlation_marker IS NOT NULL
             AND (
               json_extract(request.event_json, '$.source') IN ('slack', 'github', 'gmail')
               OR json_extract(request.event_json, '$.principal.provider') = 'linear'
             )
             AND NOT EXISTS (
               SELECT 1 FROM source_reply_outbox reply
               WHERE reply.request_id = request.id
             )
           ORDER BY request.created_at, request.rowid`,
        )
        .all() as RequestRow[]
    ).map(toRequest);
  }

  private requireOrchestration(requestId: string): AgentRequestOrchestration {
    const orchestration = this.orchestrationForRequest(requestId);
    if (!orchestration) {
      throw new SourceReplyConflictError(
        `request ${requestId} has no durable separate-task orchestration`,
      );
    }
    return orchestration;
  }

  private listRequestsForOrchestrationStage(stage: AgentRequestOrchestrationStage): AgentRequest[] {
    return (
      this.db
        .prepare(
          `SELECT request.* FROM agent_requests request
           JOIN agent_request_orchestrations orchestration
             ON orchestration.request_id = request.id
           WHERE request.status = 'submitted' AND orchestration.stage = ?
           ORDER BY request.created_at, request.rowid`,
        )
        .all(stage) as RequestRow[]
    ).map(toRequest);
  }

  setStatus(id: string, status: AgentRequestStatus, error?: string): void {
    const run = this.db.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE agent_requests SET status = ?, error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE id = ?`,
        )
        .run(status, error ?? null, now, id);
      if (status === "completed" || status === "failed") {
        this.suppressUnsentProgressAck(id, now);
      }
    });
    run();
  }

  hold(id: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE agent_requests SET status = 'held', error = ?, next_attempt_at = ?,
         attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(error, nextAttemptAt, nowIso(), id);
  }

  resetInFlight(): number {
    return this.db
      .prepare(
        `UPDATE agent_requests SET status = 'acknowledged', updated_at = ?
         WHERE status = 'dispatching'
           AND NOT EXISTS (
             SELECT 1 FROM claude_proxy_turns proxy
             WHERE proxy.agent_request_id = agent_requests.id
           )`,
      )
      .run(nowIso()).changes;
  }

  /**
   * Fail every older request that has not reached a provider-visible reply.
   * A host-owned separate task remains stoppable after child submission, so
   * its submitted state is included while ordinary submitted turns are not.
   */
  supersedePendingBeforeStop(stopRequestId: string, workItemId: string): string[] {
    const run = this.db.transaction(() => {
      const stop = this.db
        .prepare("SELECT rowid FROM agent_requests WHERE id = ?")
        .get(stopRequestId) as { rowid: number } | undefined;
      if (!stop) throw new Error(`stop request ${stopRequestId} does not exist`);
      const rows = this.db
        .prepare(
          `SELECT id FROM agent_requests
           WHERE work_item_id = ? AND rowid < ?
             AND (
               status IN ('acknowledged', 'held', 'dispatching')
               OR (
                 status = 'submitted' AND EXISTS (
                   SELECT 1 FROM agent_request_orchestrations orchestration
                   WHERE orchestration.request_id = agent_requests.id
                     AND orchestration.stage IN (
                       'child_submitted', 'child_completed', 'report_submitted'
                     )
                 )
               )
             )
             AND COALESCE(json_extract(event_json, '$.payload.agentSignal'), '') <> 'stop'`,
        )
        .all(workItemId, stop.rowid) as Array<{ id: string }>;
      for (const { id } of rows) {
        this.supersedeRequest(id, "superseded by a later authenticated stop request");
      }
      return rows.map(({ id }) => id);
    });
    return run();
  }

  /** True when this request has been overtaken by a later authenticated stop. */
  hasLaterStop(requestId: string, workItemId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM agent_requests current
           JOIN agent_requests stop ON stop.work_item_id = ? AND stop.rowid > current.rowid
          WHERE current.id = ?
            AND json_extract(stop.event_json, '$.payload.agentSignal') = 'stop'
          LIMIT 1`,
      )
      .get(workItemId, requestId);
    return row !== undefined;
  }

  supersedeRequest(id: string, error: string): void {
    const run = this.db.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'failed', error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE id = ? AND (
             status IN ('acknowledged', 'held', 'dispatching')
             OR (
               status = 'submitted' AND EXISTS (
                 SELECT 1 FROM agent_request_orchestrations orchestration
                 WHERE orchestration.request_id = agent_requests.id
               )
             )
           )`,
        )
        .run(error, now, id);
      this.db
        .prepare(
          `UPDATE ack_outbox SET status = 'failed', error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE request_id = ? AND status IN ('pending', 'held')`,
        )
        .run(error, now, id);
      this.db
        .prepare(
          `UPDATE source_reply_outbox SET status = 'failed', error = ?, next_attempt_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE request_id = ? AND status IN ('pending', 'held')`,
        )
        .run(error, now, id);
    });
    run();
  }

  ack(id: string): AckJob | null {
    const row = this.db.prepare("SELECT * FROM ack_outbox WHERE id = ?").get(id) as
      | AckRow
      | undefined;
    return row ? toAck(row) : null;
  }

  ackForRequest(requestId: string): AckJob | null {
    const row = this.db.prepare("SELECT * FROM ack_outbox WHERE request_id = ?").get(requestId) as
      | AckRow
      | undefined;
    return row ? toAck(row) : null;
  }

  sourceReply(id: string): SourceReplyJob | null {
    const row = this.db.prepare("SELECT * FROM source_reply_outbox WHERE id = ?").get(id) as
      | SourceReplyRow
      | undefined;
    return row ? toSourceReply(row) : null;
  }

  sourceReplyForRequest(requestId: string): SourceReplyJob | null {
    const row = this.db
      .prepare("SELECT * FROM source_reply_outbox WHERE request_id = ?")
      .get(requestId) as SourceReplyRow | undefined;
    return row ? toSourceReply(row) : null;
  }

  /**
   * Atomically claims due work and expired leases for one worker. An IMMEDIATE
   * transaction prevents two SQLite connections from selecting the same rows;
   * every delivery attempt is counted when it is claimed, before any provider
   * side effect can occur. The persisted source, provider, and destination form
   * the exact reply-conversation key, so a nonterminal predecessor is a FIFO
   * fence for later replies to that same target.
   */
  claimSourceReplies(options: ClaimSourceRepliesOptions): SourceReplyClaim[] {
    const leaseOwner = requiredNonEmpty(options.leaseOwner, "source reply lease owner");
    const at = requiredIsoTimestamp(options.at, "source reply claim time");
    const leaseExpiresAt = requiredIsoTimestamp(
      options.leaseExpiresAt,
      "source reply lease expiration",
    );
    if (leaseExpiresAt <= at) {
      throw new TypeError("source reply lease expiration must be after the claim time");
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("source reply claim limit must be an integer from 1 to 1000");
    }

    const run = this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT current.id, current.status FROM source_reply_outbox current
           WHERE (
             (
               current.status IN ('pending', 'held')
               AND (current.next_attempt_at IS NULL OR current.next_attempt_at <= ?)
             ) OR (
               current.status = 'sending'
               AND current.lease_expires_at IS NOT NULL
               AND current.lease_expires_at <= ?
             )
           )
             AND NOT EXISTS (
               SELECT 1 FROM source_reply_outbox predecessor
               WHERE predecessor.source_id = current.source_id
                 AND predecessor.provider = current.provider
                 AND predecessor.destination = current.destination
                 AND predecessor.status NOT IN ('sent', 'failed')
                 AND (
                   predecessor.created_at < current.created_at
                   OR (
                     predecessor.created_at = current.created_at
                     AND predecessor.rowid < current.rowid
                   )
                 )
             )
           ORDER BY current.created_at, current.rowid
           LIMIT ?`,
        )
        .all(at, at, limit) as Array<{ id: string; status: SourceReplyStatus }>;

      const claims: SourceReplyClaim[] = [];
      for (const candidate of candidates) {
        const claimed = this.db
          .prepare(
            `UPDATE source_reply_outbox
             SET status = 'sending', lease_owner = ?, lease_expires_at = ?,
                 attempt_count = attempt_count + 1, updated_at = ?
             WHERE id = ?
               AND (
                 (status IN ('pending', 'held')
                   AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
                 OR
                 (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
               )
             RETURNING *`,
          )
          .get(leaseOwner, leaseExpiresAt, at, candidate.id, at, at) as SourceReplyRow | undefined;
        if (!claimed) continue;
        const job = toSourceReply(claimed);
        claims.push({
          ...job,
          leaseOwner,
          leaseExpiresAt,
          claimIsRecovery: candidate.status === "sending",
          deliveryAttempt: job.attemptCount,
        });
      }
      return claims;
    });
    return run.immediate();
  }

  /** Provider acceptance and the reply's persisted request outcome commit together. */
  markSourceReplySent(id: string, leaseOwner: string, providerResultId?: string): void {
    const owner = requiredNonEmpty(leaseOwner, "source reply lease owner");
    const run = this.db.transaction(() => {
      const reply = this.requireSourceReplyLease(id, owner);
      const now = nowIso();
      const replyUpdate = this.db
        .prepare(
          `UPDATE source_reply_outbox SET status = 'sent', provider_result_id = ?, error = NULL,
           next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
        )
        .run(providerResultId ?? reply.providerResultId, now, id, owner);
      if (replyUpdate.changes !== 1) throw sourceReplyLeaseConflict(id, owner);
      const updated =
        reply.requestOutcome === "completed"
          ? this.db
              .prepare(
                `UPDATE agent_requests SET status = 'completed', error = NULL,
                   next_attempt_at = NULL, updated_at = ?
                 WHERE id = ? AND status IN ('submitted', 'completed')`,
              )
              .run(now, reply.requestId)
          : this.db
              .prepare(
                `UPDATE agent_requests SET status = 'failed', next_attempt_at = NULL,
                   updated_at = ?
                 WHERE id = ? AND status = 'failed'`,
              )
              .run(now, reply.requestId);
      if (updated.changes !== 1) {
        throw new SourceReplyConflictError(
          `request ${reply.requestId} is not ready for source reply outcome ${reply.requestOutcome}`,
        );
      }
      this.suppressUnsentProgressAck(reply.requestId, now);
    });
    run();
  }

  holdSourceReply(id: string, leaseOwner: string, error: string, nextAttemptAt: string): void {
    const owner = requiredNonEmpty(leaseOwner, "source reply lease owner");
    const heldUntil = requiredIsoTimestamp(nextAttemptAt, "source reply next attempt time");
    const updated = this.db
      .prepare(
        `UPDATE source_reply_outbox SET status = 'held', error = ?, next_attempt_at = ?,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
      )
      .run(error, heldUntil, nowIso(), id, owner);
    if (updated.changes !== 1) throw sourceReplyLeaseConflict(id, owner);
  }

  markSourceReplyFailed(id: string, leaseOwner: string, error: string): void {
    const owner = requiredNonEmpty(leaseOwner, "source reply lease owner");
    const run = this.db.transaction(() => {
      const reply = this.requireSourceReplyLease(id, owner);
      const now = nowIso();
      const replyUpdate = this.db
        .prepare(
          `UPDATE source_reply_outbox SET status = 'failed', error = ?, next_attempt_at = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
        )
        .run(error, now, id, owner);
      if (replyUpdate.changes !== 1) throw sourceReplyLeaseConflict(id, owner);
      this.db
        .prepare(
          `UPDATE agent_requests SET status = 'failed', error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE id = ? AND status = 'submitted'`,
        )
        .run(`source reply failed: ${error}`, now, reply.requestId);
      this.suppressUnsentProgressAck(reply.requestId, now);
    });
    run();
  }

  private requireSourceReplyLease(id: string, leaseOwner: string): SourceReplyJob {
    const row = this.db
      .prepare(
        `SELECT * FROM source_reply_outbox
         WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
      )
      .get(id, leaseOwner) as SourceReplyRow | undefined;
    if (!row) throw sourceReplyLeaseConflict(id, leaseOwner);
    return toSourceReply(row);
  }

  private suppressUnsentProgressAck(requestId: string, updatedAt = nowIso()): void {
    this.db
      .prepare(
        `UPDATE ack_outbox
         SET status = 'failed', error = ?, next_attempt_at = NULL,
             provider_result_id = NULL, updated_at = ?
         WHERE request_id = ?
           AND status IN ('pending', 'held')
           AND COALESCE(
             (SELECT json_extract(request.event_json, '$.payload.agentSignal')
              FROM agent_requests request WHERE request.id = ack_outbox.request_id),
             ''
           ) <> 'stop'`,
      )
      .run(PROGRESS_ACK_SUPPRESSED_REASON, updatedAt, requestId);
  }

  listAcksReady(at = nowIso()): AckJob[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ack_outbox
           WHERE status IN ('pending', 'held') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at`,
        )
        .all(at) as AckRow[]
    ).map(toAck);
  }

  /**
   * Atomically resolves the deadline-vs-completion race for one delayed ack.
   * A Linear stop response is a lifecycle acknowledgment and is always exempt.
   */
  claimAckForSend(id: string, at = nowIso()): AckJob | null {
    const claimAt = requiredIsoTimestamp(at, "acknowledgment claim time");
    const run = this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT ack.*, request.status AS request_status,
                  COALESCE(json_extract(request.event_json, '$.payload.agentSignal'), '')
                    AS agent_signal
           FROM ack_outbox ack
           JOIN agent_requests request ON request.id = ack.request_id
           WHERE ack.id = ?
             AND ack.status IN ('pending', 'held')
             AND (ack.next_attempt_at IS NULL OR ack.next_attempt_at <= ?)`,
        )
        .get(id, claimAt) as
        | (AckRow & { request_status: AgentRequestStatus; agent_signal: string })
        | undefined;
      if (!candidate) return null;
      if (
        candidate.agent_signal !== "stop" &&
        (candidate.request_status === "completed" ||
          candidate.request_status === "failed" ||
          this.sourceReplyForRequest(candidate.request_id) !== null)
      ) {
        this.suppressUnsentProgressAck(candidate.request_id, claimAt);
        return null;
      }
      const claimed = this.db
        .prepare(
          `UPDATE ack_outbox SET status = 'sending', updated_at = ?
           WHERE id = ?
             AND status IN ('pending', 'held')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           RETURNING *`,
        )
        .get(claimAt, id, claimAt) as AckRow | undefined;
      return claimed ? toAck(claimed) : null;
    });
    return run.immediate();
  }

  markAckSending(id: string): void {
    this.db
      .prepare("UPDATE ack_outbox SET status = 'sending', updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  markAckSent(id: string, providerResultId?: string): void {
    this.db
      .prepare(
        `UPDATE ack_outbox SET status = 'sent', provider_result_id = ?, error = NULL,
         next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(providerResultId ?? null, nowIso(), id);
  }

  holdAck(id: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE ack_outbox SET status = 'held', error = ?, next_attempt_at = ?,
         attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(error, nextAttemptAt, nowIso(), id);
  }

  releaseAckForRequest(requestId: string, payload?: Record<string, unknown>): void {
    const ack = this.ackForRequest(requestId);
    if (!ack) throw new Error(`request ${requestId} is missing its acknowledgment job`);
    this.db
      .prepare(
        `UPDATE ack_outbox SET status = 'pending', payload_json = ?, error = NULL,
         next_attempt_at = NULL, updated_at = ? WHERE request_id = ? AND status = 'held'`,
      )
      .run(JSON.stringify(payload ?? ack.payload), nowIso(), requestId);
  }

  /**
   * Atomically terminalize a request whose acknowledgment was deliberately
   * held until the side effect completed. Keeping both writes in one SQLite
   * transaction prevents a crash from stranding a completed stop response.
   */
  finalizeDeferredRequest(args: {
    requestId: string;
    status: "completed" | "failed";
    error?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  }): void {
    const run = this.db.transaction(() => {
      const ack = this.ackForRequest(args.requestId);
      if (!ack) {
        throw new Error(`request ${args.requestId} is missing its acknowledgment job`);
      }
      if (ack.status !== "held") {
        throw new Error(
          `request ${args.requestId} acknowledgment must be held before finalization`,
        );
      }
      const now = nowIso();
      const requestUpdate = this.db
        .prepare(
          `UPDATE agent_requests SET status = ?, error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE id = ? AND status = 'dispatching'`,
        )
        .run(args.status, args.error ?? null, now, args.requestId);
      if (requestUpdate.changes !== 1) {
        throw new Error(
          `request ${args.requestId} must be dispatching before deferred finalization`,
        );
      }
      const ackUpdate = this.db
        .prepare(
          `UPDATE ack_outbox SET status = 'pending', payload_json = ?, error = NULL,
           next_attempt_at = NULL, updated_at = ?
           WHERE request_id = ? AND status = 'held'`,
        )
        .run(JSON.stringify(args.payload ?? ack.payload), now, args.requestId);
      if (ackUpdate.changes !== 1) {
        throw new Error(`request ${args.requestId} held acknowledgment could not be released`);
      }
    });
    run();
  }

  markAckFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE ack_outbox SET status = 'failed', error = ?, next_attempt_at = NULL,
         attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(error, nowIso(), id);
  }

  resetAckInFlight(): number {
    return this.db
      .prepare("UPDATE ack_outbox SET status = 'pending', updated_at = ? WHERE status = 'sending'")
      .run(nowIso()).changes;
  }
}

export class WorkItemConflictError extends Error {}
export class AckConflictError extends Error {}
export class SourceReplyConflictError extends Error {}
export class SourceReplyLeaseConflictError extends SourceReplyConflictError {}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    canonicalKind: row.canonical_kind,
    canonicalKey: row.canonical_key,
    title: row.title,
    cwd: row.cwd,
    codexThreadId: row.codex_thread_id,
    codexThreadTitle: row.codex_thread_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRequest(row: RequestRow): AgentRequest {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceDeliveryId: row.source_delivery_id,
    personId: row.person_id,
    workItemId: row.work_item_id,
    requestText: row.request_text,
    executionProfile: ExecutionProfileSchema.parse(JSON.parse(row.execution_profile_json)),
    event: JSON.parse(row.event_json) as WakeEvent,
    coalesceKey: row.coalesce_key,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    correlationMarker: row.correlation_marker,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOrchestration(row: OrchestrationRow): AgentRequestOrchestration {
  return {
    requestId: row.request_id,
    stage: row.stage,
    cwd: row.cwd,
    sandbox: row.sandbox_policy,
    childPrompt: row.child_prompt,
    childTitle: row.child_title,
    reportPromptPrefix: row.report_prompt_prefix,
    reportPromptSuffix: row.report_prompt_suffix,
    parentThreadId: row.parent_thread_id,
    childThreadId: row.child_thread_id,
    childTurnId: row.child_turn_id,
    childCorrelationMarker: row.child_correlation_marker,
    childFinalResponse: row.child_final_response,
    childTitleSyncedAt: row.child_title_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAck(row: AckRow): AckJob {
  return {
    id: row.id,
    requestId: row.request_id,
    sourceId: row.source_id,
    provider: row.provider,
    providerDeliveryId: row.provider_delivery_id,
    ackKind: row.ack_kind,
    destination: row.destination,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    providerResultId: row.provider_result_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSourceReply(row: SourceReplyRow): SourceReplyJob {
  return {
    id: row.id,
    requestId: row.request_id,
    sourceId: row.source_id,
    provider: row.provider,
    replyKind: row.reply_kind,
    destination: row.destination,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    requestOutcome: row.request_outcome,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    providerResultId: row.provider_result_id,
    error: row.error,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertSameSourceReply(
  requestId: string,
  existing: SourceReplyJob,
  spec: SourceReplySpec,
  requestOutcome: SourceReplyRequestOutcome,
): void {
  if (
    existing.provider !== spec.provider ||
    existing.replyKind !== spec.kind ||
    existing.destination !== spec.destination ||
    existing.requestOutcome !== requestOutcome ||
    !isDeepStrictEqual(existing.payload, spec.payload)
  ) {
    throw new SourceReplyConflictError(
      `request ${requestId} already has a different final source reply`,
    );
  }
}

function requiredNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function requiredIsoTimestamp(value: string, label: string): string {
  const normalized = requiredNonEmpty(value, label);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return normalized;
}

function sourceReplyLeaseConflict(id: string, leaseOwner: string): SourceReplyLeaseConflictError {
  return new SourceReplyLeaseConflictError(
    `source reply ${id} is not leased to worker ${leaseOwner}`,
  );
}

function optionalNonEmpty(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  return requiredNonEmpty(value, label);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")
  );
}
