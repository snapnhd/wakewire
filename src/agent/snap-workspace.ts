import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const SNAP_ROOT = "/Users/chip/Snap";
export const SNAP_WORKSPACES_ROOT = path.join(SNAP_ROOT, "workspaces");
export const SNAP_WORKSPACE_METADATA = ".snap/workspace.env";
const COMMAND_DIAGNOSTIC_OUTPUT_LIMIT = 4_096;
const PRIVATE_METADATA_MAX_BYTES = 16 * 1_024;
const SNAP_WORKSPACE_FORCE_KILL_GRACE_MS = 2_000;
const SNAP_WORKSPACE_COMMAND_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const TRUSTED_COMMAND_PATH =
  "/Users/chip/.homebrew/bin:/Users/chip/.homebrew/sbin:/Users/chip/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const LINEAR_TICKET = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/u;
const LOWERCASE_TICKET = /^[a-z][a-z0-9]*-[0-9]+$/u;
const SYSTEM_PULL_REQUEST = /^https:\/\/github\.com\/snapnhd\/system\/pull\/[1-9][0-9]*$/u;
const REQUIRED_WORKSPACE_PROCESSES: ReadonlySet<string> = new Set([
  "redis",
  "app-web",
  "app-vite",
  "app-workers",
  "data-web",
  "snapcorp-web",
  "snapcorp-workers",
]);

export interface SnapWorkspaceCommandResult {
  stdout: string;
  stderr: string;
}

export type SnapWorkspaceCommandRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<SnapWorkspaceCommandResult>;

/** Filesystem seam for tests; production uses node:fs/promises. */
export interface SnapWorkspaceInspector {
  isDirectory(targetPath: string): Promise<boolean>;
  realpath(targetPath: string): Promise<string>;
  readTextFileIfExists(targetPath: string): Promise<string | null>;
}

export interface SnapWorkspaceResolverOptions {
  runner?: SnapWorkspaceCommandRunner;
  inspector?: SnapWorkspaceInspector;
  signal?: AbortSignal | undefined;
}

export interface SnapWorkspaceInput {
  /** Trusted exact Linear ticket, normalized to lowercase before dispatch. */
  authoritativeLinearInput?: string | undefined;
  /** Exact authenticated system PR URL; used only when authoritative Linear identity is absent. */
  pullRequestUrl?: string | undefined;
}

export interface ResolvedSnapWorkspace {
  ticket: string;
  cwd: string;
  headSha: string;
  urls: {
    app: string;
    data: string;
    snapcorp: string;
  };
}

export class InvalidSnapWorkspaceInputError extends Error {}
export interface SnapWorkspaceCommandDiagnostics {
  readonly code: string | number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class SnapWorkspaceCommandError extends Error {
  readonly #diagnostics: SnapWorkspaceCommandDiagnostics;

  constructor(
    input: string,
    cause: unknown,
    diagnostics: Partial<SnapWorkspaceCommandDiagnostics> = {},
  ) {
    super(`workspace dispatcher could not prepare ${input}`, { cause });
    const inferred = commandDiagnostics(cause);
    this.#diagnostics = Object.freeze({
      code: commandCode(diagnostics.code) ?? inferred.code,
      signal: commandSignal(diagnostics.signal) ?? inferred.signal,
      stdout: boundedCommandOutput(diagnostics.stdout ?? inferred.stdout),
      stderr: boundedCommandOutput(diagnostics.stderr ?? inferred.stderr),
    });
  }

  /** Intentionally non-enumerable so subprocess output is never serialized accidentally. */
  get diagnostics(): SnapWorkspaceCommandDiagnostics {
    return this.#diagnostics;
  }
}
export class SnapWorkspaceValidationError extends Error {}

