import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { WakeEvent } from "../core/event.js";
import type { PolicyDirectory } from "./policy.js";
import { effectivePolicy } from "./policy.js";
import { normalizeSlackFinalReplyText, type SourceReplySpec } from "./reply.js";
import type { AgentRequest, AgentRequestStore, SourceReplyJob } from "./store.js";

export interface ScheduledChannelDeliveryBinding {
  id: string;
  automationId: string;
  originRequestId: string;
  originCodexThreadId: string;
  originCodexTurnId: string;
  originCorrelationMarker: string;
  originSourceId: string;
  slackTeamId: string;
  slackChannelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledChannelDeliveryOccurrence {
  bindingId: string;
  occurrenceKey: string;
  requestId: string;
  messageSha256: string;
  createdAt: string;
}

interface ScheduledChannelDeliveryBindingRow {
  id: string;
  automation_id: string;
  origin_request_id: string;
  origin_codex_thread_id: string;
  origin_codex_turn_id: string;
  origin_correlation_marker: string;
  origin_source_id: string;
  slack_team_id: string;
  slack_channel_id: string;
  created_at: string;
  updated_at: string;
}

interface ScheduledChannelDeliveryOccurrenceRow {
  binding_id: string;
  occurrence_key: string;
  request_id: string;
  message_sha256: string;
  created_at: string;
}

export interface RegisterScheduledChannelDeliveryInput {
  automationId: string;
  originRequestId: string;
  currentCodexThreadId: string;
}

export interface SendScheduledChannelDeliveryInput {
  deliveryId: string;
  automationId: string;
  currentCodexThreadId: string;
  occurrenceKey: string;
  message: string;
}

export interface ScheduledChannelDeliverySend {
  binding: ScheduledChannelDeliveryBinding;
  occurrence: ScheduledChannelDeliveryOccurrence;
  occurrenceKey: string;
  request: AgentRequest;
  reply: SourceReplyJob;
  duplicate: boolean;
}

interface ScheduledChannelDeliveryResult {
  request: AgentRequest;
  reply: SourceReplyJob;
}

interface SlackOriginTarget {
  teamId: string;
  channelId: string;
}

export class ScheduledChannelDeliveryNotFoundError extends Error {}
export class ScheduledChannelDeliveryConflictError extends Error {}
export class ScheduledChannelDeliveryAuthorizationError extends Error {}
export class InvalidScheduledChannelDeliveryError extends Error {}

export class ScheduledChannelDeliveryStore {
  constructor(private readonly db: Database) {}

  get(id: string): ScheduledChannelDeliveryBinding | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_channel_delivery_bindings WHERE id = ?")
      .get(id) as ScheduledChannelDeliveryBindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  findAutomation(automationId: string): ScheduledChannelDeliveryBinding | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_channel_delivery_bindings WHERE automation_id = ?")
      .get(automationId) as ScheduledChannelDeliveryBindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  getOccurrence(
    bindingId: string,
    occurrenceKey: string,
  ): ScheduledChannelDeliveryOccurrence | null {
    const row = this.db
      .prepare(
        `SELECT * FROM scheduled_channel_delivery_occurrences
         WHERE binding_id = ? AND occurrence_key = ?`,
      )
      .get(bindingId, occurrenceKey) as ScheduledChannelDeliveryOccurrenceRow | undefined;
    return row ? toOccurrence(row) : null;
  }

