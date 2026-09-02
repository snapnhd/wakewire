import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { HermesTargetRef } from "./hermes-identity.js";

/** GitHub PR and/or Linear ticket that should share one Hermes session. */
export interface HermesWorkRef {
  githubRepo?: string | undefined;
  githubNumber?: string | undefined;
  linearIdentifier?: string | undefined;
}

export interface HermesSessionHit {
  id: string;
  source: string;
  title: string | null;
  sessionKey: string | null;
  chatId: string | null;
  endedAt: number | null;
  startedAt: number;
  /** True only when the session's original user turn identifies this PR/ticket. */
  firstUserMatchesRef?: boolean | undefined;
  /** True only when that original turn asks to start or recover a PR review. */
  firstUserRequestsReview?: boolean | undefined;
}

export type HermesReuseDecision =
  | { action: "create" }
  | { action: "resume"; sessionId: string }
  | { action: "supersede"; sessionId: string }
  | { action: "ignore"; sessionId: string; reason: "running" }
  | { action: "hold"; sessionId: string; reason: "running" };

export interface HermesSessionLookup {
  hits: HermesSessionHit[];
  runningIds: ReadonlySet<string>;
  cmdlineBusy: boolean;
}

const LINEAR_ID = /^[A-Z][A-Z0-9]*-\d+$/u;
const GITHUB_NUMBER = /^\d+$/u;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function workRefFromTarget(target: HermesTargetRef): HermesWorkRef {
  const githubRepo = normalizeRepo(target.repo);
  const githubNumber = normalizeNumber(target.number);
  const linearIdentifier = normalizeLinear(target.linearIdentifier);
  return {
    ...(githubRepo ? { githubRepo } : {}),
    ...(githubNumber ? { githubNumber } : {}),
    ...(linearIdentifier ? { linearIdentifier } : {}),
  };
}

export function workRefIsEmpty(ref: HermesWorkRef): boolean {
  return !ref.githubRepo && !ref.githubNumber && !ref.linearIdentifier;
}

export function sessionKeysForRef(ref: HermesWorkRef): string[] {
  const keys: string[] = [];
  if (ref.githubRepo && ref.githubNumber) {
    keys.push(`wakewire:github:${ref.githubRepo}#${ref.githubNumber}`);
  }
  if (ref.linearIdentifier) {
    keys.push(`wakewire:linear:${ref.linearIdentifier}`);
  }
  return keys;
}

/** Title/body/cmdline needles that uniquely identify this PR or ticket. */
export function workRefNeedles(ref: HermesWorkRef): string[] {
  const needles: string[] = [];
  if (ref.githubRepo && ref.githubNumber) {
    needles.push(`${ref.githubRepo}#${ref.githubNumber}`);
    needles.push(`${ref.githubRepo}/pull/${ref.githubNumber}`);
  }
  if (ref.linearIdentifier) needles.push(ref.linearIdentifier);
  return needles;
}

/** True when session_key/chatId already names a different GitHub PR or Linear ticket. */
export function sessionIdentityConflictsWithRef(
  identity: { sessionKey?: string | null | undefined; chatId?: string | null | undefined },
  ref: HermesWorkRef,
): boolean {
  const keys = new Set(sessionKeysForRef(ref));
  for (const value of [identity.sessionKey, identity.chatId]) {
    const token = value?.trim();
    if (!token) continue;
    if (
      (token.startsWith("wakewire:github:") || token.startsWith("wakewire:linear:")) &&
      !keys.has(token)
    ) {
      return true;
    }
  }
  return false;
}