/** Create or reuse one ticket workspace through the dispatcher and validate it. */
export async function resolveSnapWorkspace(
  input: SnapWorkspaceInput,
  options: SnapWorkspaceResolverOptions = {},
): Promise<ResolvedSnapWorkspace> {
  const selected = selectDispatcherInput(input);
  const runner = options.runner ?? defaultSnapWorkspaceCommandRunner;
  const initialStatusInput = selected.pullRequestUrl ?? selected.dispatchInput;
  let statusOutput: string;
  try {
    options.signal?.throwIfAborted();
    await run(
      runner,
      "make",
      ["-C", SNAP_WORKSPACES_ROOT, "dev", selected.dispatchInput],
      options.signal,
    );
    options.signal?.throwIfAborted();
    const status = await run(
      runner,
      "make",
      ["-C", SNAP_WORKSPACES_ROOT, "status", initialStatusInput],
      options.signal,
    );
    statusOutput = status.stdout;
    options.signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof SnapWorkspaceProcessFailure) {
      throw new SnapWorkspaceCommandError(selected.dispatchInput, error.cause, {
        stdout: error.stdout,
        stderr: error.stderr,
      });
    }
    throw new SnapWorkspaceCommandError(selected.dispatchInput, error);
  }

  let status = parseWorkspaceStatus(statusOutput);
  const expectedTicket = selected.expectedTicket ?? status.ticket;
  if (status.ticket !== expectedTicket) {
    throw new SnapWorkspaceValidationError(
      "pull request status ticket does not match the authoritative ticket",
    );
  }
  if (initialStatusInput !== expectedTicket) {
    const pullRequestStatus = status;
    try {
      const verifiedStatus = await run(
        runner,
        "make",
        ["-C", SNAP_WORKSPACES_ROOT, "status", expectedTicket],
        options.signal,
      );
      status = parseWorkspaceStatus(verifiedStatus.stdout);
      if (!sameWorkspaceStatus(pullRequestStatus, status)) {
        throw new SnapWorkspaceValidationError(
          "pull request status does not match the authoritative ticket workspace",
        );
      }
    } catch (error) {
      if (error instanceof SnapWorkspaceProcessFailure) {
        throw new SnapWorkspaceCommandError(expectedTicket, error.cause, {
          stdout: error.stdout,
          stderr: error.stderr,
        });
      }
      if (error instanceof SnapWorkspaceValidationError) throw error;
      throw new SnapWorkspaceCommandError(expectedTicket, error);
    }
  }
  if (status.ticket !== expectedTicket) {
    throw new SnapWorkspaceValidationError(
      "workspace status ticket does not match the resolved dispatcher identity",
    );
  }
  const ticket = status.ticket;
  const inspector = options.inspector ?? nodeInspector;
  const workspacePath = path.join(SNAP_WORKSPACES_ROOT, ticket);
  if (!(await inspector.isDirectory(workspacePath))) {
    throw new SnapWorkspaceValidationError(
      `expected workspace directory was not created: ${ticket}`,
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = await inspector.realpath(workspacePath);
  } catch {
    throw new SnapWorkspaceValidationError(`workspace path could not be resolved: ${ticket}`);
  }
  if (path.normalize(resolvedPath) !== workspacePath) {
    throw new SnapWorkspaceValidationError(
      `workspace did not resolve to the exact Snap path: ${ticket}`,
    );
  }

  const metadataPath = path.join(workspacePath, SNAP_WORKSPACE_METADATA);
  let metadata: string | null;
  try {
    metadata = await inspector.readTextFileIfExists(metadataPath);
  } catch {
    throw new SnapWorkspaceValidationError(`workspace metadata could not be read: ${ticket}`);
  }
  if (metadata === null) {
    throw new SnapWorkspaceValidationError(`workspace metadata is missing: ${ticket}`);
  }
  validateMetadataTicket(metadata, ticket);

  let gitIdentity: SnapWorkspaceCommandResult;
  try {
    gitIdentity = await run(
      runner,
      "git",
      ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD", "HEAD"],
      options.signal,
    );
  } catch (error) {
    throw new SnapWorkspaceValidationError("workspace Git identity could not be read", {
      cause: error,
    });
  }
  const [branch, headSha, ...extraGitLines] = gitIdentity.stdout.trim().split(/\r?\n/u);
  if (branch !== ticket || !headSha || !/^[0-9a-f]{40}$/u.test(headSha) || extraGitLines.length) {
    throw new SnapWorkspaceValidationError("workspace Git identity does not match ticket");
  }
  return {
    ticket,
    cwd: workspacePath,
    headSha,
    urls: status.urls,
  };
}

