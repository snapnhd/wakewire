import { apiFetch } from "../client.js";
import { AdapterNameSchema, DispatcherDefaultAgentSchema, settingKeys } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { assertLoopbackWsUrl } from "../sinks/codex-app-server.js";

const KNOWN: Record<string, string> = {
  [settingKeys.adapter]:
    "agent sink: codex-desktop (default) | codex-app-server | codex-sdk | codex-exec | hermes",
  [settingKeys.codexPath]: "override the codex binary path",
  [settingKeys.claudePath]: "override the Claude Code binary path used by Slack proxy sessions",
  [settingKeys.tmuxPath]: "override the tmux binary path used by Claude RC proxy sessions",
  [settingKeys.model]: "model override for injected turns",
  [settingKeys.appServerConnection]: "app-server connection: auto (default) | proxy | spawn",
  [settingKeys.appServerListen]:
    "shared-server mode: loopback ws:// URL (e.g. ws://127.0.0.1:4571) for live codex --remote viewing",
  [settingKeys.desktopHelperPath]:
    "signed Accessibility helper for first-task creation (default ~/.local/bin/wakewire-codex-desktop-helper)",
  [settingKeys.desktopStateDatabasePath]:
    "Codex Desktop state database used only for task-id correlation",
  [settingKeys.desktopAllowUnsupportedVersion]:
    "private IPC version override: false (default) | true after manual compatibility verification",
  [settingKeys.dispatcherDefaultAgent]:
    "authenticated Slack dispatcher default for new conversations: codex (backward-compatible default) | claude-rc",
  [settingKeys.hermesRunnerPath]:
    "Path D: absolute path to scripts/hermes_sink_runner.py (default: package scripts/)",
  [settingKeys.hermesBin]: "override hermes binary path for the hermes sink",
  [settingKeys.hermesPython]: "python used to run hermes_sink_runner.py",
  [settingKeys.hermesTimeoutSeconds]: "hermes sink hard timeout seconds (default 1500)",
  [settingKeys.hermesProfile]: "optional Hermes profile name for hermes sink sessions",
  [settingKeys.ratePerMinute]: "default deliveries/minute per route before digest coalescing (10)",
  [settingKeys.apiPort]: "management API port (0 = random)",
};

const SENSITIVE = new Set<string>([settingKeys.apiToken]);

export function configList(): void {
  const db = openDatabase();
  const settings = createStores(db).settings;
  for (const [key, help] of Object.entries(KNOWN)) {
    const value = settings.get(key);
    console.log(`${key} = ${value ?? "(default)"}\n    ${help}`);
  }
  db.close();
}

export function configGet(key: string): void {
  if (SENSITIVE.has(key)) {
    console.error(`${key} is sensitive and not printable here`);
    process.exitCode = 1;
    return;
  }
  const db = openDatabase();
  const value = createStores(db).settings.get(key);
  db.close();
  console.log(value ?? "(not set — using default)");
}

export async function configSet(key: string, value: string): Promise<void> {
  if (!(key in KNOWN)) {
    console.error(`unknown setting "${key}" — known keys:\n  ${Object.keys(KNOWN).join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  if (key === settingKeys.adapter) {
    const parsed = AdapterNameSchema.safeParse(value);
    if (!parsed.success) {
      console.error(
        `invalid adapter "${value}" — use codex-desktop | codex-sdk | codex-app-server | codex-exec | hermes`,
      );
      process.exitCode = 1;
      return;
    }
  }
  if (key === settingKeys.dispatcherDefaultAgent) {
    const parsed = DispatcherDefaultAgentSchema.safeParse(value);
    if (!parsed.success) {
      console.error(`invalid default agent "${value}" — use codex | claude-rc`);
      process.exitCode = 1;
      return;
    }
  }
  if (key === settingKeys.desktopAllowUnsupportedVersion && !["true", "false"].includes(value)) {
    console.error(`${key} must be true or false`);
    process.exitCode = 1;
    return;
  }
  if (key === settingKeys.appServerListen && value !== "") {
    try {
      assertLoopbackWsUrl(value);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  const db = openDatabase();
  createStores(db).settings.set(key, value);
  db.close();
  console.log(`${key} = ${value}`);
  try {
    await apiFetch("/api/health");
    if (key === settingKeys.dispatcherDefaultAgent) {
      console.log(
        "Note: the running daemon reads this setting live for new Slack conversations; active sessions are unchanged",
      );
    } else {
      console.log(
        "Note: the daemon is running — restart it to apply: wakewire stop && wakewire start --detach",
      );
    }
  } catch {
    // daemon not running; new value applies on next start
  }
}
