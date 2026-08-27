import { describe, expect, it, vi } from "vitest";
import {
  assertExactSnapBranch,
  InvalidSnapBranchError,
  resolveSnapWorkspace,
  SNAP_ROOT,
  SnapWorkspaceCommandError,
  type SnapWorkspaceCommandRunner,
  type SnapWorkspaceInspector,
  SnapWorkspaceValidationError,
} from "./snap-workspace.js";

const branch = "local-issue-workspaces-eng-4610";
const workspacePath = `${SNAP_ROOT}/${branch}`;

function harness(overrides: Partial<SnapWorkspaceInspector> = {}) {
  const runner = vi.fn<SnapWorkspaceCommandRunner>(async () => undefined);
  const inspector: SnapWorkspaceInspector = {
    isDirectory: vi.fn(async () => true),
    realpath: vi.fn(async () => workspacePath),
    readTextFileIfExists: vi.fn(async () => `BRANCH_NAME=${branch}\nSYSTEM=ice\n`),
    ...overrides,
  };
  return { runner, inspector };
}

describe("resolveSnapWorkspace", () => {
  it("invokes only the root Makefile contract and returns the exact validated path", async () => {
    const { runner, inspector } = harness();
    const result = await resolveSnapWorkspace(branch, { runner, inspector });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith("make", ["-C", "/Users/chip/Snap", "prepare", branch]);
    expect(result).toEqual({
      branch,
      cwd: workspacePath,
      metadataPath: `${workspacePath}/.snap/workspace.env`,
      metadataValidated: true,
    });
  });

  it("imports an open pull request through the root PR contract", async () => {
    const { runner, inspector } = harness();

    await resolveSnapWorkspace(branch, { runner, inspector, mode: "pull-request" });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith("make", ["-C", "/Users/chip/Snap", "pr", branch]);
  });

  it.each([
    "",
    "ENG-4610-title",
    "-eng-4610",
    "eng-4610-",
    "eng_4610",
    "eng-4610/title",
    "../eng-4610",
    " eng-4610",
    `eng-${"a".repeat(60)}`,
  ])("rejects an inexact branch before invoking Make: %j", async (invalidBranch) => {
    const { runner, inspector } = harness();

    await expect(resolveSnapWorkspace(invalidBranch, { runner, inspector })).rejects.toBeInstanceOf(
      InvalidSnapBranchError,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it("retains bounded command diagnostics without exposing them in the public error", async () => {
    const { inspector } = harness();
    const stdout = `stdout-prefix:${"o".repeat(5_000)}:stdout-tail`;
    const stderr = `stderr-prefix:${"e".repeat(5_000)}:stderr-tail`;
    const cause = Object.assign(
      new Error("simulated failure with output that must not be copied"),
      {
        code: 2,
        signal: "SIGTERM",
        stdout,
        stderr,
      },
    );
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async () => {
      throw cause;
    });

    const error = await resolveSnapWorkspace(branch, { runner, inspector }).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(SnapWorkspaceCommandError);
    const commandError = error as SnapWorkspaceCommandError;
    expect(commandError.message).toBe(`root Makefile could not prepare workspace ${branch}`);
    expect(commandError.message).not.toContain("simulated failure");
    expect(commandError.cause).toBe(cause);
    expect(commandError.diagnostics).toEqual({
      code: 2,
      signal: "SIGTERM",
      stdout: stdout.slice(-4_096),
      stderr: stderr.slice(-4_096),
    });
    expect(Object.isFrozen(commandError.diagnostics)).toBe(true);
    expect(JSON.stringify(commandError)).not.toContain("stdout-tail");
    expect(JSON.stringify(commandError)).not.toContain("stderr-tail");
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it("forwards cooperative cancellation to the root Make process", async () => {
    const { inspector } = harness();
    const controller = new AbortController();
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, _args, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      signal?.throwIfAborted();
    });

    await expect(
      resolveSnapWorkspace(branch, { runner, inspector, signal: controller.signal }),
    ).rejects.toBeInstanceOf(SnapWorkspaceCommandError);
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it("rejects a missing or redirected workspace directory after Make returns", async () => {
    const missing = harness({ isDirectory: vi.fn(async () => false) });
    await expect(
      resolveSnapWorkspace(branch, { runner: missing.runner, inspector: missing.inspector }),
    ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);

    const redirected = harness({ realpath: vi.fn(async () => "/private/tmp/eng-4610") });
    await expect(
      resolveSnapWorkspace(branch, {
        runner: redirected.runner,
        inspector: redirected.inspector,
      }),
    ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
  });

  it("rejects missing, duplicate, or mismatched branch metadata", async () => {
    for (const metadata of [
      null,
      "SYSTEM=ice\n",
      `BRANCH_NAME=${branch}\nBRANCH_NAME=${branch}\n`,
      "BRANCH_NAME=some-other-branch\n",
    ]) {
      const current = harness({ readTextFileIfExists: vi.fn(async () => metadata) });
      await expect(
        resolveSnapWorkspace(branch, { runner: current.runner, inspector: current.inspector }),
      ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
    }
  });

  it("allows a deliberate metadata-optional migration while still validating metadata if present", async () => {
    const missing = harness({ readTextFileIfExists: vi.fn(async () => null) });
    const result = await resolveSnapWorkspace(branch, {
      runner: missing.runner,
      inspector: missing.inspector,
      requireMetadata: false,
    });
    expect(result.metadataValidated).toBe(false);

    const mismatched = harness({
      readTextFileIfExists: vi.fn(async () => "BRANCH_NAME=wrong-branch\n"),
    });
    await expect(
      resolveSnapWorkspace(branch, {
        runner: mismatched.runner,
        inspector: mismatched.inspector,
        requireMetadata: false,
      }),
    ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
  });
});

describe("assertExactSnapBranch", () => {
  it("accepts both exact Linear branch layouts used by Snap", () => {
    expect(() => assertExactSnapBranch("eng-42-short-title")).not.toThrow();
    expect(() => assertExactSnapBranch("short-title-eng-42")).not.toThrow();
  });
});