  listOccurrences(bindingId: string, limit = 50): ScheduledChannelDeliveryOccurrence[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM scheduled_channel_delivery_occurrences
           WHERE binding_id = ?
           ORDER BY created_at DESC, occurrence_key DESC
           LIMIT ?`,
        )
        .all(bindingId, limit) as ScheduledChannelDeliveryOccurrenceRow[]
    ).map(toOccurrence);
  }

  register(input: Omit<ScheduledChannelDeliveryBinding, "id" | "createdAt" | "updatedAt">): {
    binding: ScheduledChannelDeliveryBinding;
    duplicate: boolean;
  } {
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
          `INSERT INTO scheduled_channel_delivery_bindings
            (id, automation_id, origin_request_id, origin_codex_thread_id,
             origin_codex_turn_id, origin_correlation_marker, origin_source_id,
             slack_team_id, slack_channel_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.automationId,
          input.originRequestId,
          input.originCodexThreadId,
          input.originCodexTurnId,
          input.originCorrelationMarker,
          input.originSourceId,
          input.slackTeamId,
          input.slackChannelId,
          now,
          now,
        );

      const created = this.get(id);
      if (!created) throw new Error("scheduled channel delivery binding insert failed");
      return { binding: created, duplicate: false };
    });
    return run.immediate();
  }

  recordOccurrence(
    bindingId: string,
    occurrenceKey: string,
    messageSha256: string,
    create: () => ScheduledChannelDeliveryResult,
    replay: (requestId: string) => ScheduledChannelDeliveryResult,
  ): ScheduledChannelDeliveryResult & {
    occurrence: ScheduledChannelDeliveryOccurrence;
    duplicate: boolean;
  } {
    const run = this.db.transaction(() => {
      const binding = this.get(bindingId);
      if (!binding) {
        throw new ScheduledChannelDeliveryNotFoundError(
          `unknown scheduled channel delivery ${bindingId}`,
        );
      }

      const existing = this.getOccurrence(bindingId, occurrenceKey);
      if (existing) {
        if (existing.messageSha256 !== messageSha256) {
          throw new ScheduledChannelDeliveryConflictError(
            `scheduled channel delivery ${bindingId} occurrence ${occurrenceKey} already has different content`,
          );
        }
        const result = replay(existing.requestId);
        if (result.request.id !== existing.requestId) {
          throw new ScheduledChannelDeliveryConflictError(
            `scheduled channel delivery ${bindingId} occurrence ${occurrenceKey} has a different request`,
          );
        }
        return { ...result, occurrence: existing, duplicate: true };
      }

      const result = create();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO scheduled_channel_delivery_occurrences
            (binding_id, occurrence_key, request_id, message_sha256, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(bindingId, occurrenceKey, result.request.id, messageSha256, now);
      const occurrence = this.getOccurrence(bindingId, occurrenceKey);
      if (!occurrence) throw new Error("scheduled channel delivery occurrence insert failed");
      return { ...result, occurrence, duplicate: false };
    });
    return run.immediate();
  }
}

/**
 * Binds a recurring automation to the Slack channel of its authenticated
 * origin. Each occurrence becomes a provider-only outbox job; the automation
 * callback can never select or retarget the destination.
 */
