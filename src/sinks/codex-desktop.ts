import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import type { Logger } from "../logging.js";
import {
  CODEX_DESKTOP_PRIVATE_API_WARNING,
  CodexDesktopIpcClient,
  type CodexDesktopIpcConfig,
  CodexDesktopProtocolError,
  CodexDesktopRemoteError,
  CodexDesktopUnavailableError,
  type DesktopInterruptTurnResult,
  type DesktopStartTurnInput,
  type DesktopStartTurnResult,
} from "./codex-desktop-ipc.js";
import { CodexAppServerThreadMetadata, type CodexThreadMetadata } from "./codex-thread-metadata.js";
import type {
  AgentAdapter,
  DeliveryOptions,
  DeliveryResult,
  PrepareThreadOptions,
} from "./types.js";
import { BusyError, PermanentError, UnreachableError } from "./types.js";

const DEFAULT_HELPER_PATH = path.join(
  os.homedir(),
  ".local",
  "bin",
  "wakewire-codex-desktop-helper",
);
const DEFAULT_OPEN_PATH = "/usr/bin/open";
const CORRELATION_PREFIX = "wakewire:event:v1:";
const MAX_ROLLOUT_PROOF_BYTES = 4 * 1024 * 1024;

export interface CodexDesktopAdapterConfig extends CodexDesktopIpcConfig {
  codexPath?: string | undefined;
  helperPath?: string | undefined;
  stateDatabasePath?: string | undefined;
  openPath?: string | undefined;
  helperTimeoutMs?: number | undefined;
  discoveryTimeoutMs?: number | undefined;
  discoveryPollMs?: number | undefined;
  activationDelayMs?: number | undefined;
  /** Maximum time to wait for Desktop's rollout to prove the realized turn profile. */
  deliveryVerificationTimeoutMs?: number | undefined;
  /** Poll interval while Desktop flushes the marker-bearing turn context. */
  deliveryVerificationPollMs?: number | undefined;
  maxDeepLinkBytes?: number | undefined;
  /** Open an existing task in Desktop and retry once when no renderer owns it. */
  activateUnownedThreads?: boolean | undefined;
}

export interface CodexDesktopIpc {
  inspectEnvironment(): Promise<unknown>;
  probe(): Promise<boolean>;
  startTurn(input: DesktopStartTurnInput): Promise<DesktopStartTurnResult>;
  interruptTurn?(conversationId: string): Promise<DesktopInterruptTurnResult>;
}

export interface DesktopThreadCreateInput {
  prompt: string;
  cwd: string;
  marker: string;
}

export interface DesktopThreadCreateResult {
  threadId: string;
  turnId?: string | undefined;
}

export interface DesktopThreadCreator {
  create(input: DesktopThreadCreateInput): Promise<DesktopThreadCreateResult>;
  probe?(): Promise<boolean>;
}

export interface DesktopThreadActivator {
  activate(threadId: string): Promise<void>;
}

export interface DesktopThreadTitleReader {
  read(threadId: string): Promise<string | null>;
}

export interface DesktopTaskFindInput {
  marker: string;
  cwd: string;
  notBeforeMs?: number | undefined;
}

export interface DesktopTaskFinder {
  find(input: DesktopTaskFindInput): Promise<string | null>;
  probe?(): Promise<boolean>;
}

export interface DesktopResumeDeliveryCheckInput {
  threadId: string;
  marker: string;
  model?: string | undefined;
  reasoningEffort?: DeliveryOptions["reasoningEffort"] | undefined;
  preparedThread?: boolean | undefined;
}

/**
 * Crash-recovery boundary for turns appended to an existing Desktop task.
 * Implementations must fail closed when durable state cannot be inspected.
 */
export interface DesktopResumeDeliveryGuard {
  hasMarker(input: DesktopResumeDeliveryCheckInput): Promise<boolean>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    stdin?: string | undefined,
  ): Promise<CommandResult>;
}

export interface HelperDesktopThreadCreatorConfig {
  helperPath?: string | undefined;
  stateDatabasePath?: string | undefined;
  helperTimeoutMs?: number | undefined;
  discoveryTimeoutMs?: number | undefined;
  discoveryPollMs?: number | undefined;
  maxDeepLinkBytes?: number | undefined;
}

