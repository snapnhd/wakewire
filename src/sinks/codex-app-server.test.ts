import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CodexAppServerAdapter } from "./codex-app-server.js";

const THREAD_ID = "019fa994-d602-76a3-911c-a349c4caceba";

describe("CodexAppServerAdapter", () => {
  let server: WebSocketServer | null = null;
  let adapter: CodexAppServerAdapter | null = null;

  afterEach(() => {
    adapter?.close();
    server?.close();
  });

  it("sets an explicit task title on its existing app-server connection", async () => {
    const messages: Array<Record<string, unknown>> = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(message);
        if (typeof message.id === "number") {
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        }
      });
    });
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    adapter = new CodexAppServerAdapter(pino({ level: "silent" }), {
      listenUrl: `ws://127.0.0.1:${address.port}`,
    });

    await adapter.setThreadTitle(THREAD_ID, "CJ — Check this");

    expect(messages).toEqual(
      expect.arrayContaining([
        {
          id: expect.any(Number),
          method: "thread/name/set",
          params: { threadId: THREAD_ID, name: "CJ — Check this" },
        },
      ]),
    );
  });

  it("applies per-delivery model and reasoning effort to a new thread and its turn", async () => {
    const messages: Array<Record<string, unknown>> = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(message);
        if (typeof message.id !== "number") return;
        if (message.method === "thread/start") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { thread: { id: THREAD_ID, status: { type: "idle" } } },
            }),
          );
          return;
        }
        if (message.method === "turn/start") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { turn: { id: "turn-1", status: "inProgress" } },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: THREAD_ID,
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", text: "Done" }],
                },
              },
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      });
    });
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    adapter = new CodexAppServerAdapter(pino({ level: "silent" }), {
      listenUrl: `ws://127.0.0.1:${address.port}`,
      model: "gpt-5.6-luna",
    });

    await expect(
      adapter.startThread("Investigate", {
        sandbox: "read-only",
        cwd: "/Users/chip/Snap",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      }),
    ).resolves.toEqual({
      threadId: THREAD_ID,
      turnId: "turn-1",
      finalResponse: "Done",
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        {
          id: expect.any(Number),
          method: "thread/start",
          params: {
            cwd: "/Users/chip/Snap",
            sandbox: "read-only",
            approvalPolicy: "never",
            model: "gpt-5.6-sol",
            config: { model_reasoning_effort: "ultra" },
          },
        },
        {
          id: expect.any(Number),
          method: "turn/start",
          params: {
            threadId: THREAD_ID,
            input: [{ type: "text", text: "Investigate" }],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            model: "gpt-5.6-sol",
            effort: "ultra",
          },
        },
      ]),
    );
  });
});
