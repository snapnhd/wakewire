import { WebClient } from "@slack/web-api";
import { OAuth2Client } from "google-auth-library";
import type { SourceStore } from "../db/repos.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { LinearEnvironmentIdentity } from "../sources/linear/environment.js";
import { GmailSourceConfigSchema } from "../sources/gmail/source.js";
import { SlackSourceConfigSchema } from "../sources/slack/source.js";
import type { SourceReplyResponder, SourceReplySendResult } from "./reply-responders.js";
import {
  PermanentSourceReplyError,
  RetryableSourceReplyError,
  SourceReplyResponderRegistry,
} from "./reply-responders.js";
import {
  type GmailFinalReplyInput,
  GmailFinalReplyResponder,
  type GmailFinalReplyTransport,
} from "./responders/gmail-reply.js";
import {
  GithubFinalReplyResponder,
  type GithubFinalFetch,
} from "./responders/github-reply.js";
import { LinearFinalReplyResponder } from "./responders/linear-reply.js";
import {
  type SlackConversationHistoryArguments,
  type SlackConversationRepliesArguments,
  SlackFinalReplyResponder,
  type SlackPostMessageArguments,
} from "./responders/slack-reply.js";
import type { SourceReplyJob } from "./store.js";
import { LinearGraphqlActivityTransport } from "./live-responders.js";

const PROVIDER_REQUEST_TIMEOUT_MS = 5_000;

interface SlackRawWebClient {
  apiCall(method: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface SlackFinalWebClientOptions {
  timeout: number;
  retryConfig: { retries: number };
  rejectRateLimitedCalls: boolean;
}

export type SlackFinalWebClientFactory = (
  token: string,
  options: SlackFinalWebClientOptions,
) => SlackRawWebClient;

export function createLiveSourceReplyResponders(args: {
  secrets: SecretStore;
  sources: Pick<SourceStore, "get">;
  linearEnvironment?: LinearEnvironmentIdentity | null | undefined;
  slackClientFactory?: SlackFinalWebClientFactory | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}): SourceReplyResponderRegistry {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const linearTransport = new LinearGraphqlActivityTransport(
    args.secrets,
    fetchImpl,
    args.linearEnvironment ?? null,
  );
  return new SourceReplyResponderRegistry([
    new SourceScopedSlackFinalResponder(
      args.secrets,
      args.sources,
      args.slackClientFactory ?? defaultSlackClientFactory,
    ),
    new SourceScopedGmailFinalResponder(args.secrets, args.sources, fetchImpl),
    new SourceScopedGithubFinalResponder(args.secrets, fetchImpl),
    new LinearFinalReplyResponder((input) => linearTransport.createComment(input)),
  ]);
}

interface CachedSlackClient {
  token: string;
  client: SlackRawWebClient;
}

/** Source-scoped GitHub final comment posts (Path D / Hermes sink). */
export class SourceScopedGithubFinalResponder implements SourceReplyResponder {
  readonly provider = "github";

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    const token = this.secrets.get(secretNames.githubApiToken(job.sourceId));
    if (!token) {
      throw new PermanentSourceReplyError(
        `GitHub API token is not configured for ${job.sourceId}`,
      );
    }
    const fetchAuth: GithubFinalFetch = async (url, init) => {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
        },
        body: init.body,
        signal: providerSignal(init.signal ?? signal),
      });
      return {
        status: response.status,
        headers: response.headers,
        json: () => response.json(),
        text: () => response.text(),
      };
    };
    return new GithubFinalReplyResponder(fetchAuth).send(job, signal);
  }
}