export interface HelperDesktopThreadCreatorDependencies {
  runner?: CommandRunner | undefined;
  finder?: DesktopTaskFinder | undefined;
  access?: ((file: string, mode: number) => Promise<void>) | undefined;
  stat?: ((file: string) => Promise<{ isDirectory(): boolean }>) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface SqliteDesktopTaskFinderConfig {
  stateDatabasePath?: string | undefined;
}

export interface SqliteDesktopTaskFinderDependencies {
  openDatabase?: ((file: string) => Database) | undefined;
  readFile?: ((file: string) => Promise<string>) | undefined;
}

export interface SqliteDesktopThreadTitleReaderConfig {
  stateDatabasePath?: string | undefined;
}

export interface SqliteDesktopThreadTitleReaderDependencies {
  openDatabase?: ((file: string) => Database) | undefined;
}

export interface SqliteDesktopResumeDeliveryGuardConfig {
  stateDatabasePath?: string | undefined;
}

export interface SqliteDesktopResumeDeliveryGuardDependencies {
  openDatabase?: ((file: string) => Database) | undefined;
  readFile?: ((file: string) => Promise<string>) | undefined;
}

export interface CodexDesktopAdapterDependencies {
  ipc?: CodexDesktopIpc | undefined;
  creator?: DesktopThreadCreator | undefined;
  activator?: DesktopThreadActivator | undefined;
  resumeDeliveryGuard?: DesktopResumeDeliveryGuard | undefined;
  threadMetadata?: CodexThreadMetadata | undefined;
  threadTitleReader?: DesktopThreadTitleReader | undefined;
  runner?: CommandRunner | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** The configured cwd is invalid and retrying the same delivery cannot help. */
export class DesktopCreationRequestError extends Error {}

/** Desktop UI/helper accepted a request but no durable task could be correlated. */
export class DesktopTaskDiscoveryError extends Error {}

/** Durable Desktop state could not safely establish whether a turn was sent. */
export class DesktopResumeStateError extends Error {}

/** The marker exists, but Desktop has not yet flushed enough turn state to verify it. */
export class DesktopResumeProfilePendingError extends DesktopResumeStateError {}

/** A host-prepared empty task has not yet been imported by Desktop's renderer. */
export class DesktopPreparedTaskNotMaterializedError extends DesktopResumeStateError {}

/** Desktop started the marked turn with a different model or effort than requested. */
export class DesktopExecutionProfileMismatchError extends Error {}

/** Persisted Desktop metadata could not be read safely. */
export class DesktopThreadTitleReadError extends Error {}

/**
 * AgentAdapter that keeps work inside the installed Codex Desktop process.
 * Existing tasks use private local IPC. New tasks use the Accessibility helper
 * because an empty task created by a separate app-server process is not owned
 * by Desktop's renderer and cannot accept follower IPC. Exact task titles use
 * app-server metadata so naming never changes global UI or the clipboard.
 */
export class CodexDesktopAdapter implements AgentAdapter {
  readonly name = "codex-desktop";
  private readonly ipc: CodexDesktopIpc;
  private readonly creator: DesktopThreadCreator;
  private readonly activator: DesktopThreadActivator;
  private readonly resumeDeliveryGuard: DesktopResumeDeliveryGuard;
  private readonly threadMetadata: CodexThreadMetadata;
  private readonly threadTitleReader: DesktopThreadTitleReader;
  private readonly activateUnownedThreads: boolean;
  private readonly activationDelayMs: number;
  private readonly deliveryVerificationAttempts: number;
  private readonly deliveryVerificationPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly preparedThreadIds = new Set<string>();
  /** Deep-link navigation is global UI state, so all such operations serialize. */
  private desktopUiTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    config: CodexDesktopAdapterConfig = {},
    dependencies: CodexDesktopAdapterDependencies = {},
  ) {
    const runner = dependencies.runner ?? new ExecFileCommandRunner();
    this.ipc = dependencies.ipc ?? new CodexDesktopIpcClient(config);
    this.creator =
      dependencies.creator ??
      new HelperDesktopThreadCreator(config, {
        runner,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      });
    this.activator =
      dependencies.activator ??
      new OpenUrlDesktopThreadActivator(config.openPath ?? DEFAULT_OPEN_PATH, runner);
    this.resumeDeliveryGuard =
      dependencies.resumeDeliveryGuard ??
      new SqliteDesktopResumeDeliveryGuard({ stateDatabasePath: config.stateDatabasePath });
    this.threadMetadata =
      dependencies.threadMetadata ??
      new CodexAppServerThreadMetadata(logger, { codexPath: config.codexPath });
    this.threadTitleReader =
      dependencies.threadTitleReader ??
      new SqliteDesktopThreadTitleReader({ stateDatabasePath: config.stateDatabasePath });
    this.activateUnownedThreads = config.activateUnownedThreads ?? true;
    this.activationDelayMs = config.activationDelayMs ?? 750;
    if (!Number.isSafeInteger(this.activationDelayMs) || this.activationDelayMs <= 0) {
      throw new TypeError("activationDelayMs must be a positive integer");
    }
    const deliveryVerificationTimeoutMs = config.deliveryVerificationTimeoutMs ?? 5_000;
    this.deliveryVerificationPollMs = config.deliveryVerificationPollMs ?? 50;
    if (
      !Number.isSafeInteger(deliveryVerificationTimeoutMs) ||
      deliveryVerificationTimeoutMs <= 0
    ) {
      throw new TypeError("deliveryVerificationTimeoutMs must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.deliveryVerificationPollMs) ||
      this.deliveryVerificationPollMs <= 0
    ) {
      throw new TypeError("deliveryVerificationPollMs must be a positive integer");
    }
    this.deliveryVerificationAttempts = Math.max(
      1,
      Math.ceil(deliveryVerificationTimeoutMs / this.deliveryVerificationPollMs),
    );
    this.sleep = dependencies.sleep ?? delay;
    logger.warn(
      {
        adapter: this.name,
        supportedVersions: config.supportedDesktopVersions,
        unsupportedVersionOverride: config.allowUnsupportedDesktopVersion ?? false,
      },
      CODEX_DESKTOP_PRIVATE_API_WARNING,
    );
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    opts.signal?.throwIfAborted();
    const marker = desktopCorrelationMarker({
      prompt,
      cwd: path.resolve(opts.cwd ?? process.cwd()),
      idempotencyKey: optionalIdempotencyKey(opts),
    });
    const markedPrompt = appendDesktopCorrelationMarker(prompt, marker);
    const deliveryCheck: DesktopResumeDeliveryCheckInput = {
      threadId,
      marker,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.preparedThread === true || this.preparedThreadIds.has(threadId)
        ? { preparedThread: true }
        : {}),
    };
    try {
      if (await this.resumeDeliveryGuard.hasMarker(deliveryCheck)) {
        this.logger.debug(
          { threadId, marker },
          "recovered previously submitted Codex Desktop turn from durable rollout",
        );
        return { threadId, correlationMarker: marker };
      }
      opts.signal?.throwIfAborted();
    } catch (error) {
      if (!(error instanceof DesktopPreparedTaskNotMaterializedError)) {
        throw classifyDesktopError(error, threadId);
      }
      this.logger.debug(
        { threadId },
        "host-prepared task is awaiting Desktop activation before its first turn",
      );
    }

    try {
      const started = await this.ipc.startTurn({
        conversationId: threadId,
        prompt: markedPrompt,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      });
      opts.signal?.throwIfAborted();
      await this.verifyDeliveredTurn(deliveryCheck, opts.signal);
      return resultForExistingThread(threadId, started, marker);
    } catch (error) {
      if (!this.activateUnownedThreads || !isMissingDesktopOwner(error)) {
        throw classifyDesktopError(error, threadId);
      }
      this.logger.debug({ threadId }, "opening unowned task in Codex Desktop before retry");
    }

    try {
      await this.withDesktopUiLock(() => this.activator.activate(threadId));
      opts.signal?.throwIfAborted();
      await this.sleep(this.activationDelayMs);
      const started = await this.ipc.startTurn({
        conversationId: threadId,
        prompt: markedPrompt,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      });
      opts.signal?.throwIfAborted();
      await this.verifyDeliveredTurn(deliveryCheck, opts.signal);
      return resultForExistingThread(threadId, started, marker);
    } catch (error) {
      throw classifyDesktopError(error, threadId);
    }
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    opts.signal?.throwIfAborted();
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const idempotencyKey = optionalIdempotencyKey(opts);
    const marker = desktopCorrelationMarker({ prompt, cwd, idempotencyKey });
    try {
      return await this.withDesktopUiLock(async () => {
        opts.signal?.throwIfAborted();
        const result = await this.creator.create({
          prompt: appendDesktopCorrelationMarker(prompt, marker),
          cwd,
          marker,
        });
        return { ...result, correlationMarker: marker };
      });
    } catch (error) {
      throw classifyDesktopError(error);
    }
  }

