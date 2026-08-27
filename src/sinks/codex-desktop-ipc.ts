import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { CodexReasoningEffort } from "./types.js";

/**
 * This is an intentionally private, version-gated protocol. It is not an
 * OpenAI public API and may change in any Codex Desktop release.
 */
export const CODEX_DESKTOP_PRIVATE_API_WARNING =
  "Codex Desktop IPC is a private, unsupported API; WakeWire verifies the signed app, required protocol routes, live handshake, and every realized turn.";

/** Exact versions whose full turn and interrupt shapes were manually verified. */
export const DEFAULT_SUPPORTED_DESKTOP_VERSIONS = [
  "26.721.41059",
  "26.721.81911",
  "26.727.51351",
] as const;

const DEFAULT_APP_PATH = "/Applications/ChatGPT.app";
const OPENAI_DESKTOP_TEAM_ID = "2DC432GLL2";
const DEFAULT_OPEN_PATH = "/usr/bin/open";
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_POLL_MS = 100;
const MAX_PROTOCOL_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 128;
const INITIALIZING_CLIENT_ID = "initializing-client";
const REQUIRED_TURN_PROTOCOL_TOKENS = [
  "thread-follower-start-turn-for-host",
  "thread-follower-update-thread-settings-for-host",
  "assert-thread-follower-owner-for-host",
  "thread-follower-response-method-mismatch",
] as const;

export type CodexDesktopCompatibility = "pinned" | "signed-runtime-verified" | "override";

export interface CodexDesktopIpcConfig {
  desktopAppPath?: string | undefined;
  socketPath?: string | undefined;
  /** Exact Desktop versions allowed to use this private protocol. */
  supportedDesktopVersions?: readonly string[] | undefined;
  /** Explicit escape hatch for a manually verified newer build. */
  allowUnsupportedDesktopVersion?: boolean | undefined;
  clientType?: string | undefined;
  connectTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  maxFrameBytes?: number | undefined;
  /** Time allowed for a background Desktop relaunch to recreate its private socket. */
  launchTimeoutMs?: number | undefined;
  launchPollMs?: number | undefined;
}

export interface DesktopPathStat {
  uid: number;
  mode: number;
  isDirectory(): boolean;
  isSocket(): boolean;
}

export interface CodexDesktopTransport {
  connect(socketPath: string, timeoutMs: number): Promise<Duplex>;
}

