import { spawn } from "node:child_process";
import {
  runBoundedSnapWorkspaceCommand,
  SNAP_WORKSPACES_ROOT,
  snapCommandEnvironment,
} from "./snap-workspace.js";

export const SNAP_REVIEW_PROJECTS = ["app", "data", "snapcorp", "windmill"] as const;
const SNAP_REVIEW_DIAGNOSTIC_LIMIT = 16 * 1_024;
const SNAP_REVIEW_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const SNAP_REVIEW_FORCE_KILL_GRACE_MS = 2_000;

export type SnapReviewProject = (typeof SNAP_REVIEW_PROJECTS)[number];
export type SuiteState = "passed" | "test-failed" | "lint-failed" | "missing";

export interface SnapReviewTestSummary {
  passed: boolean;
  suites: Record<SnapReviewProject, SuiteState>;
}

export interface SnapReviewTestResult extends SnapReviewTestSummary {
  headSha: string;
  diagnosticTail: string;
}

export interface SnapReviewProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  diagnosticTail: string;
}

export type SnapReviewProcessRunner = (
  executable: string,
  args: readonly string[],
  options: { signal: AbortSignal },
) => Promise<SnapReviewProcessResult>;

export function runBoundedSnapReviewProcess(
  executable: string,
  args: readonly string[],
  options: {
    signal: AbortSignal;
    outputLimit?: number;
    timeoutMs?: number;
    forceKillGraceMs?: number;
  },
): Promise<SnapReviewProcessResult> {
  const outputLimit = options.outputLimit ?? SNAP_REVIEW_DIAGNOSTIC_LIMIT;
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(executable, [...args], {
      detached: process.platform !== "win32",
      env: snapCommandEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let settled = false;
    let failureReason: unknown;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = (reason: unknown, timeoutFailure: boolean): void => {
      if (failureReason === undefined) failureReason = reason;
      if (timeoutFailure) timedOut = true;
      terminateProcessTree(child.pid, "SIGTERM");
      forceKill ??= setTimeout(
        () => terminateProcessTree(child.pid, "SIGKILL"),
        options.forceKillGraceMs ?? SNAP_REVIEW_FORCE_KILL_GRACE_MS,
      );
    };
    const onAbort = (): void =>
      terminate(options.signal.reason ?? new Error("review preflight aborted"), false);
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => terminate(new Error("review preflight timed out"), true),
            options.timeoutMs,
          );
    let tail = Buffer.alloc(0);
    const append = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > outputLimit) tail = tail.subarray(tail.length - outputLimit);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(failureReason ?? error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
      if (failureReason !== undefined) terminateProcessTree(child.pid, "SIGKILL");
      if (forceKill) clearTimeout(forceKill);
      if (failureReason !== undefined && !timedOut) {
        reject(failureReason);
        return;
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        diagnosticTail: tail.toString("utf8"),
      });
    });
  });
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The process may have exited between the timeout and the kill attempt.
  }
}

export async function readSnapWorkspaceHead(cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const { stdout } = await runBoundedSnapWorkspaceCommand(
    "/usr/bin/git",
    ["-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    signal,
  );
  return parseCleanSnapWorkspaceState(stdout);
}

export function parseCleanSnapWorkspaceState(output: string): string {
  const lines = output.split(/\r?\n/u).filter(Boolean);
  const oidLines = lines.filter((line) => line.startsWith("# branch.oid "));
  const headLines = lines.filter((line) => line.startsWith("# branch.head "));
  const fileRecords = lines.filter((line) => !line.startsWith("# "));
  const oid = oidLines[0]?.slice("# branch.oid ".length) ?? "";
  const branch = headLines[0]?.slice("# branch.head ".length) ?? "";
  if (
    oidLines.length !== 1 ||
    headLines.length !== 1 ||
    !/^[0-9a-f]{40}$/u.test(oid) ||
    !/^[a-z][a-z0-9]*-[0-9]+$/u.test(branch) ||
    fileRecords.length > 0
  ) {
    throw new Error("review preflight requires one clean ticket workspace state");
  }
  return oid;
}

export interface SnapReviewPreflightOptions {
  runner?: SnapReviewProcessRunner;
  readHead?: (cwd: string, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal | undefined;
}

export async function runSnapReviewPreflight(
  workspace: { ticket: string; cwd: string },
  options: SnapReviewPreflightOptions = {},
): Promise<SnapReviewTestResult> {
  if (
    !/^[a-z][a-z0-9]*-[0-9]+$/u.test(workspace.ticket) ||
    workspace.cwd !== `${SNAP_WORKSPACES_ROOT}/${workspace.ticket}`
  ) {
    throw new Error("test preflight requires one exact ticket workspace");
  }
  const signal = options.signal ?? new AbortController().signal;
  const runner =
    options.runner ??
    ((executable, args, runOptions) => {
      if (executable !== "make") throw new Error("review preflight command is not allowlisted");
      return runBoundedSnapReviewProcess("/usr/bin/make", args, {
        ...runOptions,
        timeoutMs: SNAP_REVIEW_TIMEOUT_MS,
      });
    });
  const readHead = options.readHead ?? readSnapWorkspaceHead;
  signal.throwIfAborted();
  const headSha = await readHead(workspace.cwd, signal);
  signal.throwIfAborted();
  const processResult = await runner(
    "make",
    ["-C", SNAP_WORKSPACES_ROOT, "test", workspace.ticket],
    { signal },
  );
  signal.throwIfAborted();
  const finalHeadSha = await readHead(workspace.cwd, signal);
  const summary = parseSnapReviewTestSummary(processResult.diagnosticTail, processResult.exitCode);
  const invalidation =
    finalHeadSha !== headSha
      ? "HEAD changed during the aggregate test run"
      : processResult.timedOut
        ? "aggregate test run timed out"
        : null;
  return {
    headSha,
    passed: summary.passed && !processResult.timedOut && finalHeadSha === headSha,
    suites: summary.suites,
    diagnosticTail: invalidation
      ? `${processResult.diagnosticTail}\n${invalidation}`.slice(-SNAP_REVIEW_DIAGNOSTIC_LIMIT)
      : processResult.diagnosticTail,
  };
}

export function parseSnapReviewTestSummary(
  output: string,
  exitCode: number | null,
): SnapReviewTestSummary {
  const suites: Record<SnapReviewProject, SuiteState> = {
    app: "missing",
    data: "missing",
    snapcorp: "missing",
    windmill: "missing",
  };
  let valid = true;
  for (const project of SNAP_REVIEW_PROJECTS) {
    const matches = [
      ...output.matchAll(
        new RegExp(
          `^${project}: (TEST PASSED|TEST FAILED \\(exit code [1-9][0-9]*\\)|LINT FAILED — suite not run)$`,
          "gmu",
        ),
      ),
    ];
    if (matches.length !== 1) {
      valid = false;
      continue;
    }
    const state = matches[0]?.[1];
    suites[project] =
      state === "TEST PASSED"
        ? "passed"
        : state?.startsWith("TEST FAILED")
          ? "test-failed"
          : "lint-failed";
  }
  const aggregate = [...output.matchAll(/^All test suites passed!$/gmu)];
  return {
    passed: valid && exitCode === 0 && aggregate.length === 1,
    suites,
  };
}