  async prepareThread(opts: PrepareThreadOptions): Promise<{ threadId: string }> {
    opts.signal?.throwIfAborted();
    if (!this.threadMetadata.prepareThread) {
      throw new PermanentError("Codex Desktop host task preparation is unavailable");
    }
    try {
      const prepared = await this.threadMetadata.prepareThread(opts);
      // Return the external identity even if cancellation arrived while
      // thread/start was in flight. The coordinator must persist that id so
      // the authenticated stop lane can interrupt it instead of orphaning it.
      this.preparedThreadIds.add(prepared.threadId);
      return prepared;
    } catch (error) {
      throw classifyDesktopError(error);
    }
  }

  async interruptThread(
    threadId: string,
  ): Promise<{ threadId: string; interruptedTurnId?: string | undefined }> {
    if (!this.ipc.interruptTurn) {
      throw new PermanentError("Codex Desktop interrupt is unavailable in this adapter build");
    }
    try {
      const result = await this.ipc.interruptTurn(threadId);
      return {
        threadId,
        ...(result.interruptedTurnId ? { interruptedTurnId: result.interruptedTurnId } : {}),
      };
    } catch (error) {
      // A task without a renderer owner cannot still have an active local turn.
      // Treat repeated/late stop signals as idempotently stopped.
      if (isMissingDesktopOwner(error)) return { threadId };
      throw classifyDesktopError(error, threadId);
    }
  }

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    await this.withDesktopUiLock(() => this.threadMetadata.setThreadTitle(threadId, title));
  }

  async readThreadTitle(threadId: string): Promise<string | null> {
    // Confirmation must be independent from the app-server writer. Its own
    // process can report a transient desired value before Desktop persists it.
    return this.threadTitleReader.read(threadId);
  }

  close(): void {
    this.threadMetadata.close?.();
  }

  async probe(): Promise<boolean> {
    try {
      if (!(await this.ipc.probe())) return false;
      return this.creator.probe ? await this.creator.probe() : true;
    } catch {
      return false;
    }
  }