export function sessionTextMatchesRef(text: string, ref: HermesWorkRef): boolean {
  const t = text.normalize("NFKC");
  if (ref.githubRepo && ref.githubNumber) {
    const repo = escapeRegExp(ref.githubRepo);
    const n = escapeRegExp(ref.githubNumber);
    if (new RegExp(`${repo}#${n}(?:\\b|$)`, "iu").test(t)) return true;
    if (new RegExp(`${repo}/pull/${n}(?:\\b|$)`, "iu").test(t)) return true;
    if (
      new RegExp(repo, "iu").test(t) &&
      (new RegExp(`(?:^|\\s)pr\\s*#${n}(?:\\b|$)`, "iu").test(t) ||
        new RegExp(`(?:^|\\s)#${n}(?:\\b|$)`, "iu").test(t))
    ) {
      return true;
    }
  }
  if (ref.linearIdentifier) {
    const id = escapeRegExp(ref.linearIdentifier);
    if (new RegExp(`(?:^|[^A-Z0-9-])${id}(?:$|[^A-Z0-9-])`, "iu").test(t)) return true;
  }
  return false;
}

export function decideHermesSessionReuse(input: {
  ref: HermesWorkRef;
  boundSessionId?: string | null;
  /** session_key of the bound Hermes row, when known. */
  boundSessionKey?: string | null;
  /** chat_id of the bound Hermes row, when known. */
  boundChatId?: string | null;
  hits: readonly HermesSessionHit[];
  runningIds: ReadonlySet<string>;
  cmdlineBusy: boolean;
  /** GitHub review_requested (and re-request). Other events hold instead of ignore. */
  reviewRequest?: boolean | undefined;
  /** The incoming review targets a different HEAD than the running frozen request. */
  headMoved?: boolean | undefined;
}): HermesReuseDecision {
  const boundConflicts = sessionIdentityConflictsWithRef(
    { sessionKey: input.boundSessionKey, chatId: input.boundChatId },
    input.ref,
  );
  const bound = boundConflicts ? "" : input.boundSessionId?.trim() || "";
  const runningBound = bound && input.runningIds.has(bound);
  const runningHit = input.hits.find((h) => input.runningIds.has(h.id));
  const busy = Boolean(runningBound || runningHit || input.cmdlineBusy);
  const busyId = runningBound ? bound : runningHit?.id || "unbound-running";

  if (busy) {
    if (input.reviewRequest && input.headMoved) {
      return { action: "supersede", sessionId: busyId };
    }
    if (input.reviewRequest) {
      return { action: "ignore", sessionId: busyId, reason: "running" };
    }
    return { action: "hold", sessionId: busyId, reason: "running" };
  }

  const preferred = [...input.hits].sort((a, b) => {
    const aReview = a.firstUserRequestsReview === true ? 1 : 0;
    const bReview = b.firstUserRequestsReview === true ? 1 : 0;
    if (aReview !== bReview) return bReview - aReview;
    const aDedicated = a.firstUserMatchesRef === true ? 1 : 0;
    const bDedicated = b.firstUserMatchesRef === true ? 1 : 0;
    if (aDedicated !== bDedicated) return bDedicated - aDedicated;
    const aOpen = a.endedAt == null ? 1 : 0;
    const bOpen = b.endedAt == null ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    // Oldest open session wins. A crash can mint a newer empty duplicate
    // (#1110 session #2); the first session holds the in-progress review.
    return a.startedAt - b.startedAt;
  })[0];
  const boundHit = bound ? input.hits.find((candidate) => candidate.id === bound) : undefined;
  if (
    (preferred?.firstUserRequestsReview === true && boundHit?.firstUserRequestsReview !== true) ||
    (preferred?.firstUserMatchesRef === true && boundHit?.firstUserMatchesRef !== true)
  ) {
    return { action: "resume", sessionId: preferred.id };
  }
  if (bound) return { action: "resume", sessionId: bound };
  if (preferred) return { action: "resume", sessionId: preferred.id };
  return { action: "create" };
}

export function sessionIdsRunningInProcessList(
  psArgs: string,
  sessionIds: readonly string[],
  needles: readonly string[],
): { runningIds: Set<string>; cmdlineBusy: boolean } {
  const runningIds = new Set<string>();
  let cmdlineBusy = false;
  const lines = psArgs.split("\n");
  for (const line of lines) {
    if (!/hermes|hermes_sink_runner/i.test(line)) continue;
    for (const id of sessionIds) {
      if (id && line.includes(id)) runningIds.add(id);
    }
    if (needles.some((n) => n && line.includes(n))) cmdlineBusy = true;
  }
  return { runningIds, cmdlineBusy };
}

