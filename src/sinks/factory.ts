import type { DaemonConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { CodexDesktopAdapter } from "./codex-desktop.js";
import { CodexExecAdapter } from "./codex-exec.js";
import { CodexSdkAdapter } from "./codex-sdk.js";
import { HermesAgentAdapter } from "./hermes.js";
import type { AgentAdapter } from "./types.js";

export function createAdapter(config: DaemonConfig, logger: Logger): AgentAdapter {
  switch (config.adapter) {
    case "codex-desktop":
      return new CodexDesktopAdapter(logger, {
        codexPath: config.codexPath,
        ...(config.desktopHelperPath ? { helperPath: config.desktopHelperPath } : {}),
        ...(config.desktopStateDatabasePath
          ? { stateDatabasePath: config.desktopStateDatabasePath }
          : {}),
        allowUnsupportedDesktopVersion: config.desktopAllowUnsupportedVersion,
      });
    case "codex-app-server":
      return new CodexAppServerAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
        connection: config.appServerConnection,
        listenUrl: config.appServerListen,
      });
    case "codex-exec":
      return new CodexExecAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
    case "hermes":
      return new HermesAgentAdapter(logger, {
        ...(config.hermesRunnerPath ? { runnerPath: config.hermesRunnerPath } : {}),
        ...(config.hermesBin ? { hermesBin: config.hermesBin } : {}),
        ...(config.hermesPython ? { hermesPython: config.hermesPython } : {}),
        defaultTimeoutSeconds: config.hermesTimeoutSeconds,
        ...(config.hermesProfile ? { profile: config.hermesProfile } : {}),
      });
    default:
      return new CodexSdkAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
  }
}
