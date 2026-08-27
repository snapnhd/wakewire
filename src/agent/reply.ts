import type { WakeEvent } from "../core/event.js";
import { isAuthenticatedSlackHumanMessage } from "../sources/slack/normalize.js";
import { linearThreadParentId } from "./linear-thread.js";

export interface SourceReplySpec {
  provider: string;
  kind: string;
  destination: string;
  payload: Record<string, unknown>;
}

export class UnsupportedSourceReplyEventError extends Error {}
export class InvalidSourceReplyEventError extends Error {}

/** Slack truncates text above 40,000 characters. Keep deterministic headroom. */
export const MAX_SLACK_FINAL_REPLY_CHARACTERS = 35_000;
const CODEX_APP_DIRECTIVE =
  /^::(?:code-comment|created-thread|inbox-item|git-stage|git-commit|git-create-branch|git-push|git-create-pr)\{.*\}\s*$/;
const CHATGPT_ATTRIBUTION_PREFIX = /^(?:\*{1,2})?Sent using(?:\*{1,2})?\s+(.+)$/iu;
const CHATGPT_PRODUCT_NAME = /^(?:\*{1,2})?@?ChatGPT(?:\*{1,2})?$/iu;
const CLAUDE_PRODUCT_NAME = /^(?:\*{1,2})?@?Claude(?: Code)?(?:\*{1,2})?$/iu;
const SLACK_CHATGPT_PROFILE_URL = String.raw`https:\/\/[a-z0-9-]+\.slack\.com\/team\/U[a-z0-9]+`;
const CHATGPT_MARKDOWN_PROFILE_LINK = new RegExp(
  String.raw`^\[(?:\*{1,2})?@?ChatGPT(?:\*{1,2})?\]\(${SLACK_CHATGPT_PROFILE_URL}\)(?:\*{1,2})?$`,
  "iu",
);
const CHATGPT_SLACK_PROFILE_LINK = new RegExp(
  String.raw`^<${SLACK_CHATGPT_PROFILE_URL}\|(?:\*{1,2})?@?ChatGPT(?:\*{1,2})?>(?:\*{1,2})?$`,
  "iu",
);
const CHATGPT_SLACK_USER_MENTION =
  /^<@U[a-z0-9]+\|(?:\*{1,2})?@?ChatGPT(?:\*{1,2})?>(?:\*{1,2})?$/iu;

/**
 * Pure provider target selection for a completed agent response. Authorization
 * happens before this boundary; this function only preserves the exact source
 * conversation that originated the request.
 */
export function buildFinalReplySpec(event: WakeEvent, finalResponse: string): SourceReplySpec {
  if (event.source === "slack") return slackFinalReply(event, finalResponse);
  if (event.source === "gmail") return gmailFinalReply(event, finalResponse);
  if (event.source === "github") return githubFinalReply(event, finalResponse);
  if (
    event.source === "webhook" &&
    typeof event.payload.provider === "string" &&
    event.payload.provider.toLowerCase() === "linear"
  ) {
    return linearFinalReply(event, finalResponse);
  }
  throw new UnsupportedSourceReplyEventError(`no final reply is defined for ${event.source}`);
}

/**
 * Preserve the exact authenticated Slack conversation bound to a Claude proxy
 * session. Every response remains rooted at the triggering message (or the
 * existing thread root), including responses in one-to-one DMs.
 */
export function buildClaudeProxyReplySpec(
  event: WakeEvent,
  finalResponse: string,
): SourceReplySpec {
  if (event.source !== "slack") {
    throw new UnsupportedSourceReplyEventError(
      `Claude proxy replies are not defined for ${event.source}`,
    );
  }
  if (!isAuthenticatedSlackHumanMessage(event)) {
    throw new InvalidSourceReplyEventError(
      "Claude proxy reply requires an authenticated normalized Slack human message",
    );
  }

  const team = payloadString(event, "team");
  const channel = payloadString(event, "channel");
  const messageTs = payloadString(event, "ts");
  const rootTs = payloadString(event, "threadTs") || messageTs;
  const channelType = payloadString(event, "channelType");
  const text = normalizeSlackClaudeProxyReplyText(finalResponse);

  if (
    channelType !== "im" &&
    channelType !== "channel" &&
    channelType !== "group" &&
    channelType !== "mpim"
  ) {
    throw new InvalidSourceReplyEventError(
      `unsupported Slack conversation type for Claude proxy: ${channelType || "missing"}`,
    );
  }
  return {
    provider: "slack",
    kind: "thread-reply",
    destination: `${team}:${channel}:${rootTs}`,
    payload: {
      channel,
      threadTs: rootTs,
      text,
    },
  };
}