function normalizeRepo(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && GITHUB_REPO.test(v) ? v : undefined;
}

function normalizeNumber(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && GITHUB_NUMBER.test(v) ? v : undefined;
}

function normalizeLinear(value: string | undefined): string | undefined {
  const v = value?.trim().toUpperCase();
  return v && LINEAR_ID.test(v) ? v : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const LOOKUP_WINDOW_SECONDS = 90 * 24 * 60 * 60;
const LOOKUP_LIMIT = 300;

/**
 * Read-only scan of Hermes state.db + `ps` for a matching live/idle session.
 * Fail-open: missing DB or ps errors look like "no session".
 */
export function defaultHermesSessionLookup(
  ref: HermesWorkRef,
  options: { dbPath?: string; nowSeconds?: number; psArgs?: string } = {},
): HermesSessionLookup {
  if (workRefIsEmpty(ref)) {
    return { hits: [], runningIds: new Set(), cmdlineBusy: false };
  }
  const dbPath = options.dbPath ?? hermesStateDbPath();
  let hits: HermesSessionHit[] = [];
  try {
    hits = queryHermesWorkSessions(dbPath, ref, options.nowSeconds);
  } catch {
    hits = [];
  }
  let psArgs = options.psArgs;
  if (psArgs === undefined) {
    try {
      psArgs = execFileSync("ps", ["-ax", "-o", "args="], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 2_000_000,
      });
    } catch {
      psArgs = "";
    }
  }
  const { runningIds, cmdlineBusy } = sessionIdsRunningInProcessList(
    psArgs,
    hits.map((h) => h.id),
    workRefNeedles(ref),
  );
  return { hits, runningIds, cmdlineBusy };
}

export function hermesStateDbPath(): string {
  const home = process.env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
  return path.join(home, "state.db");
}