/** One source-scoped Slack client and one serialized effect lane per installation. */
export class SourceScopedSlackFinalResponder implements SourceReplyResponder {
  readonly provider = "slack";
  private readonly clients = new Map<string, CachedSlackClient>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly sources: Pick<SourceStore, "get">,
    private readonly clientFactory: SlackFinalWebClientFactory = defaultSlackClientFactory,
  ) {}

  send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    return this.serialized(job.sourceId, async () => {
      signal?.throwIfAborted();
      const source = this.sources.get(job.sourceId);
      const parsed = SlackSourceConfigSchema.safeParse(source?.config);
      if (source?.kind !== "slack" || !source.enabled || !parsed.success) {
        throw new PermanentSourceReplyError(`Slack source ${job.sourceId} is not configured`);
      }
      const { agentTeamId, agentUserId } = parsed.data;
      if (!agentTeamId || !agentUserId) {
        throw new PermanentSourceReplyError(
          `Slack source ${job.sourceId} has no pinned workspace/user identity`,
        );
      }
      const token = this.secrets.get(secretNames.slackUserToken(job.sourceId));
      if (!token) {
        throw new PermanentSourceReplyError(
          `Slack user token is not configured for ${job.sourceId}`,
        );
      }
      const web = this.clientFor(job.sourceId, token);
      return new SlackFinalReplyResponder(
        {
          chat: {
            // Slack accepts client_msg_id at runtime even though the generated
            // Node request type omits it. Reconciliation does not depend solely on it.
            postMessage: async (input: SlackPostMessageArguments) =>
              (await web.apiCall("chat.postMessage", { ...input })) as {
                ok?: boolean;
                error?: string;
                channel?: string;
                ts?: string;
              },
          },
          conversations: {
            replies: async (input: SlackConversationRepliesArguments) =>
              (await web.apiCall("conversations.replies", { ...input })) as {
                ok?: boolean;
                error?: string;
                messages?: Array<{
                  ts?: string;
                  thread_ts?: string;
                  user?: string;
                  text?: string;
                  client_msg_id?: string;
                }>;
                response_metadata?: { next_cursor?: string };
              },
            history: async (input: SlackConversationHistoryArguments) =>
              (await web.apiCall("conversations.history", { ...input })) as {
                ok?: boolean;
                error?: string;
                messages?: Array<{
                  ts?: string;
                  thread_ts?: string;
                  user?: string;
                  text?: string;
                  client_msg_id?: string;
                }>;
                response_metadata?: { next_cursor?: string };
              },
          },
        },
        { teamId: agentTeamId, userId: agentUserId },
      ).send(job, signal);
    });
  }

  private clientFor(sourceId: string, token: string): SlackRawWebClient {
    const cached = this.clients.get(sourceId);
    if (cached?.token === token) return cached.client;
    const client = this.clientFactory(token, {
      timeout: PROVIDER_REQUEST_TIMEOUT_MS,
      // The durable outbox owns retries. An SDK retry loop would outlive the
      // worker timeout and race a second provider effect.
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
    this.clients.set(sourceId, { token, client });
    return client;
  }

  private serialized<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sourceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sourceId, tail);
    return current.finally(() => {
      if (this.tails.get(sourceId) === tail) this.tails.delete(sourceId);
    });
  }
}

export interface GmailFinalAccessTokenInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  signal?: AbortSignal | undefined;
}

export type GmailFinalAccessTokenProvider = (input: GmailFinalAccessTokenInput) => Promise<string>;

/** Resolves one Gmail source's OAuth identity before handing off the exact-thread effect. */
export class SourceScopedGmailFinalResponder implements SourceReplyResponder {
  readonly provider = "gmail";
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly sources: Pick<SourceStore, "get">,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly accessTokenProvider: GmailFinalAccessTokenProvider = defaultGmailAccessTokenProvider,
  ) {}

  send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    return this.serialized(job.sourceId, async () => {
      signal?.throwIfAborted();
      const source = this.sources.get(job.sourceId);
      const parsed = GmailSourceConfigSchema.safeParse(source?.config);
      if (source?.kind !== "gmail" || !source.enabled || !parsed.success) {
        throw new PermanentSourceReplyError(`Gmail source ${job.sourceId} is not configured`);
      }
      if (parsed.data.auth.kind !== "gmail-oauth") {
        throw new PermanentSourceReplyError(
          `Gmail source ${job.sourceId} does not use WakeWire OAuth credentials`,
        );
      }
      const clientId = this.secrets.get(secretNames.gmailClientId(job.sourceId));
      const clientSecret = this.secrets.get(secretNames.gmailClientSecret(job.sourceId));
      const refreshToken = this.secrets.get(secretNames.gmailRefreshToken(job.sourceId));
      if (!clientId || !clientSecret || !refreshToken) {
        throw new PermanentSourceReplyError(`Gmail OAuth is not configured for ${job.sourceId}`);
      }
      const token = await this.accessTokenProvider({
        clientId,
        clientSecret,
        refreshToken,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      return new GmailFinalReplyResponder(
        new GmailApiFinalReplyTransport(parsed.data.auth.user, token, this.fetchImpl),
      ).send(job, signal);
    });
  }

  private serialized<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sourceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sourceId, tail);
    return current.finally(() => {
      if (this.tails.get(sourceId) === tail) this.tails.delete(sourceId);
    });
  }
}

