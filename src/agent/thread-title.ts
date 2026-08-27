import type { WakeEvent } from "../core/event.js";
import type { Person } from "../people/schema.js";
import type { ResolvedLinearIssue } from "./correlation.js";

const MAX_TITLE_CODE_POINTS = 60;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export type ThreadTitlePerson = string | Pick<Person, "nickname">;

/** One-time/idempotent upgrade for titles stored before service labels were required. */
export function providerAwareStoredTitle(kind: string, title: string): string {
  const normalized = normalizePart(title);
  switch (kind) {
    case "slack": {
      const separator = normalized.indexOf(" — ");
      const detail = separator >= 0 ? normalized.slice(separator + 3) : normalized;
      return finalize(joinTitle("Slack", shortenRequest(detail)));
    }
    case "gmail": {
      const separator = normalized.indexOf(" — ");
      const detail = separator >= 0 ? normalized.slice(separator + 3) : normalized;
      return finalize(joinTitle("Email", stripMailPrefixes(detail)));
    }
    case "github":
      return /^GitHub(?:\s+|\s*—)/u.test(normalized)
        ? finalize(normalized)
        : finalize(`GitHub ${normalized || "Request"}`);
    case "linear":
      return /^Linear(?:\s+|\s*—)/u.test(normalized)
        ? finalize(normalized)
        : finalize(`Linear ${normalized || "Request"}`);
    default:
      return finalize(normalized);
  }
}

/**
 * Build a short, deterministic display title without using the safety-wrapped
 * prompt. Titles are presentation-only: callers must never use them for
 * authorization, correlation, or workspace selection.
 */
export function buildWorkItemTitle(
  event: WakeEvent,
  _person: ThreadTitlePerson,
  linearIssue?: ResolvedLinearIssue,
): string {
  const linearIdentifier = normalizePart(
    linearIssue?.identifier ?? (isLinearEvent(event) ? stringPayload(event, "identifier") : ""),
  );
  if (linearIdentifier) {
    const issueTitle = normalizePart(linearIssue?.title ?? stringPayload(event, "title"));
    const request =
      isLinearEvent(event) && !isLinearAssignment(event) ? authoredRequestDescription(event) : "";
    return finalize(joinTitle(`Linear ${linearIdentifier}`, request || issueTitle));
  }

  if (event.source === "github") return githubTitle(event);
  if (event.source === "gmail") return gmailTitle(event);
  if (event.source === "slack") return slackTitle(event);

  const service = serviceLabel(event);
  return finalize(joinTitle(service, requestDescription(event) || "Request"));
}

function githubTitle(event: WakeEvent): string {
  const itemKind =
    event.payload.isPullRequest === true || event.kind.startsWith("pull_request") ? "PR" : "Issue";
  const repo = normalizePart(stringPayload(event, "repo"));
  const number = scalarPayload(event, "number");
  const item = repo && number ? `${repo}#${number}` : repo || (number ? `#${number}` : "");
  const prefix = item ? `GitHub ${itemKind} ${item}` : `GitHub ${itemKind}`;
  const request = event.kind.includes("comment") ? requestDescription(event) : "";
  return finalize(joinTitle(prefix, request || normalizePart(stringPayload(event, "title"))));
}

function gmailTitle(event: WakeEvent): string {
  const subject = stripMailPrefixes(normalizePart(stringPayload(event, "subject")));
  const fallback = firstMeaningfulLine(
    stringPayload(event, "text") || stringPayload(event, "body"),
  );
  return finalize(joinTitle("Email", subject || shortenRequest(fallback) || "(no subject)"));
}

function slackTitle(event: WakeEvent): string {
  return finalize(joinTitle("Slack", requestDescription(event) || "Request"));
}

function requestDescription(event: WakeEvent): string {
  return shortenRequest(stripLeadingChipMentions(requestSnippet(event), event));
}

function authoredRequestDescription(event: WakeEvent): string {
  const request = normalizePart(
    stringPayload(event, "text") ||
      stringPayload(event, "body") ||
      stringPayload(event, "comment") ||
      stringPayload(event, "description"),
  );
  return shortenRequest(stripLeadingChipMentions(request, event));
}

