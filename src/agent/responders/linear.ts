import type { AckJob } from "../store.js";
import {
  assertAckJob,
  InvalidAckJobError,
  optionalStringPayload,
  stringPayload,
} from "./payload.js";
import type { AckResponder, AckSendResult } from "./types.js";

export interface LinearActivityInput {
  sourceId: string;
  target: string;
  text: string;
  /** Stable UUIDv4 from the durable outbox; Linear uses it for idempotency. */
  idempotencyKey: string;
  contentType: "thought" | "response" | "error";
  ephemeral: boolean;
  signal?: AbortSignal | undefined;
}

export interface LinearReactionInput {
  sourceId: string;
  emoji: string;
  commentId?: string | undefined;
  issueId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface LinearActivityTransport {
  /** Create the provider-native activity/comment for an already-normalized target. */
  createActivity(input: LinearActivityInput): Promise<{ activityId?: string | undefined }>;
  /** Create a normal issue comment for a dedicated API-key-backed Chip user. */
  createComment(input: LinearCommentInput): Promise<{ commentId?: string | undefined }>;
  /** React on the @chip comment (or issue, for assignment) instead of posting text. */
  createReaction(input: LinearReactionInput): Promise<{ reactionId?: string | undefined }>;
}

export interface LinearCommentInput {
  sourceId: string;
  issueId: string;
  text: string;
  idempotencyKey: string;
  /** When set, create a threaded reply under this parent comment. */
  parentId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export class LinearAckResponder implements AckResponder {
  readonly provider = "linear";

  constructor(private readonly transport: LinearActivityTransport) {}

  async send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    if (job.ackKind === "eyes-reaction") {
      assertAckJob(job, this.provider, "eyes-reaction");
      const commentId = optionalStringPayload(job, "commentId");
      const issueId = optionalStringPayload(job, "issueId");
      if (!commentId && !issueId) {
        throw new InvalidAckJobError(
          "Linear eyes reaction requires payload.commentId or payload.issueId",
        );
      }
      const result = await this.transport.createReaction({
        sourceId: job.sourceId,
        emoji: stringPayload(job, "emoji"),
        ...(commentId ? { commentId } : {}),
        ...(issueId ? { issueId } : {}),
        ...(signal ? { signal } : {}),
      });
      return { providerResultId: result.reactionId };
    }
    if (job.ackKind === "comment") {
      assertAckJob(job, this.provider, "comment");
      const parentId = optionalStringPayload(job, "parentId");
      const result = await this.transport.createComment({
        sourceId: job.sourceId,
        issueId: stringPayload(job, "target"),
        text: stringPayload(job, "text"),
        idempotencyKey: job.id,
        ...(parentId ? { parentId } : {}),
        ...(signal ? { signal } : {}),
      });
      return { providerResultId: result.commentId };
    }
    assertAckJob(job, this.provider, "activity");
    const contentType = activityContentType(job.payload.contentType);
    const result = await this.transport.createActivity({
      sourceId: job.sourceId,
      target: stringPayload(job, "target"),
      text: stringPayload(job, "text"),
      idempotencyKey: job.id,
      contentType,
      ephemeral:
        typeof job.payload.ephemeral === "boolean"
          ? job.payload.ephemeral
          : contentType === "thought",
      ...(signal ? { signal } : {}),
    });
    return { providerResultId: result.activityId };
  }
}

function activityContentType(value: unknown): LinearActivityInput["contentType"] {
  if (value === undefined) return "thought";
  if (value === "thought" || value === "response" || value === "error") return value;
  throw new InvalidAckJobError(`Linear acknowledgment has invalid payload.contentType`);
}
