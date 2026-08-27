import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

/** Absolute path of the project-local environment mounted by 1Password. */
export function projectEnvPath(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", ".env.local");
}

/**
 * Load project-local values without overriding an environment value supplied
 * explicitly by the caller. Node's native loader supports 1Password's FIFO
 * local-environment mount as well as an ordinary developer-owned env file.
 */
export function loadProjectEnv(envPath = projectEnvPath()): boolean {
  if (!fs.existsSync(envPath)) return false;
  loadEnvFile(envPath);
  return true;
}
