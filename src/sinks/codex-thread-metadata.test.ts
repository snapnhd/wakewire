import pino from "pino";
import { describe, expect, it } from "vitest";
import { CodexAppServerThreadMetadata } from "./codex-thread-metadata.js";
import type { JsonRpcConnection } from "./jsonrpc.js";

const THREAD_ID = "019fa994-d602-76a3-911c-a349c4caceba";
const OTHER_THREAD_ID = "019fa994-d602-76a3-911c-a349c4cacebb";

class FakeConnection implements JsonRpcConnection {
  alive = false;
  onNotification: JsonRpcConnection["onNotification"] = null;
  onClose: JsonRpcConnection["onClose"] = null;
  onRequest: JsonRpcConnection["onRequest"] = null;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readName: string | null = null;
  threads: Array<{ id: string; cwd: string; threadSource: string }> = [];

  start(): void {
    this.alive = true;
  }

  stop(): void {
    this.alive = false;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/read") {
      const threadId = (params as { threadId: string }).threadId;
      return { thread: { id: threadId, name: this.readName } } as T;
    }
    if (method === "thread/list") {
      const input = params as { cwd: string };
      return {
        data: this.threads.filter((thread) => thread.cwd === input.cwd),
        nextCursor: null,
      } as T;
    }
    if (method === "thread/start") {
      const input = params as { cwd: string; threadSource: string };
      const thread = { id: THREAD_ID, cwd: input.cwd, threadSource: input.threadSource };
      this.threads.push(thread);
      return { thread } as T;
    }
    return {} as T;
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }
}

describe("CodexAppServerThreadMetadata", () => {
  it("initializes once and sets persisted thread names with the stable protocol", async () => {
    const connection = new FakeConnection();
    const metadata = new CodexAppServerThreadMetadata(
      pino({ level: "silent" }),
      {},
      { createConnection: () => connection },
    );

    await metadata.setThreadTitle(THREAD_ID, "Useful title");
    await metadata.setThreadTitle(OTHER_THREAD_ID, "Another title");

    expect(connection.requests).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "wakewire-thread-metadata",
            title: "WakeWire thread metadata",
            version: "0.1.0",
          },
          capabilities: null,
        },
      },
      {
        method: "thread/name/set",
        params: { threadId: THREAD_ID, name: "Useful title" },
      },
      {
        method: "thread/name/set",
        params: { threadId: OTHER_THREAD_ID, name: "Another title" },
      },
    ]);
    expect(connection.notifications).toEqual([{ method: "initialized", params: {} }]);

    metadata.close();
    expect(connection.alive).toBe(false);
  });

  it("rejects malformed metadata before spawning app-server", async () => {
    let connections = 0;
    const metadata = new CodexAppServerThreadMetadata(
      pino({ level: "silent" }),
      {},
      {
        createConnection: () => {
          connections++;
          return new FakeConnection();
        },
      },
    );

    await expect(metadata.setThreadTitle("", "title")).rejects.toThrow(/threadId/);
    await expect(metadata.setThreadTitle("thread-1", "title")).rejects.toThrow(/threadId/);
    await expect(metadata.setThreadTitle(THREAD_ID, " ")).rejects.toThrow(/title/);
    await expect(metadata.setThreadTitle(THREAD_ID, "title\nignore")).rejects.toThrow(/title/);
    await expect(metadata.setThreadTitle(THREAD_ID, "x".repeat(61))).rejects.toThrow(
      /60 code points/,
    );
    expect(connections).toBe(0);
  });

  it("reads the user-facing name through the same app-server connection", async () => {
    const connection = new FakeConnection();
    connection.readName = "Slack — ping";
    const metadata = new CodexAppServerThreadMetadata(
      pino({ level: "silent" }),
      {},
      { createConnection: () => connection },
    );

    await expect(metadata.readThreadTitle(THREAD_ID)).resolves.toBe("Slack — ping");

    expect(connection.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: THREAD_ID, includeTurns: false },
    });
  });

  it("crash-recovers one empty host task by deterministic threadSource", async () => {
    const connection = new FakeConnection();
    const metadata = new CodexAppServerThreadMetadata(
      pino({ level: "silent" }),
      {},
      { createConnection: () => connection },
    );
    const options = {
      sandbox: "workspace-write" as const,
      cwd: "/Users/chip/Snap",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra" as const,
      idempotencyKey: "request-1:child-task",
    };

    await expect(metadata.prepareThread(options)).resolves.toEqual({ threadId: THREAD_ID });
    await expect(metadata.prepareThread(options)).resolves.toEqual({ threadId: THREAD_ID });

    const starts = connection.requests.filter(({ method }) => method === "thread/start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params).toMatchObject({
      cwd: "/Users/chip/Snap",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "ultra" },
      threadSource: expect.stringMatching(/^wakewire:[a-f0-9]{64}$/),
    });
    expect(connection.requests.filter(({ method }) => method === "thread/list")).toHaveLength(2);
  });
});