  private async withDesktopUiLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.desktopUiTail;
    let release: () => void = () => {};
    this.desktopUiTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async verifyDeliveredTurn(
    input: DesktopResumeDeliveryCheckInput,
    signal?: AbortSignal,
  ): Promise<void> {
    let pendingReason = "marker-bearing turn is not yet present in Desktop's rollout";
    for (let attempt = 0; attempt < this.deliveryVerificationAttempts; attempt++) {
      signal?.throwIfAborted();
      try {
        if (await this.resumeDeliveryGuard.hasMarker(input)) return;
      } catch (error) {
        if (
          !(error instanceof DesktopResumeProfilePendingError) &&
          !(error instanceof DesktopPreparedTaskNotMaterializedError)
        ) {
          throw error;
        }
        pendingReason = error.message;
      }
      if (attempt + 1 < this.deliveryVerificationAttempts) {
        await this.sleep(this.deliveryVerificationPollMs);
      }
    }
    throw new DesktopResumeStateError(
      `Codex Desktop did not durably verify the submitted turn: ${pendingReason}`,
    );
  }
}

/**
 * Opens Desktop's new-task route, then asks a separate macOS accessibility
 * helper to verify the exact marker and activate Send. Electron's AXPress can
 * report success without dispatching the DOM click, so both labeled and
 * unlabeled arrows use one physical click whose coordinate is accepted only
 * after strict composer-relative structure and geometry checks. It never
 * simulates Return or clicks an unverified window control. The helper must fail
 * when the composer is obscured, the marker differs, the screen is locked, or
 * a modal is present.
 */
export class HelperDesktopThreadCreator implements DesktopThreadCreator {
  private readonly helperPath: string;
  private readonly stateDatabasePath: string;
  private readonly helperTimeoutMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly discoveryPollMs: number;
  private readonly maxDeepLinkBytes: number;
  private readonly runner: CommandRunner;
  private readonly finder: DesktopTaskFinder;
  private readonly access: (file: string, mode: number) => Promise<void>;
  private readonly stat: (file: string) => Promise<{ isDirectory(): boolean }>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: HelperDesktopThreadCreatorConfig = {},
    dependencies: HelperDesktopThreadCreatorDependencies = {},
  ) {
    this.helperPath = config.helperPath ?? DEFAULT_HELPER_PATH;
    this.stateDatabasePath = config.stateDatabasePath ?? defaultStateDatabasePath();
    this.helperTimeoutMs = config.helperTimeoutMs ?? 15_000;
    // Desktop creates the task immediately, but may leave
    // threads.first_user_message empty for roughly 30 seconds while the turn
    // initializes. Wait for the exact marker instead of reopening the deep
    // link and risking a duplicate task.
    this.discoveryTimeoutMs = config.discoveryTimeoutMs ?? 60_000;
    this.discoveryPollMs = config.discoveryPollMs ?? 100;
    this.maxDeepLinkBytes = config.maxDeepLinkBytes ?? 128 * 1024;
    for (const [name, value] of [
      ["helperTimeoutMs", this.helperTimeoutMs],
      ["discoveryTimeoutMs", this.discoveryTimeoutMs],
      ["discoveryPollMs", this.discoveryPollMs],
      ["maxDeepLinkBytes", this.maxDeepLinkBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError(`${name} must be positive`);
    }
    this.runner = dependencies.runner ?? new ExecFileCommandRunner();
    this.finder =
      dependencies.finder ??
      new SqliteDesktopTaskFinder({ stateDatabasePath: config.stateDatabasePath });
    this.access = dependencies.access ?? ((file, mode) => fs.access(file, mode));
    this.stat = dependencies.stat ?? ((file) => fs.stat(file));
    this.now = dependencies.now ?? (() => Date.now());
    this.sleep = dependencies.sleep ?? delay;
  }

  async probe(): Promise<boolean> {
    try {
      await this.access(this.helperPath, fsConstants.X_OK);
      if (this.finder.probe && !(await this.finder.probe())) return false;
      await this.runner.run(this.helperPath, ["probe"], 3_000);
      return true;
    } catch {
      return false;
    }
  }

  async create(input: DesktopThreadCreateInput): Promise<DesktopThreadCreateResult> {
    validateMarker(input.marker);
    if (!input.prompt.includes(input.marker)) {
      throw new DesktopCreationRequestError("Desktop task prompt does not contain its marker");
    }

    // Crash recovery: a prior attempt may have submitted successfully before
    // WakeWire persisted the returned task id.
    const recovered = await this.finder.find({ marker: input.marker, cwd: input.cwd });
    if (recovered) return { threadId: recovered };

    // Validate every prerequisite before opening a deep link and changing UI.
    await this.assertHelperExecutable();
    await this.assertCwd(input.cwd);

    const startedAtMs = this.now();
    const deepLink = buildNewDesktopTaskUrl(input.cwd, input.prompt);
    if (Buffer.byteLength(deepLink, "utf8") > this.maxDeepLinkBytes) {
      throw new DesktopCreationRequestError(
        `Codex Desktop deep link exceeds ${this.maxDeepLinkBytes} bytes`,
      );
    }

    let helperResult: CommandResult;
    try {
      helperResult = await this.runner.run(
        this.helperPath,
        ["open-and-submit", "--request-json-stdin"],
        this.helperTimeoutMs + this.discoveryTimeoutMs + 2_000,
        JSON.stringify({
          url: deepLink,
          marker: input.marker,
          cwd: input.cwd,
          stateDatabasePath: this.stateDatabasePath,
          notBeforeMilliseconds: startedAtMs,
          uiTimeoutMilliseconds: this.helperTimeoutMs,
          discoveryTimeoutMilliseconds: this.discoveryTimeoutMs,
        }),
      );
    } catch (error) {
      throw new CodexDesktopUnavailableError(
        `Codex Desktop helper refused to submit the prefilled task: ${errorMessage(error)}`,
      );
    }

    const helperThreadId = parseDesktopHelperResult(helperResult.stdout, input.marker, input.cwd);
    if (helperThreadId) return { threadId: helperThreadId };

    const deadline = this.now() + this.discoveryTimeoutMs;
    while (true) {
      const found = await this.finder.find({
        marker: input.marker,
        cwd: input.cwd,
        notBeforeMs: startedAtMs,
      });
      if (found) return { threadId: found };
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.discoveryPollMs, remaining));
    }
    throw new DesktopTaskDiscoveryError(
      `Codex Desktop did not persist a task containing ${input.marker} in ${input.cwd}`,
    );
  }

  private async assertHelperExecutable(): Promise<void> {
    try {
      await this.access(this.helperPath, fsConstants.X_OK);
    } catch (error) {
      throw new CodexDesktopUnavailableError(
        `required Codex Desktop helper is missing or not executable at ${this.helperPath}: ${errorMessage(error)}`,
      );
    }
  }

  private async assertCwd(cwd: string): Promise<void> {
    try {
      const stat = await this.stat(cwd);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new DesktopCreationRequestError(
        `invalid Codex Desktop cwd ${cwd}: ${errorMessage(error)}`,
      );
    }
  }
}

