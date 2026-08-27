import type { AckJob } from "../store.js";
import { assertAckJob, stringPayload } from "./payload.js";
import { type AckResponder, type AckSendResult, PermanentAckError } from "./types.js";

export interface GithubResponseLike {
  status: number;
  json?: (() => Promise<unknown>) | undefined;
  text?: (() => Promise<string>) | undefined;
}

export type GithubFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<GithubResponseLike>;

/**
 * The injected fetch may add source-specific authentication. This responder
 * owns only the exact REST endpoint, method, headers, and body.
 */
export class GithubAckResponder implements AckResponder {
  readonly provider = "github";

  constructor(
    private readonly fetch: GithubFetch,
    private readonly apiBaseUrl = "https://api.github.com",
  ) {}

  async send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    assertAckJob(job, this.provider, "eyes-reaction");
    const repo = stringPayload(job, "repo");
    const targetType = stringPayload(job, "targetType");
    const targetId = stringPayload(job, "targetId");
    const content = stringPayload(job, "content");
    if (content !== "eyes") throw new Error(`unsupported GitHub reaction ${content}`);
    const endpoint = githubReactionEndpoint(repo, targetType, targetId);
    const response = await this.fetch(`${this.apiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ content }),
      ...(signal ? { signal } : {}),
    });
    // GitHub returns 201 when newly created and 200 when the user's identical
    // reaction already exists; both satisfy the idempotent acknowledgment.
    if (response.status !== 200 && response.status !== 201) {
      const detail = response.text ? (await response.text()).slice(0, 500) : "";
      const message = `GitHub reaction failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
      if ([400, 401, 403, 404, 410, 422].includes(response.status)) {
        throw new PermanentAckError(message);
      }
      throw new Error(message);
    }
    const body = response.json ? await response.json().catch(() => null) : null;
    const id =
      body && typeof body === "object" && "id" in body
        ? String((body as Record<string, unknown>).id)
        : undefined;
    return { providerResultId: id ?? `github:${job.destination}:eyes` };
  }
}

export function githubReactionEndpoint(repo: string, targetType: string, targetId: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`invalid GitHub repo ${repo}`);
  const base = `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
  const id = encodeURIComponent(targetId);
  switch (targetType) {
    case "issue":
      // GitHub's issue reaction endpoint also covers pull requests.
      return `${base}/issues/${id}/reactions`;
    case "issue-comment":
      return `${base}/issues/comments/${id}/reactions`;
    case "review-comment":
      return `${base}/pulls/comments/${id}/reactions`;
    default:
      throw new Error(`unsupported GitHub reaction target ${targetType}`);
  }
}