function selectDispatcherInput(input: SnapWorkspaceInput): {
  dispatchInput: string;
  expectedTicket?: string;
  pullRequestUrl?: string;
} {
  if (input.authoritativeLinearInput !== undefined) {
    const ticket = normalizeLinearTicket(input.authoritativeLinearInput);
    if (!ticket) {
      throw new InvalidSnapWorkspaceInputError("Linear identity must be an exact ticket");
    }
    const pullRequestUrl = input.pullRequestUrl;
    if (pullRequestUrl !== undefined && !SYSTEM_PULL_REQUEST.test(pullRequestUrl)) {
      throw new InvalidSnapWorkspaceInputError(
        "PR binding must be an exact snapnhd/system pull request URL",
      );
    }
    return {
      dispatchInput: ticket,
      expectedTicket: ticket,
      ...(pullRequestUrl ? { pullRequestUrl } : {}),
    };
  }
  const pullRequestUrl = input.pullRequestUrl;
  if (!pullRequestUrl || !SYSTEM_PULL_REQUEST.test(pullRequestUrl)) {
    throw new InvalidSnapWorkspaceInputError(
      "fallback must be an exact snapnhd/system pull request URL",
    );
  }
  return { dispatchInput: pullRequestUrl, pullRequestUrl };
}

function sameWorkspaceStatus(
  left: ReturnType<typeof parseWorkspaceStatus>,
  right: ReturnType<typeof parseWorkspaceStatus>,
): boolean {
  return (
    left.ticket === right.ticket &&
    left.urls.app === right.urls.app &&
    left.urls.data === right.urls.data &&
    left.urls.snapcorp === right.urls.snapcorp
  );
}

function normalizeLinearTicket(value: string): string | null {
  if (value !== value.trim()) return null;
  return LINEAR_TICKET.test(value) ? value.toLowerCase() : null;
}

function parseWorkspaceStatus(output: string): {
  ticket: string;
  urls: ResolvedSnapWorkspace["urls"];
} {
  const keys = new Set(["ticket", "app", "data", "snapcorp", "overmind"]);
  const values = new Map<string, string>();
  const runningProcesses = new Set<string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const pair = line.match(/^([a-z]+)=(.*)$/u);
    if (pair?.[1] && keys.has(pair[1])) {
      if (values.has(pair[1])) {
        throw new SnapWorkspaceValidationError(`workspace status duplicated ${pair[1]}`);
      }
      values.set(pair[1], pair[2] ?? "");
      continue;
    }
    const process = line.match(/^([a-z][a-z0-9-]*)\s+[1-9][0-9]*\s+running$/u);
    if (process?.[1] && REQUIRED_WORKSPACE_PROCESSES.has(process[1])) {
      runningProcesses.add(process[1]);
    }
  }
  if (!values.has("overmind") && runningProcesses.size === REQUIRED_WORKSPACE_PROCESSES.size) {
    values.set("overmind", "running");
  }
  const ticket = values.get("ticket") ?? "";
  if (!LOWERCASE_TICKET.test(ticket)) {
    throw new SnapWorkspaceValidationError("workspace status has no exact lowercase ticket");
  }
  if (values.get("overmind") !== "running") {
    throw new SnapWorkspaceValidationError("workspace runtime is not running");
  }
  const urls = {
    app: values.get("app") ?? "",
    data: values.get("data") ?? "",
    snapcorp: values.get("snapcorp") ?? "",
  };
  const expected = {
    app: `https://${ticket}.ws.chipbyte.dev`,
    data: `https://data-${ticket}.ws.chipbyte.dev`,
    snapcorp: `https://snapcorp-${ticket}.ws.chipbyte.dev`,
  };
  if (
    urls.app !== expected.app ||
    urls.data !== expected.data ||
    urls.snapcorp !== expected.snapcorp
  ) {
    throw new SnapWorkspaceValidationError("workspace status contains unexpected public hosts");
  }
  return { ticket, urls };
}

