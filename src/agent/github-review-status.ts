import type { WakeEvent } from "../core/event.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { GithubReviewStatus } from "./coordinator.js";
import {
  SNAP_REVIEW_PROJECTS,
  type SnapReviewProject,
  type SuiteState,
} from "./snap-review-preflight.js";
import { DEFAULT_CHIP_IDENTITIES } from "./targeting.js";

const STATUS_MARKER = "<!-- chip-review-status -->";
const STATUS_END_MARKER = "<!-- /chip-review-status -->";
const STATUS_UPDATED_PREFIX = "<!-- chip-review-status-updated:";
const LINKS_MARKER = "<!-- chip-workspace-links -->";
const LINKS_END_MARKER = "<!-- /chip-workspace-links -->";
const MAX_COMMENT_PAGES = 10;
const MAX_REVIEW_PAGES = 10;
const GITHUB_PAGE_SIZE = 100;
const CHIP_GITHUB_LOGIN = DEFAULT_CHIP_IDENTITIES.githubHandle;
const LEGACY_CHIP_STATUS_COMMENT = `${STATUS_MARKER}
### 🔎 Chip review

\`[█░░░░░░░░░]\` 👀 picked up — reading the ticket

👀 pickup → 🎫 ticket → 🧵 threads → 📝 diff → 💬 comments → 🧪 checks → ✅ done`;

export function githubReviewHeadMovePickupUpdate(event: WakeEvent, updatedAt: string) {
  const headSha = event.payload.headSha;
  if (
    event.kind !== "pull_request.synchronize" ||
    typeof headSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(headSha)
  ) {
    return null;
  }
  return {
    expectedHeadSha: headSha,
    status: { phase: "pickup" as const, updatedAt, headSha },
  };
}

export type GithubReviewStatusPhase =
  | "pickup"
  | "workspace-starting"
  | "workspace-ready"
  | "workspace-failed"
  | "ticket"
  | "threads"
  | "tests-running"
  | "tests-passed"
  | "tests-failed"
  | "specialists-incomplete"
  | "specialists-waiting"
  | "review-incomplete"
  | "diff"
  | "comments"
  | "checks"
  | "waiting"
  | "approved"
  | "done";

export type GithubReviewTestState = SuiteState | "pending" | "running";

export interface GithubReviewStatusUpdate {
  phase: GithubReviewStatusPhase;
  updatedAt: string;
  detail?: string | undefined;
  headSha?: string | undefined;
  tests?: Partial<Record<SnapReviewProject, GithubReviewTestState>> | undefined;
}

export interface GithubWorkspaceLinks {
  app: string;
  data: string;
  snapcorp: string;
}

export interface GithubReviewBodyUpdate {
  status: GithubReviewStatusUpdate;
  links?: GithubWorkspaceLinks | null | undefined;
  expectedHeadSha?: string | undefined;
}

export class GithubReviewBodyError extends Error {}

export function renderGithubReviewBody(body: string, update: GithubReviewBodyUpdate): string {
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const statusBlock = ownedBlock(body, STATUS_MARKER, STATUS_END_MARKER, "review status");
  const linksBlock = ownedBlock(body, LINKS_MARKER, LINKS_END_MARKER, "workspace links");
  if (
    statusBlock &&
    linksBlock &&
    statusBlock.start < linksBlock.end &&
    linksBlock.start < statusBlock.end
  ) {
    throw new GithubReviewBodyError("marker-owned PR body blocks overlap");
  }
  const ranges = [statusBlock, linksBlock]
    .filter((block): block is OwnedBlock => Boolean(block))
    .sort((a, b) => a.start - b.start);
  const remainderParts: string[] = [];
  let cursor = 0;
  for (const block of ranges) {
    remainderParts.push(body.slice(cursor, block.start));
    const canonicalSeparator = `${newline}${newline}`;
    cursor = body.startsWith(canonicalSeparator, block.end)
      ? block.end + canonicalSeparator.length
      : block.end;
  }
  remainderParts.push(body.slice(cursor));
  const remainder = remainderParts.join("");

  const links =
    update.links === undefined
      ? linksBlock?.raw
      : update.links === null
        ? undefined
        : renderWorkspaceLinks(update.links, newline);
  const status = renderStatusBlock(update.status, newline);
  const owned = [links, status].filter((block): block is string => Boolean(block));
  const prefix = owned.join(`${newline}${newline}`);
  return remainder ? `${prefix}${newline}${newline}${remainder}` : prefix;
}

