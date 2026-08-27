import { constants as fsConstants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import DatabaseConstructor, { type Database } from "better-sqlite3";

const CORRELATION_MARKER = /^wakewire:event:v1:[a-f0-9]{64}$/;
const DEFAULT_SCAN_CHUNK_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CACHED_SCANS = 32;

export interface CodexCompletionReadInput {
  /** Exact task id persisted when WakeWire submitted the request. */
  threadId: string;
  /** Delivery-stable marker appended to that request's user message. */
  marker: string;
  /** Exact turn id returned by Desktop IPC, when available. */
  turnId?: string | undefined;
}

interface CompletionResultBase {
  threadId: string;
  rolloutPath: string | null;
  turnId: string | null;
  /** Bytes through the last complete JSONL line. A partial tail is excluded. */
  committedBytes: number;
}

export interface CodexCompletionPending extends CompletionResultBase {
  status: "pending";
  reason: string;
}

export interface CodexCompletionCompleted extends CompletionResultBase {
  status: "completed";
  turnId: string;
  finalMessage: string;
}

export interface CodexCompletionAborted extends CompletionResultBase {
  status: "aborted";
  turnId: string;
  abortReason: string;
}

export interface CodexCompletionMalformed extends CompletionResultBase {
  status: "malformed";
  reason: string;
}

export interface CodexCompletionAmbiguous extends CompletionResultBase {
  status: "ambiguous";
  reason: string;
}

export type CodexCompletionReadResult =
  | CodexCompletionPending
  | CodexCompletionCompleted
  | CodexCompletionAborted
  | CodexCompletionMalformed
  | CodexCompletionAmbiguous;

export interface CodexRolloutCompletionReaderConfig {
  stateDatabasePath?: string | undefined;
  sessionsRoot?: string | undefined;
  /** Maximum bytes read from one rollout during one poll. */
  scanChunkBytes?: number | undefined;
  /** Maximum bytes retained for one not-yet-terminated JSONL record. */
  maxRecordBytes?: number | undefined;
  /** Maximum exact request scanners retained between polls. */
  maxCachedScans?: number | undefined;
  /** @deprecated Use maxRecordBytes. This never limits total rollout lifetime size. */
  maxRolloutBytes?: number | undefined;
}

export interface CodexRolloutCompletionReaderDependencies {
  openDatabase?: ((file: string) => Database) | undefined;
  openFile?: ((file: string, flags: number) => Promise<FileHandle>) | undefined;
  lstat?: ((file: string) => Promise<Stats>) | undefined;
  realpath?: ((file: string) => Promise<string>) | undefined;
  readChunk?:
    | ((handle: FileHandle, buffer: Buffer, position: number) => Promise<number>)
    | undefined;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface OpenRollout {
  canonicalPath: string;
  handle: FileHandle;
  identity: FileIdentity;
  size: number;
}

interface TerminalComplete {
  kind: "task_complete";
  finalMessage: string;
}

interface TerminalAborted {
  kind: "turn_aborted";
  abortReason: string;
}

type Terminal = TerminalComplete | TerminalAborted;

interface ScannerFailure {
  kind: "malformed" | "ambiguous";
  reason: string;
  turnId: string | null;
}

interface ScannerState {
  threadId: string;
  marker: string;
  requestedTurnId: string | null;
  rolloutPath: string;
  identity: FileIdentity;
  readOffset: number;
  committedBytes: number;
  lineNumber: number;
  pendingRecord: Buffer;
  sawRecord: boolean;
  metadataCount: number;
  activeTurnId: string | null;
  activeTurnMalformed: boolean;
  activeContextTurnId: string | null;
  activeContextAmbiguous: boolean;
  activeContextMalformed: boolean;
  markerOccurrences: number;
  markerTurnId: string | null;
  terminal: Terminal | null;
  failure: ScannerFailure | null;
}

type SafeOpenResult =
  | { status: "opened"; value: OpenRollout }
  | { status: "pending"; reason: string; rolloutPath: string }
  | { status: "malformed"; reason: string; rolloutPath: string };

/**
 * Read-only, bounded completion detector for turns run by Codex Desktop.
 *
 * Each exact task/marker/turn tuple has an incremental JSONL scanner. An
 * initial backfill advances in bounded chunks; later polls read only appended
 * bytes. The detector binds one exact user marker to one turn and trusts only
 * that turn's durable task_complete record.
 */
export class CodexRolloutCompletionReader {
  private readonly stateDatabasePath: string;
  private readonly sessionsRoot: string;
  private readonly scanChunkBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxCachedScans: number;
  private readonly openDatabase: (file: string) => Database;
  private readonly openFile: (file: string, flags: number) => Promise<FileHandle>;
  private readonly lstat: (file: string) => Promise<Stats>;
  private readonly realpath: (file: string) => Promise<string>;
  private readonly readChunk: (
    handle: FileHandle,
    buffer: Buffer,
    position: number,
  ) => Promise<number>;
  private readonly scanners = new Map<string, ScannerState>();
  private sessionsRootRealPath: string | null = null;

  constructor(
    config: CodexRolloutCompletionReaderConfig = {},
    dependencies: CodexRolloutCompletionReaderDependencies = {},
  ) {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    this.stateDatabasePath = config.stateDatabasePath ?? path.join(codexHome, "state_5.sqlite");
    this.sessionsRoot = path.resolve(config.sessionsRoot ?? path.join(codexHome, "sessions"));
    this.scanChunkBytes = positiveInteger(
      config.scanChunkBytes ?? DEFAULT_SCAN_CHUNK_BYTES,
      "scanChunkBytes",
    );
    this.maxRecordBytes = positiveInteger(
      config.maxRecordBytes ?? config.maxRolloutBytes ?? DEFAULT_MAX_RECORD_BYTES,
      "maxRecordBytes",
    );
    this.maxCachedScans = positiveInteger(
      config.maxCachedScans ?? DEFAULT_MAX_CACHED_SCANS,
      "maxCachedScans",
    );
    this.openDatabase =
      dependencies.openDatabase ??
      ((file) => new DatabaseConstructor(file, { readonly: true, fileMustExist: true }));
    this.openFile = dependencies.openFile ?? ((file, flags) => fs.open(file, flags));
    this.lstat = dependencies.lstat ?? ((file) => fs.lstat(file));
    this.realpath = dependencies.realpath ?? ((file) => fs.realpath(file));
    this.readChunk =
      dependencies.readChunk ??
      (async (handle, buffer, position) => {
        const result = await handle.read(buffer, 0, buffer.length, position);
        return result.bytesRead;
      });
  }

  async read(input: CodexCompletionReadInput): Promise<CodexCompletionReadResult> {
    const threadId = input.threadId.trim();
    const requestedTurnId = input.turnId?.trim() ?? null;
    if (!threadId) return malformed(input.threadId, null, requestedTurnId, 0, "thread id is empty");
    if (!CORRELATION_MARKER.test(input.marker)) {
      return malformed(threadId, null, requestedTurnId, 0, "correlation marker is invalid");
    }
    if (input.turnId !== undefined && !requestedTurnId) {
      return malformed(threadId, null, null, 0, "turn id is empty");
    }

    const resolved = this.resolveRolloutPath(threadId, requestedTurnId);
    if (resolved.status !== "resolved") return resolved.result;
    const opened = await this.openSafeRollout(resolved.rolloutPath);
    if (opened.status === "pending") {
      return pending(threadId, opened.rolloutPath, requestedTurnId, 0, opened.reason);
    }
    if (opened.status === "malformed") {
      return malformed(threadId, opened.rolloutPath, requestedTurnId, 0, opened.reason);
    }

    try {
      return await this.scanOpenRollout({
        threadId,
        marker: input.marker,
        requestedTurnId,
        opened: opened.value,
      });
    } finally {
      await opened.value.handle.close().catch(() => undefined);
    }
  }

  private async scanOpenRollout(input: {
    threadId: string;
    marker: string;
    requestedTurnId: string | null;
    opened: OpenRollout;
  }): Promise<CodexCompletionReadResult> {
    const { threadId, marker, requestedTurnId, opened } = input;
    const key = JSON.stringify([threadId, marker, requestedTurnId]);
    let scanner = this.scanners.get(key);
    if (scanner) {
      this.touchScanner(key, scanner);
      if (scanner.rolloutPath !== opened.canonicalPath) {
        return malformed(
          threadId,
          opened.canonicalPath,
          scanner.markerTurnId ?? requestedTurnId,
          scanner.committedBytes,
          "Codex changed the rollout path while completion was being scanned",
        );
      }
      if (!sameIdentity(scanner.identity, opened.identity)) {
        return malformed(
          threadId,
          opened.canonicalPath,
          scanner.markerTurnId ?? requestedTurnId,
          scanner.committedBytes,
          "Codex replaced the rollout file while completion was being scanned",
        );
      }
      if (opened.size < scanner.readOffset) {
        return malformed(
          threadId,
          opened.canonicalPath,
          scanner.markerTurnId ?? requestedTurnId,
          scanner.committedBytes,
          "Codex truncated the rollout file while completion was being scanned",
        );
      }
    } else {
      scanner = newScanner({
        threadId,
        marker,
        requestedTurnId,
        rolloutPath: opened.canonicalPath,
        identity: opened.identity,
      });
      this.cacheScanner(key, scanner);
    }

    if (scanner.failure) return failureResult(scanner);

    const available = opened.size - scanner.readOffset;
    if (available > 0) {
      const requestedBytes = Math.min(available, this.scanChunkBytes);
      const chunk = Buffer.allocUnsafe(requestedBytes);
      let bytesRead: number;
      try {
        bytesRead = await this.readChunk(opened.handle, chunk, scanner.readOffset);
      } catch (error) {
        return malformed(
          threadId,
          opened.canonicalPath,
          scanner.markerTurnId ?? requestedTurnId,
          scanner.committedBytes,
          `cannot read rollout: ${errorMessage(error)}`,
        );
      }
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requestedBytes) {
        return malformed(
          threadId,
          opened.canonicalPath,
          scanner.markerTurnId ?? requestedTurnId,
          scanner.committedBytes,
          "Codex returned an invalid rollout read length",
        );
      }
      if (bytesRead > 0) {
        scanner.readOffset += bytesRead;
        consumeBytes(scanner, chunk.subarray(0, bytesRead), this.maxRecordBytes);
      }
    }

    const after = await statOpenFile(opened.handle);
    if (after.status === "malformed") {
      return malformed(
        threadId,
        opened.canonicalPath,
        scanner.markerTurnId ?? requestedTurnId,
        scanner.committedBytes,
        after.reason,
      );
    }
    if (!sameIdentity(scanner.identity, after.identity)) {
      return malformed(
        threadId,
        opened.canonicalPath,
        scanner.markerTurnId ?? requestedTurnId,
        scanner.committedBytes,
        "Codex replaced the rollout file while completion was being scanned",
      );
    }
    if (after.size < scanner.readOffset) {
      return malformed(
        threadId,
        opened.canonicalPath,
        scanner.markerTurnId ?? requestedTurnId,
        scanner.committedBytes,
        "Codex truncated the rollout file while completion was being scanned",
      );
    }
    let currentPathStats: Stats;
    try {
      currentPathStats = await this.lstat(opened.canonicalPath);
    } catch (error) {
      return malformed(
        threadId,
        opened.canonicalPath,
        scanner.markerTurnId ?? requestedTurnId,
        scanner.committedBytes,
        `cannot re-inspect rollout path: ${errorMessage(error)}`,
      );
    }
    const currentPathIdentity = identityFromStats(currentPathStats);
    if (
      !currentPathStats.isFile() ||
      !currentPathIdentity ||
      !sameIdentity(scanner.identity, currentPathIdentity)
    ) {
      return malformed(
        threadId,
        opened.canonicalPath,
        scanner.markerTurnId ?? requestedTurnId,
        scanner.committedBytes,
        "Codex replaced the rollout file while completion was being scanned",
      );
    }

    return evaluateScanner(scanner, scanner.readOffset >= after.size);
  }

  private cacheScanner(key: string, scanner: ScannerState): void {
    while (this.scanners.size >= this.maxCachedScans) {
      const oldest = this.scanners.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.scanners.delete(oldest);
    }
    this.scanners.set(key, scanner);
  }

  private touchScanner(key: string, scanner: ScannerState): void {
    this.scanners.delete(key);
    this.scanners.set(key, scanner);
  }

  private async openSafeRollout(rolloutPath: string): Promise<SafeOpenResult> {
    let sessionsRoot: string;
    try {
      sessionsRoot = this.sessionsRootRealPath ?? (await this.realpath(this.sessionsRoot));
      this.sessionsRootRealPath = sessionsRoot;
    } catch (error) {
      return {
        status: "malformed",
        rolloutPath,
        reason: `cannot resolve Codex sessions root: ${errorMessage(error)}`,
      };
    }

    let linkStats: Stats;
    try {
      linkStats = await this.lstat(rolloutPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { status: "pending", rolloutPath, reason: "rollout file is not available yet" };
      }
      return {
        status: "malformed",
        rolloutPath,
        reason: `cannot inspect rollout path: ${errorMessage(error)}`,
      };
    }
    if (linkStats.isSymbolicLink()) {
      return {
        status: "malformed",
        rolloutPath,
        reason: "Codex rollout path must not be a symbolic link",
      };
    }
    if (!linkStats.isFile()) {
      return {
        status: "malformed",
        rolloutPath,
        reason: "Codex rollout is not a regular file",
      };
    }

    let canonicalPath: string;
    try {
      canonicalPath = await this.realpath(rolloutPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { status: "pending", rolloutPath, reason: "rollout file is not available yet" };
      }
      return {
        status: "malformed",
        rolloutPath,
        reason: `cannot resolve rollout path: ${errorMessage(error)}`,
      };
    }
    if (!pathIsInside(sessionsRoot, canonicalPath)) {
      return {
        status: "malformed",
        rolloutPath: canonicalPath,
        reason: "Codex rollout path is outside the configured sessions root",
      };
    }

    let handle: FileHandle;
    try {
      handle = await this.openFile(
        canonicalPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return {
          status: "pending",
          rolloutPath: canonicalPath,
          reason: "rollout file is not available yet",
        };
      }
      return {
        status: "malformed",
        rolloutPath: canonicalPath,
        reason: `cannot safely open rollout: ${errorMessage(error)}`,
      };
    }

    const inspected = await statOpenFile(handle);
    if (inspected.status === "malformed") {
      await handle.close().catch(() => undefined);
      return { status: "malformed", rolloutPath: canonicalPath, reason: inspected.reason };
    }
    return {
      status: "opened",
      value: {
        canonicalPath,
        handle,
        identity: inspected.identity,
        size: inspected.size,
      },
    };
  }

  private resolveRolloutPath(
    threadId: string,
    turnId: string | null,
  ):
    | { status: "resolved"; rolloutPath: string }
    | { status: "failed"; result: CodexCompletionMalformed } {
    let database: Database;
    try {
      database = this.openDatabase(this.stateDatabasePath);
    } catch (error) {
      return {
        status: "failed",
        result: malformed(
          threadId,
          null,
          turnId,
          0,
          `cannot open Codex state database read-only: ${errorMessage(error)}`,
        ),
      };
    }

    let rolloutPath: unknown;
    try {
      const row = database
        .prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1")
        .get(threadId) as { rollout_path?: unknown } | undefined;
      rolloutPath = row?.rollout_path;
    } catch (error) {
      return {
        status: "failed",
        result: malformed(
          threadId,
          null,
          turnId,
          0,
          `cannot resolve task in Codex state: ${errorMessage(error)}`,
        ),
      };
    } finally {
      database.close();
    }

    if (typeof rolloutPath !== "string" || !path.isAbsolute(rolloutPath)) {
      return {
        status: "failed",
        result: malformed(
          threadId,
          null,
          turnId,
          0,
          "Codex state has no absolute rollout path for the task",
        ),
      };
    }
    return { status: "resolved", rolloutPath: path.resolve(rolloutPath) };
  }
}

function newScanner(input: {
  threadId: string;
  marker: string;
  requestedTurnId: string | null;
  rolloutPath: string;
  identity: FileIdentity;
}): ScannerState {
  return {
    ...input,
    readOffset: 0,
    committedBytes: 0,
    lineNumber: 0,
    pendingRecord: Buffer.alloc(0),
    sawRecord: false,
    metadataCount: 0,
    activeTurnId: null,
    activeTurnMalformed: false,
    activeContextTurnId: null,
    activeContextAmbiguous: false,
    activeContextMalformed: false,
    markerOccurrences: 0,
    markerTurnId: null,
    terminal: null,
    failure: null,
  };
}

function consumeBytes(scanner: ScannerState, chunk: Buffer, maxRecordBytes: number): void {
  if (scanner.failure) return;
  const baseCommittedBytes = scanner.committedBytes;
  const data = scanner.pendingRecord.length ? Buffer.concat([scanner.pendingRecord, chunk]) : chunk;
  let lineStart = 0;
  while (!scanner.failure) {
    const newline = data.indexOf(0x0a, lineStart);
    if (newline < 0) break;
    const recordBytes = newline - lineStart;
    scanner.lineNumber++;
    scanner.committedBytes = baseCommittedBytes + newline + 1;
    if (recordBytes > maxRecordBytes) {
      setFailure(
        scanner,
        "malformed",
        `rollout line ${scanner.lineNumber} exceeds ${maxRecordBytes} bytes`,
      );
      break;
    }
    processLine(scanner, data.subarray(lineStart, newline));
    lineStart = newline + 1;
  }

  if (scanner.failure) {
    scanner.pendingRecord = Buffer.alloc(0);
    return;
  }
  const tail = data.subarray(lineStart);
  if (tail.length > maxRecordBytes) {
    setFailure(scanner, "malformed", `pending rollout record exceeds ${maxRecordBytes} bytes`);
    scanner.pendingRecord = Buffer.alloc(0);
    return;
  }
  scanner.pendingRecord = tail.length ? Buffer.from(tail) : Buffer.alloc(0);
}

function processLine(scanner: ScannerState, bytes: Buffer): void {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r$/, "");
  } catch {
    setFailure(scanner, "malformed", `rollout line ${scanner.lineNumber} is not valid UTF-8`);
    return;
  }
  if (!raw.trim()) return;

  let value: unknown;
  try {
    value = JSON.parse(scanner.lineNumber === 1 ? raw.replace(/^\uFEFF/, "") : raw);
  } catch {
    setFailure(scanner, "malformed", `rollout line ${scanner.lineNumber} is not valid JSON`);
    return;
  }
  if (!isRecord(value)) {
    setFailure(scanner, "malformed", `rollout line ${scanner.lineNumber} is not a JSON object`);
    return;
  }
  scanner.sawRecord = true;
  inspectRecord(scanner, value);
}

