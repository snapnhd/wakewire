import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { DeliveryNotSubmittedError, PermanentError, UnreachableError } from "./types.js";

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClaudeCliAdapterConfig {
  claudePath?: string | undefined;
  turnTimeoutMs?: number | undefined;
  probeTimeoutMs?: number | undefined;
  maxStdoutBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
  terminationGraceMs?: number | undefined;
}

export interface ClaudeCliCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  terminationGraceMs: number;
  signal?: AbortSignal | undefined;
}

export interface ClaudeCliCommandResult {
  stdout: string;
  stderr: string;
}

export interface ClaudeCliRunner {
  run(command: ClaudeCliCommand): Promise<ClaudeCliCommandResult>;
}

/** Minimal child-process surface used by the bounded runner and its tests. */
export interface ClaudeCliChildProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type ClaudeCliSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ClaudeCliChildProcess;

export interface ClaudeThreadCwdStore {
  get(threadId: string): string | undefined | Promise<string | undefined>;
  set(threadId: string, cwd: string): void | Promise<void>;
}

export interface ClaudeCliAdapterDependencies {
  runner?: ClaudeCliRunner | undefined;
  randomUuid?: (() => string) | undefined;
  cwdStore?: ClaudeThreadCwdStore | undefined;
}

/**
 * Process runner for Claude's non-interactive JSON mode. Prompts are written
 * only to stdin; argv is reserved for fixed control flags and session ids.
 */
export class SpawnClaudeCliRunner implements ClaudeCliRunner {
  constructor(private readonly spawnProcess: ClaudeCliSpawn = defaultClaudeSpawn) {}