interface OwnedBlock {
  start: number;
  end: number;
  raw: string;
}

function ownedBlock(
  body: string,
  startMarker: string,
  endMarker: string,
  label: string,
): OwnedBlock | null {
  const starts = markerMatches(body, startMarker);
  const ends = markerMatches(body, endMarker);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    throw new GithubReviewBodyError(`${label} markers must be unique and paired`);
  }
  const start = starts[0]?.index ?? -1;
  const end = (ends[0]?.index ?? -1) + (ends[0]?.text.length ?? 0);
  if (start < 0 || end <= start || (ends[0]?.index ?? -1) < start) {
    throw new GithubReviewBodyError(`${label} marker order is malformed`);
  }
  return { start, end, raw: body.slice(start, end) };
}

function markerMatches(body: string, marker: string): Array<{ index: number; text: string }> {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...body.matchAll(new RegExp(`^${escaped}\\r?$`, "gmu"))].map((match) => ({
    index: match.index,
    text: match[0],
  }));
}

function renderWorkspaceLinks(links: GithubWorkspaceLinks, newline: string): string {
  const app = new URL(links.app);
  const match = app.hostname.match(/^([a-z][a-z0-9]*-[0-9]+)\.ws\.chipbyte\.dev$/u);
  const ticket = match?.[1];
  if (
    !ticket ||
    links.app !== `https://${ticket}.ws.chipbyte.dev` ||
    links.data !== `https://data-${ticket}.ws.chipbyte.dev` ||
    links.snapcorp !== `https://snapcorp-${ticket}.ws.chipbyte.dev`
  ) {
    throw new GithubReviewBodyError("workspace links do not match one exact ticket");
  }
  return [
    LINKS_MARKER,
    "### Workspace",
    "",
    `- [App](${links.app})`,
    `- [Data](${links.data})`,
    `- [Snapcorp](${links.snapcorp})`,
    LINKS_END_MARKER,
  ].join(newline);
}

function renderStatusBlock(update: GithubReviewStatusUpdate, newline: string): string {
  const phase = statusPhase(update.phase);
  const updated = new Date(update.updatedAt);
  if (Number.isNaN(updated.getTime()) || updated.toISOString() !== update.updatedAt) {
    throw new GithubReviewBodyError("review status update time must be canonical ISO-8601");
  }
  if (update.headSha && !/^[0-9a-f]{40}$/u.test(update.headSha)) {
    throw new GithubReviewBodyError("review status HEAD must be one exact full SHA");
  }
  const detail = update.detail?.replace(/\s+/gu, " ").trim().slice(0, 200);
  const headline = detail ? `${phase.headline} — ${detail}` : phase.headline;
  const bar = `${"█".repeat(phase.progress)}${"░".repeat(10 - phase.progress)}`;
  const stages = [
    "👀 pickup",
    "🧰 workspace",
    "🎫 ticket",
    "🧵 threads",
    "🧪 local tests",
    "📝 diff",
    "💬 comments",
    "✅ GitHub checks",
    "🏁 done",
  ].map((stage, index) => (index === phase.stage ? `**${stage}**` : stage));
  const lines = [
    STATUS_MARKER,
    "### 🔎 PR Status",
    "",
    `\`[${bar}]\` ${headline}`,
    "",
    stages.join(" → "),
  ];
  if (update.tests) {
    lines.push("", renderTestStates(update.tests));
  }
  if (update.headSha) lines.push("", `HEAD: \`${update.headSha}\``);
  lines.push("", `${STATUS_UPDATED_PREFIX} ${update.updatedAt} -->`, STATUS_END_MARKER);
  return lines.join(newline);
}

