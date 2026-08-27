export type ClaudeProxyAdapterMode = "print" | "rc-tmux";

export interface ClaudeProxyDirective {
  matched: true;
  prompt: string;
  adapterMode: ClaudeProxyAdapterMode;
}

export interface CodexOverrideDirective {
  matched: true;
  /** Ordinary dispatch keeps the authenticated request text byte-for-byte. */
  requestText: string;
}

export interface DispatcherDefaultDirective {
  matched: true;
  defaultAgent: "codex" | "claude-rc";
}

const CLAUDE_PROXY_EXIT =
  /^(?:\/claude\s+(?:end|stop)|back\s+to\s+chip|stop\s+(?:the\s+)?claude\s+proxy)[.!]?$/iu;

const POLITE_AT_START =
  /^(?:please|(?:can|could|would|will)\s+you(?:\s+please)?)(?=\s|[,;:!\u2013\u2014-]|$)\s*(?:[,;:!\u2013\u2014-]\s*)?/iu;
const CLAUDE_RC_TMUX_COLON_AT_START = /^claude\s+(?:rc(?:\s+tmux)?|tmux)\s*:/iu;
const RC_IMPERATIVE_AT_START =
  /^(?:run\s+(?:this\s+)?(?:on|in)\s+claude\s+(?:rc(?:\s+tmux)?|tmux)|(?:use|ask)\s+claude\s+(?:rc(?:\s+tmux)?|tmux)\s+to|send\s+this\s+to\s+claude\s+(?:rc(?:\s+tmux)?|tmux))(?=$|\s|[:;,?\u2013\u2014-])/iu;
const CLAUDE_COLON_AT_START = /^claude\s*:/iu;
const IMPERATIVE_AT_START =
  /^(?:run\s+(?:this\s+)?(?:on|in)\s+claude|(?:use|ask)\s+claude\s+to|send\s+this\s+to\s+claude)(?=$|\s|[:;,?\u2013\u2014-])/iu;
const CODEX_OVERRIDE_COLON_AT_START = /^(?:codex|gpt)\s*:/iu;
const CODEX_OVERRIDE_IMPERATIVE_AT_START =
  /^(?:run\s+(?:this\s+)?(?:on|in)\s+(?:codex|gpt)|(?:use|ask)\s+(?:codex|gpt)\s+to|send\s+this\s+to\s+(?:codex|gpt))(?=$|\s|[:;,?\u2013\u2014-])/iu;
const DISPATCHER_DEFAULT_PATTERNS = [
  /^set\s+(?:the\s+)?default(?:\s+agent)?\s+to\s+(.+?)\s*[?!.]?\s*$/iu,
  /^make\s+(.+?)\s+(?:the\s+)?default\s*[?!.]?\s*$/iu,
  /^use\s+(.+?)\s+by\s+default\s*[?!.]?\s*$/iu,
] as const;
const CLAUDE_DEFAULT_ALIAS = /^claude(?:\s+(?:rc(?:\s+tmux)?|tmux))?$/iu;
const CODEX_DEFAULT_ALIAS = /^(?:codex|gpt)(?:\s+desktop)?$/iu;
const PROMPT_DELIMITER_AT_START = /^(?:\s*[:;,]\s*|\s*[\u2013\u2014]\s*|\s+-\s+|\s+)/u;
const EMPTY_PROMPT = /^(?:[?!.;,:\u2013\u2014-]+|please[?!.]*|thanks?[?!.]*|thank\s+you[?!.]*)$/iu;

/**
 * Parse the small, operator-owned Claude proxy grammar from authenticated
 * current-request text. This is intentionally anchored so quoted examples or
 * incidental mentions cannot switch an existing conversation into proxy mode.
 */
export function parseClaudeProxyDirective(
  requestText: string,
  slackUserId?: string,
): ClaudeProxyDirective | null {
  const remainder = hostCommandRemainder(requestText, slackUserId);

  // RC is an explicit opt-in layered over the legacy print grammar. Match it
  // first so "run on Claude RC" cannot degrade into a print prompt of "RC".
  const claudeRcColon = remainder.match(CLAUDE_RC_TMUX_COLON_AT_START);
  if (claudeRcColon) {
    return resultForPrompt(remainder.slice(claudeRcColon[0].length), "rc-tmux");
  }

  const rcImperative = remainder.match(RC_IMPERATIVE_AT_START);
  if (rcImperative) {
    const afterCommand = remainder.slice(rcImperative[0].length);
    const delimiter = afterCommand.match(PROMPT_DELIMITER_AT_START);
    if (!delimiter) return null;
    return resultForPrompt(afterCommand.slice(delimiter[0].length), "rc-tmux");
  }

  const claudeColon = remainder.match(CLAUDE_COLON_AT_START);
  if (claudeColon) {
    return resultForPrompt(remainder.slice(claudeColon[0].length), "print");
  }

  const imperative = remainder.match(IMPERATIVE_AT_START);
  if (!imperative) return null;

  const afterCommand = remainder.slice(imperative[0].length);
  const delimiter = afterCommand.match(PROMPT_DELIMITER_AT_START);
  if (!delimiter) return null;

  return resultForPrompt(afterCommand.slice(delimiter[0].length), "print");
}

