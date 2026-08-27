import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectEnv } from "./project-env.js";

const VARIABLE = "WAKEWIRE_PROJECT_ENV_TEST";
const previous = process.env[VARIABLE];

afterEach(() => {
  if (previous === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = previous;
});

describe("loadProjectEnv", () => {
  it("loads a project env file", () => {
    delete process.env[VARIABLE];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-env-"));
    const envPath = path.join(directory, ".env.local");
    fs.writeFileSync(envPath, `${VARIABLE}=from-file\n`);

    expect(loadProjectEnv(envPath)).toBe(true);
    expect(process.env[VARIABLE]).toBe("from-file");

    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("does not replace an explicitly supplied value", () => {
    process.env[VARIABLE] = "from-process";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-env-"));
    const envPath = path.join(directory, ".env.local");
    fs.writeFileSync(envPath, `${VARIABLE}=from-file\n`);

    expect(loadProjectEnv(envPath)).toBe(true);
    expect(process.env[VARIABLE]).toBe("from-process");

    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("allows projects without a local env file", () => {
    expect(loadProjectEnv(path.join(os.tmpdir(), "wakewire-missing-env"))).toBe(false);
  });
});