export class ScheduledChannelDeliveryService {
  constructor(
    private readonly bindings: ScheduledChannelDeliveryStore,
    private readonly requests: AgentRequestStore,
    private readonly people: PolicyDirectory,
    private readonly onReplyQueued: () => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(input: RegisterScheduledChannelDeliveryInput) {
    const automationId = scheduledIdentifier(input.automationId, "automation id", 128);
    const originRequestId = nonEmpty(input.originRequestId, "origin request id", 256);
    const currentCodexThreadId = nonEmpty(input.currentCodexThreadId, "current Codex task id", 256);
    const origin = this.requireOrigin(originRequestId);
    if (origin.codexThreadId !== currentCodexThreadId) {
      throw new ScheduledChannelDeliveryConflictError(
        `origin request ${origin.id} is bound to Codex task ${origin.codexThreadId}`,
      );
    }
    this.requireDeliveryAuthorization(origin);
    const target = slackOriginTarget(origin);

    const result = this.bindings.register({
      automationId,
      originRequestId: origin.id,
      originCodexThreadId: currentCodexThreadId,
      originCodexTurnId: origin.codexTurnId as string,
      originCorrelationMarker: origin.correlationMarker as string,
      originSourceId: origin.sourceId,
      slackTeamId: target.teamId,
      slackChannelId: target.channelId,
    });
    return { ...result, source: "slack" as const };
  }

  send(input: SendScheduledChannelDeliveryInput): ScheduledChannelDeliverySend {
    const deliveryId = nonEmpty(input.deliveryId, "scheduled channel delivery id", 256);
    const automationId = scheduledIdentifier(input.automationId, "automation id", 128);
    const currentCodexThreadId = nonEmpty(input.currentCodexThreadId, "current Codex task id", 256);
    const occurrenceKey = occurrenceIdentifier(input.occurrenceKey);
    const rawMessage = nonEmpty(input.message, "delivery message", 35_000);
    let message: string;
    try {
      message = normalizeSlackFinalReplyText(rawMessage);
    } catch (error) {
      throw new InvalidScheduledChannelDeliveryError(
        `invalid delivery message: ${error instanceof Error ? error.message : error}`,
      );
    }

    const binding = this.bindings.get(deliveryId);
    if (!binding) {
      throw new ScheduledChannelDeliveryNotFoundError(
        `unknown scheduled channel delivery ${deliveryId}`,
      );
    }
    this.assertCallbackBinding(binding, automationId, currentCodexThreadId);
    const origin = this.requireOrigin(binding.originRequestId);
    const target = slackOriginTarget(origin);
    assertOriginStillMatches(binding, origin, target);
    this.requireDeliveryAuthorization(origin);

    const messageSha256 = createHash("sha256").update(message).digest("hex");
    const spec: SourceReplySpec = {
      provider: "slack",
      kind: "channel-message",
      destination: `${binding.slackTeamId}:${binding.slackChannelId}`,
      payload: {
        channel: binding.slackChannelId,
        text: message,
      },
    };
    const metadata = {
      version: 1,
      deliveryId: binding.id,
      automationId,
      occurrenceKey,
      originRequestId: origin.id,
      originCodexThreadId: binding.originCodexThreadId,
      originCodexTurnId: binding.originCodexTurnId,
      originCorrelationMarker: binding.originCorrelationMarker,
    } as const;
    const event: WakeEvent = {
      ...origin.event,
      kind: `${origin.event.kind}.scheduled_channel_delivery`,
      deliveryId: scheduledOccurrenceDeliveryId(binding.id, occurrenceKey),
      occurredAt: this.now().toISOString(),
      summary: `Scheduled channel delivery for ${origin.event.summary}`,
      payload: {
        ...origin.event.payload,
        text: message,
        wakewireScheduledChannelDelivery: metadata,
      },
    };
    const enqueue = () =>
      this.requests.enqueueScheduledSourceReply({
        sourceId: origin.sourceId,
        event,
        personId: origin.personId,
        workItemId: origin.workItemId,
        requestText: message,
        executionProfile: origin.executionProfile,
        dedup: {
          scope: `scheduled-channel-delivery:${binding.id}`,
          deliveryId: scheduledOccurrenceDeliveryId(binding.id, occurrenceKey),
        },
        codexThreadId: binding.originCodexThreadId,
        correlationMarker: scheduledOccurrenceCorrelationMarker(binding.id, occurrenceKey),
        spec,
      });

    const sent = this.bindings.recordOccurrence(
      binding.id,
      occurrenceKey,
      messageSha256,
      enqueue,
      (requestId) => {
        const request = this.requests.get(requestId);
        const reply = this.requests.sourceReplyForRequest(requestId);
        if (!request || !reply) {
          throw new ScheduledChannelDeliveryConflictError(
            `scheduled channel delivery ${binding.id} occurrence ${occurrenceKey} has an incomplete outbox record`,
          );
        }
        return { request, reply };
      },
    );
    this.onReplyQueued();
    return { binding, ...sent, occurrenceKey: sent.occurrence.occurrenceKey };
  }

  status(deliveryId: string) {
    const binding = this.bindings.get(nonEmpty(deliveryId, "scheduled channel delivery id", 256));
    if (!binding) {
      throw new ScheduledChannelDeliveryNotFoundError(
        `unknown scheduled channel delivery ${deliveryId}`,
      );
    }
    return {
      binding,
      source: "slack" as const,
      occurrences: this.bindings.listOccurrences(binding.id).map((occurrence) => {
        const request = this.requests.get(occurrence.requestId);
        const reply = request ? this.requests.sourceReplyForRequest(request.id) : null;
        if (!request || !reply) {
          throw new ScheduledChannelDeliveryConflictError(
            `scheduled channel delivery occurrence ${occurrence.occurrenceKey} has an incomplete outbox record`,
          );
        }
        return {
          occurrence,
          request: { id: request.id, status: request.status },
          sourceReply: {
            id: reply.id,
            status: reply.status,
            provider: reply.provider,
            error: reply.error,
          },
        };
      }),
    };
  }

  private assertCallbackBinding(
    binding: ScheduledChannelDeliveryBinding,
    automationId: string,
    currentCodexThreadId: string,
  ): void {
    if (binding.automationId !== automationId) {
      throw new ScheduledChannelDeliveryConflictError(
        `scheduled channel delivery ${binding.id} belongs to automation ${binding.automationId}`,
      );
    }
    if (binding.originCodexThreadId !== currentCodexThreadId) {
      throw new ScheduledChannelDeliveryConflictError(
        `scheduled channel delivery ${binding.id} belongs to Codex task ${binding.originCodexThreadId}`,
      );
    }
  }

  private requireDeliveryAuthorization(origin: AgentRequest): void {
    const policy = effectivePolicy(this.people, origin.personId);
    const sourceReplies = policy?.policy.capabilities.sourceReplies;
    const connectedApps = policy?.policy.capabilities.connectedApps;
    if (
      !policy?.authorized ||
      (sourceReplies !== "write" && sourceReplies !== "full") ||
      (connectedApps !== "write" && connectedApps !== "full")
    ) {
      throw new ScheduledChannelDeliveryAuthorizationError(
        `person ${origin.personId} is not authorized for scheduled channel delivery`,
      );
    }
  }

  private requireOrigin(id: string): AgentRequest {
    const origin = this.requests.get(id);
    if (!origin) throw new ScheduledChannelDeliveryNotFoundError(`unknown origin request ${id}`);
    if (origin.event.payload.wakewireScheduledChannelDelivery) {
      throw new InvalidScheduledChannelDeliveryError(
        "a scheduled channel delivery cannot be registered from another scheduled delivery",
      );
    }
    if (origin.status !== "submitted" && origin.status !== "completed") {
      throw new InvalidScheduledChannelDeliveryError(
        `origin request ${id} is ${origin.status}; expected submitted or completed`,
      );
    }
    if (!origin.codexThreadId || !origin.codexTurnId || !origin.correlationMarker) {
      throw new InvalidScheduledChannelDeliveryError(
        `origin request ${id} has no exact Codex task, turn, and correlation binding`,
      );
    }
    slackOriginTarget(origin);
    return origin;
  }
}

function slackOriginTarget(origin: AgentRequest): SlackOriginTarget {
  const event = origin.event;
  const teamId = payloadString(event, "team");
  const channelId = payloadString(event, "channel");
  const messageTs = payloadString(event, "ts");
  const rootTs = payloadString(event, "threadTs") || messageTs;
  if (
    event.source !== "slack" ||
    event.principal?.provider !== "slack" ||
    event.principal.tenantId !== teamId ||
    !teamId ||
    !channelId ||
    !messageTs ||
    !rootTs
  ) {
    throw new InvalidScheduledChannelDeliveryError(
      "scheduled channel delivery requires an authenticated Slack origin",
    );
  }
  if (event.sourceId !== origin.sourceId) {
    throw new InvalidScheduledChannelDeliveryError(
      "Slack origin event source does not match the authenticated request source",
    );
  }
  if (
    event.conversation?.nativeKey !== `${teamId}:${channelId}:${messageTs}` ||
    event.conversation.rootKey !== `${teamId}:${channelId}:${rootTs}` ||
    event.conversation.replyTarget !== `${channelId}:${messageTs}`
  ) {
    throw new InvalidScheduledChannelDeliveryError(
      "Slack origin target does not match normalized conversation metadata",
    );
  }
  return { teamId, channelId };
}

function assertOriginStillMatches(
  binding: ScheduledChannelDeliveryBinding,
  origin: AgentRequest,
  target: SlackOriginTarget,
): void {
  if (
    origin.sourceId !== binding.originSourceId ||
    origin.codexThreadId !== binding.originCodexThreadId ||
    origin.codexTurnId !== binding.originCodexTurnId ||
    origin.correlationMarker !== binding.originCorrelationMarker ||
    target.teamId !== binding.slackTeamId ||
    target.channelId !== binding.slackChannelId
  ) {
    throw new ScheduledChannelDeliveryConflictError(
      `origin request ${origin.id} no longer matches scheduled channel delivery ${binding.id}`,
    );
  }
}

function assertSameBinding(
  existing: ScheduledChannelDeliveryBinding,
  expected: Omit<ScheduledChannelDeliveryBinding, "id" | "createdAt" | "updatedAt">,
): void {
  if (
    existing.automationId !== expected.automationId ||
    existing.originRequestId !== expected.originRequestId ||
    existing.originCodexThreadId !== expected.originCodexThreadId ||
    existing.originCodexTurnId !== expected.originCodexTurnId ||
    existing.originCorrelationMarker !== expected.originCorrelationMarker ||
    existing.originSourceId !== expected.originSourceId ||
    existing.slackTeamId !== expected.slackTeamId ||
    existing.slackChannelId !== expected.slackChannelId
  ) {
    throw new ScheduledChannelDeliveryConflictError(
      `automation ${expected.automationId} already has a different scheduled channel delivery binding`,
    );
  }
}

function scheduledOccurrenceDeliveryId(bindingId: string, occurrenceKey: string): string {
  const digest = createHash("sha256").update(`${bindingId}\0${occurrenceKey}`).digest("hex");
  return `scheduled-channel-delivery:${digest}`;
}

function scheduledOccurrenceCorrelationMarker(bindingId: string, occurrenceKey: string): string {
  const digest = createHash("sha256").update(`${bindingId}\0${occurrenceKey}`).digest("hex");
  return `wakewire:scheduled-channel-delivery:v1:${digest}`;
}

function scheduledIdentifier(value: string, label: string, max: number): string {
  const normalized = nonEmpty(value, label, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
    throw new InvalidScheduledChannelDeliveryError(
      `${label} must contain only letters, numbers, dots, underscores, colons, and hyphens`,
    );
  }
  return normalized;
}

function occurrenceIdentifier(value: string): string {
  const normalized = nonEmpty(value, "occurrence key", 256);
  if (
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new InvalidScheduledChannelDeliveryError(
      "occurrence key must not contain control characters",
    );
  }
  return normalized;
}

function nonEmpty(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new InvalidScheduledChannelDeliveryError(`${label} is required`);
  if ([...normalized].length > max) {
    throw new InvalidScheduledChannelDeliveryError(`${label} must be at most ${max} characters`);
  }
  return normalized;
}

function payloadString(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function toBinding(row: ScheduledChannelDeliveryBindingRow): ScheduledChannelDeliveryBinding {
  return {
    id: row.id,
    automationId: row.automation_id,
    originRequestId: row.origin_request_id,
    originCodexThreadId: row.origin_codex_thread_id,
    originCodexTurnId: row.origin_codex_turn_id,
    originCorrelationMarker: row.origin_correlation_marker,
    originSourceId: row.origin_source_id,
    slackTeamId: row.slack_team_id,
    slackChannelId: row.slack_channel_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOccurrence(
  row: ScheduledChannelDeliveryOccurrenceRow,
): ScheduledChannelDeliveryOccurrence {
  return {
    bindingId: row.binding_id,
    occurrenceKey: row.occurrence_key,
    requestId: row.request_id,
    messageSha256: row.message_sha256,
    createdAt: row.created_at,
  };
}
