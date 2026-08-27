import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiFetch, DaemonNotRunningError } from "../client.js";
import { WebhookMappingSchema } from "../sources/webhook/map.js";
import { WebhookVerificationSchema } from "../sources/webhook/verify.js";
import { VERSION } from "../version.js";

/**
 * Stdio MCP server bundled in the Codex plugin. It is a thin, stateless client
 * of the daemon's localhost API — all state lives in the daemon.
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "wakewire", version: VERSION });

  server.registerTool(
    "wakewire_status",
    {
      title: "WakeWire status",
      description:
        "Health of the wakewire daemon: sources, queue depth, and whether Codex is reachable.",
      inputSchema: {},
    },
    async () => call("GET", "/api/health"),
  );

  server.registerTool(
    "wakewire_followup_register",
    {
      title: "Register a WakeWire scheduled follow-up",
      description:
        "Bind a paused, thread-targeted Codex automation to the authenticated WakeWire request " +
        "that created it. Register before activating the automation; provider reply targets remain " +
        "server-side and cannot be supplied by the caller.",
      inputSchema: {
        automationId: z.string().min(1).describe("Codex automation id"),
        originRequestId: z.string().min(1).describe("Authenticated WakeWire request id"),
        currentCodexThreadId: z
          .string()
          .min(1)
          .describe("Current Codex task id from CODEX_THREAD_ID"),
      },
    },
    async (args) => call("POST", "/api/scheduled-followups/register", args),
  );

  server.registerTool(
    "wakewire_followup_complete",
    {
      title: "Complete a WakeWire scheduled follow-up",
      description:
        "Queue the terminal message exactly once through WakeWire's durable provider reply outbox. " +
        "The opaque binding, automation id, and current Codex task must all match.",
      inputSchema: {
        followupId: z.string().min(1).describe("Opaque id returned by registration"),
        automationId: z.string().min(1).describe("Codex automation id"),
        currentCodexThreadId: z
          .string()
          .min(1)
          .describe("Current Codex task id from CODEX_THREAD_ID"),
        message: z.string().min(1).describe("Exact terminal message body"),
      },
    },
    async ({ followupId, ...body }) =>
      call("POST", `/api/scheduled-followups/${encodeURIComponent(followupId)}/complete`, body),
  );

  server.registerTool(
    "wakewire_followup_status",
    {
      title: "Inspect a WakeWire scheduled follow-up",
      description: "Show a scheduled follow-up binding and its terminal provider-reply status.",
      inputSchema: {
        followupId: z.string().min(1).describe("Opaque id returned by registration"),
      },
    },
    async ({ followupId }) =>
      call("GET", `/api/scheduled-followups/${encodeURIComponent(followupId)}`),
  );

  server.registerTool(
    "wakewire_scheduled_channel_register",
    {
      title: "Register a recurring WakeWire Slack channel delivery",
      description:
        "Bind an existing thread-targeted Codex automation to the authenticated WakeWire " +
        "request that created it. WakeWire derives the exact Slack workspace/channel from the " +
        "frozen origin; callers cannot supply or retarget a destination.",
      inputSchema: {
        automationId: z.string().min(1).describe("Codex automation id"),
        originRequestId: z.string().min(1).describe("Authenticated WakeWire request id"),
        currentCodexThreadId: z
          .string()
          .min(1)
          .describe("Current Codex task id from CODEX_THREAD_ID"),
      },
    },
    async (args) => call("POST", "/api/scheduled-channel-deliveries/register", args),
  );

  server.registerTool(
    "wakewire_scheduled_channel_send",
    {
      title: "Send one recurring Slack channel occurrence through WakeWire",
      description:
        "Queue one top-level Slack message through Chip's WakeWire user token. The opaque " +
        "binding fixes the channel, and occurrenceKey makes identical retries idempotent while " +
        "conflicting content fails closed.",
      inputSchema: {
        deliveryId: z.string().min(1).describe("Opaque id returned by registration"),
        automationId: z.string().min(1).describe("Codex automation id"),
        currentCodexThreadId: z
          .string()
          .min(1)
          .describe("Current Codex task id from CODEX_THREAD_ID"),
        occurrenceKey: z
          .string()
          .min(1)
          .describe("Stable logical run key, for example 2026-07-29@America/Chicago"),
        message: z.string().min(1).describe("Exact top-level Slack message body"),
      },
    },
    async ({ deliveryId, ...body }) =>
      call(
        "POST",
        `/api/scheduled-channel-deliveries/${encodeURIComponent(deliveryId)}/send`,
        body,
      ),
  );

  server.registerTool(
    "wakewire_scheduled_channel_status",
    {
      title: "Inspect a recurring WakeWire Slack channel binding",
      description:
        "Show the immutable automation/task binding without exposing its Slack destination.",
      inputSchema: {
        deliveryId: z.string().min(1).describe("Opaque id returned by registration"),
      },
    },
    async ({ deliveryId }) =>
      call("GET", `/api/scheduled-channel-deliveries/${encodeURIComponent(deliveryId)}`),
  );

  server.registerTool(
    "wakewire_route_add",
    {
      title: "Add a wakewire route",
      description:
        "Create a route that delivers matching external events into a Codex thread. " +
        'For GitHub, match is like {"repo":"owner/repo","events":["push"],"branches":["main"]}. ' +
        'For Gmail, match is like {"label":"agent-inbox"} (a label is required). ' +
        'For ordinary Slack routing, match is like {"channels":["#dev"],"events":["message"]} ' +
        "(messages require named channels; Chip mentions and PMs use the separate dispatcher). " +
        'For generic webhook sources, match is like {"provider":"sentry","events":["issue"],"where":[{"field":"level","equals":"error"}]}. ' +
        'target.type "this-thread" targets the current conversation — the tool will tell you how to resolve the thread id if it cannot.',
      inputSchema: {
        name: z.string().min(1).describe("Short human name for the route"),
        source: z.enum(["github", "gmail", "slack", "webhook"]),
        match: z
          .record(z.string(), z.unknown())
          .describe("Source-specific match rules (see tool description)"),
        target: z.object({
          type: z.enum(["this-thread", "thread", "new-thread"]),
          threadId: z.string().optional().describe('Required when type is "thread"'),
          cwd: z.string().optional().describe('Required when type is "new-thread"'),
          worktree: z
            .boolean()
            .optional()
            .describe("new-thread only: run in a fresh git worktree per delivery"),
        }),
        promptTemplate: z
          .string()
          .optional()
          .describe(
            "Optional instructions template. May interpolate only whitelisted summary fields " +
              "like {{summary}}, {{repo}}, {{branch}}, {{subject}} — never raw payload content.",
          ),
        sandbox: z
          .enum(["read-only", "workspace-write"])
          .optional()
          .describe(
            "Sandbox for injected turns. Default read-only. Gmail routes are always read-only.",
          ),
        rateLimitPerMinute: z
          .number()
          .int()
          .positive()
          .max(600)
          .optional()
          .describe(
            "Deliveries per minute for this route before bursts coalesce into a digest turn (default 10).",
          ),
      },
    },
    async (args) => {
      if (args.target.type === "this-thread") {
        return text(
          [
            "To target the current thread I need its id, and MCP tools cannot see it.",
            "Do this now:",
            '1. Run this shell command in this conversation: echo "$CODEX_THREAD_ID"',
            "   (Codex exposes the current thread id to shell commands.)",
            '2. Call wakewire_route_add again with target {"type":"thread","threadId":"<the value>"}.',
          ].join("\n"),
        );
      }
      if (args.target.type === "thread" && !args.target.threadId) {
        return text('target.type "thread" requires target.threadId');
      }
      if (args.target.type === "new-thread" && !args.target.cwd) {
        return text('target.type "new-thread" requires target.cwd (an absolute path)');
      }
      const target =
        args.target.type === "thread"
          ? { type: "thread", threadId: args.target.threadId }
          : { type: "new-thread", cwd: args.target.cwd, worktree: args.target.worktree ?? false };
      const result = await call("POST", "/api/routes", {
        name: args.name,
        source: args.source,
        match: args.match,
        target,
        ...(args.promptTemplate ? { promptTemplate: args.promptTemplate } : {}),
        ...(args.sandbox ? { sandbox: args.sandbox } : {}),
        ...(args.rateLimitPerMinute ? { rateLimitPerMinute: args.rateLimitPerMinute } : {}),
      });
      return appendNote(
        result,
        "Sandbox note: the sandbox policy is applied to each injected turn (and to subsequent turns " +
          "on that thread until something changes it again). Gmail routes are forced read-only.",
      );
    },
  );

  server.registerTool(
    "wakewire_route_list",
    {
      title: "List wakewire routes",
      description:
        "List all configured routes with their ids, matches, targets, and enabled state.",
      inputSchema: {},
    },
    async () => call("GET", "/api/routes"),
  );

  server.registerTool(
    "wakewire_route_remove",
    {
      title: "Remove a wakewire route",
      description: "Delete a route (and its delivery history) by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => call("DELETE", `/api/routes/${encodeURIComponent(id)}`),
  );

  server.registerTool(
    "wakewire_route_toggle",
    {
      title: "Enable/disable a wakewire route",
      description: "Toggle a route on or off without deleting it.",
      inputSchema: { id: z.string().min(1), enabled: z.boolean() },
    },
    async ({ id, enabled }) =>
      call("POST", `/api/routes/${encodeURIComponent(id)}/toggle`, { enabled }),
  );

  server.registerTool(
    "wakewire_deliveries",
    {
      title: "Inspect wakewire deliveries",
      description:
        "The event inspector: recent deliveries with status (queued, delivered, failed, held, " +
        "skipped-duplicate, coalesced), errors, and the rendered prompts.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        routeId: z.string().optional(),
        status: z
          .enum([
            "received",
            "queued",
            "delivering",
            "delivered",
            "failed",
            "skipped-duplicate",
            "held",
            "coalesced",
          ])
          .optional(),
      },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.limit) params.set("limit", String(args.limit));
      if (args.routeId) params.set("routeId", args.routeId);
      if (args.status) params.set("status", args.status);
      const qs = params.toString();
      return call("GET", `/api/deliveries${qs ? `?${qs}` : ""}`);
    },
  );

  server.registerTool(
    "wakewire_replay",
    {
      title: "Replay a wakewire delivery",
      description:
        "Re-render a past delivery against the route's current template and enqueue it again.",
      inputSchema: { deliveryId: z.string().min(1) },
    },
    async ({ deliveryId }) =>
      call("POST", `/api/deliveries/${encodeURIComponent(deliveryId)}/replay`),
  );

  server.registerTool(
    "wakewire_source_setup_github",
    {
      title: "Set up the GitHub event source",
      description:
        "Create a webhook ingress for GitHub (a smee.io relay channel by default) and return the " +
        "webhook URL, secret, and step-by-step setup instructions to relay to the user.",
      inputSchema: {
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional()
          .describe('"owner/repo" the webhook will be added to (informational)'),
        mode: z
          .enum(["smee", "listen"])
          .optional()
          .describe("smee (default): relay via smee.io. listen: direct POSTs to the local daemon."),
      },
    },
    async (args) => call("POST", "/api/sources/github/setup", args),
  );

  server.registerTool(
    "wakewire_source_setup_webhook",
    {
      title: "Set up a generic webhook source",
      description:
        "Register a signed webhook ingress for ANY provider (Sentry, Grafana, Linear, ClickUp, " +
        "Stripe, CI, custom apps). Verification presets: hmac-sha256 (HMAC of the raw body in a " +
        'header, optional prefix like "sha256=") or secret-header (shared secret sent verbatim). ' +
        "The field mapping doubles as the payload whitelist — only mapped fields reach the model. " +
        "Workflow for a new provider: 1) call this without a mapping (capture mode stores the next " +
        "few raw events), 2) trigger a test event, 3) inspect it with wakewire_source_captures, " +
        '4) call this again with the mapping you authored, 5) add a route with source "webhook" ' +
        'and match {"provider": "<name>"}.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]*$/i)
          .describe('Provider label, e.g. "sentry" — used as match.provider in routes'),
        mode: z.enum(["smee", "listen"]).optional().describe("smee (default) or direct listen"),
        // The canonical schemas — never redeclare these here: zod strips
        // unknown keys, so a drifted copy silently drops tool arguments.
        verification: WebhookVerificationSchema.describe("How the provider signs requests"),
        mapping: WebhookMappingSchema.optional().describe(
          "Omit on first setup to use capture mode",
        ),
        capture: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("How many upcoming raw events to capture (default 3 for new sources)"),
        rotateSecret: z.boolean().optional().describe("Mint a new signing secret"),
      },
    },
    async (args) => call("POST", "/api/sources/webhook/setup", args),
  );

  server.registerTool(
    "wakewire_source_captures",
    {
      title: "Inspect captured webhook payloads",
      description:
        "Raw payloads captured while a webhook source is in capture mode — read one to author " +
        "the field mapping for wakewire_source_setup_webhook.",
      inputSchema: {
        sourceId: z.string().min(1),
        limit: z.number().int().positive().max(10).optional(),
      },
    },
    async ({ sourceId, limit }) => {
      const qs = limit ? `?limit=${limit}` : "";
      return call("GET", `/api/sources/${encodeURIComponent(sourceId)}/captures${qs}`);
    },
  );

  server.registerTool(
    "wakewire_source_setup_slack",
    {
      title: "Set up the Slack event source",
      description:
        "Register exact mentions and one-to-one direct messages to Chip's existing normal " +
        "Slack account over a user-authorized Socket Mode app " +
        "(outbound WebSocket — no public URL). " +
        "For a new source, omitted delivery options default to bots off and direct messages/" +
        "channel mentions on; repeat setup preserves omitted options and identity pins while " +
        "the agent email is unchanged. " +
        "Returns the one-time Slack app setup steps; the tokens themselves are stored in a " +
        "terminal via `wakewire auth slack`, never through this conversation.",
      inputSchema: {
        team: z
          .string()
          .optional()
          .describe("Workspace name, informational — used in the source id (default: default)"),
        agentEmail: z
          .string()
          .email()
          .optional()
          .describe(
            "Email on the existing normal Slack account for Chip (new-source default: chip@snapcorp.com; omitted on repeat setup preserves the current email)",
          ),
        includeBotMessages: z
          .boolean()
          .optional()
          .describe(
            "Also deliver messages posted by bots/integrations (new-source default: false; omitted on repeat setup preserves the current setting)",
          ),
        includeDirectMessages: z
          .boolean()
          .optional()
          .describe(
            "Treat one-to-one messages to Chip as Chip requests (new-source default: true; omitted on repeat setup preserves the current setting)",
          ),
        includeChannelMentions: z
          .boolean()
          .optional()
          .describe(
            "Treat exact resolved mentions of Chip's Slack user ID as requests (new-source default: true; omitted on repeat setup preserves the current setting)",
          ),
      },
    },
    async (args) => call("POST", "/api/sources/slack/setup", args),
  );

  server.registerTool(
    "wakewire_source_remove",
    {
      title: "Remove a wakewire source",
      description:
        "Stop and delete an event source by id (see wakewire_status for ids). Also removes its stored secrets.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => call("DELETE", `/api/sources/${encodeURIComponent(id)}`),
  );

  server.registerTool(
    "wakewire_source_setup_gmail",
    {
      title: "Set up the Gmail/IMAP event source",
      description:
        "Register a mail label watch and return setup instructions. Two auth options: " +
        '"gmail-oauth" (default — user brings their own Google OAuth client, then runs ' +
        '`wakewire auth gmail`) or "imap-password" (a Gmail app password or any IMAP ' +
        "server's password, then `wakewire auth imap` — simpler, no OAuth client needed).",
      inputSchema: {
        label: z.string().min(1).describe("Label/folder to watch, e.g. agent-inbox"),
        user: z.string().email().describe("Mail address"),
        authKind: z
          .enum(["gmail-oauth", "imap-password"])
          .optional()
          .describe("Default gmail-oauth. Use imap-password for app passwords or non-Gmail IMAP."),
        host: z
          .string()
          .optional()
          .describe("imap-password only: IMAP host (default imap.gmail.com)"),
        port: z.number().int().positive().optional().describe("imap-password only: default 993"),
      },
    },
    async (args) => call("POST", "/api/sources/gmail/setup", args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

async function call(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const response = await apiFetch(path, { method, ...(body !== undefined ? { body } : {}) });
    const payload = JSON.stringify(response.body, null, 2);
    if (response.status >= 400) {
      return text(`daemon returned HTTP ${response.status}:\n${payload}`);
    }
    return text(payload);
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      return text(
        `${err.message}\nIf wakewire is not installed: npm install -g wakewire && wakewire init && wakewire start`,
      );
    }
    return text(`wakewire error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function text(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

function appendNote(result: ToolResult, note: string): ToolResult {
  return { content: [...result.content, { type: "text" as const, text: note }] };
}
