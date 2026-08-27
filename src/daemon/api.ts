import crypto from "node:crypto";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { InvalidSourceReplyEventError, UnsupportedSourceReplyEventError } from "../agent/reply.js";
import {
  InvalidScheduledChannelDeliveryError,
  ScheduledChannelDeliveryAuthorizationError,
  ScheduledChannelDeliveryConflictError,
  ScheduledChannelDeliveryNotFoundError,
  type ScheduledChannelDeliveryService,
} from "../agent/scheduled-channel-delivery.js";
import {
  InvalidScheduledFollowupError,
  ScheduledFollowupAuthorizationError,
  ScheduledFollowupConflictError,
  ScheduledFollowupNotFoundError,
  type ScheduledFollowupService,
} from "../agent/scheduled-followup.js";
import type { DaemonConfig } from "../config.js";
import type { DeliveryQueue } from "../core/queue.js";
import { RouteInputSchema, SandboxPolicySchema } from "../core/route.js";
import type { DeliveryStatus, SourceRecord, Stores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { AgentAdapter } from "../sinks/types.js";
import { createSmeeChannel, GithubWebhookSource } from "../sources/github/source.js";
import { GmailSourceConfigSchema } from "../sources/gmail/source.js";
import type { LinearEnvironmentIdentity } from "../sources/linear/environment.js";
import { WebhookMappingSchema } from "../sources/webhook/map.js";
import { WebhookIngestSource } from "../sources/webhook/source.js";
import { WebhookVerificationSchema } from "../sources/webhook/verify.js";
import { VERSION } from "../version.js";
import type { SourceManager } from "./sources.js";

export interface ApiContext {
  stores: Stores;
  queue: DeliveryQueue;
  sources: SourceManager;
  secrets: SecretStore;
  adapter: AgentAdapter;
  config: DaemonConfig;
  logger: Logger;
  startedAt: string;
  scheduledChannelDeliveries: ScheduledChannelDeliveryService;
  scheduledFollowups: ScheduledFollowupService;
  linearEnvironment?: LinearEnvironmentIdentity | null;
  safetyScreening?: {
    policyVersion: string;
    mode: string;
    enforcing: boolean;
  };
}

export interface SlackSetupOptions {
  team: string;
  agentEmail?: string | undefined;
  includeBotMessages?: boolean | undefined;
  includeDirectMessages?: boolean | undefined;
  includeChannelMentions?: boolean | undefined;
}

const SLACK_SETUP_DEFAULTS = {
  agentEmail: "chip@snapcorp.com",
  includeBotMessages: false,
  includeDirectMessages: true,
  includeChannelMentions: true,
} as const;

/** Merge a repeatable Slack setup request without resetting omitted settings. */
export function resolveSlackSetupConfig(
  existing: SourceRecord | null,
  options: SlackSetupOptions,
): Record<string, unknown> {
  const previous = existing?.kind === "slack" ? existing.config : {};
  const previousAgentEmail =
    typeof previous.agentEmail === "string" ? previous.agentEmail : undefined;
  const agentEmail = options.agentEmail ?? previousAgentEmail ?? SLACK_SETUP_DEFAULTS.agentEmail;
  const sameAgent =
    previousAgentEmail !== undefined &&
    previousAgentEmail.toLocaleLowerCase("en-US") === agentEmail.toLocaleLowerCase("en-US");
  const config: Record<string, unknown> = {
    team: options.team,
    agentEmail,
    includeBotMessages:
      options.includeBotMessages ??
      (typeof previous.includeBotMessages === "boolean"
        ? previous.includeBotMessages
        : SLACK_SETUP_DEFAULTS.includeBotMessages),
    includeDirectMessages:
      options.includeDirectMessages ??
      (typeof previous.includeDirectMessages === "boolean"
        ? previous.includeDirectMessages
        : SLACK_SETUP_DEFAULTS.includeDirectMessages),
    includeChannelMentions:
      options.includeChannelMentions ??
      (typeof previous.includeChannelMentions === "boolean"
        ? previous.includeChannelMentions
        : SLACK_SETUP_DEFAULTS.includeChannelMentions),
  };

  if (sameAgent) {
    for (const key of ["agentTeamId", "agentUserId", "agentAppId"] as const) {
      if (typeof previous[key] === "string") config[key] = previous[key];
    }
  }
  return config;
}

/**
 * Localhost-only management API. Everything under /api requires the bearer
 * token from ~/.wakewire/daemon.json. /ingress is exempt — those requests
 * authenticate with webhook signatures instead.
 */
export function createApi(ctx: ApiContext): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEqual(token, ctx.config.apiToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/health", async (c) => {
    const reachable = await ctx.adapter.probe();
    return c.json({
      status: "ok",
      version: VERSION,
      pid: process.pid,
      startedAt: ctx.startedAt,
      adapter: { name: ctx.adapter.name, codexReachable: reachable },
      safetyScreening: ctx.safetyScreening,
      queueDepth: ctx.queue.queueDepth(),
      sources: ctx.sources.statuses(),
      secretsBackend: ctx.secrets.backend,
    });
  });

  // --- scheduled follow-ups ---

  app.post("/api/scheduled-followups/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        automationId: z.string(),
        originRequestId: z.string(),
        currentCodexThreadId: z.string(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid scheduled follow-up registration", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const result = ctx.scheduledFollowups.register(parsed.data);
      return c.json(
        {
          followupId: result.binding.id,
          automationId: result.binding.automationId,
          source: result.source,
          duplicate: result.duplicate,
        },
        result.duplicate ? 200 : 201,
      );
    } catch (error) {
      return scheduledFollowupError(c, error);
    }
  });

  app.post("/api/scheduled-followups/:id/complete", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        automationId: z.string(),
        currentCodexThreadId: z.string(),
        message: z.string(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid scheduled follow-up completion", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const result = ctx.scheduledFollowups.complete({
        followupId: c.req.param("id"),
        ...parsed.data,
      });
      return c.json(
        {
          followupId: result.binding.id,
          automationId: result.binding.automationId,
          accepted: true,
          duplicate: result.duplicate,
          terminalRequestId: result.request.id,
          sourceReply: {
            id: result.reply.id,
            status: result.reply.status,
            provider: result.reply.provider,
            error: result.reply.error,
          },
        },
        result.duplicate ? 200 : 201,
      );
    } catch (error) {
      return scheduledFollowupError(c, error);
    }
  });

  app.get("/api/scheduled-followups/:id", (c) => {
    try {
      const result = ctx.scheduledFollowups.status(c.req.param("id"));
      return c.json({
        followupId: result.binding.id,
        automationId: result.binding.automationId,
        originCodexThreadId: result.binding.originCodexThreadId,
        completedAt: result.binding.completedAt,
        terminal: result.terminal,
      });
    } catch (error) {
      return scheduledFollowupError(c, error);
    }
  });

  // --- recurring scheduled top-level Slack delivery ---

  app.post("/api/scheduled-channel-deliveries/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        automationId: z.string(),
        originRequestId: z.string(),
        currentCodexThreadId: z.string(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid scheduled channel delivery registration", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const result = ctx.scheduledChannelDeliveries.register(parsed.data);
      return c.json(
        {
          deliveryId: result.binding.id,
          automationId: result.binding.automationId,
          source: result.source,
          duplicate: result.duplicate,
        },
        result.duplicate ? 200 : 201,
      );
    } catch (error) {
      return scheduledChannelDeliveryError(c, error);
    }
  });

  app.post("/api/scheduled-channel-deliveries/:id/send", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        automationId: z.string(),
        currentCodexThreadId: z.string(),
        occurrenceKey: z.string(),
        message: z.string(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid scheduled channel delivery", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const result = ctx.scheduledChannelDeliveries.send({
        deliveryId: c.req.param("id"),
        ...parsed.data,
      });
      return c.json(
        {
          deliveryId: result.binding.id,
          automationId: result.binding.automationId,
          occurrenceKey: result.occurrenceKey,
          accepted: true,
          duplicate: result.duplicate,
          requestId: result.request.id,
          sourceReply: {
            id: result.reply.id,
            status: result.reply.status,
            provider: result.reply.provider,
            error: result.reply.error,
          },
        },
        result.duplicate ? 200 : 201,
      );
    } catch (error) {
      return scheduledChannelDeliveryError(c, error);
    }
  });

  app.get("/api/scheduled-channel-deliveries/:id", (c) => {
    try {
      const result = ctx.scheduledChannelDeliveries.status(c.req.param("id"));
      return c.json({
        deliveryId: result.binding.id,
        automationId: result.binding.automationId,
        originCodexThreadId: result.binding.originCodexThreadId,
        source: result.source,
        occurrences: result.occurrences.map(({ occurrence, request, sourceReply }) => ({
          occurrenceKey: occurrence.occurrenceKey,
          createdAt: occurrence.createdAt,
          request,
          sourceReply,
        })),
      });
    } catch (error) {
      return scheduledChannelDeliveryError(c, error);
    }
  });

  // --- routes ---

  app.get("/api/routes", (c) => c.json({ routes: ctx.stores.routes.list() }));

  app.post("/api/routes", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RouteInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid route", issues: parsed.error.issues }, 400);
    }
    const route = ctx.stores.routes.create(parsed.data);
    const warnings: string[] = [];
    if (route.source === "gmail") {
      const gmailSources = ctx.stores.sources.findByKind("gmail");
      const label = (route.match as { label?: string }).label?.toLowerCase();
      if (!gmailSources.some((s) => String(s.config.label ?? "").toLowerCase() === label)) {
        warnings.push(
          `no gmail source watches label "${label}" yet — run wakewire_source_setup_gmail or wakewire auth gmail`,
        );
      }
    }
    if (route.source === "github" && ctx.stores.sources.findByKind("github").length === 0) {
      warnings.push("no github source configured yet — run wakewire_source_setup_github");
    }
    ctx.logger.info({ route: route.name, id: route.id }, "route created");
    return c.json({ route, warnings }, 201);
  });

  app.delete("/api/routes/:id", (c) => {
    const removed = ctx.stores.routes.remove(c.req.param("id"));
    return removed ? c.json({ ok: true }) : c.json({ error: "route not found" }, 404);
  });

  app.post("/api/routes/:id/toggle", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const enabled = z.object({ enabled: z.boolean() }).safeParse(body);
    if (!enabled.success) return c.json({ error: "body must be {enabled: boolean}" }, 400);
    const ok = ctx.stores.routes.setEnabled(c.req.param("id"), enabled.data.enabled);
    return ok ? c.json({ ok: true }) : c.json({ error: "route not found" }, 404);
  });

  // --- deliveries ---

  app.get("/api/deliveries", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const routeId = c.req.query("routeId");
    const status = c.req.query("status") as DeliveryStatus | undefined;
    const deliveries = ctx.stores.deliveries
      .list({
        limit: Number.isFinite(limit) ? limit : 50,
        ...(routeId ? { routeId } : {}),
        ...(status ? { status } : {}),
      })
      .map(publicDelivery);
    return c.json({ deliveries });
  });

  app.post("/api/deliveries/:id/replay", (c) => {
    try {
      const delivery = ctx.queue.replay(c.req.param("id"));
      return c.json({ delivery: publicDelivery(delivery) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // --- sources ---

  app.get("/api/sources", (c) =>
    c.json({
      sources: ctx.stores.sources.list().map((s) => ({
        ...s,
        config: redactSourceConfig(s.config),
        live: ctx.sources.statuses()[s.id] ?? null,
      })),
    }),
  );

  app.post("/api/sources/github/setup", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional(),
        mode: z.enum(["smee", "listen"]).default("smee"),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    // Deterministic id: re-running setup for the same repo updates the same
    // source (and keeps its smee channel) instead of accumulating new ones.
    const sourceId = deterministicSourceId("github", parsed.data.repo ?? "default");
    const existing = ctx.stores.sources.get(sourceId);

    // Preserve the existing secret on re-setup (same rule as the generic
    // webhook source): a repeated setup call must not silently invalidate the
    // secret the user already pasted into GitHub.
    let secret = ctx.secrets.get(secretNames.githubWebhookSecret(sourceId));
    const isNewSecret = !secret;
    if (!secret) secret = crypto.randomBytes(24).toString("hex");
    let smeeUrl: string | undefined;
    if (parsed.data.mode === "smee") {
      const existingUrl = existing?.config.smeeUrl;
      if (typeof existingUrl === "string" && existingUrl.length > 0) {
        smeeUrl = existingUrl;
      } else {
        try {
          smeeUrl = await createSmeeChannel();
        } catch (err) {
          return c.json(
            {
              error: `could not create smee.io channel: ${err instanceof Error ? err.message : err}`,
            },
            502,
          );
        }
      }
    }
    const record = ctx.stores.sources.upsert({
      id: sourceId,
      kind: "github",
      config: {
        mode: parsed.data.mode,
        ...(smeeUrl ? { smeeUrl } : {}),
        ...(parsed.data.repo ? { repo: parsed.data.repo } : {}),
      },
    });
    if (isNewSecret) ctx.secrets.set(secretNames.githubWebhookSecret(record.id), secret);
    await ctx.sources.restart(record.id);

    const payloadUrl = smeeUrl ?? `http://127.0.0.1:<your-tunnel>/ingress/github/${record.id}`;
    return c.json(
      {
        sourceId: record.id,
        mode: parsed.data.mode,
        webhookUrl: payloadUrl,
        secret,
        instructions: [
          `1. Open https://github.com/${parsed.data.repo ?? "<owner>/<repo>"}/settings/hooks/new`,
          `2. Payload URL: ${payloadUrl}`,
          "3. Content type: application/json",
          `4. Secret: ${secret}${isNewSecret ? "" : " (unchanged from previous setup)"}`,
          "5. Choose the events to send (at least: pushes), then Add webhook.",
          "6. GitHub sends a ping — check wakewire_status / GET /api/sources to confirm receipt.",
        ],
      },
      201,
    );
  });

  app.post("/api/sources/gmail/setup", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        label: z.string().min(1),
        user: z.string().email(),
        authKind: z.enum(["gmail-oauth", "imap-password"]).default("gmail-oauth"),
        /** imap-password only; defaults suit Gmail app passwords. */
        host: z.string().min(1).default("imap.gmail.com"),
        port: z.number().int().positive().default(993),
        secure: z.boolean().default(true),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const { label, user, authKind, host, port, secure } = parsed.data;
    const sourceId = deterministicSourceId("gmail", `${user}:${label}`);
    const existing = ctx.stores.sources.get(sourceId);
    const config = GmailSourceConfigSchema.parse({
      label,
      auth:
        authKind === "gmail-oauth"
          ? { kind: "gmail-oauth", user }
          : { kind: "imap-password", user, host, port, secure },
      // Re-running setup must not reset the UID watermark and replay old mail.
      ...(existing?.config.state ? { state: existing.config.state } : {}),
    });
    const record = ctx.stores.sources.upsert({ id: sourceId, kind: "gmail", config });
    const instructions =
      authKind === "gmail-oauth"
        ? [
            "Gmail needs a one-time OAuth consent in a browser, so this step runs in a terminal:",
            `1. Create an OAuth client (Desktop app) in Google Cloud Console with the Gmail IMAP scope (https://mail.google.com/). WakeWire is self-hosted, so you bring your own client id/secret — this avoids Google's restricted-scope app verification.`,
            `2. Run: wakewire auth gmail --source ${record.id}`,
            `3. The daemon will start watching label "${label}" once auth completes.`,
          ]
        : [
            `This source authenticates with a password against ${host}:${port}.`,
            host === "imap.gmail.com"
              ? "1. For Gmail, create an app password at https://myaccount.google.com/apppasswords (requires 2-Step Verification). Your normal account password will not work."
              : "1. Use the account's IMAP password or an app password if the provider supports them.",
            `2. Run: wakewire auth imap --source ${record.id}`,
            `3. The daemon will start watching label/folder "${label}" once the password is stored.`,
          ];
    return c.json({ sourceId: record.id, authKind, instructions }, 201);
  });

  app.post("/api/sources/webhook/setup", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        name: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9][a-z0-9_-]*$/i),
        mode: z.enum(["smee", "listen"]).default("smee"),
        verification: WebhookVerificationSchema,
        mapping: WebhookMappingSchema.optional(),
        /** How many upcoming raw payloads to capture for mapping authoring. */
        capture: z.number().int().min(0).max(10).optional(),
        rotateSecret: z.boolean().default(false),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    if (input.mode === "smee" && input.verification.kind === "secret-header") {
      return c.json(
        {
          error:
            'secret-header verification would transit the public smee relay and expose the secret — use mode "listen" (your own tunnel) or hmac-sha256',
        },
        400,
      );
    }
    const sourceId = deterministicSourceId("webhook", input.name);
    const existing = ctx.stores.sources.get(sourceId);

    let smeeUrl: string | undefined;
    if (input.mode === "smee") {
      const existingUrl = existing?.config.smeeUrl;
      if (typeof existingUrl === "string" && existingUrl.length > 0) {
        smeeUrl = existingUrl;
      } else {
        try {
          smeeUrl = await createSmeeChannel();
        } catch (err) {
          return c.json(
            {
              error: `could not create smee.io channel: ${err instanceof Error ? err.message : err}`,
            },
            502,
          );
        }
      }
    }

    // Keep the existing secret on re-setup (mapping iterations must not break
    // the provider config); rotate only on request or first creation.
    let secret: string | null = null;
    if (!existing || input.rotateSecret || !ctx.secrets.get(secretNames.webhookSecret(sourceId))) {
      secret = crypto.randomBytes(24).toString("hex");
      ctx.secrets.set(secretNames.webhookSecret(sourceId), secret);
    }

    const config = {
      name: input.name,
      mode: input.mode,
      ...(smeeUrl ? { smeeUrl } : {}),
      verification: input.verification,
      ...(input.mapping
        ? { mapping: input.mapping }
        : existing?.config.mapping
          ? { mapping: existing.config.mapping }
          : {}),
      ...(typeof existing?.config.linearAppUserId === "string"
        ? { linearAppUserId: existing.config.linearAppUserId }
        : {}),
      ...(input.name.trim().toLowerCase() === "linear" && ctx.linearEnvironment
        ? {
            linearUserId: ctx.linearEnvironment.id,
            linearOrganizationId: ctx.linearEnvironment.organizationId,
          }
        : {
            ...(typeof existing?.config.linearUserId === "string"
              ? { linearUserId: existing.config.linearUserId }
              : {}),
            ...(typeof existing?.config.linearOrganizationId === "string"
              ? { linearOrganizationId: existing.config.linearOrganizationId }
              : {}),
          }),
      captureRemaining:
        input.capture ?? (existing ? Number(existing.config.captureRemaining ?? 0) : 3),
    };
    const record = ctx.stores.sources.upsert({ id: sourceId, kind: "webhook", config });
    await ctx.sources.restart(record.id);

    const payloadUrl = smeeUrl ?? `http://127.0.0.1:<your-tunnel>/ingress/webhook/${record.id}`;
    const verificationHint =
      input.verification.kind === "hmac-sha256"
        ? `HMAC-SHA256 of the raw body, ${input.verification.encoding}-encoded${input.verification.prefix ? `, prefixed "${input.verification.prefix}"` : ""}, in the "${input.verification.header}" header`
        : `the shared secret sent verbatim in the "${input.verification.header}" header`;
    return c.json(
      {
        sourceId: record.id,
        provider: input.name,
        webhookUrl: payloadUrl,
        secret,
        captureRemaining: config.captureRemaining,
        instructions: [
          `1. Point ${input.name}'s webhook at: ${payloadUrl}`,
          secret
            ? `2. Configure its signing secret: ${secret}`
            : "2. Signing secret unchanged (pass rotateSecret to mint a new one). If the provider issues its own secret, store it with: wakewire auth webhook --source " +
              record.id,
          `3. Signature expected: ${verificationHint}.`,
          config.captureRemaining > 0
            ? `4. The next ${config.captureRemaining} event(s) will be captured raw. Send a test event, inspect it with wakewire_source_captures, then re-run this setup with a mapping.`
            : "4. Mapping is set — events flow through it. Re-run setup with a new mapping to change it.",
          ...(input.name.trim().toLowerCase() === "linear"
            ? ctx.linearEnvironment
              ? [
                  `5. Dedicated Linear user ${ctx.linearEnvironment.name} (${ctx.linearEnvironment.id}) is pinned from the 1Password-backed LINEAR_API_KEY.`,
                  "6. Subscribe this webhook to Issue and Comment events for @Chip mentions and assignments.",
                ]
              : [
                  "5. In the Linear OAuth app, enable Agent session events and client-credentials tokens with read, write, app:mentionable, and app:assignable scopes.",
                  `6. Run wakewire auth linear-agent --source ${record.id}; it mints renewable app credentials and pins Linear viewer.id before privileged @Chip dispatch is enabled.`,
                ]
            : []),
        ],
      },
      201,
    );
  });

  app.get("/api/sources/:id/captures", (c) => {
    const id = c.req.param("id");
    if (!ctx.stores.sources.get(id)) return c.json({ error: "source not found" }, 404);
    const limit = Number(c.req.query("limit") ?? "5");
    return c.json({
      captures: ctx.stores.captures.list(id, Number.isFinite(limit) ? limit : 5),
    });
  });

  app.post("/api/sources/slack/setup", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        team: z.string().min(1).optional(),
        agentEmail: z.string().email().optional(),
        includeBotMessages: z.boolean().optional(),
        includeDirectMessages: z.boolean().optional(),
        includeChannelMentions: z.boolean().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const team = parsed.data.team ?? "default";
    const sourceId = deterministicSourceId("slack", team);
    const existing = ctx.stores.sources.get(sourceId);
    const config = resolveSlackSetupConfig(existing, { ...parsed.data, team });
    const record = ctx.stores.sources.upsert({
      id: sourceId,
      kind: "slack",
      config,
    });
    return c.json(
      {
        sourceId: record.id,
        instructions: slackSetupInstructions(record.id, String(config.agentEmail)),
      },
      201,
    );
  });

  app.post("/api/sources/:id/restart", async (c) => {
    const ok = await ctx.sources.restart(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "source not found" }, 404);
  });

  app.delete("/api/sources/:id", async (c) => {
    const id = c.req.param("id");
    const record = ctx.stores.sources.get(id);
    if (!record) return c.json({ error: "source not found" }, 404);
    await ctx.sources.remove(id);
    removeSourceSecrets(ctx.secrets, record);
    ctx.stores.captures.removeForSource(id);
    return c.json({ ok: true });
  });

  // --- test injection (M1 demo + smoke tests) ---

  app.post("/api/inject", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        threadId: z.string().min(1),
        prompt: z.string().min(1),
        sandbox: SandboxPolicySchema.default("read-only"),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    try {
      const result = await ctx.adapter.deliverToThread(parsed.data.threadId, parsed.data.prompt, {
        sandbox: parsed.data.sandbox,
      });
      return c.json({ result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // --- webhook ingress (listen-mode github sources; signature-authenticated) ---

  app.post("/ingress/webhook/:sourceId", async (c) => {
    const source = ctx.sources.get(c.req.param("sourceId"));
    if (!source || !(source instanceof WebhookIngestSource)) {
      return c.json({ error: "unknown source" }, 404);
    }
    const rawBody = await c.req.text();
    const result = await source.handleWebhook({
      getHeader: (name) => c.req.header(name),
      rawBody,
    });
    return c.json({ message: result.message }, result.status as 200);
  });

  app.post("/ingress/github/:sourceId", async (c) => {
    const source = ctx.sources.get(c.req.param("sourceId"));
    if (!source || !(source instanceof GithubWebhookSource)) {
      return c.json({ error: "unknown source" }, 404);
    }
    const rawBody = await c.req.text();
    const result = await source.handleWebhook({
      eventName: c.req.header("x-github-event"),
      deliveryId: c.req.header("x-github-delivery"),
      signature: c.req.header("x-hub-signature-256"),
      rawBody,
    });
    return c.json({ message: result.message }, result.status as 200);
  });

  return app;
}

export function slackSetupInstructions(
  sourceId: string,
  agentEmail = "chip@snapcorp.com",
): string[] {
  return [
    "Slack connects over Socket Mode (an outbound WebSocket) — no public URL needed. One-time app setup:",
    "1. Create a Slack app at https://api.slack.com/apps → 'Create New App' → 'From scratch'. This app authorizes Chip's existing normal Slack account; do not add a bot user.",
    "2. Settings → Socket Mode: enable it. Generate the app-level token with the connections:write scope (starts with xapp-).",
    "3. Features → OAuth & Permissions → User Token Scopes: add channels:history, channels:read, chat:write, im:history, mpim:history, reactions:write, users:read, and users:read.email (add groups:history/groups:read only if Chip should receive private-channel mentions). chat:write lets Chip's existing user token return completed Codex answers to the originating Slack thread.",
    "4. Features → Event Subscriptions: enable, and under 'Subscribe to events on behalf of users' add message.im, message.mpim, and message.channels (add message.groups only for private-channel mentions). Do not use Bot Events or app_mention.",
    `5. While signed in as the existing Chip account (${agentEmail}), install/reinstall the app and copy its User OAuth Token (starts with xoxp-).`,
    "6. Keep this app authorized only by Chip. WakeWire requires every event to match the pinned Slack app ID plus Chip's non-bot user and workspace IDs.",
    `7. In a terminal run: wakewire auth slack --source ${sourceId}  — it prompts for both tokens (hidden input).`,
    "8. WakeWire validates that xapp and xoxp belong to the same immutable Slack app, then pins that app plus Chip's user/workspace IDs and profile email. No second Slack account, App Home Messages tab, or channel invitation is used.",
  ];
}

/** Best-effort cleanup of every well-known credential owned by a source. */
export function removeSourceSecrets(secrets: SecretStore, record: SourceRecord): void {
  const id = record.id;
  const secretsByKind: Record<SourceRecord["kind"], string[]> = {
    github: [secretNames.githubWebhookSecret(id), secretNames.githubApiToken(id)],
    gmail: [
      secretNames.gmailClientId(id),
      secretNames.gmailClientSecret(id),
      secretNames.gmailRefreshToken(id),
      secretNames.imapPassword(id),
    ],
    slack: [
      secretNames.slackAppToken(id),
      secretNames.slackUserToken(id),
      secretNames.slackBotToken(id),
    ],
    webhook: [
      secretNames.webhookSecret(id),
      ...(String(record.config.name ?? "")
        .trim()
        .toLowerCase() === "linear"
        ? [
            secretNames.linearAgentToken(id),
            secretNames.linearAgentTokenExpiresAt(id),
            secretNames.linearAgentClientId(id),
            secretNames.linearAgentClientSecret(id),
          ]
        : []),
    ],
  };
  for (const name of secretsByKind[record.kind]) secrets.delete(name);
}

function publicDelivery(d: {
  id: string;
  routeId: string;
  sourceDeliveryId: string;
  receivedAt: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  event: unknown;
  renderedPrompt: string | null;
  threadId: string | null;
  turnId: string | null;
  error: string | null;
  coalescedInto: string | null;
  isReplay: boolean;
}) {
  return d;
}

function redactSourceConfig(config: Record<string, unknown>): Record<string, unknown> {
  // Source configs hold no secrets by design (secrets live in the secret
  // store), but keep this seam so nothing sensitive can leak by accident.
  return config;
}

function deterministicSourceId(kind: string, key: string): string {
  return `${kind}-${key.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-")}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function scheduledFollowupError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ScheduledFollowupNotFoundError) {
    return c.json({ error: message }, 404);
  }
  if (error instanceof ScheduledFollowupAuthorizationError) {
    return c.json({ error: message }, 403);
  }
  if (error instanceof ScheduledFollowupConflictError) {
    return c.json({ error: message }, 409);
  }
  if (
    error instanceof InvalidScheduledFollowupError ||
    error instanceof InvalidSourceReplyEventError ||
    error instanceof UnsupportedSourceReplyEventError
  ) {
    return c.json({ error: message }, 400);
  }
  throw error;
}

function scheduledChannelDeliveryError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ScheduledChannelDeliveryNotFoundError) {
    return c.json({ error: message }, 404);
  }
  if (error instanceof ScheduledChannelDeliveryAuthorizationError) {
    return c.json({ error: message }, 403);
  }
  if (error instanceof ScheduledChannelDeliveryConflictError) {
    return c.json({ error: message }, 409);
  }
  if (
    error instanceof InvalidScheduledChannelDeliveryError ||
    error instanceof InvalidSourceReplyEventError ||
    error instanceof UnsupportedSourceReplyEventError
  ) {
    return c.json({ error: message }, 400);
  }
  throw error;
}
