#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { authGithubApi, authLinearAgent } from "./cli/auth-agent-api.js";
import { authGmail } from "./cli/auth-gmail.js";
import { authImap } from "./cli/auth-imap.js";
import { authSlack } from "./cli/auth-slack.js";
import { authWebhook } from "./cli/auth-webhook.js";
import { configGet, configList, configSet } from "./cli/config-cmd.js";
import { desktopDoctor } from "./cli/desktop.js";
import { registerPeopleCommands } from "./cli/people.js";
import { installService, uninstallService } from "./cli/service.js";
import { runSlackToolHook } from "./cli/slack-tool-hook.js";
import { apiFetch, readDaemonState } from "./client.js";
import { loadConfig } from "./config.js";
import { runDaemon } from "./daemon/daemon.js";
import { openDatabase } from "./db/db.js";
import { createStores } from "./db/repos.js";
import { createLogger } from "./logging.js";
import { runMcpServer } from "./mcp/server.js";
import { ensurePrivateWakewireHome, logFilePath, stateFilePath, wakewireHome } from "./paths.js";
import { loadProjectEnv } from "./project-env.js";
import { VERSION } from "./version.js";

loadProjectEnv();

const cliPath = fileURLToPath(import.meta.url);
const program = new Command();

program
  .name("wakewire")
  .description("Push external events (GitHub, Gmail) into local Codex threads")
  .version(VERSION);

registerPeopleCommands(program);

program
  .command("init")
  .description("Create ~/.wakewire, run migrations, and generate the API token")
  .action(() => {
    ensurePrivateWakewireHome();
    const db = openDatabase();
    const stores = createStores(db);
    loadConfig(stores.settings); // generates the API token on first run
    db.close();
    console.log(`Initialized ${wakewireHome()}`);
    console.log("Next steps:");
    console.log("  1. wakewire start            # or: wakewire service install");
    console.log("  2. Install the Codex plugin (see README) and say: $wakewire-setup");
  });