/** Read-only task-id correlation against Desktop's durable local state. */
export class SqliteDesktopTaskFinder implements DesktopTaskFinder {
  private readonly databasePath: string;
  private readonly openDatabase: (file: string) => Database;
  private readonly readFile: (file: string) => Promise<string>;

  constructor(
    config: SqliteDesktopTaskFinderConfig = {},
    dependencies: SqliteDesktopTaskFinderDependencies = {},
  ) {
    this.databasePath = config.stateDatabasePath ?? defaultStateDatabasePath();
    this.openDatabase =
      dependencies.openDatabase ??
      ((file) => new DatabaseConstructor(file, { readonly: true, fileMustExist: true }));
    this.readFile = dependencies.readFile ?? readBoundedRolloutProof;
  }

  async probe(): Promise<boolean> {
    try {
      const db = this.openDatabase(this.databasePath);
      try {
        db.prepare("SELECT id FROM threads LIMIT 1").get();
      } finally {
        db.close();
      }
      return true;
    } catch {
      return false;
    }
  }

  async find(input: DesktopTaskFindInput): Promise<string | null> {
    validateMarker(input.marker);
    const notBeforeMs = input.notBeforeMs ?? 0;
    let db: Database;
    try {
      db = this.openDatabase(this.databasePath);
    } catch (error) {
      throw new DesktopTaskDiscoveryError(
        `cannot open Codex Desktop state database ${this.databasePath} read-only: ${errorMessage(error)}`,
      );
    }
    try {
      const rows = db
        .prepare(
          `SELECT id, rollout_path
             FROM threads
            WHERE archived = 0
              AND cwd = ?
              AND COALESCE(created_at_ms, created_at * 1000) >= ?
              AND (instr(first_user_message, ?) > 0 OR instr(preview, ?) > 0)
            ORDER BY COALESCE(created_at_ms, created_at * 1000) ASC, id ASC
            LIMIT 129`,
        )
        .all(input.cwd, notBeforeMs, input.marker, input.marker) as Array<{
        id: unknown;
        rollout_path: unknown;
      }>;
      if (rows.length > 128) {
        throw new DesktopTaskDiscoveryError(
          `too many Codex Desktop drafts matched unique marker ${input.marker}`,
        );
      }

      const submitted: string[] = [];
      for (const row of rows) {
        if (typeof row.id !== "string" || row.id.length === 0) {
          throw new DesktopTaskDiscoveryError("Codex Desktop state returned an invalid task id");
        }
        // Desktop persists a marker-bearing thread row while the New chat
        // composer is still only a draft. A rollout with a real started turn
        // is the durable boundary proving that Send actually happened.
        if (row.rollout_path === null || row.rollout_path === "") continue;
        if (typeof row.rollout_path !== "string" || !path.isAbsolute(row.rollout_path)) {
          throw new DesktopTaskDiscoveryError(
            `Codex Desktop state returned an invalid rollout path for task ${row.id}`,
          );
        }

        let rollout: string;
        try {
          rollout = await this.readFile(row.rollout_path);
        } catch (error) {
          if (isMissingFileError(error)) continue;
          throw new DesktopTaskDiscoveryError(
            `cannot inspect Codex Desktop rollout for task ${row.id}: ${errorMessage(error)}`,
          );
        }
        if (Buffer.byteLength(rollout, "utf8") > MAX_ROLLOUT_PROOF_BYTES) {
          throw new DesktopTaskDiscoveryError(
            `Codex Desktop rollout proof for task ${row.id} exceeds ${MAX_ROLLOUT_PROOF_BYTES} bytes`,
          );
        }
        if (rolloutProvesStartedTurn(rollout, input.marker)) submitted.push(row.id);
      }
      if (submitted.length > 1) {
        throw new DesktopTaskDiscoveryError(
          `multiple submitted Codex Desktop tasks matched unique marker ${input.marker}`,
        );
      }
      return submitted[0] ?? null;
    } catch (error) {
      if (error instanceof DesktopTaskDiscoveryError) throw error;
      throw new DesktopTaskDiscoveryError(
        `cannot query Codex Desktop state database: ${errorMessage(error)}`,
      );
    } finally {
      db.close();
    }
  }
}