/**
 * Detect a one-message override back to the ordinary Codex dispatcher. The
 * parsed prefix is used only for routing; the dispatcher receives the original
 * authenticated request text rather than a rewritten prompt.
 */
export function parseCodexOverrideDirective(
  requestText: string,
  slackUserId?: string,
): CodexOverrideDirective | null {
  const remainder = hostCommandRemainder(requestText, slackUserId);
  const colon = remainder.match(CODEX_OVERRIDE_COLON_AT_START);
  if (colon) {
    if (!normalizedPrompt(remainder.slice(colon[0].length))) return null;
    return { matched: true, requestText };
  }

  const imperative = remainder.match(CODEX_OVERRIDE_IMPERATIVE_AT_START);
  if (!imperative) return null;

  const afterCommand = remainder.slice(imperative[0].length);
  const delimiter = afterCommand.match(PROMPT_DELIMITER_AT_START);
  if (!delimiter) return null;
  if (!normalizedPrompt(afterCommand.slice(delimiter[0].length))) return null;
  return { matched: true, requestText };
}

/** Parse an exact host-owned command that changes the default for new Slack conversations. */
export function parseDispatcherDefaultDirective(
  requestText: string,
  slackUserId?: string,
): DispatcherDefaultDirective | null {
  const recipient = slackUserId?.trim();
  if (!recipient) return null;
  const pinnedMention = new RegExp(
    `^\\s*<@${escapeRegExp(recipient)}(?:\\|[^>\\r\\n]+)?>(?=\\s|[,;:!\\u2013\\u2014-]|$)`,
    "iu",
  );
  if (!pinnedMention.test(requestText)) return null;
  const remainder = hostCommandRemainder(requestText, slackUserId);
  for (const pattern of DISPATCHER_DEFAULT_PATTERNS) {
    const match = remainder.match(pattern);
    const alias = match?.[1]
      ?.trim()
      .replace(/[?!.]+$/u, "")
      .trim();
    if (!alias) continue;
    if (CLAUDE_DEFAULT_ALIAS.test(alias)) {
      return { matched: true, defaultAgent: "claude-rc" };
    }
    if (CODEX_DEFAULT_ALIAS.test(alias)) {
      return { matched: true, defaultAgent: "codex" };
    }
  }
  return null;
}

/**
 * Exact host-owned escape hatch for an active proxy. A leading immutable Slack
 * mention is transport addressing and may be omitted inside an already-bound
 * thread; no other surrounding prose is accepted.
 */
export function isClaudeProxyExitDirective(requestText: string, slackUserId?: string): boolean {
  let command = requestText.trim();
  const recipient = slackUserId?.trim();
  if (recipient) {
    const escaped = escapeRegExp(recipient);
    command = command
      .replace(
        new RegExp(`^<@${escaped}(?:\\|[^>\\r\\n]+)?>\\s*(?:[,;:!\\u2013\\u2014-]\\s*)?`, "iu"),
        "",
      )
      .trim();
  }
  return CLAUDE_PROXY_EXIT.test(command);
}

function resultForPrompt(
  value: string,
  adapterMode: ClaudeProxyAdapterMode,
): ClaudeProxyDirective | null {
  const prompt = normalizedPrompt(value);
  if (!prompt) return null;
  return { matched: true, prompt, adapterMode };
}

function normalizedPrompt(value: string): string | null {
  const prompt = value.trim();
  return prompt && !EMPTY_PROMPT.test(prompt) ? prompt : null;
}

function hostCommandRemainder(requestText: string, slackUserId?: string): string {
  let remainder = requestText.trimStart();
  let consumedAddress = false;
  let consumedPolitePrefix = false;

  // Address and politeness may appear in either order, but each can be consumed
  // only once so arbitrary prose cannot be skipped in search of a later trigger.
  for (let index = 0; index < 2; index += 1) {
    if (!consumedAddress) {
      const address = remainder.match(addressAtStart(slackUserId));
      if (address) {
        remainder = remainder.slice(address[0].length);
        consumedAddress = true;
        continue;
      }
    }

    if (!consumedPolitePrefix) {
      const polite = remainder.match(POLITE_AT_START);
      if (polite) {
        remainder = remainder.slice(polite[0].length);
        consumedPolitePrefix = true;
        continue;
      }
    }

    break;
  }
  return remainder;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addressAtStart(slackUserId?: string): RegExp {
  const recipient = slackUserId?.trim();
  const slackAddress = recipient
    ? `<@${escapeRegExp(recipient)}(?:\\|[^>\\r\\n]+)?>`
    : "<@[A-Z0-9]+(?:\\|[^>\\r\\n]+)?>";
  return new RegExp(
    `^(?:(?:hey|hi|hello)\\s*,?\\s+)?(?:@?chip(?:\\s+byte)?|${slackAddress})(?=\\s|[,;:!\\u2013\\u2014-]|$)\\s*(?:[,;:!\\u2013\\u2014-]\\s*)?`,
    "iu",
  );
}
