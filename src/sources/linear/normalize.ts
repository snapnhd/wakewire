import type { WakeEvent } from "../../core/event.js";

/**
 * Enrich a signature-verified generic Linear webhook after its declarative
 * trim. All named fields must be included in the source mapping; missing
 * immutable actor/organization ids intentionally leaves the event
 * unauthorized.
 */
export function normalizeLinearAgentEvent(event: WakeEvent): WakeEvent {
  if (event.source !== "webhook" || text(event, "provider").toLowerCase() !== "linear") {
    return event;
  }
  const organizationId = text(event, "organizationId");
  const actorId = text(event, "actorId");
  const actorEmail = text(event, "actorEmail").toLowerCase();
  const actorName = text(event, "actorName");
  const issueId = text(event, "issueId");
  const identifier = text(event, "identifier").toUpperCase();
  const commentId = text(event, "commentId");
  const body = text(event, "body") || text(event, "comment") || text(event, "description");
  const rootKey = organizationId && issueId ? `${organizationId}:${issueId}` : "";
  return {
    ...event,
    ...(organizationId && actorId
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
    ...(rootKey
      ? {
          conversation: {
            nativeKey: commentId ? `${rootKey}:comment:${commentId}` : rootKey,
            rootKey,
            replyTarget: text(event, "agentSessionId") || commentId || issueId,
          },
        }
      : {}),
    payload: {
      ...event.payload,
      ...(identifier ? { identifier } : {}),
      ...(body ? { body } : {}),
    },
  };
}

function text(event: WakeEvent, field: string): string {
  return typeof event.payload[field] === "string" ? event.payload[field].trim() : "";
}