function renderTestStates(tests: NonNullable<GithubReviewStatusUpdate["tests"]>): string {
  const emoji: Record<GithubReviewTestState, string> = {
    pending: "⏳",
    running: "⏳",
    passed: "✅",
    "test-failed": "❌",
    "lint-failed": "❌",
    missing: "❓",
  };
  return `Tests: ${SNAP_REVIEW_PROJECTS.map((project) => {
    const state = tests[project] ?? "pending";
    const marker = emoji[state];
    if (!marker) throw new GithubReviewBodyError(`invalid ${project} test state`);
    return `${project} ${marker}`;
  }).join(" · ")}`;
}

interface GithubReviewPhaseDetails {
  progress: number;
  stage: number;
  headline: string;
}

const GITHUB_REVIEW_PHASES: Record<GithubReviewStatusPhase, GithubReviewPhaseDetails> = {
  pickup: { progress: 1, stage: 0, headline: "👀 picked up" },
  "workspace-starting": { progress: 2, stage: 1, headline: "🧰 workspace starting" },
  "workspace-ready": { progress: 2, stage: 1, headline: "🧰 workspace ready" },
  "workspace-failed": { progress: 2, stage: 1, headline: "⏸️ workspace failed" },
  ticket: { progress: 3, stage: 2, headline: "🎫 ticket read" },
  threads: { progress: 4, stage: 3, headline: "🧵 checking open threads" },
  "tests-running": { progress: 5, stage: 4, headline: "🧪 local tests running" },
  "tests-passed": { progress: 5, stage: 4, headline: "🧪 local tests passed" },
  "tests-failed": { progress: 5, stage: 4, headline: "⏸️ local tests failed" },
  "specialists-incomplete": {
    progress: 7,
    stage: 6,
    headline: "⏳ specialist verification incomplete",
  },
  "specialists-waiting": {
    progress: 7,
    stage: 6,
    headline: "⏳ specialist verdict needs follow-up",
  },
  "review-incomplete": {
    progress: 8,
    stage: 7,
    headline: "⏳ GitHub review artifact missing",
  },
  diff: { progress: 6, stage: 5, headline: "📝 reviewing the diff" },
  comments: { progress: 7, stage: 6, headline: "💬 posting inline comments" },
  checks: { progress: 8, stage: 7, headline: "✅ checking GitHub status" },
  waiting: { progress: 10, stage: 8, headline: "⏳ waiting on the author" },
  approved: { progress: 10, stage: 8, headline: "✅ approved" },
  done: { progress: 10, stage: 8, headline: "🏁 done" },
};

function statusPhase(phase: GithubReviewStatusPhase): GithubReviewPhaseDetails {
  return GITHUB_REVIEW_PHASES[phase];
}

interface GithubIssueComment {
  id?: number | undefined;
  body?: string | undefined;
  html_url?: string | undefined;
  updated_at?: string | undefined;
  created_at?: string | undefined;
  user?: { login?: string | undefined } | undefined;
}

interface GithubPullRequest {
  body?: string | null | undefined;
  head?: { sha?: string | undefined } | undefined;
}

interface GithubPullRequestReview {
  commit_id: string;
  submitted_at: string;
  state: string;
  user: { login: string };
}

function isGithubPullRequestReview(value: unknown): value is GithubPullRequestReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  const user = review.user;
  return (
    typeof review.commit_id === "string" &&
    typeof review.submitted_at === "string" &&
    typeof review.state === "string" &&
    Boolean(user) &&
    typeof user === "object" &&
    !Array.isArray(user) &&
    typeof (user as Record<string, unknown>).login === "string"
  );
}

export interface GithubReviewArtifactExpectation {
  since: string;
  expectedHeadSha: string;
  allowedStates: readonly ("APPROVED" | "CHANGES_REQUESTED" | "COMMENTED")[];
}