class GmailApiFinalReplyTransport implements GmailFinalReplyTransport {
  constructor(
    private readonly mailbox: string,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async replySameThread(input: GmailFinalReplyInput): Promise<{ messageId?: string | undefined }> {
    input.signal?.throwIfAborted();
    const original = await this.findMessages(input.originalMessageId, input.signal);
    if (original.length !== 1 || !original[0]?.id || !original[0].threadId) {
      throw new PermanentSourceReplyError(
        original.length > 1
          ? `Gmail found multiple original messages for ${input.originalMessageId}`
          : `Gmail could not find original message ${input.originalMessageId}`,
      );
    }
    const [origin] = original;
    const existing = await this.findMessages(input.generatedMessageId, input.signal);
    if (existing.length > 1) {
      throw new PermanentSourceReplyError(
        `Gmail found multiple final replies with Message-ID ${input.generatedMessageId}`,
      );
    }
    if (existing.length === 1) {
      const [message] = existing;
      if (!message?.id || message.threadId !== origin.threadId) {
        throw new PermanentSourceReplyError(
          "Gmail final reply Message-ID exists outside the originating thread",
        );
      }
      return { messageId: message.id };
    }

    input.signal?.throwIfAborted();
    const raw = buildGmailFinalRfcMessage({
      ...input,
      from: this.mailbox,
    });
    const sent = await this.gmailJson<{ id?: string; threadId?: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { method: "POST", body: JSON.stringify({ raw, threadId: origin.threadId }) },
      input.signal,
    );
    if (sent.threadId && sent.threadId !== origin.threadId) {
      throw new PermanentSourceReplyError(
        "Gmail sent the final reply outside the originating thread",
      );
    }
    return { messageId: sent.id };
  }

  private async findMessages(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<Array<{ id?: string; threadId?: string }>> {
    const query = new URLSearchParams({ q: `rfc822msgid:${messageId}`, maxResults: "2" });
    const result = await this.gmailJson<{
      messages?: Array<{ id?: string; threadId?: string }>;
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`, {}, signal);
    return result.messages ?? [];
  }

  private async gmailJson<T>(
    url: string,
    init: { method?: "POST"; body?: string } = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      signal: providerSignal(signal),
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      ...(init.body ? { body: init.body } : {}),
    });
    if (!response.ok) throw gmailReplyHttpError(response);
    return (await response.json()) as T;
  }
}

const defaultGmailAccessTokenProvider: GmailFinalAccessTokenProvider = async (input) => {
  input.signal?.throwIfAborted();
  const oauth = new OAuth2Client({ clientId: input.clientId, clientSecret: input.clientSecret });
  oauth.setCredentials({ refresh_token: input.refreshToken });
  try {
    const { token } = await oauth.getAccessToken();
    input.signal?.throwIfAborted();
    if (!token) throw new Error("Gmail did not issue an access token");
    return token;
  } catch (error) {
    if (gmailOAuthErrorCode(error) === "invalid_grant") {
      throw new PermanentSourceReplyError("Gmail OAuth refresh token is invalid or revoked");
    }
    throw error;
  }
};

function buildGmailFinalRfcMessage(input: GmailFinalReplyInput & { from: string }): string {
  const headers = [
    `From: ${headerValue(input.from)}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${headerValue(input.subject)}`,
    `Message-ID: ${headerValue(input.generatedMessageId)}`,
    `In-Reply-To: ${headerValue(input.inReplyTo)}`,
    `References: ${headerValue(input.references.join(" "))}`,
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.text}\r\n`, "utf8").toString(
    "base64url",
  );
}

function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function gmailReplyHttpError(response: Response): Error {
  const message = `Gmail API final reply failed with HTTP ${response.status}`;
  if ([400, 401, 403, 404].includes(response.status)) {
    return new PermanentSourceReplyError(message);
  }
  if (response.status === 429) {
    return new RetryableSourceReplyError(message, retryAfterMs(response.headers) ?? 1_000);
  }
  return new Error(message);
}

function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function gmailOAuthErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  const response = record.response;
  if (!response || typeof response !== "object") return undefined;
  const data = (response as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return undefined;
  const code = (data as Record<string, unknown>).error;
  return typeof code === "string" ? code : undefined;
}

function providerSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const defaultSlackClientFactory: SlackFinalWebClientFactory = (token, options) =>
  new WebClient(token, options);
