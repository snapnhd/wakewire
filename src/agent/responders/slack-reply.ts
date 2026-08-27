import { normalizeSlackFinalReplyText } from "../reply.js";
import {
  PermanentSourceReplyError,
  RetryableSourceReplyError,
  type SourceReplyResponder,
  type SourceReplySendResult,
} from "../reply-responders.js";
import type { SourceReplyJob } from "../store.js";

const PERMANENT_SLACK_REPLY_ERRORS = new Set([
  "access_denied",
  "account_inactive",
  "app_access_restricted",
  "cannot_reply_to_message",
  "channel_not_found",
  "duplicate_channel_not_found",
  "duplicate_message_not_found",
  "enterprise_is_restricted",
  "invalid_arguments",
  "invalid_auth",
  "is_archived",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "restricted_action",
  "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "team_access_not_granted",
  "team_not_found",
  "thread_not_found",
  "token_expired",
  "token_revoked",
  "two_factor_setup_required",
]);
const RATE_LIMIT_SLACK_ERRORS = new Set([
  "rate_limited",
  "ratelimited",
  "slack_webapi_rate_limited_error",
]);
const RECONCILIATION_PAGE_SIZE = 100;
const MAX_RECONCILIATION_PAGES = 5;

interface SlackPostMessageBaseArguments {
  channel: string;
  text: string;
  client_msg_id: string;
  mrkdwn: false;
  parse: "none";
  link_names: false;
  unfurl_links: false;
  unfurl_media: false;
}

export interface SlackThreadReplyArguments extends SlackPostMessageBaseArguments {
  thread_ts: string;
  reply_broadcast: false;
}

export interface SlackChannelMessageArguments extends SlackPostMessageBaseArguments {
  thread_ts?: never;
  reply_broadcast?: never;
}

export type SlackPostMessageArguments = SlackThreadReplyArguments | SlackChannelMessageArguments;

export interface SlackConversationRepliesArguments {
  channel: string;
  ts: string;
  limit: number;
  cursor?: string | undefined;
}

export interface SlackConversationHistoryArguments {
  channel: string;
  limit: number;
  oldest: string;
  inclusive: true;
  cursor?: string | undefined;
}

interface SlackMessage {
  ts?: string | undefined;
  thread_ts?: string | undefined;
  user?: string | undefined;
  text?: string | undefined;
  client_msg_id?: string | undefined;
}

interface SlackMethodResult {
  ok?: boolean | undefined;
  error?: string | undefined;
}

export interface SlackChatPostMessageApi {
  postMessage(args: SlackPostMessageArguments): Promise<
    SlackMethodResult & {
      channel?: string | undefined;
      ts?: string | undefined;
    }
  >;
}

export interface SlackConversationsRepliesApi {
  replies(args: SlackConversationRepliesArguments): Promise<
    SlackMethodResult & {
      messages?: SlackMessage[] | undefined;
      response_metadata?: { next_cursor?: string | undefined } | undefined;
    }
  >;
}

export interface SlackConversationsHistoryApi {
  history(args: SlackConversationHistoryArguments): Promise<
    SlackMethodResult & {
      messages?: SlackMessage[] | undefined;
      response_metadata?: { next_cursor?: string | undefined } | undefined;
    }
  >;
}

export interface SlackFinalReplyClient {
  chat: SlackChatPostMessageApi;
  conversations: SlackConversationsRepliesApi & Partial<SlackConversationsHistoryApi>;
}

export interface SlackReplyIdentity {
  teamId: string;
  userId: string;
}

/** Sends the completed answer as Chip's existing normal Slack user. */
export class SlackFinalReplyResponder implements SourceReplyResponder {
  readonly provider = "slack";

  constructor(
    private readonly client: SlackFinalReplyClient,
    private readonly identity: SlackReplyIdentity,
  ) {}

  async send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    const target = slackReplyTarget(job, this.identity);
    let text: string;
    try {
      text = normalizeSlackFinalReplyText(stringPayload(job, "text"));
    } catch (error) {
      throw new PermanentSourceReplyError(
        `Slack final reply has invalid text: ${error instanceof Error ? error.message : error}`,
      );
    }

