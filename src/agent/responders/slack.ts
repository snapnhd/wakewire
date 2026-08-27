import type { AckJob } from "../store.js";
import { assertAckJob, stringPayload } from "./payload.js";
import { type AckResponder, type AckSendResult, PermanentAckError } from "./types.js";

const PERMANENT_SLACK_ERRORS = new Set([
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "message_not_found",
  "missing_scope",
  "no_permission",
  "not_authed",
  "not_in_channel",
]);

export interface SlackReactionsApi {
  add(args: { channel: string; timestamp: string; name: string }): Promise<{
    ok?: boolean | undefined;
    error?: string | undefined;
  }>;
}

export interface SlackWebClientLike {
  reactions: SlackReactionsApi;
}

export class SlackAckResponder implements AckResponder {
  readonly provider = "slack";

  constructor(private readonly client: SlackWebClientLike) {}

  async send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    assertAckJob(job, this.provider, "eyes-reaction");
    const channel = stringPayload(job, "channel");
    const timestamp = stringPayload(job, "timestamp");
    const reaction = stringPayload(job, "reaction");
    signal?.throwIfAborted();
    try {
      const result = await this.client.reactions.add({ channel, timestamp, name: reaction });
      signal?.throwIfAborted();
      if (result.ok === false && result.error !== "already_reacted") {
        if (result.error && PERMANENT_SLACK_ERRORS.has(result.error)) {
          throw new PermanentAckError(`Slack reactions.add failed: ${result.error}`);
        }
        throw new Error(`Slack reactions.add failed: ${result.error ?? "unknown error"}`);
      }
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "already_reacted")
        return {
          providerResultId: `slack:${channel}:${timestamp}:${reaction}`,
        };
      if (code && PERMANENT_SLACK_ERRORS.has(code)) {
        throw new PermanentAckError(`Slack reactions.add failed: ${code}`);
      }
      throw error;
    }
    return { providerResultId: `slack:${channel}:${timestamp}:${reaction}` };
  }
}

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.code === "string") return record.code;
  const data = record.data;
  if (
    data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return undefined;
}
