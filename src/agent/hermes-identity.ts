import type { WakeEvent } from "../core/event.js";
import type { HermesSessionOptions } from "../sinks/types.js";
import { PermanentError } from "../sinks/types.js";

export type HermesPlatform = "github" | "linear";

export interface HermesSessionStamp {
  platform: HermesPlatform;
  /** Nested roles.yaml key: github login or linear email (no platform prefix). */
  userId: string;
  userName?: string | undefined;
  chatId?: string | undefined;
}

export interface PersonEmailLike {
  emails: readonly string[];
  identities?: readonly {
    provider: string;
    externalId: string;
    handle?: string | null | undefined;
    displayName?: string | null | undefined;
  }[];
  nickname?: string | undefined;
}

export interface HermesTargetRef {
  platform: HermesPlatform;
  /** e.g. snapnhd/system */
  repo?: string | undefined;
  /** PR/issue number */
  number?: string | undefined;
  /** Linear identifier e.g. FRA-2818 */
  linearIdentifier?: string | undefined;
  /** Optional short human title fragment */
  shortTitle?: string | undefined;
  workItemId?: string | undefined;
}

const MAX_TITLE = 100;

/**
 * Prefer Snapcorp addresses, else first enrolled email (lowercased).
 */
export function pickLinearEmail(emails: readonly string[]): string | null {
  const normalized = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return null;
  const snap = normalized.find((e) => e.endsWith("@snapcorp.com"));
  return snap ?? normalized[0] ?? null;
}

/**
 * Map an authorized Chip principal + person record to Hermes session stamps
 * for gateway-role-policy (platform + nested user id).
 */
export function hermesIdentityFromPrincipal(input: {
  event: WakeEvent;
  person: PersonEmailLike;
  workItemId?: string | undefined;
}): HermesSessionStamp {
  const principal = input.event.principal;
  const provider = principal?.provider ?? inferProvider(input.event);
  if (provider === "github") {
    const login = (
      principal?.handle ||
      input.person.identities?.find((i) => i.provider === "github")?.handle ||
      input.person.identities?.find((i) => i.provider === "github")?.externalId ||
      principal?.subjectId ||
      ""
    )
      .trim()
      .toLowerCase();
    if (!login) {
      throw new PermanentError("missing github login for Hermes session stamp");
    }
    return {
      platform: "github",
      userId: login,
      ...(principal?.displayName || input.person.nickname
        ? { userName: principal?.displayName ?? input.person.nickname }
        : {}),
      ...(input.workItemId ? { chatId: `workitem:${input.workItemId}` } : {}),
    };
  }
  if (provider === "linear") {
    const fromPrincipal = principal?.email?.trim().toLowerCase();
    const email =
      (fromPrincipal?.includes("@") ? fromPrincipal : null) || pickLinearEmail(input.person.emails);
    if (!email) {
      throw new PermanentError(
        "missing linear email for Hermes session stamp (enroll a person email alias)",
      );
    }
    return {
      platform: "linear",
      userId: email,
      ...(principal?.displayName || input.person.nickname
        ? { userName: principal?.displayName ?? input.person.nickname }
        : {}),
      ...(input.workItemId ? { chatId: `workitem:${input.workItemId}` } : {}),
    };
  }
  throw new PermanentError(
    `Hermes sink only stamps github|linear principals (got ${provider ?? "unknown"})`,
  );
}

/** Extract stable GH/Linear target fields from a WakeEvent + optional Linear issue. */
export function hermesTargetFromEvent(
  event: WakeEvent,
  opts?: {
    workItemId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearTitle?: string | undefined;
  },
): HermesTargetRef {
  const platform = (event.principal?.provider ?? inferProvider(event)) as
    | HermesPlatform
    | undefined;
  if (platform === "github") {
    const repo = normalizePart(stringPayload(event, "repo"));
    const number = scalarPayload(event, "number");
    const shortTitle = normalizePart(stringPayload(event, "title"));
    const linearIdentifier = normalizePart(opts?.linearIdentifier ?? "");
    return {
      platform: "github",
      ...(repo ? { repo } : {}),
      ...(number ? { number } : {}),
      ...(shortTitle ? { shortTitle } : {}),
      ...(linearIdentifier ? { linearIdentifier } : {}),
      ...(opts?.workItemId ? { workItemId: opts.workItemId } : {}),
    };
  }
  const linearIdentifier = normalizePart(
    opts?.linearIdentifier ?? stringPayload(event, "identifier"),
  );
  const shortTitle = normalizePart(opts?.linearTitle ?? stringPayload(event, "title"));
  return {
    platform: "linear",
    ...(linearIdentifier ? { linearIdentifier } : {}),
    ...(shortTitle ? { shortTitle } : {}),
    ...(opts?.workItemId ? { workItemId: opts.workItemId } : {}),
  };
}

