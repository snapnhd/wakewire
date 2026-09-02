import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseCleanSnapWorkspaceState,
  parseSnapReviewTestSummary,
  readSnapWorkspaceHead,
  runBoundedSnapReviewProcess,
  runSnapReviewPreflight,
} from "./snap-review-preflight.js";

describe("parseCleanSnapWorkspaceState", () => {
  it("rejects tracked or untracked files even when the branch OID is unchanged", () => {
    const sha = "a".repeat(40);
    expect(() =>
      parseCleanSnapWorkspaceState(
        [`# branch.oid ${sha}`, "# branch.head fra-2967", "? untracked.txt"].join("\n"),
      ),
    ).toThrow(/clean/u);
  });
});

describe("parseSnapReviewTestSummary", () => {
  it("accepts the complete four-suite aggregate footer", () => {
    const output = [
      "app: TEST PASSED",
      "data: TEST PASSED",
      "snapcorp: TEST PASSED",
      "windmill: TEST PASSED",
      "All test suites passed!",
    ].join("\n");

    expect(parseSnapReviewTestSummary(output, 0)).toEqual({
      passed: true,
      suites: {
        app: "passed",
        data: "passed",
        snapcorp: "passed",
        windmill: "passed",
      },
    });
  });

  it("classifies test and lint failures and refuses a nonzero aggregate", () => {
    const output = [
      "app: TEST FAILED (exit code 7)",
      "data: LINT FAILED — suite not run",
      "snapcorp: TEST PASSED",
      "windmill: TEST PASSED",
    ].join("\n");

    expect(parseSnapReviewTestSummary(output, 7)).toEqual({
      passed: false,
      suites: {
        app: "test-failed",
        data: "lint-failed",
        snapcorp: "passed",
        windmill: "passed",
      },
    });
  });

  it.each([
    [
      "missing suite",
      "app: TEST PASSED\ndata: TEST PASSED\nsnapcorp: TEST PASSED\nAll test suites passed!",
    ],
    [
      "duplicate suite",
      "app: TEST PASSED\napp: TEST PASSED\ndata: TEST PASSED\nsnapcorp: TEST PASSED\nwindmill: TEST PASSED\nAll test suites passed!",
    ],
    [
      "missing aggregate",
      "app: TEST PASSED\ndata: TEST PASSED\nsnapcorp: TEST PASSED\nwindmill: TEST PASSED",
    ],
  ])("fails closed for a malformed footer: %s", (_label, output) => {
    expect(parseSnapReviewTestSummary(output, 0).passed).toBe(false);
  });
});

describe("runSnapReviewPreflight", () => {
  it("runs the dispatcher aggregate and binds a pass to the unchanged exact HEAD", async () => {
    const ticket = "fra-2967";
    const headSha = "d".repeat(40);
    const output = [
      "app: TEST PASSED",
      "data: TEST PASSED",
      "snapcorp: TEST PASSED",
      "windmill: TEST PASSED",
      "All test suites passed!",
    ].join("\n");
    const runner = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      diagnosticTail: output,
    }));
    const readHead = vi.fn(async () => headSha);

    await expect(
      runSnapReviewPreflight(
        { ticket, cwd: `/Users/chip/Snap/workspaces/${ticket}` },
        { runner: runner as never, readHead },
      ),
    ).resolves.toEqual({
      headSha,
      passed: true,
      suites: {
        app: "passed",
        data: "passed",
        snapcorp: "passed",
        windmill: "passed",
      },
      diagnosticTail: output,
    });
    expect(runner).toHaveBeenCalledWith(
      "make",
      ["-C", "/Users/chip/Snap/workspaces", "test", ticket],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(readHead).toHaveBeenCalledTimes(2);
  });

  it("invalidates a passing footer when HEAD moves during the run", async () => {
    const output = [
      "app: TEST PASSED",
      "data: TEST PASSED",
      "snapcorp: TEST PASSED",
      "windmill: TEST PASSED",
      "All test suites passed!",
    ].join("\n");
    const runner = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      diagnosticTail: output,
    }));
    const readHead = vi
      .fn<(cwd: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce("d".repeat(40))
      .mockResolvedValueOnce("e".repeat(40));

    const result = await runSnapReviewPreflight(
      { ticket: "fra-2967", cwd: "/Users/chip/Snap/workspaces/fra-2967" },
      { runner, readHead },
    );
    expect(result).toMatchObject({ headSha: "d".repeat(40), passed: false });
  });

  it("propagates cancellation instead of reporting a test failure", async () => {
    const controller = new AbortController();
    const readHead = vi.fn(async () => "d".repeat(40));
    const runner = vi.fn(async () => {
      controller.abort(new Error("shutdown"));
      throw controller.signal.reason;
    });

    await expect(
      runSnapReviewPreflight(
        { ticket: "fra-2967", cwd: "/Users/chip/Snap/workspaces/fra-2967" },
        { runner, readHead, signal: controller.signal },
      ),
    ).rejects.toThrow("shutdown");
    expect(readHead).toHaveBeenCalledOnce();
  });
});

