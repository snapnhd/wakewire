import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { dbPath, ensurePrivateWakewireHome } from "../paths.js";
import { migrate } from "./migrations.js";

export type { Database };

export function openDatabase(file: string = dbPath()): Database {
  if (file !== ":memory:") {
    const defaultFile = file === dbPath();
    if (defaultFile) ensurePrivateWakewireHome(path.dirname(file));
    else fs.mkdirSync(path.dirname(file), { recursive: true });
    assertSafeDatabasePath(file, defaultFile);
  }
  const db = new DatabaseConstructor(file);
  if (file !== ":memory:" && file === dbPath()) fs.chmodSync(file, 0o600);
  migrate(db);
  return db;
}

function assertSafeDatabasePath(file: string, enforceOwnership: boolean): void {
  let state: fs.Stats;
  try {
    state = fs.lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new Error(`WakeWire database must be a regular file: ${file}`);
  }
  const uid = process.getuid?.();
  if (enforceOwnership && uid !== undefined && state.uid !== uid) {
    throw new Error(`WakeWire database is not owned by uid ${uid}: ${file}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
