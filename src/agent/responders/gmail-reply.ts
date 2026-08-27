import { normalizeGmailFinalReplyText } from "../reply.js";
import {
  PermanentSourceReplyError,
  type SourceReplyResponder,
  type SourceReplySendResult,
} from "../reply-responders.js";
import type { SourceReplyJob } from "../store.js";

export interface GmailFinalReplyInput {
  sourceId: string;
  generatedMessageId: string;
  originalMessageId: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string[];
  signal?: AbortSignal | undefined;
}

export interface GmailFinalReplyTransport {
  /** Reconcile the stable generated Message-ID, then send in the original Gmail thread. */
  replySameThread(input: GmailFinalReplyInput): Promise<{ messageId?: string | undefined }>;
}

export class GmailFinalReplyResponder implements SourceReplyResponder {
  readonly provider = "gmail";

  constructor(private readonly transport: GmailFinalReplyTransport) {}

  async send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    assertGmailReplyJob(job);
    const originalMessageId = stringPayload(job, "originalMessageId");
    if (job.destination !== originalMessageId) {
      throw new PermanentSourceReplyError(
        "Gmail final reply destination and original Message-ID do not match",
      );
    }
    const inReplyTo = stringPayload(job, "inReplyTo");
    if (inReplyTo !== originalMessageId) {
      throw new PermanentSourceReplyError(
        "Gmail final reply In-Reply-To and original Message-ID do not match",
      );
    }
    let text: string;
    try {
      text = normalizeGmailFinalReplyText(stringPayload(job, "text"));
    } catch (error) {
      throw new PermanentSourceReplyError(
        `Gmail final reply has invalid text: ${error instanceof Error ? error.message : error}`,
      );
    }
    const result = await this.transport.replySameThread({
      sourceId: job.sourceId,
      generatedMessageId: `<wakewire-reply-${job.id}@wakewire.local>`,
      originalMessageId,
      to: stringPayload(job, "to"),
      subject: stringPayload(job, "subject"),
      text,
      inReplyTo,
      references: stringArrayPayload(job, "references"),
      ...(signal ? { signal } : {}),
    });
    if (!result.messageId) {
      throw new Error("Gmail messages.send returned no message id; reconcile before retrying");
    }
    return { providerResultId: `gmail:${result.messageId}` };
  }
}

function assertGmailReplyJob(job: SourceReplyJob): void {
  if (job.provider.toLowerCase() !== "gmail" || job.replyKind !== "thread-reply") {
    throw new PermanentSourceReplyError(
      `expected Gmail thread-reply job, received ${job.provider}:${job.replyKind}`,
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id)) {
    throw new PermanentSourceReplyError("Gmail final reply id must be a UUID");
  }
}

function stringPayload(job: SourceReplyJob, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new PermanentSourceReplyError(`Gmail final reply is missing payload.${key}`);
  }
  return value.trim();
}

function stringArrayPayload(job: SourceReplyJob, key: string): string[] {
  const value = job.payload[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new PermanentSourceReplyError(`Gmail final reply has invalid payload.${key}`);
  }
  return value.map((entry) => (entry as string).trim());
}