    try {
      // Reconcile on every attempt. Besides crash recovery, this closes the
      // process-race window before a lease owner performs the provider effect.
      const existing =
        target.kind === "thread-reply"
          ? await this.findExistingReply(job.id, target, text, signal)
          : await this.findExistingChannelMessage(job, target, text, signal);
      if (existing) return existing;

      signal?.throwIfAborted();
      const common = {
        channel: target.channel,
        text,
        // Slack accepts this stable UUID as one deduplication layer. Durable
        // exact-thread reconciliation remains the authoritative retry guard.
        client_msg_id: job.id,
        // Final model text is untrusted provider content. Disabling mrkdwn and
        // automatic linking keeps explicit <@U123>/<!channel> syntax inert.
        mrkdwn: false,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      } as const;
      const result = await this.client.chat.postMessage(
        target.kind === "thread-reply"
          ? { ...common, thread_ts: target.threadTs, reply_broadcast: false }
          : common,
      );
      // Do not observe cancellation after the provider call: Slack may already
      // have accepted the effect, and the DB must be allowed to record it.
      if (result.ok === false) throw slackReplyError(result.error, "chat.postMessage");
      if (result.channel && result.channel !== target.channel) {
        throw new PermanentSourceReplyError(
          "Slack chat.postMessage returned a different channel; refusing an ambiguous retry",
        );
      }
      if (!result.ts) {
        throw new Error(
          "Slack chat.postMessage returned no message timestamp; reconcile before retrying",
        );
      }
      return { providerResultId: `slack:${target.channel}:${result.ts}` };
    } catch (error) {
      throw classifySlackError(error);
    }
  }

  private async findExistingReply(
    clientMessageId: string,
    target: SlackThreadReplyTarget,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<SourceReplySendResult | null> {
    const candidates: SlackMessage[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_RECONCILIATION_PAGES; page++) {
      signal?.throwIfAborted();
      const result = await this.client.conversations.replies({
        channel: target.channel,
        ts: target.threadTs,
        limit: RECONCILIATION_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (result.ok === false) throw slackReplyError(result.error, "conversations.replies");
      if (!Array.isArray(result.messages)) {
        throw new PermanentSourceReplyError(
          "Slack conversations.replies returned malformed messages; refusing to post",
        );
      }
      for (const message of result.messages) {
        if (message.client_msg_id === clientMessageId) candidates.push(message);
      }

      cursor = result.response_metadata?.next_cursor?.trim() || undefined;
      if (!cursor) return validateReconciledReply(candidates, target, expectedText, this.identity);
    }

    throw new PermanentSourceReplyError(
      `Slack thread exceeded the bounded ${MAX_RECONCILIATION_PAGES}-page reconciliation scan; refusing to post`,
    );
  }

  private async findExistingChannelMessage(
    job: SourceReplyJob,
    target: SlackChannelMessageTarget,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<SourceReplySendResult | null> {
    const history = this.client.conversations.history;
    if (!history) {
      throw new PermanentSourceReplyError(
        "Slack channel-message reconciliation is not configured; refusing to post",
      );
    }
    const candidates: SlackMessage[] = [];
    const oldest = slackHistoryOldest(job.createdAt);
    let cursor: string | undefined;

    for (let page = 0; page < MAX_RECONCILIATION_PAGES; page++) {
      signal?.throwIfAborted();
      const result = await history({
        channel: target.channel,
        limit: RECONCILIATION_PAGE_SIZE,
        oldest,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      });
      if (result.ok === false) throw slackReplyError(result.error, "conversations.history");
      if (!Array.isArray(result.messages)) {
        throw new PermanentSourceReplyError(
          "Slack conversations.history returned malformed messages; refusing to post",
        );
      }
      for (const message of result.messages) {
        if (message.client_msg_id === job.id) candidates.push(message);
      }

      cursor = result.response_metadata?.next_cursor?.trim() || undefined;
      if (!cursor) {
        return validateReconciledChannelMessage(candidates, target, expectedText, this.identity);
      }
    }

    throw new PermanentSourceReplyError(
      `Slack channel exceeded the bounded ${MAX_RECONCILIATION_PAGES}-page reconciliation scan; refusing to post`,
    );
  }
}

interface SlackThreadReplyTarget {
  kind: "thread-reply";
  teamId: string;
  channel: string;
  threadTs: string;
}

interface SlackChannelMessageTarget {
  kind: "channel-message";
  teamId: string;
  channel: string;
}

type SlackReplyTarget = SlackThreadReplyTarget | SlackChannelMessageTarget;

function slackReplyTarget(job: SourceReplyJob, identity: SlackReplyIdentity): SlackReplyTarget {
  assertSlackReplyJob(job);
  const channel = stringPayload(job, "channel");
  const pieces = job.destination.split(":");
  const expectedPieces = job.replyKind === "thread-reply" ? 3 : 2;
  if (pieces.length !== expectedPieces || pieces.some((piece) => !piece.trim())) {
    throw new PermanentSourceReplyError(
      job.replyKind === "thread-reply"
        ? "Slack thread reply destination must be team:channel:threadTs"
        : "Slack channel message destination must be team:channel",
    );
  }
  const [teamId, destinationChannel] = pieces as [string, string];
  if (identity.teamId !== teamId || destinationChannel !== channel) {
    throw new PermanentSourceReplyError(
      "Slack reply destination, payload, and pinned workspace do not match",
    );
  }
  if (!identity.userId.trim()) {
    throw new PermanentSourceReplyError("Slack final reply has no pinned agent user id");
  }
  if (job.replyKind === "channel-message") {
    if (typeof job.payload.threadTs === "string" && job.payload.threadTs.trim()) {
      throw new PermanentSourceReplyError(
        "Slack channel message must not contain payload.threadTs",
      );
    }
    return { kind: "channel-message", teamId, channel };
  }
  const threadTs = stringPayload(job, "threadTs");
  const destinationThreadTs = pieces[2];
  if (destinationThreadTs !== threadTs) {
    throw new PermanentSourceReplyError(
      "Slack thread reply destination and payload thread do not match",
    );
  }
  return { kind: "thread-reply", teamId, channel, threadTs };
}

function validateReconciledReply(
  candidates: SlackMessage[],
  target: SlackThreadReplyTarget,
  expectedText: string,
  identity: SlackReplyIdentity,
): SourceReplySendResult | null {
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new PermanentSourceReplyError(
      "Slack thread contains multiple replies with this client_msg_id; refusing an ambiguous retry",
    );
  }
  const [message] = candidates;
  if (
    !message?.ts ||
    message.thread_ts !== target.threadTs ||
    message.user !== identity.userId ||
    message.text !== expectedText
  ) {
    throw new PermanentSourceReplyError(
      "Slack client_msg_id exists but its thread, author, or text differs; refusing to post",
    );
  }
  return { providerResultId: `slack:${target.channel}:${message.ts}` };
}

function validateReconciledChannelMessage(
  candidates: SlackMessage[],
  target: SlackChannelMessageTarget,
  expectedText: string,
  identity: SlackReplyIdentity,
): SourceReplySendResult | null {
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new PermanentSourceReplyError(
      "Slack channel contains multiple messages with this client_msg_id; refusing an ambiguous retry",
    );
  }
  const [message] = candidates;
  if (
    !message?.ts ||
    message.thread_ts !== undefined ||
    message.user !== identity.userId ||
    message.text !== expectedText
  ) {
    throw new PermanentSourceReplyError(
      "Slack client_msg_id exists but its thread state, author, or text differs; refusing to post",
    );
  }
  return { providerResultId: `slack:${target.channel}:${message.ts}` };
}

function assertSlackReplyJob(job: SourceReplyJob): void {
  if (
    job.provider.toLowerCase() !== "slack" ||
    (job.replyKind !== "thread-reply" && job.replyKind !== "channel-message")
  ) {
    throw new PermanentSourceReplyError(
      `expected Slack thread-reply or channel-message job, received ${job.provider}:${job.replyKind}`,
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id)) {
    throw new PermanentSourceReplyError("Slack final reply id must be a UUID");
  }
}

function slackHistoryOldest(createdAt: string): string {
  const milliseconds = Date.parse(createdAt);
  if (!Number.isFinite(milliseconds)) {
    throw new PermanentSourceReplyError("Slack channel message has an invalid createdAt timestamp");
  }
  return (Math.max(0, milliseconds - 5_000) / 1_000).toFixed(3);
}

function stringPayload(job: SourceReplyJob, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new PermanentSourceReplyError(`Slack final reply is missing payload.${key}`);
  }
  return value.trim();
}

