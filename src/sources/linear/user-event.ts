import type { WakeEvent } from "../../core/event.js";

const TEXT_LIMIT = 8_000;
const ASSIGNMENT_DIRECTIVE = "Work on the Linear issue assigned to Chip.";

export class InvalidLinearUserEventError extends Error {}

/**
 * Normalize signed Linear data-change webhooks for a dedicated Chip user.
 * The API-key viewer and organization are pinned on the source before these
 * events can become privileged; generic mappings cannot manufacture targets.
 */
export function linearUserEventToWakeEvent(args: {
  body: Record<string, unknown>;
  sourceId: string;
  expectedUserId?: string | undefined;
  expectedOrganizationId?: string | undefined;
  signedBodyDeliveryId?: string | undefined;
}): WakeEvent | null {
  const { body, sourceId, signedBodyDeliveryId } = args;
  const expectedUserId = string(args.expectedUserId);
  const expectedOrganizationId = string(args.expectedOrganizationId);
  if (!expectedUserId || !expectedOrganizationId) return null;

  const type = string(body.type);
  if (type !== "Comment" && type !== "Issue") return null;
  const action = string(body.action).toLowerCase();
  const data = record(body.data);
  const updatedFrom = record(body.updatedFrom);
  const organizationId = consistentIdentity(
    "organization",
    body.organizationId,
    data.organizationId,
  );
  if (!organizationId || organizationId !== expectedOrganizationId) {
    throw new InvalidLinearUserEventError("Linear user event organization does not match its pin");
  }

  const actor = record(body.actor);
  const actorId = consistentIdentity(
    "actor",
    actor.id,
    body.actorId,
    type === "Comment" ? data.userId : undefined,
  );
  if (!actorId) return null;

  const issue = type === "Issue" ? data : record(data.issue);
  const issueId = consistentIdentity("issue", type === "Issue" ? data.id : data.issueId, issue.id);
  if (!issueId) return null;

  const mentionText = currentMentionText(type, action, data, updatedFrom);
  const assigneeId =
    type === "Issue"
      ? consistentIdentity("assignee", data.assigneeId, record(data.assignee).id)
      : "";
  const assigned =
    type === "Issue" &&
    assigneeId === expectedUserId &&
    (action === "create" ||
      (action === "update" &&
        (hasOwn(updatedFrom, "assigneeId") || hasOwn(updatedFrom, "assignee"))));
  const mentioned = Boolean(mentionText) && exactChipMention(mentionText);
  if (!assigned && !mentioned) return null;

  const commentId = type === "Comment" ? string(data.id) : "";
  const parentCommentId =
    type === "Comment"
      ? consistentIdentity("parent comment", data.parentId, record(data.parent).id)
      : "";
  const url = string(body.url) || string(issue.url);
  const identifier = string(issue.identifier).toUpperCase() || linearIdentifierFromUrl(url);
  const title = string(issue.title);
  const directive = mentioned ? mentionText : ASSIGNMENT_DIRECTIVE;
  const deliveryId = string(signedBodyDeliveryId);
  if (!deliveryId) return null;
  const rootKey = `${organizationId}:${issueId}`;

  return {
    source: "webhook",
    sourceId,
    kind: assigned ? "LinearUserEvent.assignment" : "LinearUserEvent.mention",
    deliveryId,
    occurredAt: isoTimestamp(body.createdAt) ?? new Date().toISOString(),
    summary: `${string(actor.name) || "Linear user"} ${assigned ? "assigned" : "mentioned"} Chip${identifier ? ` on ${identifier}` : ""}`,
    payload: {
      provider: "linear",
      action,
      linearTrigger: assigned ? "assignment" : "mention",
      chipUserId: expectedUserId,
      organizationId,
      issueId,
      ...(identifier ? { identifier } : {}),
      ...(title ? { title: truncate(title, 500) } : {}),
      ...(url ? { url } : {}),
      ...(commentId ? { commentId } : {}),
      ...(parentCommentId && parentCommentId !== commentId ? { parentCommentId } : {}),
      body: truncate(directive, TEXT_LIMIT),
      actorId,
      ...(string(actor.email) ? { actorEmail: string(actor.email).toLowerCase() } : {}),
      ...(string(actor.name) ? { actorName: string(actor.name) } : {}),
    },
    principal: {
      provider: "linear",
      tenantId: organizationId,
      subjectId: actorId,
      ...(string(actor.email) ? { email: string(actor.email).toLowerCase() } : {}),
      ...(string(actor.name) ? { displayName: string(actor.name) } : {}),
    },
    conversation: {
      nativeKey: commentId ? `${rootKey}:comment:${commentId}` : rootKey,
      rootKey,
      replyTarget: issueId,
    },
    targetMentions: [{ kind: "linear-user", value: expectedUserId }],
  };
}

export function isPrivilegedLinearUserEvent(event: WakeEvent): boolean {
  if (
    event.source !== "webhook" ||
    string(event.payload.provider).toLowerCase() !== "linear" ||
    (event.kind !== "LinearUserEvent.mention" && event.kind !== "LinearUserEvent.assignment")
  ) {
    return false;
  }
  const chipUserId = string(event.payload.chipUserId);
  const issueId = string(event.payload.issueId);
  const organizationId = string(event.payload.organizationId);
  if (
    !chipUserId ||
    !issueId ||
    !organizationId ||
    event.conversation?.rootKey !== `${organizationId}:${issueId}` ||
    event.conversation.replyTarget !== issueId
  ) {
    return false;
  }
  return (event.targetMentions ?? []).some(
    (mention) => mention.kind === "linear-user" && mention.value === chipUserId,
  );
}

function currentMentionText(
  type: string,
  action: string,
  data: Record<string, unknown>,
  updatedFrom: Record<string, unknown>,
): string {
  if (type === "Comment") {
    if (action !== "create" && action !== "update") return "";
    if (action === "update" && !hasOwn(updatedFrom, "body") && !hasOwn(updatedFrom, "bodyData")) {
      return "";
    }
    return string(data.body);
  }
  if (action !== "create" && action !== "update") return "";
  if (
    action === "update" &&
    !hasOwn(updatedFrom, "description") &&
    !hasOwn(updatedFrom, "descriptionData")
  ) {
    return "";
  }
  return string(data.description);
}

function exactChipMention(value: string): boolean {
  return /(^|\s)@(?:Chip Byte|chip)(?=\s|[.,!?;:]|$)/i.test(value);
}

function linearIdentifierFromUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "linear.app") return "";
    const segments = url.pathname.split("/").filter(Boolean);
    const issueIndex = segments.findIndex((segment) => segment.toLowerCase() === "issue");
    const identifier = issueIndex >= 0 ? segments[issueIndex + 1] : undefined;
    return identifier && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)
      ? identifier.toUpperCase()
      : "";
  } catch {
    return "";
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function consistentIdentity(label: string, ...values: unknown[]): string {
  const identities = values.map(string).filter(Boolean);
  if (new Set(identities).size > 1) {
    throw new InvalidLinearUserEventError(`Linear user event has conflicting ${label} ids`);
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
