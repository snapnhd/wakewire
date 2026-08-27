import type { WakeEvent } from "../../core/event.js";

const TEXT_LIMIT = 8_000;
const CONTEXT_LIMIT = 12_000;
const DELEGATION_DIRECTIVE = "Work on the Linear issue delegated to Chip.";

export class InvalidLinearAgentSessionEventError extends Error {}

/**
 * Normalize Linear's native AgentSessionEvent webhook without a user-authored
 * generic mapping. The webhook has already passed Linear HMAC and timestamp
 * verification before this function runs.
 */
export function linearAgentSessionToWakeEvent(args: {
  body: Record<string, unknown>;
  sourceId: string;
  /** Immutable app user id queried from Linear's viewer API during source setup. */
  expectedAppUserId?: string | undefined;
  /** Fallback digest computed from the already-verified signed request body. */
  signedBodyDeliveryId?: string | undefined;
}): WakeEvent | null {
  const { body, sourceId, expectedAppUserId, signedBodyDeliveryId } = args;
  if (string(body.type) !== "AgentSessionEvent") return null;
  const action = string(body.action).toLowerCase();
  if (action !== "created" && action !== "prompted") return null;

  const session = record(body.agentSession);
  const activity = record(body.agentActivity);
  const organizationId = consistentIdentity(
    "organization",
    body.organizationId,
    session.organizationId,
  );
  const sessionId = string(session.id);
  const issue = record(session.issue);
  const issueId = consistentIdentity("issue", session.issueId, issue.id);
  const identifier = string(issue.identifier).toUpperCase();
  const actor = action === "prompted" ? record(activity.user) : record(session.creator);
  const actorId = consistentIdentity(
    "actor",
    actor.id,
    action === "prompted" ? activity.userId : session.creatorId,
  );
  const actorEmail = string(actor.email).toLowerCase();
  const actorName = string(actor.name);
  const appUserId = string(body.appUserId);
  const pinnedAppUserId = string(expectedAppUserId);
  const appIdentityMatches =
    Boolean(pinnedAppUserId) &&
    appUserId === pinnedAppUserId &&
    string(session.appUserId) === pinnedAppUserId;
  const agentSignal = action === "prompted" ? promptedSignal(activity) : "";
  const createdDelegation =
    action === "created" &&
    appIdentityMatches &&
    isCreatedIssueDelegation(body, session, actorId, issueId, identifier);
  const createdMention =
    action === "created" && createdEventMentionsChip(body, session, actorId, appUserId);
  const directive =
    action === "prompted"
      ? promptedDirective(activity)
      : createdDelegation
        ? DELEGATION_DIRECTIVE
        : createdDirective(body, session, actorId);
  const addressed =
    appIdentityMatches &&
    (action === "prompted"
      ? Boolean(directive) || agentSignal === "stop"
      : createdDelegation || (Boolean(directive) && createdMention));
  const webhookId = string(body.webhookId);
  // webhookId and the fallback digest are covered by Linear's body HMAC. The
  // relay's linear-delivery header is mutable and must never select this key.
  const deliveryId = webhookId || string(signedBodyDeliveryId);
  if (!deliveryId || !organizationId || !sessionId) return null;

  const occurredAt = isoTimestamp(body.createdAt) ?? new Date().toISOString();
  const commentId =
    string(activity.sourceCommentId) ||
    string(session.sourceCommentId) ||
    string(session.commentId);
  const promptContext = truncate(string(body.promptContext), CONTEXT_LIMIT);
  const activityId = string(activity.id);
  const nativeKey = activityId ? `${sessionId}:activity:${activityId}` : sessionId;
  const rootKey = issueId
    ? `${organizationId}:${issueId}`
    : `${organizationId}:agent-session:${sessionId}`;
  const createdVerb = createdDelegation
    ? "delegated"
    : createdMention
      ? "mentioned"
      : "started a session for";

  return {
    source: "webhook",
    sourceId,
    kind: `AgentSessionEvent.${action}`,
    deliveryId,
    occurredAt,
    summary: `${actorName || "Linear user"} ${action === "created" ? createdVerb : "prompted"} Chip${identifier ? ` on ${identifier}` : ""}`,
    payload: {
      provider: "linear",
      action,
      agentSessionId: sessionId,
      organizationId,
      appUserId,
      ...(agentSignal ? { agentSignal } : {}),
      ...(createdDelegation ? { agentTrigger: "delegation" } : {}),
      ...(issueId ? { issueId } : {}),
      ...(identifier ? { identifier } : {}),
      ...(string(issue.title) ? { title: truncate(string(issue.title), 500) } : {}),
      ...(string(issue.url) ? { url: string(issue.url) } : {}),
      ...(commentId ? { commentId } : {}),
      ...(directive ? { body: truncate(directive, TEXT_LIMIT) } : {}),
      ...(promptContext ? { promptContext } : {}),
      actorId,
      actorEmail,
      actorName,
    },
    ...(actorId
      ? {
          principal: {
            provider: "linear" as const,
            tenantId: organizationId,
            subjectId: actorId,
            ...(actorEmail ? { email: actorEmail } : {}),
            ...(actorName ? { displayName: actorName } : {}),
          },
        }
      : {}),
    conversation: {
      nativeKey,
      rootKey,
      replyTarget: sessionId,
    },
    ...(addressed
      ? {
          targetMentions: [{ kind: "agent-session" as const, value: appUserId }],
        }
      : {}),
  };
}

