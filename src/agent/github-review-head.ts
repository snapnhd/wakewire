import type { WakeEvent } from "../core/event.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import { DEFAULT_CHIP_IDENTITIES } from "./targeting.js";

export interface ChipReviewCommit {
  lastChipReviewSha?: string | null;
  lastChipReviewState?: string | null;
  lastChipReviewBody?: string | null;
}

export interface ChipReviewHeadEvidence extends ChipReviewCommit {
  headSha: string;
}

const PROCESS_MISS_PATTERNS = [
  /exact[- ]head local verification/iu,
  /retrievable aggregate/iu,
  /host gate (?:is )?unavailable/iu,
  /cannot be prepared under this review role/iu,
  /workspace could not be prepared/iu,
  /no agent task was started/iu,
  /review clone has tracked changes/iu,
  /local tests (?:are )?running[\s\S]*no live [`']?make test/iu,
] as const;

export function isProcessMissReviewBody(body: string | null | undefined): boolean {
  const text = body?.trim() ?? "";
  return text.length > 0 && PROCESS_MISS_PATTERNS.some((pattern) => pattern.test(text));
}

export function chipReviewCoversHead(evidence: ChipReviewHeadEvidence): boolean {
  if (!evidence.lastChipReviewSha || evidence.lastChipReviewSha !== evidence.headSha) return false;
  const state = evidence.lastChipReviewState?.trim().toUpperCase();
  if (state === "APPROVED" || state === "CHANGES_REQUESTED") return true;
  if (state !== "COMMENTED") return false;

  const body = evidence.lastChipReviewBody?.trim() ?? "";
  if (!body || isProcessMissReviewBody(body)) return false;
  return (
    /\bblocking\s*:/iu.test(body) ||
    /\bproduct findings?\s*:/iu.test(body) ||
    /\bno blocking(?: findings?)?\b/iu.test(body)
  );
}

interface GithubReviewRecord {
  body?: string | null;
  commit_id: string;
  state: string;
  submitted_at: string;
  user: { login: string };
}

export function createGithubReviewCommitLookup(args: {
  secrets: SecretStore;
  fetch?: typeof globalThis.fetch;
}): (event: WakeEvent, signal?: AbortSignal) => Promise<ChipReviewCommit | null> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  return async (event, signal) => {
    if (event.source !== "github") return null;
    const repo = event.payload.repo;
    const number = event.payload.number;
    const sourceId = event.sourceId?.trim();
    if (
      typeof repo !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) ||
      (typeof number !== "string" && typeof number !== "number") ||
      !sourceId
    ) {
      return null;
    }
    const token = args.secrets.get(secretNames.githubApiToken(sourceId));
    if (!token) return null;
    const reviews: GithubReviewRecord[] = [];
    for (let page = 1; page <= 10; page++) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`,
        {
          ...(signal ? { signal } : {}),
          headers: {
            accept: "application/vnd.github+json",
            authorization: "Bearer ".concat(token),
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!response.ok) throw new Error(`GitHub review HEAD lookup failed with ${response.status}`);
      const values = (await response.json()) as unknown;
      if (!Array.isArray(values) || !values.every(isGithubReviewRecord)) {
        throw new Error("GitHub review HEAD lookup returned malformed evidence");
      }
      reviews.push(...values);
      if (values.length < 100) break;
      if (page === 10) throw new Error("GitHub review HEAD lookup exceeded the safe page bound");
    }
    const latest = reviews
      .filter(
        (review) =>
          review.user.login.toLowerCase() === DEFAULT_CHIP_IDENTITIES.githubHandle.toLowerCase(),
      )
      .sort((left, right) => Date.parse(right.submitted_at) - Date.parse(left.submitted_at))[0];
    if (!latest) return null;
    return {
      lastChipReviewSha: latest.commit_id,
      lastChipReviewState: latest.state,
      lastChipReviewBody: latest.body ?? "",
    };
  };
}

function isGithubReviewRecord(value: unknown): value is GithubReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  const user = review.user;
  return (
    (review.body === undefined || review.body === null || typeof review.body === "string") &&
    typeof review.commit_id === "string" &&
    typeof review.state === "string" &&
    typeof review.submitted_at === "string" &&
    Boolean(user) &&
    typeof user === "object" &&
    !Array.isArray(user) &&
    typeof (user as Record<string, unknown>).login === "string"
  );
}