export function normalizeSlackFinalReplyText(value: string): string {
  // Desktop renders these standalone control directives as UI actions rather
  // than answer text. Match that presentation at the provider boundary while
  // retaining the raw terminal message in Codex's read-only rollout.
  const lines = value.split(/\r?\n/).filter((line) => !CODEX_APP_DIRECTIVE.test(line.trim()));
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (isChatGptAttribution(lines.at(-1)?.trim() ?? "")) lines.pop();
  const normalized = lines.join("\n").trim();
  if (!normalized) throw new InvalidSourceReplyEventError("final response must not be empty");

  const characters = [...normalized];
  if (characters.length <= MAX_SLACK_FINAL_REPLY_CHARACTERS) return normalized;

  const suffix = "\n\n[Response truncated; the full result remains in Codex Desktop.]";
  const kept = MAX_SLACK_FINAL_REPLY_CHARACTERS - [...suffix].length;
  return `${characters.slice(0, kept).join("")}${suffix}`;
}

/** Claude proxy variant with a terminal-session-specific truncation notice. */
export function normalizeSlackClaudeProxyReplyText(value: string): string {
  const lines = value.split(/\r?\n/).filter((line) => !CODEX_APP_DIRECTIVE.test(line.trim()));
  while (lines.at(-1)?.trim() === "") lines.pop();
  const trailingLine = lines.at(-1)?.trim() ?? "";
  if (isChatGptAttribution(trailingLine) || isClaudeAttribution(trailingLine)) lines.pop();
  const normalized = lines.join("\n").trim();
  if (!normalized) throw new InvalidSourceReplyEventError("final response must not be empty");

  const characters = [...normalized];
  if (characters.length <= MAX_SLACK_FINAL_REPLY_CHARACTERS) return normalized;

  const suffix =
    "\n\n[Response truncated; the full result remains in the Claude terminal session.]";
  const kept = MAX_SLACK_FINAL_REPLY_CHARACTERS - [...suffix].length;
  return `${characters.slice(0, kept).join("")}${suffix}`;
}

export function normalizeGmailFinalReplyText(value: string): string {
  const lines = value.split(/\r?\n/).filter((line) => !CODEX_APP_DIRECTIVE.test(line.trim()));
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (isChatGptAttribution(lines.at(-1)?.trim() ?? "")) lines.pop();
  const normalized = lines.join("\n").trim();
  if (!normalized) throw new InvalidSourceReplyEventError("final response must not be empty");
  return normalized;
}

function slackFinalReply(event: WakeEvent, finalResponse: string): SourceReplySpec {
  const team = payloadString(event, "team");
  const channel = payloadString(event, "channel");
  const messageTs = payloadString(event, "ts");
  const rootTs = payloadString(event, "threadTs") || messageTs;
  if (!team || !channel || !messageTs || !rootTs) {
    throw new InvalidSourceReplyEventError(
      "Slack final reply requires payload.team, payload.channel, and payload.ts",
    );
  }
  if (
    event.conversation?.nativeKey !== `${team}:${channel}:${messageTs}` ||
    event.conversation.rootKey !== `${team}:${channel}:${rootTs}` ||
    event.conversation.replyTarget !== `${channel}:${messageTs}`
  ) {
    throw new InvalidSourceReplyEventError(
      "Slack final reply target does not match normalized conversation metadata",
    );
  }
  return {
    provider: "slack",
    kind: "thread-reply",
    destination: `${team}:${channel}:${rootTs}`,
    payload: {
      channel,
      threadTs: rootTs,
      text: normalizeSlackFinalReplyText(finalResponse),
    },
  };
}

function gmailFinalReply(event: WakeEvent, finalResponse: string): SourceReplySpec {
  const to = payloadString(event, "fromEmail");
  const messageId = payloadString(event, "rfcMessageId");
  const replyTarget = event.conversation?.replyTarget?.trim() ?? "";
  if (!to || !messageId || !replyTarget) {
    throw new InvalidSourceReplyEventError(
      "Gmail final reply requires payload.fromEmail, payload.rfcMessageId, and a reply target",
    );
  }
  if (
    event.conversation?.nativeKey !== messageId ||
    replyTarget !== messageId ||
    event.deliveryId.trim() !== messageId
  ) {
    throw new InvalidSourceReplyEventError(
      "Gmail final reply target does not match normalized conversation metadata",
    );
  }
  const rawSubject = payloadString(event, "subject") || "(no subject)";
  const subject = /^\s*re\s*:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
  const references = payloadStrings(event, "references");
  return {
    provider: "gmail",
    kind: "thread-reply",
    destination: messageId,
    payload: {
      originalMessageId: messageId,
      to,
      subject,
      text: normalizeGmailFinalReplyText(finalResponse),
      inReplyTo: messageId,
      references: [...new Set([...references, messageId])],
    },
  };
}

