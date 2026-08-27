import crypto from "node:crypto";
import { WebClient } from "@slack/web-api";
import { OAuth2Client } from "google-auth-library";
import type { SourceStore } from "../db/repos.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { LinearEnvironmentIdentity } from "../sources/linear/environment.js";
import { LinearAgentTokenProvider } from "../sources/linear/token.js";
import { shouldRetryLinearCommentWithoutParent } from "./linear-thread.js";
import { GithubAckResponder } from "./responders/github.js";
import { GmailAckResponder, type GmailReplyInput } from "./responders/gmail.js";
import { LinearAckResponder, type LinearActivityInput } from "./responders/linear.js";
import { SlackAckResponder } from "./responders/slack.js";
import type { AckResponder, AckSendResult } from "./responders/types.js";
import { AckResponderRegistry, PermanentAckError } from "./responders/types.js";
import type { AckJob } from "./store.js";

const PROVIDER_REQUEST_TIMEOUT_MS = 7_500;

export function createLiveAckResponders(args: {
  secrets: SecretStore;
  sources: SourceStore;
  linearEnvironment?: LinearEnvironmentIdentity | null;
  fetch?: typeof globalThis.fetch;
}): AckResponderRegistry {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  return new AckResponderRegistry([
    new SourceScopedSlackResponder(args.secrets),
    new SourceScopedGithubResponder(args.secrets, fetchImpl),
    new GmailAckResponder(new GmailApiReplyTransport(args.secrets, args.sources, fetchImpl)),
    new LinearAckResponder(
      new LinearGraphqlActivityTransport(args.secrets, fetchImpl, args.linearEnvironment ?? null),
    ),
  ]);
}

class SourceScopedSlackResponder implements AckResponder {
  readonly provider = "slack";

  constructor(private readonly secrets: SecretStore) {}

  async send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    const token = this.secrets.get(secretNames.slackUserToken(job.sourceId));
    if (!token) {
      throw new PermanentAckError(`Slack user token is not configured for ${job.sourceId}`);
    }
    return new SlackAckResponder(
      new WebClient(token, { timeout: PROVIDER_REQUEST_TIMEOUT_MS }),
    ).send(job, signal);
  }
}

class SourceScopedGithubResponder implements AckResponder {
  readonly provider = "github";

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    const token = this.secrets.get(secretNames.githubApiToken(job.sourceId));
    if (!token) {
      throw new PermanentAckError(`GitHub API token is not configured for ${job.sourceId}`);
    }
    const responder = new GithubAckResponder(async (url, init) =>
      this.fetchImpl(url, {
        ...init,
        signal: providerSignal(signal),
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      }),
    );
    return responder.send(job, signal);
  }
}