export function extractGithubReviewStatus(body: string): string | null {
  let block: OwnedBlock | null;
  try {
    block = ownedBlock(body, STATUS_MARKER, STATUS_END_MARKER, "review status");
  } catch {
    return null;
  }
  if (!block) return null;
  const headlines = block.raw
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .match(/^`\[[█░]+\]`\s+(.+)$/u)?.[1]
        ?.trim(),
    )
    .filter((headline): headline is string => Boolean(headline));
  if (headlines.length !== 1) return null;
  const headline = headlines[0] ?? "";
  return Object.values(GITHUB_REVIEW_PHASES).some((phase) => phase.headline === headline)
    ? headline
    : null;
}

export function createGithubReviewStatusLookup(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
}): (event: WakeEvent, signal?: AbortSignal) => Promise<GithubReviewStatus | null> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  return async (event, signal) => {
    const context = githubReviewContext(event, args.secrets);
    if (!context) return null;
    const pull = await getPullRequest(fetchImpl, context, signal);
    if (!pull) return null;
    const summary = extractGithubReviewStatus(pull.body ?? "");
    return summary
      ? {
          summary,
          url: canonicalPullRequestUrl(context),
        }
      : null;
  };
}

export function createGithubReviewStatusUpdate(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
}): (
  event: WakeEvent,
  update: GithubReviewBodyUpdate,
  signal?: AbortSignal,
) => Promise<GithubReviewStatus | null> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  return async (event, update, signal) => {
    const context = githubReviewContext(event, args.secrets);
    if (context?.repo !== "snapnhd/system") return null;
    const pull = await getPullRequest(fetchImpl, context, signal);
    if (!pull) return null;
    if (!pullMatchesExpectedHead(pull, update.expectedHeadSha, update.status.headSha)) return null;
    const comments = await listIssueComments(fetchImpl, context, signal);
    const legacy = comments ? latestChipStatus(comments) : null;
    const body = pull.body ?? "";
    const effectiveUpdate =
      !body.includes(STATUS_MARKER) && legacy?.summary && !update.status.detail
        ? { ...update, status: { ...update.status, detail: legacy.summary } }
        : update;
    let rendered: string;
    try {
      rendered = renderGithubReviewBody(body, effectiveUpdate);
    } catch (error) {
      if (error instanceof GithubReviewBodyError) return null;
      throw error;
    }
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `https://api.github.com/repos/${context.repo}/pulls/${context.number}`,
      {
        method: "PATCH",
        ...(signal ? { signal } : {}),
        headers: githubHeaders(context.token, true),
        body: JSON.stringify({ body: rendered }),
      },
    );
    if (!response.ok) return null;
    const verified = await getPullRequest(fetchImpl, context, signal);
    if (
      !verified ||
      (verified.body ?? "") !== rendered ||
      !pullMatchesExpectedHead(verified, update.expectedHeadSha, update.status.headSha)
    ) {
      return null;
    }
    if (comments && !(await deleteLegacyStatusComments(fetchImpl, context, comments, signal))) {
      return null;
    }
    return {
      summary: extractGithubReviewStatus(rendered) ?? "review in progress",
      url: canonicalPullRequestUrl(context),
    };
  };
}

export function createGithubReviewStatusEnsure(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}): (event: WakeEvent, signal?: AbortSignal) => Promise<GithubReviewStatus | null> {
  const update = createGithubReviewStatusUpdate(args);
  const now = args.now ?? (() => new Date());
  return (event, signal) =>
    update(event, { status: { phase: "pickup", updatedAt: now().toISOString() } }, signal);
}