  run(command: ClaudeCliCommand): Promise<ClaudeCliCommandResult> {
    validatePositiveInteger(command.timeoutMs, "timeoutMs");
    validatePositiveInteger(command.maxStdoutBytes, "maxStdoutBytes");
    validatePositiveInteger(command.maxStderrBytes, "maxStderrBytes");
    validatePositiveInteger(command.terminationGraceMs, "terminationGraceMs");
    command.signal?.throwIfAborted();

    return new Promise((resolve, reject) => {
      let child: ClaudeCliChildProcess;
      try {
        child = this.spawnProcess(command.executable, command.args, {
          cwd: command.cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new DeliveryNotSubmittedError(
            `Claude CLI could not be spawned: ${asError(error).message}`,
          ),
        );
        return;
      }

      let settled = false;
      let spawnConfirmed = false;
      let terminationError: Error | null = null;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      let escalationTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (escalationTimer) clearTimeout(escalationTimer);
        command.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(asError(error));
      };
      const terminate = (error: unknown): void => {
        if (settled || terminationError) return;
        terminationError = asError(error);
        if (timer) clearTimeout(timer);
        command.signal?.removeEventListener("abort", onAbort);
        escalationTimer = setTimeout(() => {
          if (settled) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // A concurrent exit will be observed through the close event.
          }
        }, command.terminationGraceMs);
        try {
          child.kill("SIGTERM");
        } catch {
          // A concurrent exit will be observed through the close event.
        }
      };
      const onAbort = (): void => {
        try {
          command.signal?.throwIfAborted();
          terminate(new Error("Claude CLI command aborted"));
        } catch (error) {
          terminate(error);
        }
      };
      child.stdout.on("data", (chunk: string | Buffer) => {
        if (settled || terminationError) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > command.maxStdoutBytes) {
          terminate(new Error(`Claude CLI stdout exceeded ${command.maxStdoutBytes} bytes`));
          return;
        }
        stdoutChunks.push(buffer);
      });
      child.stderr.on("data", (chunk: string | Buffer) => {
        if (settled || terminationError) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.byteLength;
        if (stderrBytes > command.maxStderrBytes) {
          terminate(new Error(`Claude CLI stderr exceeded ${command.maxStderrBytes} bytes`));
          return;
        }
        stderrChunks.push(buffer);
      });
      child.stdin.once("error", (error) => terminate(error));
      child.once("spawn", () => {
        spawnConfirmed = true;
      });
      child.once("error", (error) => {
        if (terminationError) return;
        if (spawnConfirmed) {
          terminate(error);
          return;
        }
        fail(new DeliveryNotSubmittedError(`Claude CLI could not be spawned: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        if (terminationError) {
          fail(terminationError);
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          const diagnostic = stderr.trim().slice(-1_000);
          fail(
            new Error(
              `Claude CLI exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${diagnostic ? `: ${diagnostic}` : ""}`,
            ),
          );
          return;
        }
        settled = true;
        cleanup();
        resolve({ stdout, stderr });
      });

      timer = setTimeout(() => {
        terminate(new Error(`Claude CLI timed out after ${command.timeoutMs}ms`));
      }, command.timeoutMs);
      command.signal?.addEventListener("abort", onAbort, { once: true });
      if (command.signal?.aborted) {
        onAbort();
        return;
      }

      try {
        child.stdin.end(command.stdin);
      } catch (error) {
        terminate(error);
      }
    });
  }
}

class InMemoryClaudeThreadCwdStore implements ClaudeThreadCwdStore {
  private readonly byThread = new Map<string, string>();

  get(threadId: string): string | undefined {
    return this.byThread.get(threadId);
  }

  set(threadId: string, cwd: string): void {
    this.byThread.set(threadId, cwd);
  }
}

/**
 * Claude Code CLI adapter using one persisted Claude session id per WakeWire
 * task. Every turn is a fresh headless process, while `--resume` preserves the
 * conversation. The original cwd is pinned because Claude resolves sessions
 * within a project directory.
 */
export class ClaudeCliAdapter implements AgentAdapter {
  readonly name = "claude-cli";
  private readonly runner: ClaudeCliRunner;
  private readonly uuid: () => string;
  private readonly cwdStore: ClaudeThreadCwdStore;
  private readonly turnTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly terminationGraceMs: number;

  constructor(
    private readonly logger: Logger,
    private readonly config: ClaudeCliAdapterConfig = {},
    dependencies: ClaudeCliAdapterDependencies = {},
  ) {
    this.runner = dependencies.runner ?? new SpawnClaudeCliRunner();
    this.uuid = dependencies.randomUuid ?? randomUUID;
    this.cwdStore = dependencies.cwdStore ?? new InMemoryClaudeThreadCwdStore();
    this.turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    this.maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.terminationGraceMs = config.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    validatePositiveInteger(this.turnTimeoutMs, "turnTimeoutMs");
    validatePositiveInteger(this.probeTimeoutMs, "probeTimeoutMs");
    validatePositiveInteger(this.maxStdoutBytes, "maxStdoutBytes");
    validatePositiveInteger(this.maxStderrBytes, "maxStderrBytes");
    validatePositiveInteger(this.terminationGraceMs, "terminationGraceMs");
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    throwIfAbortedBeforeDelivery(opts.signal);
    const sandboxArgs = claudeSandboxArgs(opts.sandbox);
    const sessionId = startSessionId(opts.idempotencyKey, this.uuid);
    const cwd = await existingDirectory(opts.cwd ?? process.cwd());
    throwIfAbortedBeforeDelivery(opts.signal);
    const result = await this.invoke(
      claudeTurnArgs(sandboxArgs, ["--session-id", sessionId]),
      prompt,
      cwd,
      opts.signal,
      null,
    );
    await this.bindCwd(result.threadId, cwd);
    return result;
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    throwIfAbortedBeforeDelivery(opts.signal);
    const sandboxArgs = claudeSandboxArgs(opts.sandbox);
    const sessionId = validateSessionIdBeforeSubmission(threadId);
    const cwd = await this.resolveResumeCwd(sessionId, opts.cwd);
    throwIfAbortedBeforeDelivery(opts.signal);
    const result = await this.invoke(
      claudeTurnArgs(sandboxArgs, ["--resume", sessionId]),
      prompt,
      cwd,
      opts.signal,
      sessionId,
    );
    await this.bindCwd(result.threadId, cwd);
    return result;
  }

  async probe(): Promise<boolean> {
    try {
      await this.runner.run({
        executable: this.config.claudePath ?? "claude",
        args: ["--version"],
        cwd: process.cwd(),
        stdin: "",
        timeoutMs: this.probeTimeoutMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
        terminationGraceMs: this.terminationGraceMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async invoke(
    args: readonly string[],
    prompt: string,
    cwd: string,
    signal: AbortSignal | undefined,
    resumedThreadId: string | null,
  ): Promise<DeliveryResult> {
    try {
      const output = await this.runner.run({
        executable: this.config.claudePath ?? "claude",
        args,
        cwd,
        stdin: prompt,
        timeoutMs: this.turnTimeoutMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
        terminationGraceMs: this.terminationGraceMs,
        ...(signal ? { signal } : {}),
      });
      const expectedSessionId = resumedThreadId ?? args.at(-1);
      if (!expectedSessionId) {
        throw new UnreachableError("Claude CLI invocation has no expected session id");
      }
      return parseClaudeCliResult(output.stdout, expectedSessionId);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      const mapped = mapClaudeCliError(error, resumedThreadId);
      this.logger.debug(
        { adapter: this.name, threadId: resumedThreadId, error: mapped.name },
        "Claude CLI invocation failed",
      );
      throw mapped;
    }
  }

  private async resolveResumeCwd(
    threadId: string,
    requestedCwd: string | undefined,
  ): Promise<string> {
    const persisted = await this.cwdStore.get(threadId);
    const persistedPath = persisted ? resolveCwdPath(persisted) : undefined;
    const requested = requestedCwd ? resolveCwdPath(requestedCwd) : undefined;
    if (persistedPath && requested && persistedPath !== requested) {
      throw new DeliveryNotSubmittedError(
        `Claude session ${threadId} is bound to ${persistedPath}, not ${requested}`,
      );
    }
    const cwd = persistedPath ?? requested;
    if (!cwd) {
      throw new DeliveryNotSubmittedError(
        `Claude session ${threadId} has no persisted working directory; an exact cwd is required`,
      );
    }
    return existingDirectory(cwd);
  }

  private async bindCwd(threadId: string, cwd: string): Promise<void> {
    const resolved = path.resolve(cwd);
    const existing = await this.cwdStore.get(threadId);
    if (existing && path.resolve(existing) !== resolved) {
      throw new PermanentError(
        `Claude session ${threadId} is already bound to ${path.resolve(existing)}, not ${resolved}`,
      );
    }
    if (!existing) await this.cwdStore.set(threadId, resolved);
  }
}

export function parseClaudeCliResult(stdout: string, expectedSessionId: string): DeliveryResult {
  if (!UUID_PATTERN.test(expectedSessionId)) {
    throw new UnreachableError("Claude CLI result was checked against an invalid session id");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new UnreachableError("Claude CLI did not return one valid JSON result object");
  }
  if (!isRecord(value)) {
    throw new UnreachableError("Claude CLI result is not an object");
  }
  if (value.type !== "result" || value.subtype !== "success" || value.is_error !== false) {
    throw new UnreachableError("Claude CLI returned a non-success result object");
  }
  if (typeof value.session_id !== "string" || value.session_id !== expectedSessionId) {
    throw new UnreachableError("Claude CLI result session id does not match the requested session");
  }
  if (typeof value.result !== "string" || value.result.trim().length === 0) {
    throw new UnreachableError("Claude CLI result has no non-empty final response string");
  }
  return { threadId: value.session_id, finalResponse: value.result };
}

function startSessionId(idempotencyKey: string | undefined, fallback: () => string): string {
  if (idempotencyKey !== undefined) {
    if (!UUID_PATTERN.test(idempotencyKey)) {
      throw new DeliveryNotSubmittedError("Claude idempotency key must be a valid UUID");
    }
    return idempotencyKey;
  }
  return validateSessionIdBeforeSubmission(fallback());
}

function validateSessionIdBeforeSubmission(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new DeliveryNotSubmittedError("Claude session id must be a valid UUID");
  }
  return value;
}

function claudeTurnArgs(
  sandboxArgs: readonly string[],
  sessionArgs: readonly string[],
): readonly string[] {
  return ["-p", "--output-format", "json", ...sandboxArgs, ...sessionArgs];
}

function claudeSandboxArgs(sandbox: DeliveryOptions["sandbox"]): readonly string[] {
  switch (sandbox) {
    case "read-only":
    case "workspace-write":
      // The authenticated owner proxy intentionally mirrors the full-capability
      // Desktop boundary. Claude's ambient tools, MCP servers, plugins, skills,
      // hooks, and integrations remain available; the repeated WakeWire safety
      // envelope governs the requested work.
      return ["--permission-mode", "bypassPermissions"];
    default:
      throw new DeliveryNotSubmittedError(`Unsupported Claude sandbox policy: ${String(sandbox)}`);
  }
}

async function existingDirectory(value: string): Promise<string> {
  const resolved = resolveCwdPath(value);
  try {
    const entry = await stat(resolved);
    if (!entry.isDirectory()) {
      throw new DeliveryNotSubmittedError(
        `Claude working directory is not a directory: ${resolved}`,
      );
    }
  } catch (error) {
    if (error instanceof DeliveryNotSubmittedError) throw error;
    throw new DeliveryNotSubmittedError(
      `Claude working directory is not accessible: ${resolved}: ${asError(error).message}`,
    );
  }
  return resolved;
}

function resolveCwdPath(value: string): string {
  try {
    return path.resolve(value);
  } catch (error) {
    throw new DeliveryNotSubmittedError(
      `Claude working directory is invalid: ${asError(error).message}`,
    );
  }
}

function throwIfAbortedBeforeDelivery(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DeliveryNotSubmittedError("Claude delivery was canceled before process spawn");
  }
}

function mapClaudeCliError(error: unknown, threadId: string | null): Error {
  if (error instanceof PermanentError || error instanceof UnreachableError) return error;
  const normalized = asError(error);
  if (/ENOENT|command not found|not installed/i.test(normalized.message)) {
    return new UnreachableError(`Claude CLI is not runnable: ${normalized.message}`);
  }
  if (
    threadId &&
    /(no|unknown|missing).*(session|conversation)|(session|conversation).*(not found|does not exist)/i.test(
      normalized.message,
    )
  ) {
    return new PermanentError(`Claude session ${threadId} was not found`);
  }
  return normalized;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultClaudeSpawn(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
  },
): ClaudeCliChildProcess {
  return spawn(executable, [...args], options);
}
