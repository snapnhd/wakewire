import type { WakeEvent } from "../core/event.js";
import { isPrivilegedLinearAgentSessionEvent } from "../sources/linear/agent-session.js";
import { isPrivilegedLinearUserEvent } from "../sources/linear/user-event.js";
import { isPrivilegedSlackUserEvent } from "../sources/slack/normalize.js";

export interface ChipIdentityConfig {
  slackDisplayName: string;
  githubHandle: string;
  linearDisplayName: string;
  emailAddress: string;
  shorthand: string;
}

export const DEFAULT_CHIP_IDENTITIES: ChipIdentityConfig = {
  slackDisplayName: "Chip Byte",
  githubHandle: "chipbyte-snap",
  linearDisplayName: "Chip Byte",
  emailAddress: "chip@snapcorp.com",
  shorthand: "chip",
};

/**
 * Provider-normalized targeting check. This never authorizes the sender; it
 * only proves that an authenticated provider event addressed Chip.
 */
export function isChipAddressed(
  event: WakeEvent,
  config: ChipIdentityConfig = DEFAULT_CHIP_IDENTITIES,
): boolean {
  if (event.source === "slack") {
    // Chip is a normal Slack account. The user-authorized source converts an
    // exact <@USER_ID> mention (including a message.mpim group PM) or a
    // one-to-one message.im into this pinned, structurally revalidated shape.
    return isPrivilegedSlackUserEvent(event);
  }
  if (event.source === "github") {
    if (event.kind === "pull_request.review_requested") {
      return hasTarget(event, "handle", config.githubHandle);
    }
    if (event.kind === "pull_request.synchronize") {
      const author = stringField(event.payload, "author");
      const requestedReviewers = Array.isArray(event.payload.requestedReviewerLogins)
        ? event.payload.requestedReviewerLogins
        : [];
      return (
        !equalFold(author, config.githubHandle) &&
        requestedReviewers.some(
          (reviewer) => typeof reviewer === "string" && equalFold(reviewer, config.githubHandle),
        )
      );
    }
    if (isChipMaintainedPrFeedback(event, config)) return true;
    return (
      hasTarget(event, "handle", config.githubHandle) ||
      hasTarget(event, "handle", config.shorthand)
    );
  }
  if (event.source === "gmail") {
    // Delivery to Chip's mailbox is routing, not an invocation. Require an
    // exact @chip in the newly authored (unquoted) message as well.
    return (
      hasTarget(event, "email", config.emailAddress) && hasTarget(event, "handle", config.shorthand)
    );
  }
  if (isLinearEvent(event)) {
    return isPrivilegedLinearAgentSessionEvent(event) || isPrivilegedLinearUserEvent(event);
  }
  return false;
}

/** Suppress loops even when a provider delivers Chip's own outbound action. */
export function isChipPrincipal(
  event: WakeEvent,
  config: ChipIdentityConfig = DEFAULT_CHIP_IDENTITIES,
): boolean {
  const principal = event.principal;
  if (!principal) return false;
  if (principal.provider === "github") {
    return equalFold(principal.handle, config.githubHandle);
  }
  if (principal.provider === "gmail") {
    return equalFold(principal.email ?? principal.subjectId, config.emailAddress);
  }
  if (principal.provider === "slack") {
    const chipUserId = stringField(event.payload, "recipientUser");
    const teamId = stringField(event.payload, "team");
    return Boolean(
      chipUserId && teamId && principal.subjectId === chipUserId && principal.tenantId === teamId,
    );
  }
  if (principal.provider === "linear") {
    const chipUserId = stringField(event.payload, "chipUserId");
    return chipUserId
      ? principal.subjectId === chipUserId
      : equalFold(principal.displayName, config.linearDisplayName);
  }
  return false;
}

/** The sender-authored command. Quoted/fetched material remains untrusted later. */
export function requestText(event: WakeEvent): string {
  if (isChipMaintainedPrFeedback(event)) {
    const repo = stringField(event.payload, "repo");
    const number = String(event.payload.number ?? "").trim();
    return [
      `An enrolled engineer left new feedback on Chip-authored PR ${repo}#${number}.`,
      "Load pr-workflow first. Act as the PR author: fetch every unresolved review thread and top-level comment, fix or rebut each clear in-scope item, reply inline, resolve only concluded threads, ask the engineer when the right resolution is ambiguous, and never merge the PR automatically.",
    ].join(" ");
  }
  const preferred =
    (event.source === "gmail" ? stringField(event.payload, "authoredBody") : "") ||
    stringField(event.payload, "body") ||
    stringField(event.payload, "text") ||
    stringField(event.payload, "comment") ||
    stringField(event.payload, "description");
  return preferred || event.summary;
}

export function isChipMaintainedPrFeedback(
  event: WakeEvent,
  config: ChipIdentityConfig = DEFAULT_CHIP_IDENTITIES,
): boolean {
  if (event.source !== "github" || event.payload.isPullRequest !== true) return false;
  if (!positiveInteger(event.payload.repositoryId) || !positiveInteger(event.payload.number)) {
    return false;
  }
  if (!equalFold(stringField(event.payload, "pullRequestAuthorLogin"), config.githubHandle)) {
    return false;
  }
  if (event.payload.senderAuthoredFeedback !== true) return false;
  if (stringField(event.payload, "senderType") !== "User") return false;
  return (
    event.kind === "issue_comment.created" ||
    event.kind === "pull_request_review_comment.created" ||
    event.kind === "pull_request_review.submitted"
  );
}

/**
 * Health-check shorthand. After stripping Chip address markers, if the message
 * is exactly lowercase `ping`, return `pong`. Otherwise null (normal dispatch).
 */
export function exactPingPongReply(requestText: string): "pong" | null {
  const stripped = requestText
    .replace(/@chipbyte-snap\b/gi, " ")
    .replace(/@chip\b/gi, " ")
    .replace(/@Chip\s+Byte\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === "ping" ? "pong" : null;
}

function hasTarget(event: WakeEvent, kind: string, expected: string): boolean {
  return (event.targetMentions ?? []).some(
    (mention) => mention.kind === kind && equalFold(mention.value, expected),
  );
}

function isLinearEvent(event: WakeEvent): boolean {
  return event.source === "webhook" && equalFold(stringField(event.payload, "provider"), "linear");
}

function stringField(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function equalFold(left: string | undefined, right: string): boolean {
  return left?.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}
