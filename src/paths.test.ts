import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateWakewireHome } from "./paths.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("ensurePrivateWakewireHome", () => {
  it("repairs an existing permissive state directory to mode 0700", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-paths-"));
    cleanup.push(parent);
    const state = path.join(parent, "state");
    fs.mkdirSync(state, { mode: 0o755 });
    fs.chmodSync(state, 0o755);
    expect(ensurePrivateWakewireHome(state)).toBe(state);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink as the state root", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-paths-"));
    cleanup.push(parent);
    const real = path.join(parent, "real");
    const link = path.join(parent, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(() => ensurePrivateWakewireHome(link)).toThrow("must be a real directory");
  });
});