export function createGithubReviewArtifactLookup(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
}): (
  event: WakeEvent,
  expectation: GithubReviewArtifactExpectation,
  signal?: AbortSignal,
) => Promise<boolean> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const retryDelayMs = args.retryDelayMs ?? 1_000;
  return async (event, expectation, signal) => {
    const context = githubReviewContext(event, args.secrets);
    const sinceMs = Date.parse(expectation.since);
    if (
      !context ||
      Number.isNaN(sinceMs) ||
      !/^[0-9a-f]{40}$/u.test(expectation.expectedHeadSha) ||
      expectation.allowedStates.length === 0
    ) {
      return false;
    }
    const { repo, number, token } = context;

    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const reviews = await githubReviewPages(
        fetchImpl,
        `https://api.github.com/repos/${repo}/pulls/${number}/reviews`,
        token,
        signal,
      );
      const pull = await getPullRequest(fetchImpl, context, signal);
      if (!pull) throw new Error("GitHub PR HEAD evidence is unavailable");
      if (canonicalHeadSha(pull) !== expectation.expectedHeadSha) return false;
      const matchingReviews = reviews.filter(
        (review) =>
          review.user.login === CHIP_GITHUB_LOGIN &&
          timestampValue(review.submitted_at) > sinceMs &&
          review.commit_id === expectation.expectedHeadSha,
      );
      const hasProhibitedApproval =
        !expectation.allowedStates.includes("APPROVED") &&
        matchingReviews.some((review) => review.state === "APPROVED");
      const hasReview =
        expectation.allowedStates.length === 1 && expectation.allowedStates[0] === "COMMENTED"
          ? !hasProhibitedApproval &&
            matchingReviews.length === 1 &&
            matchingReviews[0]?.state === "COMMENTED"
          : !hasProhibitedApproval &&
            matchingReviews.some((review) =>
              expectation.allowedStates.includes(
                review.state as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED",
              ),
            );
      if (hasReview) return true;
      if (attempt < 2 && retryDelayMs > 0) await abortableDelay(retryDelayMs, signal);
    }
    return false;
  };
}

async function getPullRequest(
  fetchImpl: typeof globalThis.fetch,
  context: GithubReviewContext,
  signal?: AbortSignal,
): Promise<GithubPullRequest | null> {
  signal?.throwIfAborted();
  const response = await fetchImpl(
    `https://api.github.com/repos/${context.repo}/pulls/${context.number}`,
    {
      ...(signal ? { signal } : {}),
      headers: githubHeaders(context.token),
    },
  );
  if (!response.ok) return null;
  const value = (await response.json()) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "body")
  ) {
    return null;
  }
  const pull = value as Record<string, unknown>;
  if (pull.body !== null && typeof pull.body !== "string") return null;
  if (
    pull.head !== undefined &&
    (!pull.head || typeof pull.head !== "object" || Array.isArray(pull.head))
  ) {
    return null;
  }
  return value as GithubPullRequest;
}

function githubHeaders(token: string, json = false): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
    "x-github-api-version": "2022-11-28",
  };
}

async function deleteLegacyStatusComments(
  fetchImpl: typeof globalThis.fetch,
  context: GithubReviewContext,
  comments: GithubIssueComment[],
  signal?: AbortSignal,
): Promise<boolean> {
  for (const comment of comments) {
    if (
      comment.user?.login !== CHIP_GITHUB_LOGIN ||
      !isLegacyChipStatusComment(comment.body) ||
      !Number.isSafeInteger(comment.id) ||
      Number(comment.id) <= 0
    ) {
      continue;
    }
    signal?.throwIfAborted();
    const endpoint = `https://api.github.com/repos/${context.repo}/issues/comments/${comment.id}`;
    const currentResponse = await fetchImpl(endpoint, {
      ...(signal ? { signal } : {}),
      headers: githubHeaders(context.token),
    });
    if (!currentResponse.ok) return false;
    const current = (await currentResponse.json()) as GithubIssueComment;
    if (
      current.id !== comment.id ||
      current.user?.login !== CHIP_GITHUB_LOGIN ||
      !isLegacyChipStatusComment(current.body)
    ) {
      return false;
    }
    signal?.throwIfAborted();
    const deleted = await fetchImpl(endpoint, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
      headers: githubHeaders(context.token),
    });
    if (!deleted.ok && deleted.status !== 404) return false;
    signal?.throwIfAborted();
    const verified = await fetchImpl(endpoint, {
      ...(signal ? { signal } : {}),
      headers: githubHeaders(context.token),
    });
    if (verified.status !== 404) return false;
  }
  return true;
}