/**
 * True only for the source-pinned native event shape. Declaratively mapped
 * Linear webhooks deliberately cannot manufacture this privileged target.
 */
export function isPrivilegedLinearAgentSessionEvent(event: WakeEvent): boolean {
  if (event.source !== "webhook" || string(event.payload.provider).toLowerCase() !== "linear") {
    return false;
  }
  if (event.kind !== "AgentSessionEvent.created" && event.kind !== "AgentSessionEvent.prompted") {
    return false;
  }
  const appUserId = string(event.payload.appUserId);
  const sessionId = string(event.payload.agentSessionId);
  if (!appUserId || !sessionId || event.conversation?.replyTarget !== sessionId) return false;
  return (event.targetMentions ?? []).some(
    (mention) => mention.kind === "agent-session" && mention.value === appUserId,
  );
}

function promptedDirective(activity: Record<string, unknown>): string {
  const content = record(activity.content);
  return string(content.type).toLowerCase() === "prompt" ? string(content.body) : "";
}

function promptedSignal(activity: Record<string, unknown>): string {
  const content = record(activity.content);
  if (string(content.type).toLowerCase() !== "prompt") return "";
  return string(activity.signal).toLowerCase() === "stop" ? "stop" : "";
}

/**
 * Linear documents a created AgentSessionEvent as either a mention or an issue
 * delegation. Its AgentSession webhook shape does not expose `delegateId`, so
 * distinguish delegation by the absence of every comment anchor plus one
 * structured issue context matching the immutable session issue. Generic Issue
 * webhooks never reach this function, and ambiguous native shapes fail closed.
 */
function isCreatedIssueDelegation(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  actorId: string,
  issueId: string,
  identifier: string,
): boolean {
  if (!actorId || !issueId || !identifier) return false;

  const issue = record(session.issue);
  if (string(session.issueId) !== issueId || string(issue.id) !== issueId) return false;
  if (
    (session.comment !== undefined && session.comment !== null) ||
    string(session.commentId) ||
    string(session.sourceCommentId) ||
    Object.keys(record(body.agentActivity)).length > 0 ||
    array(body.previousComments).length > 0
  ) {
    return false;
  }

  const context = string(body.promptContext);
  if (!context || /<primary-directive-thread\b/i.test(context)) return false;
  const contextIdentifiers = structuredIssueIdentifiers(context);
  return contextIdentifiers.length === 1 && contextIdentifiers[0] === identifier;
}

function structuredIssueIdentifiers(context: string): string[] {
  const identifiers: string[] = [];
  for (const match of context.matchAll(
    /<issue\b[^>]*\bidentifier\s*=\s*["']([^"']+)["'][^>]*>/gi,
  )) {
    const identifier = string(match[1]).toUpperCase();
    if (identifier) identifiers.push(identifier);
  }
  return identifiers;
}