function run(
  runner: SnapWorkspaceCommandRunner,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<SnapWorkspaceCommandResult> {
  return signal ? runner(executable, args, signal) : runner(executable, args);
}

const defaultSnapWorkspaceCommandRunner: SnapWorkspaceCommandRunner = (
  executable,
  args,
  signal,
) => {
  if (executable !== "make" && executable !== "git") {
    throw new SnapWorkspaceValidationError("workspace command is not allowlisted");
  }
  return runBoundedSnapWorkspaceCommand(`/usr/bin/${executable}`, args, signal);
};

export function runBoundedSnapWorkspaceCommand(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<SnapWorkspaceCommandResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, [...args], {
      detached: process.platform !== "win32",
      env: snapCommandEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let stderr = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let failureReason: unknown;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = (reason: unknown): void => {
      if (failureReason === undefined) failureReason = reason;
      terminateWorkspaceProcessTree(child.pid, "SIGTERM");
      forceKill ??= setTimeout(
        () => terminateWorkspaceProcessTree(child.pid, "SIGKILL"),
        SNAP_WORKSPACE_FORCE_KILL_GRACE_MS,
      );
    };
    const onAbort = (): void => terminate(signal?.reason ?? new Error("workspace command aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => terminate(new Error("workspace command timed out")),
      SNAP_WORKSPACE_COMMAND_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBoundedCommandOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBoundedCommandOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      reject(new SnapWorkspaceProcessFailure(error, stdout, stderr));
    });
    child.once("close", (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failureReason !== undefined) terminateWorkspaceProcessTree(child.pid, "SIGKILL");
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      if (failureReason !== undefined || exitCode !== 0) {
        const cause =
          failureReason ??
          Object.assign(new Error(`workspace command exited ${exitCode ?? "without a code"}`), {
            code: exitCode,
            signal: childSignal,
          });
        reject(new SnapWorkspaceProcessFailure(cause, stdout, stderr));
        return;
      }
      resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

function appendBoundedCommandOutput(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([current, chunk]);
  return combined.length > COMMAND_DIAGNOSTIC_OUTPUT_LIMIT
    ? combined.subarray(combined.length - COMMAND_DIAGNOSTIC_OUTPUT_LIMIT)
    : combined;
}

function terminateWorkspaceProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The process may have exited between the state transition and the signal.
  }
}

export function snapCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_OPTIONAL_LOCKS: "0",
    HOME: "/Users/chip",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LOGNAME: "chip",
    PATH: TRUSTED_COMMAND_PATH,
    SHELL: "/bin/zsh",
    TMPDIR: "/tmp",
    USER: "chip",
  };
}

class SnapWorkspaceProcessFailure {
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    readonly cause: unknown,
    stdout: unknown,
    stderr: unknown,
  ) {
    this.stdout = boundedCommandOutput(stdout);
    this.stderr = boundedCommandOutput(stderr);
  }
}

const nodeInspector: SnapWorkspaceInspector = {
  async isDirectory(targetPath) {
    try {
      return (await stat(targetPath)).isDirectory();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
  realpath,
  readTextFileIfExists: readPrivateWorkspaceMetadata,
};

export async function readPrivateWorkspaceMetadata(targetPath: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new SnapWorkspaceValidationError("workspace metadata could not be opened safely", {
      cause: error,
    });
  }
  try {
    const metadataStat = await handle.stat();
    const effectiveUid = process.geteuid?.();
    if (
      !metadataStat.isFile() ||
      effectiveUid === undefined ||
      metadataStat.uid !== effectiveUid ||
      (metadataStat.mode & 0o777) !== 0o600 ||
      metadataStat.size > PRIVATE_METADATA_MAX_BYTES
    ) {
      throw new SnapWorkspaceValidationError("workspace metadata is not an owner-private file");
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof SnapWorkspaceValidationError) throw error;
    throw new SnapWorkspaceValidationError("workspace metadata could not be read safely", {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

function validateMetadataTicket(metadata: string, ticket: string): void {
  const values = [...metadata.matchAll(/^TICKET=(.*)$/gm)].map((match) => match[1]);
  if (values.length !== 1 || values[0] !== ticket) {
    throw new SnapWorkspaceValidationError(`workspace metadata does not match ticket ${ticket}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function commandDiagnostics(cause: unknown): SnapWorkspaceCommandDiagnostics {
  return {
    code: commandCode(property(cause, "code")),
    signal: commandSignal(property(cause, "signal")),
    stdout: boundedCommandOutput(property(cause, "stdout")),
    stderr: boundedCommandOutput(property(cause, "stderr")),
  };
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function commandCode(value: unknown): string | number | null {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function commandSignal(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedCommandOutput(value: unknown): string {
  const output =
    typeof value === "string"
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value).toString("utf8")
        : "";
  return output.length > COMMAND_DIAGNOSTIC_OUTPUT_LIMIT
    ? output.slice(-COMMAND_DIAGNOSTIC_OUTPUT_LIMIT)
    : output;
}
