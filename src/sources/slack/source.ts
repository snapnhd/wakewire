import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import type { Source, SourceContext } from "../types.js";
import { isBotEvent, slackToWakeEvent } from "./normalize.js";

export const SlackSourceConfigSchema = z
  .object({
    /** Informational workspace name used in the deterministic source id. */
    team: z.string().min(1).default("default"),
    /** Expected email of the normal Slack account that represents Chip. */
    agentEmail: z.string().email().default("chip@snapcorp.com"),
    /** Pinned from the app-level token and required on every event envelope. */
    agentAppId: z.string().min(1).optional(),
    /** Pinned by `wakewire auth slack` after validating Chip's user token. */
    agentTeamId: z.string().min(1).optional(),
    /** Pinned by `wakewire auth slack` after validating Chip's user token. */
    agentUserId: z.string().min(1).optional(),
    /** Deliver messages posted by bots/integrations too. Off by default. */
    includeBotMessages: z.boolean().default(false),
    /** Treat authenticated one-to-one messages to Chip as Chip requests. */
    includeDirectMessages: z.boolean().default(true),
    /** Treat exact Slack user-ID mentions of Chip in channels or group PMs as Chip requests. */
    includeChannelMentions: z.boolean().default(true),
  })
  .refine(
    (config) => {
      const pins = [config.agentAppId, config.agentTeamId, config.agentUserId].map(Boolean);
      return pins.every((present) => present === pins[0]);
    },
    {
      message: "agentAppId, agentTeamId, and agentUserId must be pinned together",
    },
  );

export type SlackSourceConfig = z.infer<typeof SlackSourceConfigSchema>;

export interface SlackEventAuthorization {
  team_id?: string;
  user_id?: string;
  is_bot?: boolean;
}

export interface SlackEventBody {
  event_id?: string;
  api_app_id?: string;
  team_id?: string;
  event?: Record<string, unknown>;
  authorizations?: SlackEventAuthorization[];
}

export interface SlackAuthIdentity {
  app_id?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
}

interface SlackEnvelope {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  type: string;
  body: SlackEventBody;
  retry_num?: number;
}

/**
 * Slack source over Socket Mode: an outbound WebSocket authenticated with an
 * app-level token (xapp-…), so — like the smee relay for GitHub — no public
 * HTTP endpoint is needed. A user OAuth token (xoxp-…) scoped to Chip's normal
 * Slack account supplies event visibility, identity resolution, and reactions.
 *
 * Deliverable events are acked only after they are durably enqueued (see
 * handleEnvelope); un-acked envelopes are redelivered by Slack with the same
 * event_id, and dedup collapses them.
 */
export class SlackSocketSource implements Source {
  readonly kind = "slack" as const;
  private client: SocketModeClient | null = null;
  private web: WebClient | null = null;
  private connected = false;
  private received = 0;
  private skippedBots = 0;
  private skippedAuthorizations = 0;
  private lastEventAt: string | null = null;
  private lastError: string | null = null;
  private readonly channelNames = new Map<string, string | undefined>();
  private readonly userNames = new Map<string, string | undefined>();

  constructor(
    readonly id: string,
    private readonly config: SlackSourceConfig,
    private readonly secrets: SecretStore,
    private readonly ctx: SourceContext,
  ) {}

