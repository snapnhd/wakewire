import { convert } from "html-to-text";
import type { ParsedMail } from "mailparser";
import type { WakeEvent } from "../../core/event.js";

const BODY_LIMIT = 4_000;

/**
 * Reduce a parsed email to the fields prompts need. Plain text is preferred;
 * HTML is converted with html-to-text (never regex-stripped). Body is
 * truncated to 4,000 chars.
 */
export function emailToWakeEvent(args: {
  mail: ParsedMail;
  label: string;
  fallbackId: string;
  mailbox?: string | undefined;
  sourceId?: string | undefined;
}): WakeEvent {
  const { mail, label, fallbackId, mailbox, sourceId } = args;
  const from = mail.from?.text ?? "unknown";
  const fromEmail = firstAddress(mail.from)?.toLowerCase();
  const to = addressText(mail.to);
  const recipients = [...addresses(mail.to), ...addresses(mail.cc)].map((address) =>
    address.toLowerCase(),
  );
  const subject = mail.subject ?? "(no subject)";
  const date = (mail.date ?? new Date()).toISOString();
  const body = extractBody(mail);
  const authoredBody = extractAuthoredBody(body);
  const handleMentions = extractAtHandles(authoredBody);
  const rfcMessageId = mail.messageId?.trim() || undefined;
  // IMAP always gives us a synthetic delivery identity for durable dedup, but
  // only a real RFC Message-ID can be searched and replied to through Gmail.
  const deliveryId = rfcMessageId ?? fallbackId;
  const references = Array.isArray(mail.references)
    ? mail.references
    : mail.references
      ? [mail.references]
      : [];
  const authentication = gmailAuthentication(mail, fromEmail);
  const rootMessageId = references[0] ?? mail.inReplyTo ?? deliveryId;
  return {
    source: "gmail",
    ...(sourceId ? { sourceId } : {}),
    kind: "email",
    deliveryId,
    occurredAt: date,
    summary: `Email from ${from}: ${subject}`,
    payload: {
      label,
      from,
      ...(fromEmail ? { fromEmail } : {}),
      to,
      subject,
      date,
      body,
      authoredBody,
      ...(rfcMessageId ? { rfcMessageId } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
      ...(mail.replyTo ? { replyTo: addressText(mail.replyTo) } : {}),
      authenticationResults: authentication.results,
      authenticated: authentication.authenticated,
    },
    ...(fromEmail && mailbox
      ? {
          principal: {
            provider: "gmail" as const,
            tenantId: mailbox.toLowerCase(),
            subjectId: fromEmail,
            email: fromEmail,
            ...(mail.from?.value[0]?.name ? { displayName: mail.from.value[0].name } : {}),
          },
        }
      : {}),
    conversation: {
      nativeKey: deliveryId,
      rootKey: rootMessageId,
      replyTarget: deliveryId,
    },
    ...(recipients.length > 0 || handleMentions.length > 0
      ? {
          targetMentions: [
            ...recipients.map((value) => ({ kind: "email" as const, value })),
            ...handleMentions.map((value) => ({ kind: "handle" as const, value })),
          ],
        }
      : {}),
  };
}

export function extractBody(mail: Pick<ParsedMail, "text" | "html">): string {
  const text =
    mail.text && mail.text.trim().length > 0
      ? mail.text
      : typeof mail.html === "string"
        ? convert(mail.html, {
            wordwrap: false,
            selectors: [
              { selector: "a", options: { ignoreHref: false } },
              { selector: "img", format: "skip" },
            ],
          })
        : "";
  return truncate(text.trim(), BODY_LIMIT);
}

/**
 * Keep only the newly authored portion of a message. Email clients include old
 * messages in text/plain bodies, so quoted history must not be able to supply a
 * stale @chip command for a later unmentioned reply.
 */
export function extractAuthoredBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (isQuotedHistoryBoundary(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Exact email-style @handles from the current authored text, never addresses. */
export function extractAtHandles(body: string): string[] {
  const handles = new Set<string>();
  const pattern = /(?:^|[\s([{'"“‘])@([\p{L}\p{N}](?:[\p{L}\p{N}_-]{0,63}))/giu;
  for (const match of body.matchAll(pattern)) {
    const handle = match[1]?.toLocaleLowerCase("en-US");
    if (!handle) continue;
    const nextIndex = (match.index ?? 0) + match[0].length;
    const next = body[nextIndex] ?? "";
    // Reject address/domain/path continuations such as @chip@example.com,
    // @chip.example, and @chip/away. Normal sentence punctuation remains valid.
    if (
      next === "@" ||
      next === "/" ||
      (next === "." && /[\p{L}\p{N}]/u.test(body[nextIndex + 1] ?? ""))
    ) {
      continue;
    }
    handles.add(handle);
  }
  return [...handles];
}

function isQuotedHistoryBoundary(line: string): boolean {
  return (
    /^\s*>/.test(line) ||
    /^\s*On\s+.+\s+wrote:\s*$/iu.test(line) ||
    /^\s*-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}\s*$/iu.test(line) ||
    /^\s*Begin forwarded message:\s*$/iu.test(line) ||
    /^\s*--\s*$/.test(line) ||
    /^\s*Sent from my\b/iu.test(line)
  );
}

function addressText(to: ParsedMail["to"]): string {
  if (!to) return "";
  if (Array.isArray(to)) return to.map((a) => a.text).join(", ");
  return to.text;
}

function addresses(value: ParsedMail["to"] | ParsedMail["cc"]): string[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((object) =>
    object.value
      .map((entry) => entry.address)
      .filter((address): address is string => typeof address === "string" && address.length > 0),
  );
}

function firstAddress(value: ParsedMail["from"]): string | undefined {
  return value?.value.find((entry) => entry.address)?.address;
}

/**
 * Authorize only from Gmail's topmost Authentication-Results verdict. A
 * sender can add arbitrary lower headers, so accepting "any dmarc=pass"
 * would let a forged header turn an untrusted From address into a principal.
 */
function gmailAuthentication(
  mail: ParsedMail,
  fromEmail: string | undefined,
): { results: string; authenticated: boolean } {
  const lines = mail.headerLines
    .filter((header) => header.key.toLowerCase() === "authentication-results")
    .map((header) => header.line.replace(/^[^:]+:\s*/i, "").replace(/\r?\n[\t ]+/g, " "));
  const results = lines.join("\n");
  const trusted = lines[0] ?? "";
  const fromDomain = emailDomain(fromEmail);
  const evaluatedDomain = /\bheader\.from=(?:"([^"]+)"|([^\s;]+))/i.exec(trusted);
  const headerFrom = (evaluatedDomain?.[1] ?? evaluatedDomain?.[2] ?? "").trim().toLowerCase();
  return {
    results,
    authenticated:
      Boolean(fromDomain) &&
      /^mx\.google\.com\s*;/i.test(trusted) &&
      /\bdmarc=pass\b/i.test(trusted) &&
      headerFrom === fromDomain,
  };
}

function emailDomain(email: string | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at >= 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : "";
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}
