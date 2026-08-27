import type { WakeEvent } from "../core/event.js";
import { isPrivilegedLinearAgentSessionEvent } from "../sources/linear/agent-session.js";
import { isPrivilegedLinearUserEvent } from "../sources/linear/user-event.js";
import { linearThreadParentId } from "./linear-thread.js";

/** Exact provider operation persisted in the acknowledgment outbox. */
export interface AckSpec {
  provider: string;
  kind: string;
  destination: string;
  payload: Record<string, unknown>;
}

export class UnsupportedAckEventError extends Error {}
export class InvalidAckEventError extends Error {}

/**
 * Pure provider-specific acknowledgment selection. Authorization happens before
 * this function; it only turns a normalized event into an outbound operation.
 */
export function buildAckSpec(event: WakeEvent, nickname: string): AckSpec {
  const name = requiredString(nickname, "nickname");
  if (event.source === "slack") return slackAck(event);
  if (event.source === "github") return githubAck(event);
  if (event.source === "gmail") return gmailAck(event, name);
  if (isLinear(event)) return linearAck(event, name);
  throw new UnsupportedAckEventError(`no acknowledgment is defined for ${event.source}`);
}

function slackAck(event: WakeEvent): AckSpec {
  const channel = payloadString(event, "channel");
  const timestamp = payloadString(event, "ts");
  if (!channel || !timestamp) {
    throw new InvalidAckEventError("Slack acknowledgment requires payload.channel and payload.ts");
  }
  return {
    provider: "slack",
    kind: "eyes-reaction",
    destination: `${channel}:${timestamp}`,
    payload: { channel, timestamp, reaction: "eyes" },
  };
}

function githubAck(event: WakeEvent): AckSpec {
  const repo = payloadString(event, "repo");
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new InvalidAckEventError("GitHub acknowledgment requires payload.repo");
  }
  const commentId = payloadIdentifier(event, "commentId");
  const number = payloadIdentifier(event, "number");
  let targetType: "issue" | "issue-comment" | "review-comment";
  let targetId: string;
  if (
    event.kind === "pull_request_review_comment" ||
    event.kind.startsWith("pull_request_review_comment.")
  ) {
    targetType = "review-comment";
    targetId = requiredString(commentId, "GitHub review comment id");
  } else if (event.kind === "issue_comment" || event.kind.startsWith("issue_comment.")) {
    targetType = "issue-comment";
    targetId = requiredString(commentId, "GitHub issue comment id");
  } else {
    targetType = "issue";
    targetId = requiredString(number, "GitHub issue or pull request number");
  }
  return {
    provider: "github",
    kind: "eyes-reaction",
    destination: `${repo}:${targetType}:${targetId}`,
    payload: { repo, targetType, targetId, content: "eyes" },
  };
}

function gmailAck(event: WakeEvent, nickname: string): AckSpec {
  const to = payloadString(event, "fromEmail");
  const originalMessageId = payloadString(event, "rfcMessageId");
  if (!to || !originalMessageId) {
    throw new InvalidAckEventError(
      "Gmail acknowledgment requires payload.fromEmail and payload.rfcMessageId",
    );
  }
  if (
    event.deliveryId !== originalMessageId ||
    event.conversation?.nativeKey !== originalMessageId ||
    event.conversation.replyTarget !== originalMessageId
  ) {
    throw new InvalidAckEventError(
      "Gmail acknowledgment target does not match normalized conversation metadata",
    );
  }
  const rawSubject = payloadString(event, "subject") || "(no subject)";
  const subject = /^\s*re\s*:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
  const references = payloadStrings(event, "references");
  const threadReferences = [...new Set([...references, originalMessageId])];
  return {
    provider: "gmail",
    kind: "brief-reply",
    destination: originalMessageId,
    payload: {
      to,
      subject,
      text: `I'm on it, ${nickname}.`,
      originalMessageId,
      inReplyTo: originalMessageId,
      references: threadReferences,
    },
  };
}

/** Same 👀 glyph Slack/GitHub progress eyes use. Linear stores the native emoji. */
export const LINEAR_PROGRESS_EYES_EMOJI = "👀";

function linearAck(event: WakeEvent, nickname: string): AckSpec {
  const target =
    event.conversation?.replyTarget ||
    payloadIdentifier(event, "commentId") ||
    payloadIdentifier(event, "issueId") ||
    payloadString(event, "identifier") ||
    payloadString(event, "url");
  if (!target) {
    throw new InvalidAckEventError(
      "Linear acknowledgment requires a normalized reply target or mapped issue/comment id",
    );
  }
  if (isPrivilegedLinearUserEvent(event)) {
    return linearUserProgressEyes(event, target);
  }
  const parentId = linearThreadParentId(event.payload);
  return {
    provider: "linear",
    kind: "activity",
    destination: parentId ? `${target}:comment:${parentId}` : target,
    payload:
      event.payload.agentSignal === "stop"
        ? {
            target,
            text: `Stopped, ${nickname}.`,
            contentType: "response",
            ephemeral: false,
            ...(parentId ? { parentId } : {}),
          }
        : {
            target,
            text: `${LINEAR_PROGRESS_EYES_EMOJI} I'm on it, ${nickname}.`,
            contentType: "thought",
            ephemeral: true,
            ...(parentId ? { parentId } : {}),
          },
  };
}

function linearUserProgressEyes(event: WakeEvent, fallbackTarget: string): AckSpec {
  const commentId = payloadIdentifier(event, "commentId");
  const issueId = payloadIdentifier(event, "issueId") || fallbackTarget;
  if (commentId) {
    return {
      provider: "linear",
      kind: "eyes-reaction",
      destination: `comment:${commentId}`,
      payload: { commentId, emoji: LINEAR_PROGRESS_EYES_EMOJI },
    };
  }
  if (!issueId) {
    throw new InvalidAckEventError(
      "Linear acknowledgment requires payload.commentId or payload.issueId",
    );
  }
  return {
    provider: "linear",
    kind: "eyes-reaction",
    destination: `issue:${issueId}`,
    payload: { issueId, emoji: LINEAR_PROGRESS_EYES_EMOJI },
  };
}

function isLinear(event: WakeEvent): boolean {
  return isPrivilegedLinearAgentSessionEvent(event) || isPrivilegedLinearUserEvent(event);
}

function payloadString(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadIdentifier(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function payloadStrings(event: WakeEvent, key: string): string[] {
  const value = event.payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new InvalidAckEventError(`${label} is required`);
  return normalized;
}