function inspectRecord(scanner: ScannerState, record: Record<string, unknown>): void {
  if (record.type === "session_meta") {
    inspectSessionMetadata(scanner, record.payload);
    return;
  }

  const payload = eventPayload(record);
  if (payload?.type === "task_started") {
    scanner.activeTurnId =
      typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : null;
    scanner.activeTurnMalformed = scanner.activeTurnId === null;
    scanner.activeContextTurnId = null;
    scanner.activeContextAmbiguous = false;
    scanner.activeContextMalformed = false;
  }

  if (record.type === "turn_context") {
    inspectTurnContext(scanner, record.payload);
  }

  if (isUserMessage(record)) {
    inspectUserMessage(scanner, record.payload as Record<string, unknown>);
  }

  if (
    scanner.markerTurnId &&
    (payload?.type === "task_complete" || payload?.type === "turn_aborted") &&
    payload.turn_id === scanner.markerTurnId
  ) {
    inspectTerminal(scanner, payload);
  }
}

function inspectSessionMetadata(scanner: ScannerState, payload: unknown): void {
  if (!isRecord(payload)) {
    setFailure(scanner, "malformed", "rollout contains invalid session metadata");
    return;
  }
  const identityValues = [payload.id, payload.session_id];
  const present = identityValues.filter((value) => value !== undefined && value !== null);
  if (
    present.length === 0 ||
    present.some((value) => typeof value !== "string" || !value || value !== scanner.threadId)
  ) {
    setFailure(scanner, "malformed", "rollout session identity does not match the stored task id");
    return;
  }
  scanner.metadataCount++;
}

