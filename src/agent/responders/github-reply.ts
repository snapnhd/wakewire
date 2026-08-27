import { normalizeGithubFinalReplyText } from "../reply.js";
import {
  PermanentSourceReplyError,
  RetryableSourceReplyError,
  type SourceReplyResponder,
  type SourceReplySendResult,
} from "../reply-responders.js";
import type { SourceReplyJob } from "../store.js";

export interface GithubResponseLike {
  status: number;
  headers?: { get?(name: string): string | null } | undefined;
  json?: (() => Promise<unknown>) | undefined;
  text?: (() => Promise<string>) | undefined;
}

export type GithubFinalFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<GithubResponseLike>;

/**
 * Posts a new issue/PR comment with the agent's final answer.
 * Idempotency: embeds `<!-- wakewire-reply:{jobId} -->` and treats HTTP 201 as
 * success; callers may re-drive the outbox safely if the comment already exists
 * only when GitHub returns the same marker on a future enhancement — for now
 * duplicate posts on crash-after-201 are accepted as rare.
 */
export class GithubFinalReplyResponder implements SourceReplyResponder {
  readonly provider = "github";

  constructor(
    private readonly fetch: GithubFinalFetch,
    private readonly apiBaseUrl = "https://api.github.com",
  ) {}

  async send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    if (job.provider.toLowerCase() !== "github" || job.replyKind !== "issue-comment") {
      throw new PermanentSourceReplyError(
        `expected GitHub issue-comment job, received ${job.provider}:${job.replyKind}`,
      );
    }
    const repo = stringPayload(job, "repo");
    const number = stringPayload(job, "number");
    if (!repo || !/^[^/]+\/[^/]+$/.test(repo) || !/^\d+$/.test(number)) {
      throw new PermanentSourceReplyError("GitHub final reply requires repo owner/name and number");
    }
    let text: string;
    try {
      text = normalizeGithubFinalReplyText(stringPayload(job, "text"));
    } catch (error) {
      throw new PermanentSourceReplyError(
        `GitHub final reply has invalid text: ${error instanceof Error ? error.message : error}`,
      );
    }
    const body = `${text}\n\n<!-- wakewire-reply:${job.id} -->`;
    const [owner, name] = repo.split("/");
    const endpoint = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues/${encodeURIComponent(number)}/comments`;
    const response = await this.fetch(`${this.apiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ body }),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 201) {
      const detail = response.text ? (await response.text()).slice(0, 500) : "";
      const message = `GitHub issue comment failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
      if ([400, 401, 403, 404, 410, 422].includes(response.status)) {
        throw new PermanentSourceReplyError(message);
      }
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response.headers) ?? 1_000;
        throw new RetryableSourceReplyError(message, retryAfter);
      }
      throw new Error(message);
    }
    const json = response.json ? await response.json().catch(() => null) : null;
    const id =
      json && typeof json === "object" && "id" in json
        ? String((json as Record<string, unknown>).id)
        : undefined;
    return { providerResultId: id ? `github:comment:${id}` : `github:${job.destination}` };
  }
}

function stringPayload(job: SourceReplyJob, key: string): string {
  const value = job.payload[key];
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function retryAfterMs(headers: GithubResponseLike["headers"]): number | null {
  const value = headers?.get?.("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
