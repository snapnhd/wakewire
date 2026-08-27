import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root directory for all wakewire state. Overridable for tests and multi-profile setups. */
export function wakewireHome(): string {
  return process.env.WAKEWIRE_HOME ?? path.join(os.homedir(), ".wakewire");
}

/** Create/repair the state root as a same-user-only, non-symlink directory. */
export function ensurePrivateWakewireHome(directory: string = wakewireHome()): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let state = fs.lstatSync(directory);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`WakeWire state root must be a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && state.uid !== uid) {
    throw new Error(`WakeWire state root is not owned by uid ${uid}: ${directory}`);
  }
  if ((state.mode & 0o077) !== 0) {
    fs.chmodSync(directory, 0o700);
    state = fs.lstatSync(directory);
  }
  if ((state.mode & 0o077) !== 0) {
    throw new Error(`WakeWire state root is not private (expected mode 0700): ${directory}`);
  }
  return directory;
}

export function dbPath(): string {
  return path.join(wakewireHome(), "state.db");
}

/** Written by the daemon on boot: { pid, port, token, startedAt }. Mode 0600. */
export function stateFilePath(): string {
  return path.join(wakewireHome(), "daemon.json");
}

export function logsDir(): string {
  return path.join(wakewireHome(), "logs");
}

export function logFilePath(): string {
  return path.join(logsDir(), "wakewire.log");
}

/** Fallback secret storage when no OS keychain is available. Mode 0600. */
export function secretsFilePath(): string {
  return path.join(wakewireHome(), "secrets.json");
}

export function worktreesDir(): string {
  return path.join(wakewireHome(), "worktrees");
}
