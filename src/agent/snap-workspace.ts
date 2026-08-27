import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isValidLowercaseBranch } from "./references.js";

export const SNAP_ROOT = "/Users/chip/Snap";
export const SNAP_WORKSPACE_METADATA = ".snap/workspace.env";
const COMMAND_DIAGNOSTIC_OUTPUT_LIMIT = 4_096;

export type SnapWorkspaceCommandRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<void>;

/** Filesystem seam for tests; production uses node:fs/promises. */
export interface SnapWorkspaceInspector {
  isDirectory(targetPath: string): Promise<boolean>;
  realpath(targetPath: string): Promise<string>;
  readTextFileIfExists(targetPath: string): Promise<string | null>;
}

export interface SnapWorkspaceResolverOptions {
  runner?: SnapWorkspaceCommandRunner;
  inspector?: SnapWorkspaceInspector;
  /** Select the root controller contract for a Linear issue or an existing PR head. */
  mode?: "issue" | "pull-request";
  /** Defaults to true. A caller must opt out explicitly while migrating older workspaces. */
  requireMetadata?: boolean;
  signal?: AbortSignal | undefined;
}

export interface ResolvedSnapWorkspace {
  branch: string;
  cwd: string;
  metadataPath: string;
  metadataValidated: boolean;
}

export class InvalidSnapBranchError extends Error {}
export interface SnapWorkspaceCommandDiagnostics {
  readonly code: string | number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class SnapWorkspaceCommandError extends Error {
  readonly #diagnostics: SnapWorkspaceCommandDiagnostics;

  constructor(
    branch: string,
    cause: unknown,
    diagnostics: Partial<SnapWorkspaceCommandDiagnostics> = {},
  ) {
    super(`root Makefile could not prepare workspace ${branch}`, { cause });
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

/**
 * Create or reuse a Snap issue workspace through `make prepare`, or import an
 * existing PR head through `make pr`, then validate the exact resulting path.
 * No branch is repaired, slugified, or passed through a shell.
 */
export async function resolveSnapWorkspace(
  branch: string,
  options: SnapWorkspaceResolverOptions = {},
): Promise<ResolvedSnapWorkspace> {
  assertExactSnapBranch(branch);

  const runner = options.runner ?? execFileRunner;
  const target = options.mode === "pull-request" ? "pr" : "prepare";
  try {
    options.signal?.throwIfAborted();
    await (options.signal
      ? runner("make", ["-C", SNAP_ROOT, target, branch], options.signal)
      : runner("make", ["-C", SNAP_ROOT, target, branch]));
    options.signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof ExecFileFailure) {
      throw new SnapWorkspaceCommandError(branch, error.cause, {
        stdout: error.stdout,
        stderr: error.stderr,
      });
    }
    throw new SnapWorkspaceCommandError(branch, error);
  }

  const inspector = options.inspector ?? nodeInspector;
  const workspacePath = path.join(SNAP_ROOT, branch);
  if (!(await inspector.isDirectory(workspacePath))) {
    throw new SnapWorkspaceValidationError(
      `expected workspace directory was not created: ${branch}`,
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = await inspector.realpath(workspacePath);
  } catch {
    throw new SnapWorkspaceValidationError(`workspace path could not be resolved: ${branch}`);
  }
  if (path.normalize(resolvedPath) !== workspacePath) {
    throw new SnapWorkspaceValidationError(
      `workspace did not resolve to the exact Snap path: ${branch}`,
    );
  }

  const metadataPath = path.join(workspacePath, SNAP_WORKSPACE_METADATA);
  let metadata: string | null;
  try {
    metadata = await inspector.readTextFileIfExists(metadataPath);
  } catch {
    throw new SnapWorkspaceValidationError(`workspace metadata could not be read: ${branch}`);
  }

  if (metadata === null) {
    if (options.requireMetadata !== false) {
      throw new SnapWorkspaceValidationError(`workspace metadata is missing: ${branch}`);
    }
    return {
      branch,
      cwd: workspacePath,
      metadataPath,
      metadataValidated: false,
    };
  }

  validateMetadataBranch(metadata, branch);
  return {
    branch,
    cwd: workspacePath,
    metadataPath,
    metadataValidated: true,
  };
}

/** Validate the exact controller-supported lowercase branch syntax and length. */
export function assertExactSnapBranch(branch: string): void {
  if (!isValidLowercaseBranch(branch)) {
    throw new InvalidSnapBranchError("branch must be the exact lowercase Linear branch name");
  }
}

const execFileRunner: SnapWorkspaceCommandRunner = (executable, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", shell: false, signal },
      (error, stdout, stderr) => {
        if (error) reject(new ExecFileFailure(error, stdout, stderr));
        else resolve();
      },
    );
  });

class ExecFileFailure {
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
  async readTextFileIfExists(targetPath) {
    try {
      return await readFile(targetPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
};

function validateMetadataBranch(metadata: string, branch: string): void {
  const values = [...metadata.matchAll(/^BRANCH_NAME=(.*)$/gm)].map((match) => match[1]);
  if (values.length !== 1 || values[0] !== branch) {
    throw new SnapWorkspaceValidationError(`workspace metadata does not match branch ${branch}`);
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