function createdDirective(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  actorId: string,
): string {
  const sourceComment = createdSourceComment(body, session, actorId);
  if (sourceComment && string(sourceComment.body)) return string(sourceComment.body);
  if (!createdAuthorConsistent(body, session, actorId)) return "";
  return primaryDirectiveText(
    string(body.promptContext),
    primaryThreadId(session),
    string(body.appUserId),
  );
}

function createdEventMentionsChip(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  actorId: string,
  appUserId: string,
): boolean {
  if (!appUserId) return false;
  const sourceComment = createdSourceComment(body, session, actorId);
  if (sourceComment && exactChipMention(string(sourceComment.body))) return true;
  if (!createdAuthorConsistent(body, session, actorId)) return false;
  return Boolean(
    primaryDirectiveMentionComment(string(body.promptContext), primaryThreadId(session), appUserId),
  );
}

function createdSourceComment(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  actorId: string,
): Record<string, unknown> | null {
  if (!actorId) return null;
  const sourceId = string(session.sourceCommentId);
  if (sourceId) {
    const previous = array(body.previousComments)
      .map(record)
      .find((comment) => string(comment.id) === sourceId);
    return previous && string(previous.userId) === actorId ? previous : null;
  }

  const root = record(session.comment);
  if (string(root.userId) !== actorId) return null;
  const rootId = string(root.id);
  const commentId = string(session.commentId);
  if (commentId && rootId && rootId !== commentId) return null;
  return root;
}

function createdAuthorConsistent(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  actorId: string,
): boolean {
  if (!actorId) return false;
  const sourceId = string(session.sourceCommentId);
  if (sourceId) {
    const source = array(body.previousComments)
      .map(record)
      .find((comment) => string(comment.id) === sourceId);
    // Linear may omit the current triggering child from `previousComments`.
    // When present, it must agree with the immutable session creator.
    return !source || string(source.userId) === actorId;
  }
  return string(record(session.comment).userId) === actorId;
}

function primaryThreadId(session: Record<string, unknown>): string {
  return string(session.commentId) || string(session.sourceCommentId);
}

function primaryDirectiveThread(context: string, expectedThreadId: string): string {
  if (!context || !expectedThreadId) return "";
  const escapedId = escapeRegExp(expectedThreadId);
  const thread = new RegExp(
    `<primary-directive-thread\\b[^>]*\\bcomment-id=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/primary-directive-thread>`,
    "i",
  ).exec(context)?.[1];
  return thread ?? "";
}

function hasStructuredUserMention(comment: string, appUserId: string): boolean {
  if (!comment || !appUserId) return false;
  const escapedId = escapeRegExp(appUserId);
  return new RegExp(`<user\\b[^>]*\\bid=["']${escapedId}["'][^>]*>[\\s\\S]*?<\\/user>`, "i").test(
    comment,
  );
}

function primaryDirectiveMentionComment(
  context: string,
  threadId: string,
  appUserId: string,
): string {
  const thread = primaryDirectiveThread(context, threadId);
  if (!thread) return "";
  let latest = "";
  for (const match of thread.matchAll(/<comment\b[^>]*>([\s\S]*?)<\/comment>/gi)) {
    latest = match[1] ?? "";
  }
  // The current triggering child is the final comment in Linear's primary
  // directive thread. An older mention must not authorize a later delegation.
  return hasStructuredUserMention(latest, appUserId) ? latest : "";
}

function primaryDirectiveText(context: string, commentId: string, appUserId: string): string {
  const comment = primaryDirectiveMentionComment(context, commentId, appUserId);
  if (!comment) return "";
  const escapedId = escapeRegExp(appUserId);
  return comment
    .replace(
      new RegExp(`<user\\b[^>]*\\bid=["']${escapedId}["'][^>]*>[\\s\\S]*?<\\/user>`, "gi"),
      "@Chip Byte",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactChipMention(value: string): boolean {
  return /(^|\s)@(?:Chip Byte|chip)(?=\s|[.,!?;:]|$)/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function consistentIdentity(label: string, ...values: unknown[]): string {
  const identities = values.map(string).filter(Boolean);
  if (new Set(identities).size > 1) {
    throw new InvalidLinearAgentSessionEventError(
      `Linear AgentSessionEvent has conflicting ${label} ids`,
    );
  }
  return identities[0] ?? "";
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [truncated]`;
}