export interface CodexDesktopIpcDependencies {
  transport?: CodexDesktopTransport | undefined;
  lstat?: ((file: string) => Promise<DesktopPathStat>) | undefined;
  readFile?: ((file: string, encoding: "utf8") => Promise<string>) | undefined;
  currentUid?: (() => number | undefined) | undefined;
  randomUUID?: (() => string) | undefined;
  verifyDesktopApplication?: ((appPath: string) => Promise<void>) | undefined;
  verifyTurnProtocolBundle?: ((appPath: string) => Promise<void>) | undefined;
  launchApplication?: ((appPath: string) => Promise<void>) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface CodexDesktopEnvironment {
  appPath: string;
  desktopVersion: string;
  bundleVersion?: string | undefined;
  socketPath: string;
  turnCompatibility: CodexDesktopCompatibility;
  interruptSupported: boolean;
}

export interface CodexDesktopProbeResult {
  ok: boolean;
  environment?: CodexDesktopEnvironment | undefined;
  reason?: string | undefined;
}

export interface DesktopStartTurnInput {
  conversationId: string;
  prompt: string;
  cwd?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: CodexReasoningEffort | undefined;
  /**
   * Durable last-moment barrier for callers that must record a possible send.
   * It runs after Desktop initialization and immediately before the turn frame
   * is handed to the connection for writing. A rejection sends no turn frame.
   */
  beforeDispatch?: (() => Promise<void>) | undefined;
}

export interface DesktopStartTurnResult {
  requestId: string;
  turnId?: string | undefined;
  result: unknown;
}

export interface DesktopInterruptTurnResult {
  requestId: string;
  interruptedTurnId?: string | undefined;
  result: unknown;
}

interface IpcRequest {
  type: "request";
  requestId: string;
  sourceClientId: string;
  version: number;
  method: string;
  params: unknown;
  timeoutMs?: number;
}

interface IpcResponse {
  type: string;
  requestId?: unknown;
  result?: unknown;
  error?: unknown;
}

export class CodexDesktopUnavailableError extends Error {}

/** A transient missing/stale Desktop endpoint that may recover after relaunch. */
export class CodexDesktopEndpointUnavailableError extends CodexDesktopUnavailableError {}

export class CodexDesktopProtocolError extends Error {}

export class CodexDesktopRemoteError extends Error {
  constructor(
    message: string,
    readonly remoteError: unknown,
  ) {
    super(message);
  }
}

/** Incremental decoder for Desktop's UInt32LE-length-prefixed JSON frames. */
export class CodexDesktopFrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    assertPositiveInteger(maxFrameBytes, "maxFrameBytes");
  }

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const decoded: unknown[] = [];

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32LE(0);
      if (frameLength > this.maxFrameBytes) {
        throw new CodexDesktopProtocolError(
          `Codex Desktop IPC frame is ${frameLength} bytes; limit is ${this.maxFrameBytes}`,
        );
      }
      const totalLength = frameLength + 4;
      if (this.buffer.length < totalLength) break;
      const json = this.buffer.subarray(4, totalLength).toString("utf8");
      this.buffer = this.buffer.subarray(totalLength);
      try {
        decoded.push(JSON.parse(json));
      } catch (error) {
        throw new CodexDesktopProtocolError(
          `Codex Desktop IPC returned invalid JSON: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    // Once the four-byte header is present, the declared size check above is
    // authoritative. This additionally bounds the pre-header/partial buffer.
    if (this.buffer.length > this.maxFrameBytes + 4) {
      throw new CodexDesktopProtocolError("Codex Desktop IPC receive buffer exceeded its limit");
    }
    return decoded;
  }
}

export function encodeCodexDesktopFrame(
  value: unknown,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  assertPositiveInteger(maxFrameBytes, "maxFrameBytes");
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > maxFrameBytes) {
    throw new CodexDesktopProtocolError(
      `Codex Desktop IPC request is ${payload.length} bytes; limit is ${maxFrameBytes}`,
    );
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Minimal same-user client for the private IPC router embedded in Codex
 * Desktop. A fresh connection is initialized for every operation so a broken
 * Desktop restart cannot leave WakeWire holding a stale client id.
 */
export class CodexDesktopIpcClient {
  private readonly appPath: string;
  private readonly socketPath: string;
  private readonly supportedVersions: readonly string[];
  private readonly strictVersionList: boolean;
  private readonly allowUnsupportedVersion: boolean;
  private readonly clientType: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly launchTimeoutMs: number;
  private readonly launchPollMs: number;
  private readonly transport: CodexDesktopTransport;
  private readonly lstat: (file: string) => Promise<DesktopPathStat>;
  private readonly readFile: (file: string, encoding: "utf8") => Promise<string>;
  private readonly currentUid: () => number | undefined;
  private readonly randomUUID: () => string;
  private readonly verifyDesktopApplication: (appPath: string) => Promise<void>;
  private readonly verifyTurnProtocolBundle: (appPath: string) => Promise<void>;
  private readonly launchApplication: (appPath: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly validationByBuild = new Map<string, Promise<CodexDesktopCompatibility>>();

  constructor(config: CodexDesktopIpcConfig = {}, dependencies: CodexDesktopIpcDependencies = {}) {
    this.appPath = config.desktopAppPath ?? DEFAULT_APP_PATH;
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    this.socketPath = config.socketPath ?? path.join(codexHome, "ipc", "ipc.sock");
    this.supportedVersions = config.supportedDesktopVersions ?? DEFAULT_SUPPORTED_DESKTOP_VERSIONS;
    this.strictVersionList = config.supportedDesktopVersions !== undefined;
    this.allowUnsupportedVersion = config.allowUnsupportedDesktopVersion ?? false;
    this.clientType = config.clientType ?? "wakewire-bridge";
    this.connectTimeoutMs = config.connectTimeoutMs ?? 2_000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
    this.maxFrameBytes = config.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.launchTimeoutMs = config.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    this.launchPollMs = config.launchPollMs ?? DEFAULT_LAUNCH_POLL_MS;
    assertPositiveInteger(this.connectTimeoutMs, "connectTimeoutMs");
    assertPositiveInteger(this.requestTimeoutMs, "requestTimeoutMs");
    assertPositiveInteger(this.maxFrameBytes, "maxFrameBytes");
    assertPositiveInteger(this.launchTimeoutMs, "launchTimeoutMs");
    assertPositiveInteger(this.launchPollMs, "launchPollMs");
    this.transport = dependencies.transport ?? new NodeUnixSocketTransport();
    this.lstat = dependencies.lstat ?? ((file) => fs.lstat(file));
    this.readFile = dependencies.readFile ?? ((file, encoding) => fs.readFile(file, encoding));
    this.currentUid = dependencies.currentUid ?? (() => process.getuid?.());
    this.randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
    this.verifyDesktopApplication =
      dependencies.verifyDesktopApplication ?? verifyOpenAiDesktopApplication;
    this.verifyTurnProtocolBundle =
      dependencies.verifyTurnProtocolBundle ?? verifyDesktopTurnProtocolBundle;
    this.launchApplication =
      dependencies.launchApplication ??
      ((appPath) => launchDesktopApplication(DEFAULT_OPEN_PATH, appPath));
    this.sleep = dependencies.sleep ?? delay;
  }

  async inspectEnvironment(): Promise<CodexDesktopEnvironment> {
    const uid = this.currentUid();
    if (uid === undefined) {
      throw new CodexDesktopUnavailableError(
        "Codex Desktop IPC requires a Unix process with a verifiable uid",
      );
    }

    const application = await this.inspectApplication();
    await this.inspectPrivateEndpoint(uid);
    return { ...application, socketPath: this.socketPath };
  }

  private async inspectApplication(): Promise<Omit<CodexDesktopEnvironment, "socketPath">> {
    let app: DesktopPathStat;
    try {
      app = await this.lstat(this.appPath);
    } catch (error) {
      throw unavailable(`Codex Desktop is not installed at ${this.appPath}`, error);
    }
    if (!app.isDirectory()) {
      throw new CodexDesktopUnavailableError(`${this.appPath} is not an application directory`);
    }

    const infoPlist = path.join(this.appPath, "Contents", "Info.plist");
    let plist: string;
    try {
      plist = await this.readFile(infoPlist, "utf8");
    } catch (error) {
      throw unavailable(`cannot read Codex Desktop metadata at ${infoPlist}`, error);
    }
    const desktopVersion = parsePlistString(plist, "CFBundleShortVersionString");
    const bundleVersion = parsePlistString(plist, "CFBundleVersion");
    const bundleId = parsePlistString(plist, "CFBundleIdentifier");
    if (!desktopVersion || bundleId !== "com.openai.codex") {
      throw new CodexDesktopUnavailableError(
        `${this.appPath} is not a recognizable Codex Desktop installation`,
      );
    }

    const buildKey = `${desktopVersion}\0${bundleVersion ?? ""}`;
    let validation = this.validationByBuild.get(buildKey);
    if (!validation) {
      validation = this.validateApplicationBuild(desktopVersion);
      this.validationByBuild.set(buildKey, validation);
      validation.catch(() => this.validationByBuild.delete(buildKey));
    }
    const turnCompatibility = await validation;

    return {
      appPath: this.appPath,
      desktopVersion,
      ...(bundleVersion ? { bundleVersion } : {}),
      turnCompatibility,
      interruptSupported:
        this.allowUnsupportedVersion || this.supportedVersions.includes(desktopVersion),
    };
  }

  private async validateApplicationBuild(
    desktopVersion: string,
  ): Promise<CodexDesktopCompatibility> {
    if (
      this.strictVersionList &&
      !this.allowUnsupportedVersion &&
      !this.supportedVersions.includes(desktopVersion)
    ) {
      throw new CodexDesktopUnavailableError(
        `Codex Desktop ${desktopVersion} is not approved by the configured strict IPC version list (supported: ${this.supportedVersions.join(", ") || "none"})`,
      );
    }
    await this.verifyDesktopApplication(this.appPath);
    if (this.supportedVersions.includes(desktopVersion)) return "pinned";
    if (this.allowUnsupportedVersion) return "override";
    await this.verifyTurnProtocolBundle(this.appPath);
    return "signed-runtime-verified";
  }

  private async inspectPrivateEndpoint(uid: number): Promise<void> {
    const ipcDirectory = path.dirname(this.socketPath);
    let directory: DesktopPathStat;
    try {
      directory = await this.lstat(ipcDirectory);
    } catch (error) {
      throw endpointUnavailable(
        `Codex Desktop IPC directory is not available at ${ipcDirectory}`,
        error,
      );
    }
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
      throw new CodexDesktopUnavailableError(
        `Codex Desktop IPC directory ${ipcDirectory} must be a private directory owned by uid ${uid}`,
      );
    }

    let socket: DesktopPathStat;
    try {
      socket = await this.lstat(this.socketPath);
    } catch (error) {
      throw endpointUnavailable(
        `Codex Desktop IPC socket is not available at ${this.socketPath}`,
        error,
      );
    }
    if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
      throw new CodexDesktopUnavailableError(
        `Codex Desktop IPC endpoint ${this.socketPath} must be a private Unix socket owned by uid ${uid}`,
      );
    }
  }

  async probeDetailed(): Promise<CodexDesktopProbeResult> {
    try {
      const environment = await this.inspectEnvironment();
      await this.withInitializedConnection(async () => undefined, false);
      return { ok: true, environment };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async probe(): Promise<boolean> {
    return (await this.probeDetailed()).ok;
  }

  async startTurn(input: DesktopStartTurnInput): Promise<DesktopStartTurnResult> {
    if (!input.conversationId.trim()) {
      throw new CodexDesktopProtocolError("conversationId must not be empty");
    }
    if (!input.prompt.trim()) {
      throw new CodexDesktopProtocolError("prompt must not be empty");
    }

    return this.withInitializedConnection(async (connection, clientId) => {
      if (input.model || input.reasoningEffort) {
        const settingsRequestId = this.randomUUID();
        const settingsResult = await connection.request({
          type: "request",
          requestId: settingsRequestId,
          sourceClientId: clientId,
          version: 1,
          method: "thread-follower-update-thread-settings",
          params: {
            conversationId: input.conversationId,
            threadSettings: {
              ...(input.model ? { model: input.model } : {}),
              ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
            },
          },
          timeoutMs: this.requestTimeoutMs,
        });
        if (recordBoolean(settingsResult, "ok") !== true) {
          throw new CodexDesktopProtocolError(
            "Codex Desktop did not confirm the requested next-turn settings",
          );
        }
      }

      // Arm the caller's durable dispatch fence only after the idempotent
      // next-turn settings update, immediately before the non-idempotent turn.
      await input.beforeDispatch?.();
      const requestId = this.randomUUID();
      const result = await connection.request({
        type: "request",
        requestId,
        sourceClientId: clientId,
        version: 1,
        method: "thread-follower-start-turn",
        params: {
          conversationId: input.conversationId,
          turnStartParams: {
            input: [{ type: "text", text: input.prompt, text_elements: [] }],
            ...(input.cwd ? { cwd: input.cwd } : {}),
            // Retain these as defense in depth for builds that also consume
            // start-turn overrides; the acknowledged thread settings remain
            // the authoritative next-turn application path.
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
          },
        },
        timeoutMs: this.requestTimeoutMs,
      });
      return {
        requestId,
        result,
        ...(extractTurnId(result) ? { turnId: extractTurnId(result) } : {}),
      };
    });
  }

  /**
   * Version-gated private route used by supported Desktop builds' own Stop UI.
   * The renderer that owns the conversation performs the actual interruption.
   */
  async interruptTurn(conversationId: string): Promise<DesktopInterruptTurnResult> {
    if (!conversationId.trim()) {
      throw new CodexDesktopProtocolError("conversationId must not be empty");
    }
    return this.withInitializedConnection(
      async (connection, clientId) => {
        const requestId = this.randomUUID();
        const result = await connection.request({
          type: "request",
          requestId,
          sourceClientId: clientId,
          version: 3,
          method: "thread-follower-interrupt-turn",
          params: { conversationId, mode: "user-stop" },
          timeoutMs: this.requestTimeoutMs,
        });
        if (recordBoolean(result, "ok") !== true) {
          throw new CodexDesktopProtocolError(
            "Codex Desktop did not confirm that the task was interrupted",
          );
        }
        const interruptedTurnId = recordString(result, "interruptedTurnId");
        return {
          requestId,
          result,
          ...(interruptedTurnId ? { interruptedTurnId } : {}),
        };
      },
      true,
      "interrupt",
    );
  }

  private async withInitializedConnection<T>(
    operation: (connection: FramedJsonConnection, clientId: string) => Promise<T>,
    inspect = true,
    capability: "turn" | "interrupt" = "turn",
  ): Promise<T> {
    if (inspect) {
      const application = await this.inspectApplication();
      if (capability === "interrupt" && !application.interruptSupported) {
        throw new CodexDesktopUnavailableError(
          `Codex Desktop ${application.desktopVersion} has not been approved for WakeWire's interrupt protocol`,
        );
      }
    }
    const socket = inspect ? await this.connectWithRecovery() : await this.connectOnce();
    let initialized: { connection: FramedJsonConnection; clientId: string };
    try {
      initialized = await this.initializeSocket(socket);
    } catch (error) {
      if (!inspect || !(error instanceof CodexDesktopUnavailableError)) throw error;
      initialized = await this.initializeSocket(await this.relaunchAndConnect());
    }
    try {
      return await operation(initialized.connection, initialized.clientId);
    } finally {
      initialized.connection.close();
    }
  }

  private async initializeSocket(
    socket: Duplex,
  ): Promise<{ connection: FramedJsonConnection; clientId: string }> {
    const connection = new FramedJsonConnection(socket, this.maxFrameBytes, this.requestTimeoutMs);
    try {
      const initialized = await connection.request({
        type: "request",
        requestId: this.randomUUID(),
        sourceClientId: INITIALIZING_CLIENT_ID,
        version: 0,
        method: "initialize",
        params: { clientType: this.clientType },
      });
      const clientId = recordString(initialized, "clientId");
      if (!clientId) {
        throw new CodexDesktopProtocolError(
          "Codex Desktop initialize response did not include a clientId",
        );
      }
      return { connection, clientId };
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  private async connectOnce(): Promise<Duplex> {
    const uid = this.currentUid();
    if (uid === undefined) {
      throw new CodexDesktopUnavailableError(
        "Codex Desktop IPC requires a Unix process with a verifiable uid",
      );
    }
    await this.inspectPrivateEndpoint(uid);
    try {
      return await this.transport.connect(this.socketPath, this.connectTimeoutMs);
    } catch (error) {
      throw endpointUnavailable(`cannot connect to Codex Desktop IPC at ${this.socketPath}`, error);
    }
  }

  private async connectWithRecovery(): Promise<Duplex> {
    try {
      return await this.connectOnce();
    } catch (error) {
      if (!(error instanceof CodexDesktopEndpointUnavailableError)) throw error;
    }

    return this.relaunchAndConnect();
  }

  private async relaunchAndConnect(): Promise<Duplex> {
    try {
      await this.launchApplication(this.appPath);
    } catch (error) {
      throw unavailable(`cannot relaunch Codex Desktop at ${this.appPath}`, error);
    }

    const deadline = Date.now() + this.launchTimeoutMs;
    let lastError: unknown;
    do {
      try {
        return await this.connectOnce();
      } catch (error) {
        if (!(error instanceof CodexDesktopEndpointUnavailableError)) throw error;
        lastError = error;
      }
      await this.sleep(this.launchPollMs);
    } while (Date.now() < deadline);

    throw endpointUnavailable(
      `Codex Desktop did not recreate a usable IPC endpoint within ${this.launchTimeoutMs}ms`,
      lastError,
    );
  }
}

class NodeUnixSocketTransport implements CodexDesktopTransport {
  connect(socketPath: string, timeoutMs: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new CodexDesktopUnavailableError(`IPC connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onConnect = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }
}

class FramedJsonConnection {
  private readonly decoder: CodexDesktopFrameDecoder;
  private readonly queued: unknown[] = [];
  private waiter:
    | {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private failure: Error | undefined;

  constructor(
    private readonly socket: Duplex,
    private readonly maxFrameBytes: number,
    private readonly requestTimeoutMs: number,
  ) {
    this.decoder = new CodexDesktopFrameDecoder(maxFrameBytes);
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }

  async request(request: IpcRequest): Promise<unknown> {
    await this.write(request);
    const deadline = Date.now() + this.requestTimeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CodexDesktopUnavailableError(
          `Codex Desktop IPC request ${request.method} timed out after ${this.requestTimeoutMs}ms`,
        );
      }
      const message = asResponse(await this.nextMessage(remaining));
      // Broadcasts and replies for other local clients can share the router.
      if (!message || message.requestId !== request.requestId) continue;
      if (message.type !== "response" && message.type !== "error") {
        throw new CodexDesktopProtocolError(
          `Codex Desktop IPC returned unexpected message type ${message.type}`,
        );
      }
      if (message.error !== undefined && message.error !== null) {
        throw new CodexDesktopRemoteError(remoteErrorMessage(message.error), message.error);
      }
      if (message.type === "error") {
        throw new CodexDesktopRemoteError(remoteErrorMessage(message), message);
      }
      return message.result;
    }
  }

  close(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new CodexDesktopUnavailableError("Codex Desktop IPC connection closed"));
      this.waiter = undefined;
    }
    this.socket.destroy();
  }

  private write(value: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let frame: Buffer;
    try {
      frame = encodeCodexDesktopFrame(value, this.maxFrameBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private nextMessage(timeoutMs: number): Promise<unknown> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) {
      return Promise.reject(
        new CodexDesktopProtocolError("concurrent IPC reads are not supported"),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(
          new CodexDesktopUnavailableError(
            `Codex Desktop IPC response timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  private readonly onData = (chunk: Buffer) => {
    try {
      for (const value of this.decoder.push(chunk)) this.pushMessage(value);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly onError = (error: Error) => {
    this.fail(unavailable("Codex Desktop IPC connection failed", error));
  };

  private readonly onEnd = () => {
    this.fail(new CodexDesktopUnavailableError("Codex Desktop IPC connection ended"));
  };

  private pushMessage(value: unknown): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    if (this.queued.length >= MAX_QUEUED_MESSAGES) {
      this.fail(
        new CodexDesktopProtocolError(
          `Codex Desktop IPC queued more than ${MAX_QUEUED_MESSAGES} unsolicited messages`,
        ),
      );
      return;
    }
    this.queued.push(value);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function asResponse(value: unknown): IpcResponse | null {
  if (!value || typeof value !== "object") return null;
  return value as IpcResponse;
}

function extractTurnId(result: unknown): string | undefined {
  const direct = recordString(result, "turnId");
  if (direct) return direct;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const directTurn = recordString(record.turn, "id");
  if (directTurn) return directTurn;
  const nested = record.result;
  if (!nested || typeof nested !== "object") return undefined;
  return recordString((nested as Record<string, unknown>).turn, "id");
}

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const member = (value as Record<string, unknown>)[key];
  return typeof member === "string" && member.length > 0 ? member : undefined;
}

function recordBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const member = (value as Record<string, unknown>)[key];
  return typeof member === "boolean" ? member : undefined;
}

function remoteErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  return (
    recordString(error, "message") ?? recordString(error, "errorMessage") ?? JSON.stringify(error)
  );
}

function parsePlistString(plist: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = plist.match(
    new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([^<]+)</string>`),
  );
  return match?.[1]?.trim();
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function unavailable(message: string, cause: unknown): CodexDesktopUnavailableError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CodexDesktopUnavailableError(`${message}: ${detail}`);
}

function endpointUnavailable(
  message: string,
  cause: unknown,
): CodexDesktopEndpointUnavailableError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CodexDesktopEndpointUnavailableError(`${message}: ${detail}`);
}

async function verifyOpenAiDesktopApplication(appPath: string): Promise<void> {
  try {
    await runExecutable("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    const details = await runExecutable("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
    const description = `${details.stdout}\n${details.stderr}`;
    if (!description.includes("Identifier=com.openai.codex")) {
      throw new Error("the code signature has an unexpected application identifier");
    }
    if (!description.includes(`TeamIdentifier=${OPENAI_DESKTOP_TEAM_ID}`)) {
      throw new Error("the code signature is not owned by the expected OpenAI team");
    }
  } catch (error) {
    throw unavailable(`Codex Desktop at ${appPath} failed code-signature verification`, error);
  }
}

export async function verifyDesktopTurnProtocolBundle(appPath: string): Promise<void> {
  const archivePath = path.join(appPath, "Contents", "Resources", "app.asar");
  let archive: Awaited<ReturnType<typeof fs.open>>;
  try {
    archive = await fs.open(archivePath, "r");
  } catch (error) {
    throw unavailable(`cannot open Codex Desktop protocol bundle at ${archivePath}`, error);
  }

  try {
    const stat = await archive.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROTOCOL_ARCHIVE_BYTES) {
      throw new CodexDesktopUnavailableError(
        `Codex Desktop protocol bundle must be a regular file no larger than ${MAX_PROTOCOL_ARCHIVE_BYTES} bytes`,
      );
    }

    const needles = new Map(
      REQUIRED_TURN_PROTOCOL_TOKENS.map((token) => [token, Buffer.from(token, "utf8")]),
    );
    const maxNeedleBytes = Math.max(...[...needles.values()].map((needle) => needle.length));
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let overlap = Buffer.alloc(0);
    let position = 0;
    while (needles.size > 0) {
      const { bytesRead } = await archive.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const search = Buffer.concat([overlap, buffer.subarray(0, bytesRead)]);
      for (const [token, needle] of needles) {
        if (search.indexOf(needle) >= 0) needles.delete(token);
      }
      overlap = Buffer.from(search.subarray(Math.max(0, search.length - maxNeedleBytes + 1)));
    }

    if (needles.size > 0) {
      throw new CodexDesktopUnavailableError(
        `Codex Desktop protocol bundle is missing required turn routes: ${[...needles.keys()].join(", ")}`,
      );
    }
  } finally {
    await archive.close();
  }
}

async function launchDesktopApplication(openPath: string, appPath: string): Promise<void> {
  await runExecutable(openPath, ["-g", "-j", appPath]);
}

function runExecutable(
  executable: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
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
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