function requestSnippet(event: WakeEvent): string {
  return normalizePart(
    stringPayload(event, "text") ||
      stringPayload(event, "body") ||
      stringPayload(event, "comment") ||
      stringPayload(event, "description") ||
      event.summary,
  );
}

function stripLeadingChipMentions(value: string, event: WakeEvent): string {
  const slackIds = new Set<string>();
  const recipient = stringPayload(event, "recipientUser");
  if (recipient) slackIds.add(recipient);
  for (const mention of event.targetMentions ?? []) {
    if (mention.kind === "slack-user" || mention.kind === "direct-message") {
      slackIds.add(mention.value);
    }
  }

  const encodedIds = [...slackIds].map((id) => `<@${escapeRegExp(id)}(?:\\|[^>]+)?>`);
  const mentions = [
    ...encodedIds,
    "@chip\\s+byte(?=\\s|[,:;.!?\\-—]|$)",
    "@chipbyte-snap(?=\\s|[,:;.!?\\-—]|$)",
    "@chip(?=\\s|[,:;.!?\\-—]|$)",
  ];
  const leading = new RegExp(`^(?:(?:${mentions.join("|")})\\s*(?:[,:;.!?\\-—]+\\s*)?)+`, "iu");
  return normalizePart(value.replace(leading, ""));
}

function joinTitle(prefix: string, detail: string): string {
  return detail ? `${prefix} — ${detail}` : prefix;
}

function shortenRequest(value: string): string {
  let shortened = normalizePart(value);
  const prefixes = [
    /^(?:hey|hi|hello)\s+(?:chip(?:\s+byte)?[,.:;!?-]*\s+)?/iu,
    /^(?:can|could|would|will)\s+you\s+/iu,
    /^would\s+you\s+mind\s+/iu,
    /^please\s+/iu,
    /^i\s+(?:need|want)\s+(?:you\s+)?to\s+/iu,
    /^i(?:'d|\s+would)\s+like\s+(?:you\s+)?to\s+/iu,
    /^help\s+me(?:\s+to)?\s+/iu,
    /^(?:give|send|show|tell)\s+me\s+(?:the\s+)?/iu,
  ];
  while (shortened) {
    const previous = shortened;
    for (const prefix of prefixes) shortened = shortened.replace(prefix, "");
    shortened = normalizePart(shortened);
    if (shortened === previous) break;
  }
  return shortened;
}

function stripMailPrefixes(value: string): string {
  let subject = value;
  while (/^(?:re|fw|fwd)\s*:\s*/iu.test(subject)) {
    subject = subject.replace(/^(?:re|fw|fwd)\s*:\s*/iu, "");
  }
  return normalizePart(subject);
}

function firstMeaningfulLine(value: string): string {
  return value.split(/\r?\n/u).map(normalizePart).find(Boolean) ?? "";
}

function finalize(value: string): string {
  const normalized = normalizePart(value) || "Request";
  const codePoints = [...normalized];
  if (codePoints.length <= MAX_TITLE_CODE_POINTS) return normalized;
  return `${codePoints
    .slice(0, MAX_TITLE_CODE_POINTS - 1)
    .join("")
    .trimEnd()}…`;
}

function normalizePart(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stringPayload(event: WakeEvent, key: string): string {
  return typeof event.payload[key] === "string" ? event.payload[key] : "";
}

function scalarPayload(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "string") return normalizePart(value);
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function isLinearEvent(event: WakeEvent): boolean {
  return (
    event.principal?.provider === "linear" ||
    (event.source === "webhook" && stringPayload(event, "provider").toLowerCase() === "linear")
  );
}

function isLinearAssignment(event: WakeEvent): boolean {
  return (
    stringPayload(event, "linearTrigger") === "assignment" ||
    stringPayload(event, "agentTrigger") === "delegation"
  );
}

function serviceLabel(event: WakeEvent): string {
  const provider = event.source === "webhook" ? stringPayload(event, "provider") : event.source;
  switch (provider.toLowerCase()) {
    case "gmail":
      return "Email";
    case "github":
      return "GitHub";
    case "linear":
      return "Linear";
    case "slack":
      return "Slack";
    default:
      return normalizePart(provider) || "Request";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