describe("runBoundedSnapReviewProcess", () => {
  it("retains only a bounded diagnostic tail", async () => {
    const controller = new AbortController();
    const result = await runBoundedSnapReviewProcess(
      process.execPath,
      ["-e", "process.stdout.write('prefix-' + 'x'.repeat(10000) + '-tail')"],
      { signal: controller.signal, outputLimit: 256 },
    );

    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(Buffer.byteLength(result.diagnosticTail)).toBeLessThanOrEqual(256);
    expect(result.diagnosticTail.endsWith("-tail")).toBe(true);
    expect(result.diagnosticTail).not.toContain("prefix-");
  });

  it("times out a long-running process", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = await runBoundedSnapReviewProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 500)"],
      { signal: controller.signal, timeoutMs: 100, forceKillGraceMs: 10 } as never,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(300);
  });

  it("cancels the complete child process group", async () => {
    const controller = new AbortController();
    const operation = runBoundedSnapReviewProcess(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 100)"],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);

    await expect(operation).rejects.toThrow("cancelled by test");
  });

  it("kills a resistant descendant after the direct child exits", async () => {
    const marker = path.join(tmpdir(), `wakewire-preflight-descendant-${process.pid}`);
    await rm(marker, { force: true });
    const descendant = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(
      marker,
    )}, 'alive'), 300); setInterval(() => {}, 1000)`;
    const parent = `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(
      descendant,
    )}], {stdio:'ignore'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`;
    const controller = new AbortController();
    const operation = runBoundedSnapReviewProcess(process.execPath, ["-e", parent], {
      signal: controller.signal,
      forceKillGraceMs: 10,
    });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 100);

    try {
      await expect(operation).rejects.toThrow("cancelled by test");
      await new Promise((resolve) => setTimeout(resolve, 400));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(marker, { force: true });
    }
  });

  it("scrubs inherited interpreter and build controls", async () => {
    vi.stubEnv("PYTHONPATH", "/hostile/python");
    vi.stubEnv("MAKEFILES", "/hostile/makefile");
    try {
      const result = await runBoundedSnapReviewProcess(
        process.execPath,
        [
          "-e",
          "process.stdout.write([process.env.PYTHONPATH ?? '', process.env.MAKEFILES ?? '', process.env.PATH ? 'path' : ''].join('|'))",
        ],
        { signal: new AbortController().signal },
      );
      expect(result.diagnosticTail).toBe("||path");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("readSnapWorkspaceHead", () => {
  it("reads one exact full Git HEAD without a shell", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "wakewire-clean-head-"));
    try {
      execFileSync("/usr/bin/git", ["-C", cwd, "init", "-b", "fra-2967"]);
      execFileSync("/usr/bin/git", ["-C", cwd, "config", "user.name", "WakeWire Test"]);
      execFileSync("/usr/bin/git", ["-C", cwd, "config", "user.email", "wakewire@example.test"]);
      await writeFile(path.join(cwd, "README.md"), "clean\n", "utf8");
      execFileSync("/usr/bin/git", ["-C", cwd, "add", "README.md"]);
      execFileSync("/usr/bin/git", ["-C", cwd, "commit", "-m", "test"]);

      const head = await readSnapWorkspaceHead(cwd, new AbortController().signal);
      expect(head).toMatch(/^[0-9a-f]{40}$/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("wraps Git status with bounded process-tree cancellation", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "wakewire-head-cancel-"));
    const pidFile = path.join(cwd, "hook.pid");
    const hook = path.join(cwd, "fsmonitor-hook");
    try {
      execFileSync("/usr/bin/git", ["-C", cwd, "init", "-b", "fra-2967"]);
      execFileSync("/usr/bin/git", ["-C", cwd, "config", "user.name", "WakeWire Test"]);
      execFileSync("/usr/bin/git", ["-C", cwd, "config", "user.email", "wakewire@example.test"]);
      await writeFile(path.join(cwd, "README.md"), "clean\n", "utf8");
      execFileSync("/usr/bin/git", ["-C", cwd, "add", "README.md"]);
      execFileSync("/usr/bin/git", ["-C", cwd, "commit", "-m", "test"]);
      await writeFile(
        hook,
        `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(
          pidFile,
        )}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`,
        "utf8",
      );
      await chmod(hook, 0o755);
      execFileSync("/usr/bin/git", ["-C", cwd, "config", "core.fsmonitor", hook]);
      const controller = new AbortController();
      const operation = readSnapWorkspaceHead(cwd, controller.signal);
      setTimeout(() => controller.abort(new Error("cancelled by test")), 100);

      await expect(operation).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "cancelled by test" }),
        stdout: expect.any(String),
        stderr: expect.any(String),
      });
    } finally {
      try {
        const pid = Number(await readFile(pidFile, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        // The bounded implementation may terminate before the hook records its PID.
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
