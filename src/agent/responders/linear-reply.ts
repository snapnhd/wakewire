import {
  PermanentSourceReplyError,
  RetryableSourceReplyError,
  type SourceReplyResponder,
  type SourceReplySendResult,
} from "../reply-responders.js";
import type { SourceReplyJob } from "../store.js";
import type { LinearCommentInput } from "./linear.js";

/**
 * Final Linear issue comment for Path D / Hermes (and any sink that returns
 * finalResponse). Reuses the dedicated Chip API key transport used by acks.
 */
export class LinearFinalReplyResponder implements SourceReplyResponder {
  readonly provider = "linear";

  constructor(
    private readonly createComment: (
      input: LinearCommentInput,
    ) => Promise<{ commentId?: string | undefined }>,
  ) {}

  async send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    if (job.provider.toLowerCase() !== "linear" || job.replyKind !== "issue-comment") {
      throw new PermanentSourceReplyError(
        `expected Linear issue-comment job, received ${job.provider}:${job.replyKind}`,
      );
    }
    const issueId = stringPayload(job, "target");
    const text = stringPayload(job, "text");
    const parentId = optionalStringPayload(job, "parentId");
    try {
      const result = await this.createComment({
        sourceId: job.sourceId,
        issueId,
        text,
        idempotencyKey: job.id,
        ...(parentId ? { parentId } : {}),
        ...(signal ? { signal } : {}),
      });
      return { providerResultId: result.commentId };
    } catch (error) {
      if (error instanceof PermanentSourceReplyError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/not configured|401|403|404|400/i.test(message)) {
        throw new PermanentSourceReplyError(message);
      }
      throw new RetryableSourceReplyError(message, 2_000);
    }
  }
}

function stringPayload(job: SourceReplyJob, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new PermanentSourceReplyError(`Linear final reply is missing payload.${key}`);
  }
  return value.trim();
}

function optionalStringPayload(job: SourceReplyJob, key: string): string | undefined {
  const value = job.payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