/** Read-only confirmation for title reconciliation against Desktop-owned state. */
export class SqliteDesktopThreadTitleReader implements DesktopThreadTitleReader {
  private readonly databasePath: string;
  private readonly openDatabase: (file: string) => Database;

  constructor(
    config: SqliteDesktopThreadTitleReaderConfig = {},
    dependencies: SqliteDesktopThreadTitleReaderDependencies = {},
  ) {
    this.databasePath = config.stateDatabasePath ?? defaultStateDatabasePath();
    this.openDatabase =
      dependencies.openDatabase ??
      ((file) => new DatabaseConstructor(file, { readonly: true, fileMustExist: true }));
  }

  async read(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new TypeError("threadId must not be empty");
    let database: Database;
    try {
      database = this.openDatabase(this.databasePath);
    } catch (error) {
      throw new DesktopThreadTitleReadError(
        `cannot open Codex Desktop state database ${this.databasePath} read-only: ${errorMessage(error)}`,
      );
    }
    try {
      const row = database
        .prepare("SELECT title FROM threads WHERE id = ? LIMIT 1")
        .get(normalizedThreadId) as { title: unknown } | undefined;
      if (!row) return null;
      if (typeof row.title !== "string" || !row.title.trim()) {
        throw new DesktopThreadTitleReadError(
          `Codex Desktop task ${normalizedThreadId} has an invalid persisted title`,
        );
      }
      return row.title;
    } catch (error) {
      if (error instanceof DesktopThreadTitleReadError) throw error;
      throw new DesktopThreadTitleReadError(
        `cannot read Codex Desktop task title: ${errorMessage(error)}`,
      );
    } finally {
      database.close();
    }
  }
}

/**
 * Resolves a task's durable rollout from Desktop's read-only state database and
 * searches it for the delivery-stable marker before an existing-task IPC send.
 */
export class SqliteDesktopResumeDeliveryGuard implements DesktopResumeDeliveryGuard {
  private readonly databasePath: string;
  private readonly openDatabase: (file: string) => Database;
  private readonly readFile: (file: string) => Promise<string>;

  constructor(
    config: SqliteDesktopResumeDeliveryGuardConfig = {},
    dependencies: SqliteDesktopResumeDeliveryGuardDependencies = {},
  ) {
    this.databasePath = config.stateDatabasePath ?? defaultStateDatabasePath();
    this.openDatabase =
      dependencies.openDatabase ??
      ((file) => new DatabaseConstructor(file, { readonly: true, fileMustExist: true }));
    this.readFile = dependencies.readFile ?? readBoundedRolloutProof;
  }

