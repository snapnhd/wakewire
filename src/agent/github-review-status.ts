import type { WakeEvent } from "../core/event.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { GithubReviewStatus } from "./coordinator.js";

const STATUS_MARKER = "<!-- chip-review-status -->";
const MAX_COMMENT_PAGES = 10;

export const CHIP_REVIEW_STATUS_PICKUP_BODY = `${STATUS_MARKER}
### 🔎 Chip review

\`[█░░░░░░░░░]\` 👀 picked up — reading the ticket

👀 pickup → 🎫 ticket → 🧵 threads → 📝 diff → 💬 comments → 🧪 checks → ✅ done
`;

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

interface GithubIssueComment {
  body?: string | undefined;
  html_url?: string | undefined;
  updated_at?: string | undefined;
  created_at?: string | undefined;
  user?: { login?: string | undefined } | undefined;
}

interface GithubPullRequestReview {
  submitted_at?: string | undefined;
  state?: string | undefined;
  user?: { login?: string | undefined } | undefined;
}

export function extractGithubReviewStatus(body: string): string | null {
  if (!body.includes(STATUS_MARKER)) return null;
  for (const line of body.split(/\r?\n/u)) {
    const match = line.trim().match(/^`\[[█░]+\]`\s+(.+)$/u);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

export function createGithubReviewStatusLookup(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
}): (event: WakeEvent, signal?: AbortSignal) => Promise<GithubReviewStatus | null> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  return async (event, signal) => {
    const context = githubReviewContext(event, args.secrets);
    if (!context) return null;
    const comments = await listIssueComments(fetchImpl, context, signal);
    return comments ? latestChipStatus(comments) : null;
  };
}

export function createGithubReviewStatusEnsure(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
}): (event: WakeEvent, signal?: AbortSignal) => Promise<GithubReviewStatus | null> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  return async (event, signal) => {
    const context = githubReviewContext(event, args.secrets);
    if (!context) return null;
    const comments = await listIssueComments(fetchImpl, context, signal);
    if (!comments) return null;
    const existing = latestChipStatus(comments);
    if (existing) return existing;
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `https://api.github.com/repos/${context.repo}/issues/${context.number}/comments`,
      {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${context.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body: CHIP_REVIEW_STATUS_PICKUP_BODY }),
      },
    );
    if (!response.ok) return null;
    const created = (await response.json()) as GithubIssueComment;
    return {
      summary: extractGithubReviewStatus(CHIP_REVIEW_STATUS_PICKUP_BODY) ?? "review in progress",
      ...(typeof created.html_url === "string" && created.html_url
        ? { url: created.html_url }
        : {}),
    };
  };
}

export function createGithubReviewArtifactLookup(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
}): (event: WakeEvent, since: string, signal?: AbortSignal) => Promise<boolean> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const retryDelayMs = args.retryDelayMs ?? 1_000;
  return async (event, since, signal) => {
    if (event.source !== "github") return false;
    const repo = payloadString(event, "repo");
    const number = payloadIdentifier(event, "number");
    const sourceId = event.sourceId?.trim();
    const sinceMs = Date.parse(since);
    if (!repo || !/^[^/]+\/[^/]+$/u.test(repo) || !number || !sourceId || Number.isNaN(sinceMs)) {
      return false;
    }
    const token = args.secrets.get(secretNames.githubApiToken(sourceId));
    if (!token) return false;

    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const [reviews, comments] = await Promise.all([
        githubPages<GithubPullRequestReview>(
          fetchImpl,
          `https://api.github.com/repos/${repo}/pulls/${number}/reviews`,
          token,
          signal,
        ),
        githubPages<GithubIssueComment>(
          fetchImpl,
          `https://api.github.com/repos/${repo}/issues/${number}/comments`,
          token,
          signal,
        ),
      ]);
      const hasReview = reviews.some(
        (review) =>
          review.user?.login === "chipbyte-snap" &&
          timestampValue(review.submitted_at) >= sinceMs &&
          /^(?:APPROVED|CHANGES_REQUESTED|COMMENTED)$/u.test(review.state ?? ""),
      );
      const hasStatus = comments.some(
        (comment) =>
          comment.user?.login === "chipbyte-snap" &&
          comment.body?.includes(STATUS_MARKER) &&
          timestamp(comment) >= sinceMs,
      );
      if (hasReview || hasStatus) return true;
      if (attempt < 2 && retryDelayMs > 0) await abortableDelay(retryDelayMs, signal);
    }
    return false;
  };
}

async function githubPages<T>(
  fetchImpl: typeof globalThis.fetch,
  endpoint: string,
  token: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    signal?.throwIfAborted();
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetchImpl(`${endpoint}${separator}per_page=100&page=${page}`, {
      ...(signal ? { signal } : {}),
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) return [];
    const pageValues = (await response.json()) as T[];
    values.push(...pageValues);
    if (pageValues.length < 100) break;
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
        comment.user?.login === "chipbyte-snap" && comment.body?.includes(STATUS_MARKER),
    )
    .sort((a, b) => timestamp(b) - timestamp(a))[0];
  if (!status?.body) return null;
  return {
    summary: extractGithubReviewStatus(status.body) ?? "review in progress",
    ...(status.html_url ? { url: status.html_url } : {}),
  };
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
      `https://api.github.com/repos/${context.repo}/issues/${context.number}/comments?per_page=100&page=${page}`,
      {
        ...(signal ? { signal } : {}),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${context.token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) return null;
    const pageValues = (await response.json()) as GithubIssueComment[];
    values.push(...pageValues);
    if (pageValues.length < 100) break;
  }
  return values;
}

interface GithubReviewContext {
  repo: string;
  number: string;
  token: string;
}

function githubReviewContext(event: WakeEvent, secrets: SecretStore): GithubReviewContext | null {
  if (event.source !== "github") return null;
  const repo = payloadString(event, "repo");
  const number = payloadIdentifier(event, "number");
  const sourceId = event.sourceId?.trim();
  if (!repo || !/^[^/]+\/[^/]+$/u.test(repo) || !number || !sourceId) return null;
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

function payloadString(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadIdentifier(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  return typeof value === "string" && /^\d+$/u.test(value.trim()) ? value.trim() : "";
}