class GmailApiReplyTransport {
  constructor(
    private readonly secrets: SecretStore,
    private readonly sources: SourceStore,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async replySameThread(input: GmailReplyInput): Promise<{ messageId?: string | undefined }> {
    const source = this.sources.get(input.sourceId);
    const auth = asRecord(source?.config.auth);
    const mailbox = stringValue(auth.user);
    if (source?.kind !== "gmail" || !mailbox) {
      throw new PermanentAckError(`Gmail source ${input.sourceId} is not configured`);
    }
    const token = await this.accessToken(input.sourceId, input.signal);
    input.signal?.throwIfAborted();
    const marker = crypto
      .createHash("sha256")
      .update(`${input.sourceId}\0${input.originalMessageId}`)
      .digest("hex")
      .slice(0, 32);
    const ackMessageId = `<wakewire-ack-${marker}@snapcorp.com>`;
    const existing = await this.findMessage(token, ackMessageId, input.signal);
    if (existing?.id) return { messageId: existing.id };
    const original = await this.findMessage(token, input.originalMessageId, input.signal);
    if (!original?.threadId) {
      throw new PermanentAckError(
        `Gmail could not find original message ${input.originalMessageId}`,
      );
    }
    const raw = buildRfcMessage({ ...input, from: mailbox, messageId: ackMessageId });
    const sent = await this.gmailJson<{ id?: string }>(
      token,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { method: "POST", body: JSON.stringify({ raw, threadId: original.threadId }) },
      input.signal,
    );
    return { messageId: sent.id };
  }

  private async accessToken(sourceId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const clientId = this.secrets.get(secretNames.gmailClientId(sourceId));
    const clientSecret = this.secrets.get(secretNames.gmailClientSecret(sourceId));
    const refreshToken = this.secrets.get(secretNames.gmailRefreshToken(sourceId));
    if (!clientId || !clientSecret || !refreshToken) {
      throw new PermanentAckError(`Gmail OAuth is not configured for ${sourceId}`);
    }
    const oauth = new OAuth2Client({ clientId, clientSecret });
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    signal?.throwIfAborted();
    if (!token) throw new Error(`Gmail did not issue an access token for ${sourceId}`);
    return token;
  }

  private async findMessage(
    token: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<{ id?: string; threadId?: string } | null> {
    const query = new URLSearchParams({ q: `rfc822msgid:${messageId}`, maxResults: "1" });
    const result = await this.gmailJson<{
      messages?: Array<{ id?: string; threadId?: string }>;
    }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`, {}, signal);
    return result.messages?.[0] ?? null;
  }

  private async gmailJson<T>(
    token: string,
    url: string,
    init: { method?: "POST"; body?: string } = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      signal: providerSignal(signal),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body ? { body: init.body } : {}),
    });
    if (!response.ok) {
      const message = `Gmail API request failed with HTTP ${response.status}`;
      if ([400, 401, 403, 404].includes(response.status)) {
        throw new PermanentAckError(message);
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }
}

export class LinearGraphqlActivityTransport {
  private readonly providers = new Map<string, LinearAgentTokenProvider>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof globalThis.fetch,
    private readonly linearEnvironment: LinearEnvironmentIdentity | null,
  ) {}

  async createComment(input: {
    sourceId?: string | undefined;
    issueId: string;
    text: string;
    idempotencyKey: string;
    parentId?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ commentId?: string | undefined }> {
    if (!this.linearEnvironment) {
      throw new PermanentAckError("dedicated Linear API key is not configured");
    }
    const post = async (parentId?: string) => {
      const response = await this.fetchImpl("https://api.linear.app/graphql", {
        method: "POST",
        signal: providerSignal(input.signal),
        headers: {
          authorization: this.linearEnvironment!.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `mutation WakeWireCommentAck($input: CommentCreateInput!) {
            commentCreate(input: $input) { success comment { id } }
          }`,
          variables: {
            input: {
              id: input.idempotencyKey,
              issueId: input.issueId,
              body: input.text,
              ...(parentId ? { parentId } : {}),
            },
          },
        }),
      });
      const body = (await response.json()) as {
        data?: { commentCreate?: { success?: boolean; comment?: { id?: string } } };
        errors?: Array<{ message?: string }>;
      };
      return { response, body };
    };

    let { response, body } = await post(input.parentId);
    const errText =
      body.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join("; ") ?? "";
    // If the parent comment vanished or the id was synthetic, still post a
    // top-level reply rather than leave the Chip turn stuck.
    if (
      input.parentId &&
      (!response.ok || body.errors?.length || !body.data?.commentCreate?.success) &&
      shouldRetryLinearCommentWithoutParent(errText)
    ) {
      ({ response, body } = await post(undefined));
    }
    if (!response.ok || body.errors?.length || !body.data?.commentCreate?.success) {
      const detail = body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      const message = `Linear comment failed (${response.status})${detail ? `: ${detail}` : ""}`;
      if ([400, 401, 403, 404].includes(response.status) || /entity not found/i.test(message)) {
        throw new PermanentAckError(message);
      }
      throw new Error(message);
    }
    return {
      commentId: body.data.commentCreate.comment?.id ?? input.idempotencyKey,
    };
  }

  async createReaction(input: {
    sourceId?: string | undefined;
    emoji: string;
    commentId?: string | undefined;
    issueId?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ reactionId?: string | undefined }> {
    if (!this.linearEnvironment) {
      throw new PermanentAckError("dedicated Linear API key is not configured");
    }
    const commentId = input.commentId?.trim() ?? "";
    const issueId = input.issueId?.trim() ?? "";
    if (!commentId && !issueId) {
      throw new PermanentAckError("Linear reaction requires commentId or issueId");
    }
    const response = await this.fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      signal: providerSignal(input.signal),
      headers: {
        authorization: this.linearEnvironment.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation WakeWireReactionAck($input: ReactionCreateInput!) {
          reactionCreate(input: $input) { success reaction { id emoji } }
        }`,
        variables: {
          input: {
            emoji: input.emoji,
            ...(commentId ? { commentId } : { issueId }),
          },
        },
      }),
    });
    const body = (await response.json()) as {
      data?: { reactionCreate?: { success?: boolean; reaction?: { id?: string } } };
      errors?: Array<{ message?: string }>;
    };
    const errText =
      body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") ?? "";
    if (isDuplicateLinearReaction(errText)) {
      return {
        reactionId: `linear:${commentId || issueId}:${input.emoji}`,
      };
    }
    if (!response.ok || body.errors?.length || !body.data?.reactionCreate?.success) {
      const message = `Linear reaction failed (${response.status})${errText ? `: ${errText}` : ""}`;
      if ([400, 401, 403, 404].includes(response.status) || /entity not found/i.test(message)) {
        throw new PermanentAckError(message);
      }
      throw new Error(message);
    }
    return {
      reactionId:
        body.data.reactionCreate.reaction?.id ?? `linear:${commentId || issueId}:${input.emoji}`,
    };
  }

  async createActivity(input: LinearActivityInput): Promise<{ activityId?: string | undefined }> {
    if (
      !this.secrets.get(secretNames.linearAgentClientId(input.sourceId)) ||
      !this.secrets.get(secretNames.linearAgentClientSecret(input.sourceId))
    ) {
      throw new PermanentAckError(
        `renewable Linear app credentials are not configured for ${input.sourceId}`,
      );
    }
    let provider = this.providers.get(input.sourceId);
    if (!provider) {
      provider = new LinearAgentTokenProvider(input.sourceId, this.secrets, {
        fetch: this.fetchImpl,
      });
      this.providers.set(input.sourceId, provider);
    }
    let token = await provider.getToken();
    input.signal?.throwIfAborted();
    let response = await this.sendLinearActivity(token, input);
    if (response.status === 401) {
      provider.invalidate();
      token = await provider.getToken();
      input.signal?.throwIfAborted();
      response = await this.sendLinearActivity(token, input);
    }
    const body = (await response.json()) as {
      data?: { agentActivityCreate?: { success?: boolean; agentActivity?: { id?: string } } };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || body.errors?.length || !body.data?.agentActivityCreate?.success) {
      const detail = body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      const message = `Linear activity failed (${response.status})${detail ? `: ${detail}` : ""}`;
      if ([400, 401, 403, 404].includes(response.status)) {
        throw new PermanentAckError(message);
      }
      throw new Error(message);
    }
    return {
      activityId: body.data.agentActivityCreate.agentActivity?.id ?? input.idempotencyKey,
    };
  }

  private sendLinearActivity(token: string, input: LinearActivityInput): Promise<Response> {
    return this.fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      signal: providerSignal(input.signal),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation WakeWireAck($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success agentActivity { id } }
        }`,
        variables: {
          input: {
            id: input.idempotencyKey,
            agentSessionId: input.target,
            content: { type: input.contentType, body: input.text },
            ephemeral: input.ephemeral,
          },
        },
      }),
    });
  }
}

function buildRfcMessage(input: GmailReplyInput & { from: string; messageId: string }): string {
  const headers = [
    `From: ${headerValue(input.from)}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${headerValue(input.subject)}`,
    `Message-ID: ${headerValue(input.messageId)}`,
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDuplicateLinearReaction(errorText: string): boolean {
  return /already (?:exists|reacted)|duplicate reaction/i.test(errorText);
}

function providerSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