  async hasMarker(input: DesktopResumeDeliveryCheckInput): Promise<boolean> {
    validateMarker(input.marker);
    if (!input.threadId.trim()) {
      throw new DesktopResumeStateError("Codex Desktop task id must not be empty");
    }

    let database: Database;
    try {
      database = this.openDatabase(this.databasePath);
    } catch (error) {
      throw new DesktopResumeStateError(
        `cannot open Codex Desktop state database ${this.databasePath} read-only: ${errorMessage(error)}`,
      );
    }

    let row: { rollout_path?: unknown } | undefined;
    try {
      row = database
        .prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1")
        .get(input.threadId) as { rollout_path?: unknown } | undefined;
    } catch (error) {
      throw new DesktopResumeStateError(
        `cannot query Codex Desktop state for task ${input.threadId}: ${errorMessage(error)}`,
      );
    } finally {
      database.close();
    }

    if (!row && input.preparedThread) {
      throw new DesktopPreparedTaskNotMaterializedError(
        `host-prepared Codex Desktop task ${input.threadId} is not materialized yet`,
      );
    }
    if (!row) {
      throw new DesktopResumeStateError(`Codex Desktop state has no task ${input.threadId}`);
    }
    const rolloutPath = row.rollout_path;
    // App-server preparation persists an empty task before its first rollout
    // exists. That is positive proof that this known task has no sent turn yet.
    if (rolloutPath === null || rolloutPath === "") return false;
    if (typeof rolloutPath !== "string" || !path.isAbsolute(rolloutPath)) {
      throw new DesktopResumeStateError(
        `Codex Desktop state has no valid rollout path for task ${input.threadId}`,
      );
    }

    try {
      const rollout = await this.readFile(rolloutPath);
      if (Buffer.byteLength(rollout, "utf8") > MAX_ROLLOUT_PROOF_BYTES) {
        throw new DesktopResumeStateError(
          `Codex Desktop rollout proof for task ${input.threadId} exceeds ${MAX_ROLLOUT_PROOF_BYTES} bytes`,
        );
      }
      const proof = inspectMarkerTurn(rollout, input.marker);
      if (proof.status === "absent") return false;
      if (proof.status === "pending") {
        throw new DesktopResumeProfilePendingError(
          `marker-bearing turn for task ${input.threadId} is not fully persisted yet`,
        );
      }
      if (input.model && proof.model !== input.model) {
        throw new DesktopExecutionProfileMismatchError(
          `Codex Desktop task ${input.threadId} started ${proof.turnId} with model ${JSON.stringify(proof.model ?? null)}; expected ${JSON.stringify(input.model)}`,
        );
      }
      if (input.reasoningEffort && proof.reasoningEffort !== input.reasoningEffort) {
        throw new DesktopExecutionProfileMismatchError(
          `Codex Desktop task ${input.threadId} started ${proof.turnId} with reasoning effort ${JSON.stringify(proof.reasoningEffort ?? null)}; expected ${JSON.stringify(input.reasoningEffort)}`,
        );
      }
      return true;
    } catch (error) {
      if (
        error instanceof DesktopResumeProfilePendingError ||
        error instanceof DesktopExecutionProfileMismatchError
      ) {
        throw error;
      }
      throw new DesktopResumeStateError(
        `cannot inspect Codex Desktop rollout for task ${input.threadId}: ${errorMessage(error)}`,
      );
    }
  }
}

export class OpenUrlDesktopThreadActivator implements DesktopThreadActivator {
  constructor(
    private readonly openPath: string = DEFAULT_OPEN_PATH,
    private readonly runner: CommandRunner = new ExecFileCommandRunner(),
  ) {}

  async activate(threadId: string): Promise<void> {
    if (!threadId.trim()) throw new DesktopCreationRequestError("thread id must not be empty");
    const url = `codex://threads/${encodeURIComponent(threadId)}`;
    try {
      await this.runner.run(this.openPath, ["-g", url], 5_000);
    } catch (error) {
      throw new CodexDesktopUnavailableError(
        `cannot open Codex Desktop task ${threadId}: ${errorMessage(error)}`,
      );
    }
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    stdin?: string,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        [...args],
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `${executable} failed: ${error.message}${stderr.trim() ? `: ${stderr.trim().slice(-1_000)}` : ""}`,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      child.stdin?.end(stdin ?? "");
    });
  }
}

export function buildNewDesktopTaskUrl(cwd: string, prompt: string): string {
  const query = new URLSearchParams({ path: cwd, prompt });
  return `codex://threads/new?${query.toString()}`;
}

export function desktopCorrelationMarker(input: {
  prompt: string;
  cwd: string;
  idempotencyKey?: string | undefined;
}): string {
  const material = input.idempotencyKey
    ? `idempotency\0${input.idempotencyKey}`
    : `legacy\0${input.cwd}\0${input.prompt}`;
  return `${CORRELATION_PREFIX}${crypto.createHash("sha256").update(material).digest("hex")}`;
}

export function appendDesktopCorrelationMarker(prompt: string, marker: string): string {
  validateMarker(marker);
  if (prompt.includes(marker)) return prompt;
  return `${prompt}\n\n[WakeWire correlation: ${marker}]`;
}

/**
 * Optional helper fast-path. A helper may print other diagnostics, but a task
 * id is trusted only from a JSON line binding it to the exact marker and cwd.
 */
export function parseDesktopHelperResult(
  stdout: string,
  expectedMarker: string,
  expectedCwd: string,
): string | null {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        value.marker === expectedMarker &&
        value.cwd === expectedCwd &&
        typeof value.threadId === "string" &&
        value.threadId.length > 0
      ) {
        return value.threadId;
      }
    } catch {
      // Helper diagnostics are allowed; only a matching JSON line is trusted.
    }
  }
  return null;
}

function resultForExistingThread(
  threadId: string,
  started: DesktopStartTurnResult,
  correlationMarker: string,
): DeliveryResult {
  return {
    threadId,
    ...(started.turnId ? { turnId: started.turnId } : {}),
    correlationMarker,
  };
}