/**
 * Stable session_key / chat id for one open PR/issue WorkItem.
 * Examples: wakewire:github:snapnhd/system#997 , wakewire:linear:FRA-2818
 */
export function buildHermesSessionKey(target: HermesTargetRef): string {
  if (target.platform === "github") {
    const item =
      target.repo && target.number
        ? `${target.repo}#${target.number}`
        : target.repo || (target.number ? `#${target.number}` : "");
    if (item) return `wakewire:github:${item}`;
  } else if (target.linearIdentifier) {
    return `wakewire:linear:${target.linearIdentifier}`;
  }
  if (target.workItemId) return `wakewire:${target.platform}:workitem:${target.workItemId}`;
  return `wakewire:${target.platform}:unknown`;
}

/**
 * Desktop-facing title (≤100 chars, unique-friendly).
 * GitHub: snapnhd/system#997 or snapnhd/system#997 · short
 * Linear: FRA-2818 · short
 */
export function buildHermesDesktopTitle(target: HermesTargetRef, fallbackTitle?: string): string {
  if (target.platform === "github") {
    const item =
      target.repo && target.number
        ? `${target.repo}#${target.number}`
        : target.repo || (target.number ? `#${target.number}` : "GitHub");
    const detail = clipDetail(target.shortTitle || fallbackTitle || "");
    return clipTitle(detail ? `${item} · ${detail}` : item);
  }
  const id = target.linearIdentifier || "Linear";
  const detail = clipDetail(target.shortTitle || fallbackTitle || "");
  return clipTitle(detail ? `${id} · ${detail}` : id);
}

/**
 * Full Hermes DeliveryOptions.hermesSession stamp: policy identity + desktop presentation.
 */
export function buildHermesSessionOptions(input: {
  event: WakeEvent;
  person: PersonEmailLike;
  workItemId?: string | undefined;
  workItemTitle?: string | undefined;
  linearIdentifier?: string | undefined;
  linearTitle?: string | undefined;
}): HermesSessionOptions {
  const stamp = hermesIdentityFromPrincipal({
    event: input.event,
    person: input.person,
    workItemId: input.workItemId,
  });
  const target = hermesTargetFromEvent(input.event, {
    workItemId: input.workItemId,
    linearIdentifier: input.linearIdentifier,
    linearTitle: input.linearTitle,
  });
  // Prefer stable target keys over opaque workitem:uuid when we have repo#n / FRA-id.
  const sessionKey = buildHermesSessionKey(target);
  const chatId = sessionKey.endsWith(":unknown") && stamp.chatId ? stamp.chatId : sessionKey;
  const sessionTitle = buildHermesDesktopTitle(target, input.workItemTitle);
  const displayName = stamp.userName || stamp.userId;
  return {
    platform: stamp.platform,
    userId: stamp.userId,
    chatId,
    sessionKey,
    sessionTitle,
    displayName,
    ...(stamp.userName ? { userName: stamp.userName } : {}),
  };
}

function inferProvider(event: WakeEvent): string | undefined {
  if (event.principal?.provider) return event.principal.provider;
  if (event.source === "github") return "github";
  // Linear arrives via signed webhook source in this fork.
  if (event.source === "webhook" && typeof event.payload.type === "string") {
    return "linear";
  }
  return undefined;
}

function stringPayload(event: WakeEvent, key: string): string {
  return typeof event.payload[key] === "string" ? event.payload[key] : "";
}

function scalarPayload(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "string") return normalizePart(value);
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function normalizePart(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function clipDetail(value: string): string {
  const n = normalizePart(value);
  if (!n) return "";
  // Drop redundant service prefixes from WorkItem titles when used as fallback.
  const stripped = n
    .replace(/^GitHub\s+(?:PR|Issue)\s+/iu, "")
    .replace(/^Linear\s+/iu, "")
    .replace(/^[^—]+—\s*/u, (m) => (m.includes("#") || /^[A-Z]+-\d+/u.test(m) ? "" : m))
    .replace(/^[A-Za-z0-9_.-]+#\d+\s*[·—-]\s*/u, "")
    .replace(/^[A-Z]+-\d+\s*[·—-]\s*/iu, "")
    .trim();
  const use = stripped || n;
  const pts = [...use];
  return pts.length > 48 ? `${pts.slice(0, 47).join("").trimEnd()}…` : use;
}

function clipTitle(value: string): string {
  const n = normalizePart(value) || "Chip";
  const pts = [...n];
  return pts.length > MAX_TITLE
    ? `${pts
        .slice(0, MAX_TITLE - 1)
        .join("")
        .trimEnd()}…`
    : n;
}