  async start(): Promise<void> {
    const appToken = this.secrets.get(secretNames.slackAppToken(this.id));
    const userToken = this.secrets.get(secretNames.slackUserToken(this.id));
    if (!appToken) {
      throw new Error(`no Slack app token stored for source ${this.id} — run: wakewire auth slack`);
    }
    if (!userToken) {
      throw new Error(
        `no Slack user token stored for source ${this.id} — run: wakewire auth slack`,
      );
    }
    if (!this.config.agentAppId || !this.config.agentTeamId || !this.config.agentUserId) {
      throw new Error(
        `Slack app/agent identity is not pinned for ${this.id} — run: wakewire auth slack`,
      );
    }
    const web = new WebClient(userToken);
    await this.validateAgentIdentity(web);
    this.web = web;

    const client = new SocketModeClient({ appToken, logger: noopSlackLogger() });
    this.client = client;

    client.on("connected", () => {
      this.connected = true;
      this.lastError = null;
      this.ctx.logger.info({ source: this.id }, "slack socket connected");
    });
    client.on("disconnected", () => {
      this.connected = false;
      this.ctx.logger.warn(
        { source: this.id },
        "slack socket disconnected — client will reconnect",
      );
    });
    client.on("error", (err: Error) => {
      this.lastError = err.message;
      this.ctx.logger.warn({ source: this.id, err: err.message }, "slack socket error");
    });

    client.on("slack_event", (envelope: SlackEnvelope) => {
      void this.handleEnvelope(envelope).catch((err) => {
        this.ctx.logger.warn({ source: this.id, err: String(err) }, "slack event handling failed");
      });
    });

    await client.start();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.web = null;
    this.connected = false;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // socket already gone
      }
    }
  }

  status(): Record<string, unknown> {
    return {
      team: this.config.team,
      agentEmail: this.config.agentEmail,
      agentAppId: this.config.agentAppId ?? null,
      agentTeamId: this.config.agentTeamId ?? null,
      agentUserId: this.config.agentUserId ?? null,
      includeDirectMessages: this.config.includeDirectMessages,
      includeChannelMentions: this.config.includeChannelMentions,
      connected: this.connected,
      received: this.received,
      skippedBots: this.skippedBots,
      skippedAuthorizations: this.skippedAuthorizations,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  /**
   * Ack ordering: events we won't deliver are acked immediately, but
   * deliverable events are acked only AFTER ctx.emit() returns — emit is
   * synchronous through route matching and the SQLite enqueue, so an ack
   * means the event is durably queued. If anything throws (or the process
   * dies) before that, the envelope stays un-acked and Slack redelivers with
   * the same event_id, which our dedup collapses. Cached names are used during
   * that window; misses are warmed only after durable accept and acknowledgment.
   */
  private async handleEnvelope(envelope: SlackEnvelope): Promise<void> {
    if (envelope.type !== "events_api") {
      await envelope.ack();
      return;
    }
    const event = envelope.body.event;
    const eventId = envelope.body.event_id;
    if (!event || !eventId) {
      await envelope.ack();
      return;
    }
    if (!this.isChipUserAuthorization(envelope)) {
      this.skippedAuthorizations++;
      await envelope.ack();
      return;
    }
    // Final replies are posted with Chip's normal user token. Slack sends those
    // messages back over Socket Mode, so reject the pinned agent principal at
    // ingress before either the privileged dispatcher or ordinary routes can
    // observe it.
    if (isPinnedSlackAgentAuthoredEvent(event, this.config)) {
      await envelope.ack();
      return;
    }
    if (!this.config.includeBotMessages && isBotEvent(event)) {
      this.skippedBots++;
      await envelope.ack();
      return;
    }

    const channelId = strOf(event.channel);
    const userId = strOf(event.user);
    // Never spend Slack's transport-ack window on optional display-name API
    // calls. Cached names are used when available; misses are warmed after the
    // durable local accept and envelope acknowledgement.
    const names = {
      channelName: this.channelNames.get(channelId),
      userName: this.userNames.get(userId),
    };
    const wakeEvent = slackToWakeEvent({
      event,
      eventId,
      teamId: envelope.body.team_id,
      names,
      sourceId: this.id,
      targetUserId: this.config.agentUserId,
      includeDirectMessages: this.config.includeDirectMessages,
      includeChannelMentions: this.config.includeChannelMentions,
    });
    if (!wakeEvent) {
      await envelope.ack();
      return;
    }
    this.received++;
    this.lastEventAt = new Date().toISOString();
    this.ctx.emit(wakeEvent); // synchronous: matches routes and enqueues to SQLite
    await envelope.ack();
    void Promise.all([this.resolveChannel(channelId), this.resolveUser(userId)]);
  }

  private isChipUserAuthorization(envelope: SlackEnvelope): boolean {
    return isPinnedSlackUserAuthorization(envelope.body, this.config);
  }

  private async validateAgentIdentity(web: WebClient): Promise<void> {
    const expectedAppId = this.config.agentAppId;
    const expectedTeamId = this.config.agentTeamId;
    const expectedUserId = this.config.agentUserId;
    if (!expectedAppId || !expectedTeamId || !expectedUserId) {
      throw new Error("Slack app/agent identity is not pinned");
    }
    const auth = (await web.auth.test()) as SlackAuthIdentity;
    if (auth.bot_id) throw new Error("Slack user token resolved to a bot identity");
    const returnedAppId = auth.app_id?.trim();
    if (returnedAppId && returnedAppId !== expectedAppId) {
      throw new Error("Slack user token does not match the pinned Slack app");
    }
    if (!isPinnedSlackAuthIdentity(auth, this.config)) {
      throw new Error("Slack user token does not match the pinned Chip account");
    }
    const info = await web.users.info({ user: expectedUserId });
    if (info.user?.is_bot || info.user?.is_app_user) {
      throw new Error("Slack user token resolved to a bot/app identity");
    }
    const email = info.user?.profile?.email?.trim().toLocaleLowerCase("en-US");
    if (email !== this.config.agentEmail.trim().toLocaleLowerCase("en-US")) {
      throw new Error("Slack user token profile email does not match the configured Chip email");
    }
  }

  private async resolveChannel(id: string): Promise<string | undefined> {
    if (!id || !this.web) return undefined;
    if (this.channelNames.has(id)) return this.channelNames.get(id);
    let name: string | undefined;
    try {
      const info = await this.web.conversations.info({ channel: id });
      name = info.channel?.name ?? undefined;
    } catch {
      name = undefined; // token lacks access/scope — ids still work for matching
    }
    this.channelNames.set(id, name);
    return name;
  }

  private async resolveUser(id: string): Promise<string | undefined> {
    if (!id || !this.web) return undefined;
    if (this.userNames.has(id)) return this.userNames.get(id);
    let name: string | undefined;
    try {
      const info = await this.web.users.info({ user: id });
      name = info.user?.profile?.display_name || info.user?.real_name || info.user?.name;
    } catch {
      name = undefined;
    }
    this.userNames.set(id, name);
    return name;
  }
}

/** True only for an event authored by the immutable Slack user pinned as Chip. */
export function isPinnedSlackAgentAuthoredEvent(
  event: Record<string, unknown>,
  config: SlackSourceConfig,
): boolean {
  return Boolean(config.agentUserId) && strOf(event.user) === config.agentUserId;
}

/**
 * Slack's standard auth.test user-token response omits app_id. Accept that
 * documented shape while still rejecting any explicit mismatch and requiring
 * the immutable normal-user/workspace pins. App identity is enforced again on
 * every Socket Mode envelope by isPinnedSlackUserAuthorization.
 */
export function isPinnedSlackAuthIdentity(
  auth: SlackAuthIdentity,
  config: SlackSourceConfig,
): boolean {
  const appId = config.agentAppId;
  const teamId = config.agentTeamId;
  const userId = config.agentUserId;
  if (!appId || !teamId || !userId || auth.bot_id) return false;
  const returnedAppId = auth.app_id?.trim();
  return (
    (!returnedAppId || returnedAppId === appId) &&
    auth.team_id === teamId &&
    auth.user_id === userId
  );
}

/** Require the Socket Mode event to be visible specifically as pinned human Chip. */
export function isPinnedSlackUserAuthorization(
  body: SlackEventBody,
  config: SlackSourceConfig,
): boolean {
  const appId = config.agentAppId;
  const teamId = config.agentTeamId;
  const userId = config.agentUserId;
  if (!appId || !teamId || !userId || body.api_app_id !== appId || body.team_id !== teamId) {
    return false;
  }
  return Boolean(
    body.authorizations?.some(
      (authorization) =>
        authorization.team_id === teamId &&
        authorization.user_id === userId &&
        authorization.is_bot === false,
    ),
  );
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The SDK's default logger writes to stdout; route everything through pino instead. */
function noopSlackLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    setLevel: () => {},
    getLevel: () => LogLevel.ERROR,
    setName: () => {},
  };
}