function slackReplyError(code: string | undefined, method: string): Error {
  const normalized = code || "unknown error";
  if (RATE_LIMIT_SLACK_ERRORS.has(normalized)) {
    return new RetryableSourceReplyError(`Slack ${method} failed: ${normalized}`, 1_000);
  }
  return PERMANENT_SLACK_REPLY_ERRORS.has(normalized)
    ? new PermanentSourceReplyError(`Slack ${method} failed: ${normalized}`)
    : new Error(`Slack ${method} failed: ${normalized}`);
}

function classifySlackError(error: unknown): Error {
  if (error instanceof PermanentSourceReplyError || error instanceof RetryableSourceReplyError) {
    return error;
  }
  const code = slackErrorCode(error);
  if (code && RATE_LIMIT_SLACK_ERRORS.has(code)) {
    return new RetryableSourceReplyError(
      `Slack API rate limited the final reply: ${code}`,
      slackRetryAfterMs(error) ?? 1_000,
    );
  }
  if (code && PERMANENT_SLACK_REPLY_ERRORS.has(code)) {
    return new PermanentSourceReplyError(`Slack final reply failed: ${code}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  const data = record.data;
  if (
    data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return typeof record.code === "string" ? record.code : undefined;
}

function slackRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const seconds = (error as Record<string, unknown>).retryAfter;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1_000);
}