function inspectTurnContext(scanner: ScannerState, payload: unknown): void {
  if (!isRecord(payload) || typeof payload.turn_id !== "string" || !payload.turn_id) {
    scanner.activeContextMalformed = true;
    return;
  }
  if (scanner.activeContextTurnId && scanner.activeContextTurnId !== payload.turn_id) {
    scanner.activeContextAmbiguous = true;
  } else {
    scanner.activeContextTurnId = payload.turn_id;
  }
}

function inspectUserMessage(scanner: ScannerState, payload: Record<string, unknown>): void {
  const contents = payload.content;
  if (!Array.isArray(contents)) {
    setFailure(
      scanner,
      "malformed",
      `user message on rollout line ${scanner.lineNumber} has invalid content`,
    );
    return;
  }
  let occurrences = 0;
  for (const content of contents) {
    if (!isRecord(content) || content.type !== "input_text" || typeof content.text !== "string") {
      continue;
    }
    occurrences += countOccurrences(content.text, scanner.marker);
  }
  if (occurrences === 0) return;

  scanner.markerOccurrences += occurrences;
  if (scanner.markerOccurrences > 1) {
    setFailure(
      scanner,
      "ambiguous",
      "the exact correlation marker appears in multiple user-message locations",
    );
    return;
  }
  if (scanner.activeTurnMalformed || !scanner.activeTurnId) {
    setFailure(
      scanner,
      "malformed",
      "the marked user message has no preceding task_started record",
    );
    return;
  }
  if (scanner.requestedTurnId && scanner.requestedTurnId !== scanner.activeTurnId) {
    setFailure(
      scanner,
      "ambiguous",
      "the supplied turn id does not own the marked user message",
      scanner.requestedTurnId,
    );
    return;
  }
  if (scanner.activeContextMalformed) {
    setFailure(
      scanner,
      "malformed",
      "turn_context before the marked message has no valid turn id",
      scanner.activeTurnId,
    );
    return;
  }
  if (!scanner.activeContextTurnId) {
    setFailure(
      scanner,
      "malformed",
      "the marked user message has no preceding turn_context",
      scanner.activeTurnId,
    );
    return;
  }
  if (scanner.activeContextAmbiguous || scanner.activeContextTurnId !== scanner.activeTurnId) {
    setFailure(
      scanner,
      "ambiguous",
      "turn_context records do not uniquely bind the marked user message",
      scanner.activeTurnId,
    );
    return;
  }
  scanner.markerTurnId = scanner.activeTurnId;
}