program
  .command("start")
  .description("Run the daemon (foreground by default)")
  .option("-d, --detach", "fork to the background and return")
  .action(async (opts: { detach?: boolean }) => {
    const existing = readDaemonState();
    if (existing && processAlive(existing.pid)) {
      console.error(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
      process.exitCode = 1;
      return;
    }
    if (opts.detach) {
      const child = spawn(process.execPath, [cliPath, "start"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`daemon starting in background (pid ${child.pid}). Logs: ${logFilePath()}`);
      return;
    }
    await runDaemon(createLogger({ daemon: true }));
  });

program
  .command("stop")
  .description("Stop the running daemon")
  .action(() => {
    const state = readDaemonState();
    if (!state || !processAlive(state.pid)) {
      console.log("daemon is not running");
      fs.rmSync(stateFilePath(), { force: true });
      return;
    }
    process.kill(state.pid, "SIGTERM");
    console.log(`sent SIGTERM to pid ${state.pid}`);
  });

program
  .command("status")
  .description("Show daemon status, sources, and queue depth")
  .action(async () => {
    const state = readDaemonState();
    if (!state || !processAlive(state.pid)) {
      console.log("daemon: not running");
      return;
    }
    try {
      const health = await apiFetch("/api/health");
      console.log(JSON.stringify(health.body, null, 2));
    } catch (err) {
      console.log(
        `daemon: state file exists (pid ${state.pid}) but API is unreachable: ${err instanceof Error ? err.message : err}`,
      );
    }
  });

program
  .command("logs")
  .description("Show daemon logs")
  .option("-f, --follow", "follow the log")
  .option("-n, --lines <n>", "number of lines", "100")
  .action((opts: { follow?: boolean; lines: string }) => {
    if (!fs.existsSync(logFilePath())) {
      console.log(`no log file yet at ${logFilePath()}`);
      return;
    }
    const args = ["-n", opts.lines, ...(opts.follow ? ["-f"] : []), logFilePath()];
    spawn("tail", args, { stdio: "inherit" });
  });

const auth = program.command("auth").description("Authenticate event sources");
auth
  .command("gmail")
  .description("Run the Google OAuth flow for a gmail source")
  .option("--source <id>", "gmail source id (from wakewire_source_setup_gmail)")
  .option("--client-id <id>", "Google OAuth client id")
  .option("--client-secret <secret>", "Google OAuth client secret")
  .action(async (opts: { source?: string; clientId?: string; clientSecret?: string }) => {
    await authGmail(createLogger(), opts);
  });
auth
  .command("imap")
  .description(
    "Store the password for a password-authenticated mail source (e.g. a Gmail app password)",
  )
  .option(
    "--source <id>",
    'source id (from wakewire_source_setup_gmail with authKind "imap-password")',
  )
  .option(
    "--password <password>",
    "provide non-interactively (visible in shell history — prefer the prompt)",
  )
  .action(async (opts: { source?: string; password?: string }) => {
    await authImap(createLogger(), opts);
  });
auth
  .command("slack")
  .description(
    "Validate, pin, and store Slack tokens from .env.local or hidden prompts in the Keychain",
  )
  .option("--source <id>", "slack source id (from wakewire_source_setup_slack)")
  .option("--app-token <token>", "app-level token (prefer SLACK_APP_TOKEN or hidden prompt)")
  .option("--user-token <token>", "Chip user token (prefer SLACK_USER_TOKEN or hidden prompt)")
  .action(async (opts: { source?: string; appToken?: string; userToken?: string }) => {
    await authSlack(createLogger(), opts);
  });
auth
  .command("webhook")
  .description("Store a provider-issued signing secret for a generic webhook source")
  .option("--source <id>", "webhook source id (from wakewire_source_setup_webhook)")
  .option("--secret <secret>", "provide non-interactively (prefer the hidden prompt)")
  .action(async (opts: { source?: string; secret?: string }) => {
    await authWebhook(createLogger(), opts);
  });
auth
  .command("github-api")
  .description("Store a GitHub App installation/PAT token for reactions and account resolution")
  .option("--source <id>", "github source id")
  .option("--token <token>", "provide non-interactively (prefer the hidden prompt)")
  .action(async (opts: { source?: string; token?: string }) => {
    await authGithubApi(createLogger(), opts);
  });
auth
  .command("linear-agent")
  .description("Store renewable Linear app credentials and pin Chip's immutable app user id")
  .option("--source <id>", "Linear webhook source id")
  .option("--client-id <id>", "Linear OAuth application client id")
  .option("--client-secret <secret>", "provide non-interactively (prefer the hidden prompt)")
  .action(async (opts: { source?: string; clientId?: string; clientSecret?: string }) => {
    await authLinearAgent(createLogger(), opts);
  });

const config = program.command("config").description("Read and write daemon settings");
config
  .command("list")
  .description("Show known settings, current values, and what they do")
  .action(() => configList());
config
  .command("get <key>")
  .description("Print a setting's current value")
  .action((key: string) => configGet(key));
config
  .command("set <key> <value>")
  .description("Set a setting, e.g. wakewire config set sink.adapter codex-app-server")
  .action(async (key: string, value: string) => {
    await configSet(key, value);
  });

const scheduledFollowup = program
  .command("scheduled-followup")
  .description("Bind and complete WakeWire-originated scheduled tasks");
scheduledFollowup
  .command("register")
  .description("Bind a paused automation to its authenticated originating request and Codex task")
  .requiredOption("--automation-id <id>", "Codex automation id")
  .requiredOption("--origin-request-id <id>", "authenticated WakeWire request id")
  .requiredOption("--current-codex-thread-id <id>", "current Codex task id")
  .action(
    async (opts: {
      automationId: string;
      originRequestId: string;
      currentCodexThreadId: string;
    }) => {
      await printApiResult(
        await apiFetch("/api/scheduled-followups/register", {
          method: "POST",
          body: opts,
        }),
      );
    },
  );
scheduledFollowup
  .command("complete")
  .description("Queue one durable provider reply for a terminal scheduled-task result")
  .requiredOption("--followup-id <id>", "opaque scheduled follow-up id")
  .requiredOption("--automation-id <id>", "Codex automation id")
  .requiredOption("--current-codex-thread-id <id>", "current Codex task id")
  .requiredOption("--message <text>", "exact terminal message body")
  .action(
    async (opts: {
      followupId: string;
      automationId: string;
      currentCodexThreadId: string;
      message: string;
    }) => {
      await printApiResult(
        await apiFetch(`/api/scheduled-followups/${encodeURIComponent(opts.followupId)}/complete`, {
          method: "POST",
          body: {
            automationId: opts.automationId,
            currentCodexThreadId: opts.currentCodexThreadId,
            message: opts.message,
          },
        }),
      );
    },
  );
scheduledFollowup
  .command("status")
  .description("Inspect a scheduled follow-up binding and its terminal reply")
  .requiredOption("--followup-id <id>", "opaque scheduled follow-up id")
  .action(async (opts: { followupId: string }) => {
    await printApiResult(
      await apiFetch(`/api/scheduled-followups/${encodeURIComponent(opts.followupId)}`),
    );
  });

const scheduledChannelDelivery = program
  .command("scheduled-channel-delivery")
  .description("Bind and send recurring top-level Slack messages through WakeWire");
scheduledChannelDelivery
  .command("register")
  .description("Bind an automation to the Slack channel of its authenticated origin request")
  .requiredOption("--automation-id <id>", "Codex automation id")
  .requiredOption("--origin-request-id <id>", "authenticated WakeWire request id")
  .requiredOption("--current-codex-thread-id <id>", "current Codex task id")
  .action(
    async (opts: {
      automationId: string;
      originRequestId: string;
      currentCodexThreadId: string;
    }) => {
      await printApiResult(
        await apiFetch("/api/scheduled-channel-deliveries/register", {
          method: "POST",
          body: opts,
        }),
      );
    },
  );
scheduledChannelDelivery
  .command("send")
  .description("Queue one idempotent top-level Slack message for a scheduled occurrence")
  .requiredOption("--delivery-id <id>", "opaque scheduled channel delivery id")
  .requiredOption("--automation-id <id>", "Codex automation id")
  .requiredOption("--current-codex-thread-id <id>", "current Codex task id")
  .requiredOption("--occurrence-key <key>", "stable logical run key")
  .option("--message <text>", "exact message body")
  .option("--message-file <path>", "read the exact message body from a file")
  .option("--message-stdin", "read the exact message body from stdin")
  .action(
    async (opts: {
      deliveryId: string;
      automationId: string;
      currentCodexThreadId: string;
      occurrenceKey: string;
      message?: string;
      messageFile?: string;
      messageStdin?: boolean;
    }) => {
      const message = readScheduledChannelMessage(opts);
      await printApiResult(
        await apiFetch(
          `/api/scheduled-channel-deliveries/${encodeURIComponent(opts.deliveryId)}/send`,
          {
            method: "POST",
            body: {
              automationId: opts.automationId,
              currentCodexThreadId: opts.currentCodexThreadId,
              occurrenceKey: opts.occurrenceKey,
              message,
            },
          },
        ),
      );
    },
  );
scheduledChannelDelivery
  .command("status")
  .description("Inspect a recurring scheduled channel binding")
  .requiredOption("--delivery-id <id>", "opaque scheduled channel delivery id")
  .action(async (opts: { deliveryId: string }) => {
    await printApiResult(
      await apiFetch(`/api/scheduled-channel-deliveries/${encodeURIComponent(opts.deliveryId)}`),
    );
  });

const service = program.command("service").description("Run the daemon as a login service");
service
  .command("install")
  .description("Install a launchd agent (macOS) or systemd user unit (Linux)")
  .action(async () => {
    await installService(cliPath);
  });
service
  .command("uninstall")
  .description("Remove the launchd agent / systemd unit")
  .action(async () => {
    await uninstallService();
  });

const desktop = program.command("desktop").description("Inspect the Codex Desktop bridge");
desktop
  .command("doctor")
  .description("Check Desktop version, private IPC, helper, and task-state database")
  .action(async () => {
    await desktopDoctor();
  });

program
  .command("mcp")
  .description("Run the wakewire MCP server on stdio (used by the Codex plugin)")
  .action(async () => {
    await runMcpServer();
  });

program
  .command("slack-tool-hook", { hidden: true })
  .description("Enforce WakeWire's non-destructive Slack connector allowlist for Codex")
  .action(async () => {
    await runSlackToolHook();
  });

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readScheduledChannelMessage(options: {
  message?: string;
  messageFile?: string;
  messageStdin?: boolean;
}): string {
  const selected = [
    options.message !== undefined,
    options.messageFile !== undefined,
    options.messageStdin === true,
  ].filter(Boolean).length;
  if (selected !== 1) {
    throw new Error("choose exactly one of --message, --message-file, or --message-stdin");
  }
  if (options.message !== undefined) return options.message;
  if (options.messageFile !== undefined) return fs.readFileSync(options.messageFile, "utf8");
  return fs.readFileSync(0, "utf8");
}

async function printApiResult(response: { status: number; body: unknown }): Promise<void> {
  const output = JSON.stringify(response.body, null, 2);
  if (response.status >= 400) {
    console.error(output);
    process.exitCode = 1;
    return;
  }
  console.log(output);
}

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
