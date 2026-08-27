import type { AckJob } from "../store.js";
import { assertAckJob, stringArrayPayload, stringPayload } from "./payload.js";
import type { AckResponder, AckSendResult } from "./types.js";

export interface GmailReplyInput {
  sourceId: string;
  originalMessageId: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string[];
  signal?: AbortSignal | undefined;
}

export interface GmailReplyTransport {
  /** Resolve credentials/threading and send through the configured source. */
  replySameThread(input: GmailReplyInput): Promise<{ messageId?: string | undefined }>;
}

export class GmailAckResponder implements AckResponder {
  readonly provider = "gmail";

  constructor(private readonly transport: GmailReplyTransport) {}

  async send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    assertAckJob(job, this.provider, "brief-reply");
    const result = await this.transport.replySameThread({
      sourceId: job.sourceId,
      originalMessageId: stringPayload(job, "originalMessageId"),
      to: stringPayload(job, "to"),
      subject: stringPayload(job, "subject"),
      text: stringPayload(job, "text"),
      inReplyTo: stringPayload(job, "inReplyTo"),
      references: stringArrayPayload(job, "references"),
      ...(signal ? { signal } : {}),
    });
    return { providerResultId: result.messageId };
  }
}