function inspectTerminal(scanner: ScannerState, payload: Record<string, unknown>): void {
  if (scanner.terminal) {
    setFailure(
      scanner,
      "ambiguous",
      "the marked turn has multiple terminal records",
      scanner.markerTurnId,
    );
    return;
  }
  if (payload.type === "turn_aborted") {
    scanner.terminal = {
      kind: "turn_aborted",
      abortReason:
        typeof payload.reason === "string" && payload.reason.trim() ? payload.reason : "unknown",
    };
    return;
  }
  const finalMessage = payload.last_agent_message;
  if (typeof finalMessage !== "string" || !finalMessage.trim()) {
    setFailure(
      scanner,
      "malformed",
      "task_complete has no nonempty last_agent_message",
      scanner.markerTurnId,
    );
    return;
  }
  scanner.terminal = { kind: "task_complete", finalMessage };
}

function evaluateScanner(scanner: ScannerState, caughtUp: boolean): CodexCompletionReadResult {
  if (scanner.failure) return failureResult(scanner);
  const turnId = scanner.markerTurnId ?? scanner.requestedTurnId;
  if (!caughtUp) {
    return pending(
      scanner.threadId,
      scanner.rolloutPath,
      turnId,
      scanner.committedBytes,
      `scanning rollout history from byte ${scanner.readOffset}`,
    );
  }
  if (!scanner.sawRecord) {
    return pending(
      scanner.threadId,
      scanner.rolloutPath,
      turnId,
      scanner.committedBytes,
      "rollout has no complete records yet",
    );
  }
  if (scanner.metadataCount === 0) {
    return malformed(
      scanner.threadId,
      scanner.rolloutPath,
      turnId,
      scanner.committedBytes,
      "rollout has no valid session metadata",
    );
  }
  if (!scanner.markerTurnId) {
    return pending(
      scanner.threadId,
      scanner.rolloutPath,
      scanner.requestedTurnId,
      scanner.committedBytes,
      "the marked user message is not durable yet",
    );
  }
  if (!scanner.terminal) {
    return pending(
      scanner.threadId,
      scanner.rolloutPath,
      scanner.markerTurnId,
      scanner.committedBytes,
      "the marked turn has not reached a durable terminal record",
    );
  }
  if (scanner.terminal.kind === "turn_aborted") {
    return {
      status: "aborted",
      threadId: scanner.threadId,
      rolloutPath: scanner.rolloutPath,
      turnId: scanner.markerTurnId,
      committedBytes: scanner.committedBytes,
      abortReason: scanner.terminal.abortReason,
    };
  }
  return {
    status: "completed",
    threadId: scanner.threadId,
    rolloutPath: scanner.rolloutPath,
    turnId: scanner.markerTurnId,
    committedBytes: scanner.committedBytes,
    finalMessage: scanner.terminal.finalMessage,
  };
}

