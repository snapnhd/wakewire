import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { WakeEvent } from "../core/event.js";
import type { PolicyDirectory } from "./policy.js";
import { effectivePolicy } from "./policy.js";
import { buildFinalReplySpec } from "./reply.js";
import type { AgentRequest, AgentRequestStore, SourceReplyJob } from "./store.js";

export interface ScheduledFollowupBinding {
  id: string;
  automationId: string;
  originRequestId: string;
  originCodexThreadId: string;
  originCodexTurnId: string;
  originCorrelationMarker: string;
  terminalRequestId: string | null;
  terminalMessageSha256: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduledFollowupBindingRow {
  id: string;
  automation_id: string;
  origin_request_id: string;
  origin_codex_thread_id: string;
  origin_codex_turn_id: string;
  origin_correlation_marker: string;
  terminal_request_id: string | null;
  terminal_message_sha256: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterScheduledFollowupInput {
  automationId: string;
  originRequestId: string;
  currentCodexThreadId: string;
}

export interface CompleteScheduledFollowupInput {
  followupId: string;
  automationId: string;
  currentCodexThreadId: string;
  message: string;
}

export interface ScheduledFollowupCompletion {
  binding: ScheduledFollowupBinding;
  request: AgentRequest;
  reply: SourceReplyJob;
  duplicate: boolean;
}

interface ScheduledReplyResult {
  request: AgentRequest;
  reply: SourceReplyJob;
}

export class ScheduledFollowupNotFoundError extends Error {}
export class ScheduledFollowupConflictError extends Error {}
export class ScheduledFollowupAuthorizationError extends Error {}
export class InvalidScheduledFollowupError extends Error {}

export class ScheduledFollowupStore {
  constructor(private readonly db: Database) {}

  get(id: string): ScheduledFollowupBinding | null {
    const row = this.db.prepare("SELECT * FROM scheduled_followup_bindings WHERE id = ?").get(id) as
      | ScheduledFollowupBindingRow
      | undefined;
    return row ? toBinding(row) : null;
  }

  findAutomation(automationId: string): ScheduledFollowupBinding | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_followup_bindings WHERE automation_id = ?")
      .get(automationId) as ScheduledFollowupBindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  register(
    input: Omit<
      ScheduledFollowupBinding,
      | "id"
      | "terminalRequestId"
      | "terminalMessageSha256"
      | "completedAt"
      | "createdAt"
      | "updatedAt"
    >,
  ) {
    const run = this.db.transaction(() => {
      const existing = this.findAutomation(input.automationId);
      if (existing) {
        assertSameBinding(existing, input);
        return { binding: existing, duplicate: true };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO scheduled_followup_bindings
            (id, automation_id, origin_request_id, origin_codex_thread_id,
             origin_codex_turn_id, origin_correlation_marker, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.automationId,
          input.originRequestId,
          input.originCodexThreadId,
          input.originCodexTurnId,
          input.originCorrelationMarker,
          now,
          now,
        );

      const created = this.get(id);
      if (!created) throw new Error("scheduled follow-up binding insert failed");
      return { binding: created, duplicate: false };
    });
    return run.immediate();
  }

  /**
   * First terminal write wins for the whole binding. The child request, reply
   * outbox, and terminal pointer commit in one IMMEDIATE transaction.
   */
  finish(
    id: string,
    messageSha256: string,
    create: () => ScheduledReplyResult,
    replay: (requestId: string) => ScheduledReplyResult,
  ): ScheduledReplyResult & { binding: ScheduledFollowupBinding; duplicate: boolean } {
    const run = this.db.transaction(() => {
      const binding = this.get(id);
      if (!binding) {
        throw new ScheduledFollowupNotFoundError(`unknown scheduled follow-up ${id}`);
      }
      if (binding.terminalRequestId) {
        if (binding.terminalMessageSha256 !== messageSha256) {
          throw new ScheduledFollowupConflictError(
            `scheduled follow-up ${id} already completed with different content`,
          );
        }
        return { ...replay(binding.terminalRequestId), binding, duplicate: true };
      }

      const result = create();
      const completedAt = new Date().toISOString();
      const update = this.db
        .prepare(
          `UPDATE scheduled_followup_bindings
           SET terminal_request_id = ?, terminal_message_sha256 = ?, completed_at = ?,
               updated_at = ?
           WHERE id = ? AND terminal_request_id IS NULL`,
        )
        .run(result.request.id, messageSha256, completedAt, completedAt, id);
      if (update.changes !== 1) {
        throw new ScheduledFollowupConflictError(
          `scheduled follow-up ${id} was completed concurrently`,
        );
      }
      const completed = this.get(id);
      if (!completed) throw new Error(`scheduled follow-up ${id} disappeared`);
      return { ...result, binding: completed, duplicate: false };
    });
    return run.immediate();
  }
}

/**
 * Binds a thread-targeted Codex heartbeat to its authenticated WakeWire
 * request. The heartbeat renders the task result; this service queues only the
 * matching provider reply through the durable outbox.
 */
export class ScheduledFollowupService {
  constructor(
    private readonly bindings: ScheduledFollowupStore,
    private readonly requests: AgentRequestStore,
    private readonly people: PolicyDirectory,
    private readonly onReplyQueued: () => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(input: RegisterScheduledFollowupInput) {
    const automationId = scheduledIdentifier(input.automationId, "automation id", 128);
    const originRequestId = nonEmpty(input.originRequestId, "origin request id", 256);
    const currentCodexThreadId = nonEmpty(input.currentCodexThreadId, "current Codex task id", 256);
    const origin = this.requireOrigin(originRequestId);
    if (origin.codexThreadId !== currentCodexThreadId) {
      throw new ScheduledFollowupConflictError(
        `origin request ${origin.id} is bound to Codex task ${origin.codexThreadId}`,
      );
    }

    const result = this.bindings.register({
      automationId,
      originRequestId: origin.id,
      originCodexThreadId: currentCodexThreadId,
      originCodexTurnId: origin.codexTurnId as string,
      originCorrelationMarker: origin.correlationMarker as string,
    });
    return { ...result, source: origin.event.source };
  }

  complete(input: CompleteScheduledFollowupInput): ScheduledFollowupCompletion {
    const followupId = nonEmpty(input.followupId, "follow-up id", 256);
    const automationId = scheduledIdentifier(input.automationId, "automation id", 128);
    const currentCodexThreadId = nonEmpty(input.currentCodexThreadId, "current Codex task id", 256);
    const message = nonEmpty(input.message, "completion message", 35_000);
    const initialBinding = this.bindings.get(followupId);
    if (!initialBinding) {
      throw new ScheduledFollowupNotFoundError(`unknown scheduled follow-up ${followupId}`);
    }
    this.assertCallbackBinding(initialBinding, automationId, currentCodexThreadId);
    const messageSha256 = createHash("sha256").update(message).digest("hex");

    const completed = this.bindings.finish(
      followupId,
      messageSha256,
      () => {
        const binding = this.bindings.get(followupId) as ScheduledFollowupBinding;
        this.assertCallbackBinding(binding, automationId, currentCodexThreadId);
        const origin = this.requireOrigin(binding.originRequestId);
        assertOriginStillMatches(binding, origin);
        this.requireSourceReplyAuthorization(origin);

        // The provider target is derived only from the frozen origin event.
        const spec = buildFinalReplySpec(origin.event, message);
        const metadata = {
          version: 1,
          followupId: binding.id,
          automationId,
          originRequestId: origin.id,
          originCodexThreadId: binding.originCodexThreadId,
          originCodexTurnId: binding.originCodexTurnId,
          originCorrelationMarker: binding.originCorrelationMarker,
        } as const;
        const event: WakeEvent = {
          ...origin.event,
          kind: `${origin.event.kind}.scheduled_followup`,
          deliveryId: scheduledDeliveryId(binding.id),
          occurredAt: this.now().toISOString(),
          summary: `Scheduled follow-up completed for ${origin.event.summary}`,
          payload: {
            ...origin.event.payload,
            text: message,
            wakewireScheduledFollowup: metadata,
          },
        };
        return this.requests.enqueueScheduledSourceReply({
          sourceId: origin.sourceId,
          event,
          personId: origin.personId,
          workItemId: origin.workItemId,
          requestText: message,
          executionProfile: origin.executionProfile,
          dedup: { scope: `scheduled-followup:${binding.id}`, deliveryId: "terminal" },
          codexThreadId: binding.originCodexThreadId,
          correlationMarker: scheduledCorrelationMarker(binding.id),
          spec,
        });
      },
      (requestId) => {
        const request = this.requests.get(requestId);
        const reply = this.requests.sourceReplyForRequest(requestId);
        if (!request || !reply) {
          throw new ScheduledFollowupConflictError(
            `scheduled follow-up ${followupId} has an incomplete terminal record`,
          );
        }
        return { request, reply };
      },
    );
    this.onReplyQueued();
    return completed;
  }

  status(followupId: string) {
    const binding = this.bindings.get(nonEmpty(followupId, "follow-up id", 256));
    if (!binding) {
      throw new ScheduledFollowupNotFoundError(`unknown scheduled follow-up ${followupId}`);
    }
    const request = binding.terminalRequestId ? this.requests.get(binding.terminalRequestId) : null;
    const reply = request ? this.requests.sourceReplyForRequest(request.id) : null;
    return {
      binding,
      terminal: request
        ? {
            requestId: request.id,
            status: request.status,
            sourceReply: reply
              ? {
                  id: reply.id,
                  status: reply.status,
                  provider: reply.provider,
                  error: reply.error,
                }
              : null,
          }
        : null,
    };
  }

  private assertCallbackBinding(
    binding: ScheduledFollowupBinding,
    automationId: string,
    currentCodexThreadId: string,
  ): void {
    // This caller assertion catches an automation accidentally moved to a
    // different task. It never selects or retargets delivery: the authenticated
    // local API plus opaque binding authorizes the callback, and the provider
    // destination is derived exclusively from the frozen origin event.
    if (binding.automationId !== automationId) {
      throw new ScheduledFollowupConflictError(
        `scheduled follow-up ${binding.id} belongs to automation ${binding.automationId}`,
      );
    }
    if (binding.originCodexThreadId !== currentCodexThreadId) {
      throw new ScheduledFollowupConflictError(
        `scheduled follow-up ${binding.id} belongs to Codex task ${binding.originCodexThreadId}`,
      );
    }
  }

  private requireSourceReplyAuthorization(origin: AgentRequest): void {
    const policy = effectivePolicy(this.people, origin.personId);
    const level = policy?.policy.capabilities.sourceReplies;
    if (!policy?.authorized || (level !== "write" && level !== "full")) {
      throw new ScheduledFollowupAuthorizationError(
        `person ${origin.personId} is no longer authorized for source replies`,
      );
    }
  }

  private requireOrigin(id: string): AgentRequest {
    const origin = this.requests.get(id);
    if (!origin) throw new ScheduledFollowupNotFoundError(`unknown origin request ${id}`);
    if (origin.event.payload.wakewireScheduledFollowup) {
      throw new InvalidScheduledFollowupError(
        "a scheduled follow-up cannot be registered from another scheduled follow-up",
      );
    }
    if (origin.status !== "submitted" && origin.status !== "completed") {
      throw new InvalidScheduledFollowupError(
        `origin request ${id} is ${origin.status}; expected submitted or completed`,
      );
    }
    if (!origin.codexThreadId || !origin.codexTurnId || !origin.correlationMarker) {
      throw new InvalidScheduledFollowupError(
        `origin request ${id} has no exact Codex task, turn, and correlation binding`,
      );
    }
    buildFinalReplySpec(origin.event, "Scheduled follow-up binding validation");
    return origin;
  }
}

function scheduledDeliveryId(followupId: string): string {
  return `scheduled-followup:${createHash("sha256").update(followupId).digest("hex")}`;
}

function scheduledCorrelationMarker(followupId: string): string {
  return `wakewire:scheduled-followup:v1:${createHash("sha256").update(followupId).digest("hex")}`;
}

function assertOriginStillMatches(binding: ScheduledFollowupBinding, origin: AgentRequest): void {
  if (
    origin.codexThreadId !== binding.originCodexThreadId ||
    origin.codexTurnId !== binding.originCodexTurnId ||
    origin.correlationMarker !== binding.originCorrelationMarker
  ) {
    throw new ScheduledFollowupConflictError(
      `origin request ${origin.id} no longer matches scheduled follow-up ${binding.id}`,
    );
  }
}

function assertSameBinding(
  existing: ScheduledFollowupBinding,
  expected: Omit<
    ScheduledFollowupBinding,
    "id" | "terminalRequestId" | "terminalMessageSha256" | "completedAt" | "createdAt" | "updatedAt"
  >,
): void {
  if (
    existing.automationId !== expected.automationId ||
    existing.originRequestId !== expected.originRequestId ||
    existing.originCodexThreadId !== expected.originCodexThreadId ||
    existing.originCodexTurnId !== expected.originCodexTurnId ||
    existing.originCorrelationMarker !== expected.originCorrelationMarker
  ) {
    throw new ScheduledFollowupConflictError(
      `automation ${expected.automationId} already has a different scheduled follow-up binding`,
    );
  }
}

function scheduledIdentifier(value: string, label: string, max: number): string {
  const normalized = nonEmpty(value, label, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
    throw new InvalidScheduledFollowupError(
      `${label} must contain only letters, numbers, dots, underscores, colons, and hyphens`,
    );
  }
  return normalized;
}

function nonEmpty(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new InvalidScheduledFollowupError(`${label} is required`);
  if ([...normalized].length > max) {
    throw new InvalidScheduledFollowupError(`${label} must be at most ${max} characters`);
  }
  return normalized;
}

function toBinding(row: ScheduledFollowupBindingRow): ScheduledFollowupBinding {
  return {
    id: row.id,
    automationId: row.automation_id,
    originRequestId: row.origin_request_id,
    originCodexThreadId: row.origin_codex_thread_id,
    originCodexTurnId: row.origin_codex_turn_id,
    originCorrelationMarker: row.origin_correlation_marker,
    terminalRequestId: row.terminal_request_id,
    terminalMessageSha256: row.terminal_message_sha256,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
