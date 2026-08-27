import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { type CommandRunner, ExecFileCommandRunner } from "../sinks/codex-desktop.js";
import { CodexDesktopIpcClient, type CodexDesktopProbeResult } from "../sinks/codex-desktop-ipc.js";

export interface DesktopHelperProbeResult {
  ok: boolean;
  reason?: string | undefined;
}

export interface DesktopDoctorResult {
  ok: boolean;
  ipc: CodexDesktopProbeResult;
  firstTaskHelper: {
    ok: boolean;
    path: string;
    executable: boolean;
    accessibilityReady: boolean;
    reason?: string | undefined;
  };
  stateDatabase: {
    ok: boolean;
    path: string;
    reason?: string | undefined;
  };
  warning: string;
}

export interface DesktopDoctorChecks {
  access?: ((file: string, mode: number) => Promise<void>) | undefined;
  probeHelper?: ((helperPath: string) => Promise<DesktopHelperProbeResult>) | undefined;
}

export async function desktopDoctor(): Promise<void> {
  const db = openDatabase();
  const config = loadConfig(createStores(db).settings);
  db.close();
  const helper =
    config.desktopHelperPath ??
    path.join(os.homedir(), ".local", "bin", "wakewire-codex-desktop-helper");
  const stateDatabase =
    config.desktopStateDatabasePath ??
    path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "state_5.sqlite");
  const ipc = new CodexDesktopIpcClient({
    allowUnsupportedDesktopVersion: config.desktopAllowUnsupportedVersion,
  });
  const ipcResult = await ipc.probeDetailed();
  const result = await inspectDesktopReadiness({
    helperPath: helper,
    stateDatabasePath: stateDatabase,
    ipc: ipcResult,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

/** Collect every readiness edge without mutating Desktop or requesting TCC permission. */
export async function inspectDesktopReadiness(
  input: {
    helperPath: string;
    stateDatabasePath: string;
    ipc: CodexDesktopProbeResult;
  },
  checks: DesktopDoctorChecks = {},
): Promise<DesktopDoctorResult> {
  const access = checks.access ?? ((file, mode) => fs.access(file, mode));
  const probeHelper = checks.probeHelper ?? ((helper) => probeDesktopHelper(helper));
  const helperExecutable = await accessible(input.helperPath, fsConstants.X_OK, access);
  const stateOk = await accessible(input.stateDatabasePath, fsConstants.R_OK, access);
  const helperProbe = helperExecutable
    ? await probeHelper(input.helperPath).catch((error) => ({
        ok: false,
        reason: conciseError(error),
      }))
    : { ok: false, reason: "helper is missing or not executable" };
  const helperOk = helperExecutable && helperProbe.ok;

  return {
    ok: input.ipc.ok && helperOk && stateOk,
    ipc: input.ipc,
    firstTaskHelper: {
      ok: helperOk,
      path: input.helperPath,
      executable: helperExecutable,
      accessibilityReady: helperProbe.ok,
      ...(!helperOk
        ? { reason: helperProbe.reason ?? "helper Accessibility/session probe failed" }
        : {}),
    },
    stateDatabase: {
      ok: stateOk,
      path: input.stateDatabasePath,
      ...(!stateOk ? { reason: "Codex Desktop state database is missing or unreadable" } : {}),
    },
    warning:
      "Codex Desktop IPC is private; WakeWire verifies the OpenAI signature, turn routes, live handshake, and realized turn. Interrupt support remains pinned per verified build.",
  };
}

export async function probeDesktopHelper(
  helperPath: string,
  runner: CommandRunner = new ExecFileCommandRunner(),
): Promise<DesktopHelperProbeResult> {
  try {
    const { stdout } = await runner.run(helperPath, ["probe"], 3_000);
    const value = JSON.parse(stdout.trim()) as { ok?: unknown };
    if (value.ok !== true) {
      return { ok: false, reason: "helper probe returned an invalid readiness response" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: conciseError(error) };
  }
}

async function accessible(
  file: string,
  mode: number,
  access: (file: string, mode: number) => Promise<void>,
): Promise<boolean> {
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

function conciseError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return (message || "helper probe failed").slice(-1_000);
}
