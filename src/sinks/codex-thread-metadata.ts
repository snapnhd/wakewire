import { createHash } from "node:crypto";
import path from "node:path";
import type { Logger } from "../logging.js";
import { JsonRpcChild, type JsonRpcConnection } from "./jsonrpc.js";
import type { PrepareThreadOptions } from "./types.js";

const CLIENT_INFO = {
  name: "wakewire-thread-metadata",
  title: "WakeWire thread metadata",
  version: "0.1.0",
};

export interface CodexThreadMetadata {
  setThreadTitle(threadId: string, title: string): Promise<void>;
  /** Read Codex's user-facing name through the same metadata connection. */
  readThreadTitle?(threadId: string): Promise<string | null>;
  /** Crash-recoverably create an empty task for host-owned orchestration. */
  prepareThread?(options: PrepareThreadOptions): Promise<{ threadId: string }>;
  close?(): void;
}

interface ThreadSummary {
  id: string;
  cwd: string;
  threadSource?: string | null | undefined;
}

interface ThreadListResponse {
  data: ThreadSummary[];
  nextCursor?: string | null | undefined;
}

interface ThreadStartResponse {
  thread: ThreadSummary;
}

export interface CodexThreadMetadataConfig {
  codexPath?: string | undefined;
}

export interface CodexThreadMetadataDependencies {
  createConnection?: (() => JsonRpcConnection) | undefined;
}

/**
 * Small app-server metadata client shared by adapters that do not already own
 * an app-server connection. `thread/name/set` updates persisted threads too,
 * so it can name a task that Codex Desktop created through its UI.
 */
export class CodexAppServerThreadMetadata implements CodexThreadMetadata {
  private connection: JsonRpcConnection | null = null;
  private initializing: Promise<JsonRpcConnection> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly config: CodexThreadMetadataConfig = {},
    private readonly dependencies: CodexThreadMetadataDependencies = {},
  ) {}

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    const normalizedThreadId = validateCodexThreadId(threadId);
    const normalizedTitle = validateCodexThreadTitle(title);
    const rpc = await this.connect();
    await rpc.request(
      "thread/name/set",
      { threadId: normalizedThreadId, name: normalizedTitle },
      15_000,
    );
  }

  async readThreadTitle(threadId: string): Promise<string | null> {
    const normalizedThreadId = validateCodexThreadId(threadId);
    const rpc = await this.connect();
    const response = await rpc.request<unknown>(
      "thread/read",
      { threadId: normalizedThreadId, includeTurns: false },
      15_000,
    );
    if (!response || typeof response !== "object") {
      throw new Error("thread/read returned an invalid response");
    }
    const thread = (response as Record<string, unknown>).thread;
    if (!thread || typeof thread !== "object") {
      throw new Error("thread/read response did not include a thread");
    }
    const record = thread as Record<string, unknown>;
    if (record.id !== normalizedThreadId) {
      throw new Error("thread/read returned a different thread");
    }
    if (record.name === null || record.name === undefined) return null;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error("thread/read returned an invalid thread name");
    }
    return record.name;
  }

  async prepareThread(options: PrepareThreadOptions): Promise<{ threadId: string }> {
    const cwd = path.resolve(options.cwd);
    const idempotencyKey = options.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey !== options.idempotencyKey) {
      throw new TypeError("thread preparation idempotency key must be non-empty and trimmed");
    }
    const threadSource = `wakewire:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
    const rpc = await this.connect();
    const recovered = await this.findPreparedThread(rpc, cwd, threadSource);
    if (recovered) return { threadId: recovered };

    const started = await rpc.request<ThreadStartResponse>(
      "thread/start",
      {
        cwd,
        sandbox: options.sandbox,
        approvalPolicy: "never",
        model: options.model,
        ...(options.reasoningEffort
          ? { config: { model_reasoning_effort: options.reasoningEffort } }
          : {}),
        threadSource,
      },
      15_000,
    );
    const threadId = validatePreparedThread(started?.thread, cwd, threadSource);
    return { threadId };
  }

  close(): void {
    const rpc = this.connection;
    this.connection = null;
    rpc?.stop();
  }

  private async connect(): Promise<JsonRpcConnection> {
    if (this.connection?.alive) return this.connection;
    if (this.initializing) return this.initializing;
    this.initializing = this.open().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async findPreparedThread(
    rpc: JsonRpcConnection,
    cwd: string,
    threadSource: string,
  ): Promise<string | null> {
    let cursor: string | null = null;
    const matches: string[] = [];
    for (let page = 0; page < 100; page++) {
      const response: ThreadListResponse = await rpc.request<ThreadListResponse>(
        "thread/list",
        {
          cwd,
          sourceKinds: ["appServer"],
          sortKey: "created_at",
          sortDirection: "desc",
          useStateDbOnly: true,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        15_000,
      );
      if (!response || !Array.isArray(response.data)) {
        throw new Error("thread/list returned an invalid response");
      }
      for (const thread of response.data) {
        if (thread.threadSource !== threadSource) continue;
        matches.push(validatePreparedThread(thread, cwd, threadSource));
        if (matches.length > 1) {
          throw new Error(`multiple Codex tasks matched orchestration source ${threadSource}`);
        }
      }
      cursor = response.nextCursor ?? null;
      if (!cursor) return matches[0] ?? null;
    }
    throw new Error("thread/list pagination exceeded the orchestration recovery limit");
  }

  private async open(): Promise<JsonRpcConnection> {
    this.connection?.stop();
    const rpc = this.dependencies.createConnection
      ? this.dependencies.createConnection()
      : new JsonRpcChild(this.config.codexPath ?? "codex", ["app-server"], this.logger);
    rpc.onRequest = (method) => {
      this.logger.warn({ method }, "declining unexpected thread-metadata request");
      return { errorMessage: "wakewire thread metadata declines interactive requests" };
    };
    rpc.onNotification = null;
    rpc.onClose = () => {
      if (this.connection === rpc) this.connection = null;
    };
    rpc.start();
    try {
      await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null }, 15_000);
      rpc.notify("initialized", {});
    } catch (error) {
      rpc.stop();
      throw error;
    }
    this.connection = rpc;
    return rpc;
  }
}

export function validateCodexThreadId(threadId: string): string {
  const normalized = threadId.trim();
  if (
    normalized !== threadId ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(normalized)
  ) {
    throw new TypeError("threadId must be a canonical lowercase UUID");
  }
  return normalized;
}

export function validateCodexThreadTitle(title: string): string {
  const normalized = title.trim();
  if (
    !normalized ||
    normalized !== title ||
    [...normalized].length > 60 ||
    Buffer.byteLength(normalized, "utf8") > 512 ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new TypeError(
      "thread title must be non-empty, trimmed, single-line, and at most 60 code points / 512 bytes",
    );
  }
  return normalized;
}

function validatePreparedThread(
  thread: ThreadSummary | null | undefined,
  cwd: string,
  threadSource: string,
): string {
  if (!thread || typeof thread !== "object") {
    throw new Error("thread/start returned no task");
  }
  if (typeof thread.id !== "string" || typeof thread.cwd !== "string") {
    throw new Error("Codex prepared task returned an invalid identity");
  }
  const threadId = validateCodexThreadId(thread.id);
  if (path.resolve(thread.cwd) !== cwd) {
    throw new Error(`Codex prepared task ${threadId} in a different working directory`);
  }
  if (thread.threadSource !== threadSource) {
    throw new Error(`Codex prepared task ${threadId} with a different orchestration source`);
  }
  return threadId;
}