async function githubReviewPages(
  fetchImpl: typeof globalThis.fetch,
  endpoint: string,
  token: string,
  signal?: AbortSignal,
): Promise<GithubPullRequestReview[]> {
  const values: GithubPullRequestReview[] = [];
  for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
    signal?.throwIfAborted();
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetchImpl(
      `${endpoint}${separator}per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      {
        ...(signal ? { signal } : {}),
        headers: githubHeaders(token),
      },
    );
    if (!response.ok) throw new Error(`GitHub evidence request failed with ${response.status}`);
    const pageValues = (await response.json()) as unknown;
    if (!Array.isArray(pageValues)) throw new Error("GitHub evidence response is not an array");
    if (!pageValues.every(isGithubPullRequestReview)) {
      throw new Error("GitHub review evidence contains a malformed entry");
    }
    values.push(...pageValues);
    if (pageValues.length < GITHUB_PAGE_SIZE) return values;
    if (page === MAX_REVIEW_PAGES) {
      throw new Error("GitHub evidence pagination exceeded the safe bound");
    }
  }
  return values;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function latestChipStatus(comments: GithubIssueComment[]): GithubReviewStatus | null {
  const status = comments
    .filter(
      (comment) =>
        comment.user?.login === CHIP_GITHUB_LOGIN && isLegacyChipStatusComment(comment.body),
    )
    .sort((a, b) => timestamp(b) - timestamp(a))[0];
  if (!status?.body) return null;
  return {
    summary: extractGithubReviewStatus(status.body) ?? "review in progress",
    ...(status.html_url ? { url: status.html_url } : {}),
  };
}

function isLegacyChipStatusComment(body?: string): boolean {
  if (!body) return false;
  const normalized = body.replace(/\r\n/gu, "\n");
  return (
    normalized === LEGACY_CHIP_STATUS_COMMENT || normalized === `${LEGACY_CHIP_STATUS_COMMENT}\n`
  );
}

async function listIssueComments(
  fetchImpl: typeof globalThis.fetch,
  context: GithubReviewContext,
  signal?: AbortSignal,
): Promise<GithubIssueComment[] | null> {
  const values: GithubIssueComment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `https://api.github.com/repos/${context.repo}/issues/${context.number}/comments?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      {
        ...(signal ? { signal } : {}),
        headers: githubHeaders(context.token),
      },
    );
    if (!response.ok) return null;
    const pageValues = (await response.json()) as GithubIssueComment[];
    values.push(...pageValues);
    if (pageValues.length < GITHUB_PAGE_SIZE) break;
  }
  return values;
}

interface GithubReviewContext {
  repo: string;
  number: string;
  token: string;
}

function canonicalHeadSha(pull: GithubPullRequest): string | undefined {
  const sha = pull.head?.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
}

function pullMatchesExpectedHead(
  pull: GithubPullRequest,
  expectedHeadSha: string | undefined,
  renderedHeadSha: string | undefined,
): boolean {
  if (expectedHeadSha === undefined) return true;
  return (
    /^[0-9a-f]{40}$/u.test(expectedHeadSha) &&
    renderedHeadSha === expectedHeadSha &&
    canonicalHeadSha(pull) === expectedHeadSha
  );
}

function canonicalPullRequestUrl(context: GithubReviewContext): string {
  return `https://github.com/${context.repo}/pull/${context.number}`;
}

function githubReviewContext(event: WakeEvent, secrets: SecretStore): GithubReviewContext | null {
  if (event.source !== "github") return null;
  const repo = event.payload.repo;
  const number = payloadIdentifier(event, "number");
  const sourceId = event.sourceId?.trim();
  if (
    typeof repo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) ||
    !number ||
    !sourceId
  ) {
    return null;
  }
  const token = secrets.get(secretNames.githubApiToken(sourceId));
  if (!token) return null;
  return { repo, number, token };
}

function timestampValue(value?: string): number {
  return Date.parse(value ?? "") || 0;
}

function timestamp(comment: GithubIssueComment): number {
  return Date.parse(comment.updated_at || comment.created_at || "") || 0;
}

function payloadIdentifier(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return "";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? value : "";
}