function optionalIdempotencyKey(opts: DeliveryOptions): string | undefined {
  const value = (opts as DeliveryOptions & { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMissingDesktopOwner(error: unknown): boolean {
  if (isOwnershipSettlingResponse(error)) return true;
  return (
    error instanceof CodexDesktopRemoteError &&
    error.message.trim().toLowerCase() === "no request handler owns conversation"
  );
}

function isOwnershipSettlingResponse(error: unknown): boolean {
  if (!(error instanceof CodexDesktopRemoteError)) return false;
  // Supported Desktop's follower route emits this exact response when no
  // renderer owns the task. Broader owner errors are not treated as equivalent.
  const exactValues = new Set(["no-client-found"]);
  if (exactValues.has(error.message.trim().toLowerCase())) return true;
  if (!isRecord(error.remoteError)) return false;
  for (const key of ["code", "type", "error"] as const) {
    const value = error.remoteError[key];
    if (typeof value === "string" && exactValues.has(value.trim().toLowerCase())) return true;
  }
  return false;
}

function classifyDesktopError(error: unknown, threadId?: string): Error {
  if (
    error instanceof BusyError ||
    error instanceof PermanentError ||
    error instanceof UnreachableError
  ) {
    return error;
  }
  const message = errorMessage(error);
  if (/(busy|turn in flight|already active|inprogress|in progress)/i.test(message)) {
    return new BusyError(message);
  }
  if (
    threadId &&
    (/((unknown|missing|no such|not found).*(thread|task|conversation))/i.test(message) ||
      /((thread|task|conversation).*(unknown|missing|no such|not found))/i.test(message))
  ) {
    return new PermanentError(`task ${threadId} not found: ${message}`);
  }
  if (error instanceof DesktopCreationRequestError) return new PermanentError(message);
  if (error instanceof DesktopExecutionProfileMismatchError) return new PermanentError(message);
  if (
    error instanceof CodexDesktopUnavailableError ||
    error instanceof CodexDesktopProtocolError ||
    error instanceof CodexDesktopRemoteError ||
    error instanceof DesktopTaskDiscoveryError ||
    error instanceof DesktopResumeStateError
  ) {
    return new UnreachableError(message);
  }
  return error instanceof Error ? error : new Error(message);
}

function validateMarker(marker: string): void {
  if (!new RegExp(`^${CORRELATION_PREFIX.replaceAll(":", "\\:")}[a-f0-9]{64}$`).test(marker)) {
    throw new DesktopCreationRequestError("invalid WakeWire Desktop correlation marker");
  }
}

function rolloutProvesStartedTurn(rollout: string, marker: string): boolean {
  return inspectMarkerTurn(rollout, marker).status === "verified";
}

type MarkerTurnProof =
  | { status: "absent" }
  | { status: "pending" }
  | {
      status: "verified";
      turnId: string;
      model: string | null;
      reasoningEffort: string | null;
    };

function inspectMarkerTurn(rollout: string, marker: string): MarkerTurnProof {
  const startedTurnIds = new Set<string>();
  const contexts = new Map<string, { model: string | null; reasoningEffort: string | null }>();
  const markerTurnIds = new Set<string>();
  let markerInUserMessage = false;
  const lines = rollout.split("\n");
  const finalLineMayBePartial = !rollout.endsWith("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      // Desktop appends JSONL concurrently. Ignore only an incomplete final
      // record; malformed durable records fail closed.
      if (finalLineMayBePartial && index === lines.length - 1) continue;
      throw new DesktopTaskDiscoveryError(
        `Codex Desktop rollout contains invalid JSON: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(record)) continue;
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) continue;

    if (record.type === "event_msg" && payload.type === "task_started") {
      if (typeof payload.turn_id === "string" && payload.turn_id) {
        startedTurnIds.add(payload.turn_id);
      }
      continue;
    }
    if (record.type === "turn_context") {
      if (typeof payload.turn_id === "string" && payload.turn_id) {
        const collaborationMode = isRecord(payload.collaboration_mode)
          ? payload.collaboration_mode
          : null;
        const settings =
          collaborationMode && isRecord(collaborationMode.settings)
            ? collaborationMode.settings
            : null;
        const effort = settings?.reasoning_effort ?? payload.reasoning_effort ?? payload.effort;
        contexts.set(payload.turn_id, {
          model: typeof payload.model === "string" ? payload.model : null,
          reasoningEffort: typeof effort === "string" ? effort : null,
        });
      }
      continue;
    }
    if (record.type !== "response_item" || payload.type !== "message" || payload.role !== "user") {
      continue;
    }
    if (!Array.isArray(payload.content)) continue;
    const containsMarker = payload.content.some(
      (item) =>
        isRecord(item) &&
        item.type === "input_text" &&
        typeof item.text === "string" &&
        item.text.includes(marker),
    );
    if (!containsMarker) continue;
    markerInUserMessage = true;
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : null;
    const turnId = metadata?.turn_id ?? metadata?.turnId ?? payload.turn_id;
    if (typeof turnId === "string" && turnId) markerTurnIds.add(turnId);
  }

  if (!markerInUserMessage)
    return rollout.includes(marker) ? { status: "pending" } : { status: "absent" };
  if (markerTurnIds.size !== 1) return { status: "pending" };
  const [turnId] = markerTurnIds;
  if (!turnId || !startedTurnIds.has(turnId)) return { status: "pending" };
  const context = contexts.get(turnId);
  if (!context) return { status: "pending" };
  return { status: "verified", turnId, ...context };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function readBoundedRolloutProof(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_ROLLOUT_PROOF_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ROLLOUT_PROOF_BYTES) {
      throw new DesktopTaskDiscoveryError(
        `Codex Desktop rollout proof exceeds ${MAX_ROLLOUT_PROOF_BYTES} bytes`,
      );
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultStateDatabasePath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "state_5.sqlite");
}