function failureResult(scanner: ScannerState): CodexCompletionMalformed | CodexCompletionAmbiguous {
  const failure = scanner.failure;
  if (!failure) throw new Error("completion scanner has no failure");
  return failure.kind === "malformed"
    ? malformed(
        scanner.threadId,
        scanner.rolloutPath,
        failure.turnId,
        scanner.committedBytes,
        failure.reason,
      )
    : ambiguous(
        scanner.threadId,
        scanner.rolloutPath,
        failure.turnId,
        scanner.committedBytes,
        failure.reason,
      );
}

function setFailure(
  scanner: ScannerState,
  kind: ScannerFailure["kind"],
  reason: string,
  turnId: string | null = scanner.markerTurnId ?? scanner.requestedTurnId,
): void {
  scanner.failure ??= { kind, reason, turnId };
}

async function statOpenFile(
  handle: FileHandle,
): Promise<
  | { status: "valid"; identity: FileIdentity; size: number }
  | { status: "malformed"; reason: string }
> {
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      return { status: "malformed", reason: "Codex rollout is not a regular file" };
    }
    if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { status: "malformed", reason: "Codex rollout size is not safely representable" };
    }
    return {
      status: "valid",
      identity: { device: stats.dev, inode: stats.ino },
      size: Number(stats.size),
    };
  } catch (error) {
    return { status: "malformed", reason: `cannot inspect open rollout: ${errorMessage(error)}` };
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identityFromStats(stats: Stats): FileIdentity | null {
  if (!Number.isSafeInteger(stats.dev) || !Number.isSafeInteger(stats.ino)) return null;
  return { device: BigInt(stats.dev), inode: BigInt(stats.ino) };
}

function isUserMessage(record: Record<string, unknown>): boolean {
  if (record.type !== "response_item" || !isRecord(record.payload)) return false;
  return record.payload.type === "message" && record.payload.role === "user";
}

function eventPayload(record: Record<string, unknown>): Record<string, unknown> | null {
  return record.type === "event_msg" && isRecord(record.payload) ? record.payload : null;
}

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(marker, offset);
    if (found < 0) return count;
    count++;
    offset = found + marker.length;
  }
}

function pending(
  threadId: string,
  rolloutPath: string | null,
  turnId: string | null,
  committedBytes: number,
  reason: string,
): CodexCompletionPending {
  return { status: "pending", threadId, rolloutPath, turnId, committedBytes, reason };
}

function malformed(
  threadId: string,
  rolloutPath: string | null,
  turnId: string | null,
  committedBytes: number,
  reason: string,
): CodexCompletionMalformed {
  return { status: "malformed", threadId, rolloutPath, turnId, committedBytes, reason };
}

function ambiguous(
  threadId: string,
  rolloutPath: string | null,
  turnId: string | null,
  committedBytes: number,
  reason: string,
): CodexCompletionAmbiguous {
  return { status: "ambiguous", threadId, rolloutPath, turnId, committedBytes, reason };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