/** Read session_key/chat_id for a bound Hermes session. Missing DB/row is null. */
export function loadHermesSessionIdentity(
  sessionId: string,
  options: { dbPath?: string } = {},
): { sessionKey: string | null; chatId: string | null } | null {
  const id = sessionId.trim();
  if (!id) return null;
  const dbPath = options.dbPath ?? hermesStateDbPath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(`SELECT session_key AS sessionKey, chat_id AS chatId FROM sessions WHERE id = ?`)
        .get(id) as { sessionKey: string | null; chatId: string | null } | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function sessionIdsWithMatchingUserMessages(
  db: InstanceType<typeof Database>,
  rows: readonly { id: string }[],
  ref: HermesWorkRef,
): string[] {
  const needles = workRefNeedles(ref)
    .map((needle) => needle.replace(/[%_\\]/gu, ""))
    .filter(Boolean);
  if (needles.length === 0 || rows.length === 0) return [];
  try {
    const idPlaceholders = rows.map(() => "?").join(",");
    const likeClauses = needles.map(() => "m.content LIKE ?").join(" OR ");
    const found = db
      .prepare(
        `SELECT DISTINCT m.session_id AS id
           FROM messages m
          WHERE m.role = 'user'
            AND COALESCE(m.active, 1) = 1
            AND m.session_id IN (${idPlaceholders})
            AND (${likeClauses})`,
      )
      .all(...rows.map((row) => row.id), ...needles.map((needle) => `%${needle}%`)) as Array<{
      id: string;
    }>;
    return found.map((row) => row.id);
  } catch {
    return [];
  }
}

interface FirstUserEvidence {
  matchesRef: Set<string>;
  requestsReview: Set<string>;
}

function firstUserRequestsReview(text: string, ref: HermesWorkRef): boolean {
  if (!sessionTextMatchesRef(text, ref)) return false;
  const normalized = text.normalize("NFKC").replace(/pr-workflow/giu, "");
  return (
    /\bpull_request\.review_requested\b/iu.test(normalized) ||
    /^\s*(?:review|rereview|re-review)\b/iu.test(normalized) ||
    /^\s*recover\b[\s\S]{0,200}\b(?:review|rereview|re-review)\b/iu.test(normalized) ||
    /@chip(?:byte-snap)?\b[\s\S]{0,80}\b(?:review|rereview|re-review)\b/iu.test(normalized) ||
    /\b(?:please|can you|could you|would you)\b[\s\S]{0,80}\b(?:review|rereview|re-review)\b/iu.test(
      normalized,
    )
  );
}

function firstUserEvidence(
  db: InstanceType<typeof Database>,
  rows: readonly { id: string }[],
  ref: HermesWorkRef,
): FirstUserEvidence {
  const empty = (): FirstUserEvidence => ({ matchesRef: new Set(), requestsReview: new Set() });
  if (rows.length === 0) return empty();
  try {
    const placeholders = rows.map(() => "?").join(",");
    const first = db
      .prepare(
        `SELECT m.session_id AS id, m.content
           FROM messages m
          WHERE m.role = 'user'
            AND COALESCE(m.active, 1) = 1
            AND m.session_id IN (${placeholders})
            AND NOT EXISTS (
              SELECT 1
                FROM messages earlier
               WHERE earlier.session_id = m.session_id
                 AND earlier.role = 'user'
                 AND COALESCE(earlier.active, 1) = 1
                 AND (earlier.timestamp < m.timestamp OR
                      (earlier.timestamp = m.timestamp AND earlier.id < m.id))
            )`,
      )
      .all(...rows.map((row) => row.id)) as Array<{ id: string; content: string | null }>;
    const evidence = empty();
    for (const row of first) {
      if (!row.content || !sessionTextMatchesRef(row.content, ref)) continue;
      evidence.matchesRef.add(row.id);
      if (firstUserRequestsReview(row.content, ref)) evidence.requestsReview.add(row.id);
    }
    return evidence;
  } catch {
    return empty();
  }
}

function queryHermesWorkSessions(
  dbPath: string,
  ref: HermesWorkRef,
  nowSeconds = Date.now() / 1000,
): HermesSessionHit[] {
  if (!fs.existsSync(dbPath)) return [];
  const keys = new Set(sessionKeysForRef(ref));
  const cutoff = nowSeconds - LOOKUP_WINDOW_SECONDS;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, source, title, session_key AS sessionKey, chat_id AS chatId,
                ended_at AS endedAt, started_at AS startedAt
           FROM sessions
          WHERE COALESCE(archived, 0) = 0
            AND started_at > ?
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(cutoff, LOOKUP_LIMIT) as Array<{
      id: string;
      source: string;
      title: string | null;
      sessionKey: string | null;
      chatId: string | null;
      endedAt: number | null;
      startedAt: number;
    }>;
    const firstUser = firstUserEvidence(db, rows, ref);
    const candidates = rows.map((row) => ({
      ...row,
      firstUserMatchesRef: firstUser.matchesRef.has(row.id),
      firstUserRequestsReview: firstUser.requestsReview.has(row.id),
    }));
    const matched = new Map<string, HermesSessionHit>();
    const conflicted = new Set<string>();
    for (const row of candidates) {
      if (row.sessionKey && keys.has(row.sessionKey)) {
        matched.set(row.id, row);
        continue;
      }
      if (row.chatId && keys.has(row.chatId)) {
        matched.set(row.id, row);
        continue;
      }
      if (sessionIdentityConflictsWithRef(row, ref)) {
        conflicted.add(row.id);
        continue;
      }
      if (row.title && sessionTextMatchesRef(row.title, ref)) {
        matched.set(row.id, row);
      }
    }
    // Mid-turn crash can leave session_key/title unset (wrapper title). Scan
    // user messages for repo#N / FRA-id so reboot resume still finds the PR.
    // Do not steal a session already keyed to a different PR/ticket.
    const unmatched = candidates.filter((row) => !matched.has(row.id) && !conflicted.has(row.id));
    if (unmatched.length > 0) {
      for (const id of sessionIdsWithMatchingUserMessages(db, unmatched, ref)) {
        const row = unmatched.find((candidate) => candidate.id === id);
        if (row) matched.set(row.id, row);
      }
    }
    return [...matched.values()];
  } finally {
    db.close();
  }
}