/** GitHub issue/PR comment ceiling is large; keep headroom under common UI limits. */
export const MAX_GITHUB_FINAL_REPLY_CHARACTERS = 60_000;

export function normalizeGithubFinalReplyText(value: string): string {
  const lines = value.split(/\r?\n/).filter((line) => !CODEX_APP_DIRECTIVE.test(line.trim()));
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (isChatGptAttribution(lines.at(-1)?.trim() ?? "")) lines.pop();
  const normalized = lines.join("\n").trim();
  if (!normalized) throw new InvalidSourceReplyEventError("final response must not be empty");
  const characters = [...normalized];
  if (characters.length <= MAX_GITHUB_FINAL_REPLY_CHARACTERS) return normalized;
  const suffix = "\n\n[Response truncated.]";
  const kept = MAX_GITHUB_FINAL_REPLY_CHARACTERS - [...suffix].length;
  return `${characters.slice(0, kept).join("")}${suffix}`;
}

/**
 * Post a top-level issue/PR comment on the originating GitHub item.
 * Eyes ack already landed on the triggering comment; the final answer is a
 * new issue comment (GitHub has no first-class "reply to comment" in REST for
 * ordinary issue comments).
 *
 * `pull_request.review_requested` is excluded: Chip posts the review via
 * `gh pr review` / GitHub API. Echoing finalResponse as an issue comment
 * duplicates that summary (incident: snapnhd/system#1108, also #1105).
 */
export function shouldSkipGithubIssueComment(event: WakeEvent): boolean {
  return event.source === "github" && event.kind.startsWith("pull_request.review_requested");
}

export function buildGithubReviewProgressReplySpec(
  event: WakeEvent,
  message: string,
): SourceReplySpec {
  if (event.source !== "github") {
    throw new InvalidSourceReplyEventError("review progress reply requires a GitHub event");
  }
  return githubIssueCommentReply(event, message);
}

function githubFinalReply(event: WakeEvent, finalResponse: string): SourceReplySpec {
  if (shouldSkipGithubIssueComment(event)) {
    throw new UnsupportedSourceReplyEventError(
      "GitHub review_requested: skip issue-comment; the agent posts the review",
    );
  }
  return githubIssueCommentReply(event, finalResponse);
}

function githubIssueCommentReply(event: WakeEvent, message: string): SourceReplySpec {
  const repo = payloadString(event, "repo");
  const number = payloadIdentifier(event, "number");
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new InvalidSourceReplyEventError(
      "GitHub final reply requires payload.repo as owner/name",
    );
  }
  if (!number) {
    throw new InvalidSourceReplyEventError(
      "GitHub final reply requires payload.number (issue or pull request)",
    );
  }
  return {
    provider: "github",
    kind: "issue-comment",
    destination: `${repo}:issue:${number}`,
    payload: {
      repo,
      number,
      text: normalizeGithubFinalReplyText(message),
    },
  };
}

function linearFinalReply(event: WakeEvent, finalResponse: string): SourceReplySpec {
  const issueId =
    payloadString(event, "issueId") ||
    (typeof event.conversation?.replyTarget === "string"
      ? event.conversation.replyTarget.trim()
      : "");
  if (!issueId) {
    throw new InvalidSourceReplyEventError("Linear final reply requires payload.issueId");
  }
  const text = normalizeGithubFinalReplyText(finalResponse);
  if (!text) {
    throw new InvalidSourceReplyEventError("final response is empty after normalization");
  }
  // Prefer the thread root: Linear rejects parentId when the mention is already a reply.
  const parentId = linearThreadParentId(event.payload);
  return {
    provider: "linear",
    kind: "issue-comment",
    destination: parentId ? `${issueId}:comment:${parentId}` : issueId,
    payload: {
      target: issueId,
      text,
      ...(parentId ? { parentId } : {}),
    },
  };
}

function payloadString(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadIdentifier(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return String(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return "";
}

function payloadStrings(event: WakeEvent, key: string): string[] {
  const value = event.payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isChatGptAttribution(line: string): boolean {
  const product = CHATGPT_ATTRIBUTION_PREFIX.exec(line)?.[1];
  if (!product) return false;
  return (
    CHATGPT_PRODUCT_NAME.test(product) ||
    CHATGPT_MARKDOWN_PROFILE_LINK.test(product) ||
    CHATGPT_SLACK_PROFILE_LINK.test(product) ||
    CHATGPT_SLACK_USER_MENTION.test(product)
  );
}

function isClaudeAttribution(line: string): boolean {
  const product = CHATGPT_ATTRIBUTION_PREFIX.exec(line)?.[1];
  return Boolean(product && CLAUDE_PRODUCT_NAME.test(product));
}
