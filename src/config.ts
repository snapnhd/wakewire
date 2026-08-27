import crypto from "node:crypto";
import { z } from "zod";
import type { SettingsStore } from "./db/repos.js";

export const AdapterNameSchema = z.enum([
  "codex-desktop",
  "codex-sdk",
  "codex-app-server",
  "codex-exec",
  "hermes",
]);
export type AdapterName = z.infer<typeof AdapterNameSchema>;

export const DispatcherDefaultAgentSchema = z.enum(["codex", "claude-rc"]);
export type DispatcherDefaultAgent = z.infer<typeof DispatcherDefaultAgentSchema>;

export interface DaemonConfig {
  adapter: AdapterName;
  codexPath: string | undefined;
  claudePath: string | undefined;
  tmuxPath: string | undefined;
  model: string | undefined;
  appServerConnection: "auto" | "proxy" | "spawn";
  /** Loopback ws:// URL for shared-server mode (codex --remote TUIs attach to it). */
  appServerListen: string | undefined;
  desktopHelperPath: string | undefined;
  desktopStateDatabasePath: string | undefined;
  desktopAllowUnsupportedVersion: boolean;
  dispatcherDefaultAgent: DispatcherDefaultAgent;
  /** Path D: absolute path to scripts/hermes_sink_runner.py */
  hermesRunnerPath: string | undefined;
  hermesBin: string | undefined;
  hermesPython: string | undefined;
  hermesTimeoutSeconds: number;
  hermesProfile: string | undefined;
  ratePerMinute: number;
  /** 0 = pick a random free port and record it in the state file. */
  apiPort: number;
  apiToken: string;
}

export const settingKeys = {
  adapter: "sink.adapter",
  codexPath: "sink.codexPath",
  claudePath: "sink.claudePath",
  tmuxPath: "sink.tmuxPath",
  model: "sink.model",
  appServerConnection: "sink.appServerConnection",
  appServerListen: "sink.appServerListen",
  desktopHelperPath: "sink.desktopHelperPath",
  desktopStateDatabasePath: "sink.desktopStateDatabasePath",
  desktopAllowUnsupportedVersion: "sink.desktopAllowUnsupportedVersion",
  dispatcherDefaultAgent: "dispatcher.defaultAgent",
  hermesRunnerPath: "sink.hermesRunnerPath",
  hermesBin: "sink.hermesBin",
  hermesPython: "sink.hermesPython",
  hermesTimeoutSeconds: "sink.hermesTimeoutSeconds",
  hermesProfile: "sink.hermesProfile",
  ratePerMinute: "queue.ratePerMinute",
  apiPort: "api.port",
  apiToken: "api.token",
} as const;

export function loadDispatcherDefaultAgent(settings: SettingsStore): DispatcherDefaultAgent {
  return DispatcherDefaultAgentSchema.catch("codex").parse(
    settings.get(settingKeys.dispatcherDefaultAgent) ?? "codex",
  );
}

export function loadConfig(settings: SettingsStore): DaemonConfig {
  const adapter = AdapterNameSchema.catch("codex-desktop").parse(
    settings.get(settingKeys.adapter) ?? "codex-desktop",
  );
  const rate = Number(settings.get(settingKeys.ratePerMinute) ?? "10");
  const port = Number(settings.get(settingKeys.apiPort) ?? "0");
  const connection = z
    .enum(["auto", "proxy", "spawn"])
    .catch("auto")
    .parse(settings.get(settingKeys.appServerConnection) ?? "auto");
  const hermesTimeout = Number(settings.get(settingKeys.hermesTimeoutSeconds) ?? "1500");
  return {
    adapter,
    codexPath: settings.get(settingKeys.codexPath) ?? undefined,
    claudePath: settings.get(settingKeys.claudePath) ?? undefined,
    tmuxPath: settings.get(settingKeys.tmuxPath) ?? undefined,
    model: settings.get(settingKeys.model) ?? undefined,
    appServerConnection: connection,
    appServerListen: settings.get(settingKeys.appServerListen) ?? undefined,
    desktopHelperPath: settings.get(settingKeys.desktopHelperPath) ?? undefined,
    desktopStateDatabasePath: settings.get(settingKeys.desktopStateDatabasePath) ?? undefined,
    desktopAllowUnsupportedVersion:
      settings.get(settingKeys.desktopAllowUnsupportedVersion) === "true",
    dispatcherDefaultAgent: loadDispatcherDefaultAgent(settings),
    hermesRunnerPath: settings.get(settingKeys.hermesRunnerPath) ?? undefined,
    hermesBin: settings.get(settingKeys.hermesBin) ?? undefined,
    hermesPython: settings.get(settingKeys.hermesPython) ?? undefined,
    hermesTimeoutSeconds:
      Number.isFinite(hermesTimeout) && hermesTimeout > 0 ? hermesTimeout : 1500,
    hermesProfile: settings.get(settingKeys.hermesProfile) ?? undefined,
    ratePerMinute: Number.isFinite(rate) && rate > 0 ? rate : 10,
    apiPort: Number.isFinite(port) && port >= 0 ? port : 0,
    apiToken: settings.getOrCreate(settingKeys.apiToken, () =>
      crypto.randomBytes(32).toString("hex"),
    ),
  };
}
