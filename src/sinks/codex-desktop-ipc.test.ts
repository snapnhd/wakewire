import type { PathLike } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CodexDesktopFrameDecoder,
  CodexDesktopIpcClient,
  CodexDesktopProtocolError,
  type CodexDesktopTransport,
  DEFAULT_SUPPORTED_DESKTOP_VERSIONS,
  type DesktopPathStat,
  encodeCodexDesktopFrame,
  verifyDesktopTurnProtocolBundle,
} from "./codex-desktop-ipc.js";

describe("Codex Desktop IPC framing", () => {
  it("decodes fragmented and coalesced UInt32LE JSON frames", () => {
    const first = encodeCodexDesktopFrame({ one: 1 });
    const second = encodeCodexDesktopFrame({ two: 2 });
    const joined = Buffer.concat([first, second]);
    const decoder = new CodexDesktopFrameDecoder(1_024);

    expect(decoder.push(joined.subarray(0, 2))).toEqual([]);
    expect(decoder.push(joined.subarray(2, first.length + 3))).toEqual([{ one: 1 }]);
    expect(decoder.push(joined.subarray(first.length + 3))).toEqual([{ two: 2 }]);
  });

  it("rejects oversized inbound and outbound frames before processing payloads", () => {
    expect(() => encodeCodexDesktopFrame({ data: "x".repeat(100) }, 20)).toThrow(
      CodexDesktopProtocolError,
    );

    const declaredHuge = Buffer.alloc(4);
    declaredHuge.writeUInt32LE(10_000, 0);
    expect(() => new CodexDesktopFrameDecoder(32).push(declaredHuge)).toThrow(
      /frame is 10000 bytes/,
    );
  });

  it("rejects invalid JSON", () => {
    const payload = Buffer.from("not-json");
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    expect(() => new CodexDesktopFrameDecoder().push(frame)).toThrow(/invalid JSON/);
  });
});

describe("Codex Desktop signed-bundle compatibility", () => {
  it("requires every turn route used by WakeWire", async () => {
    const appPath = await fs.mkdtemp(path.join(os.tmpdir(), "wakewire-desktop-bundle-"));
    const resources = path.join(appPath, "Contents", "Resources");
    await fs.mkdir(resources, { recursive: true });
    const protocol = [
      "thread-follower-start-turn-for-host",
      "thread-follower-update-thread-settings-for-host",
      "assert-thread-follower-owner-for-host",
      "thread-follower-response-method-mismatch",
    ].join("\0");
    await fs.writeFile(path.join(resources, "app.asar"), protocol);

    try {
      await expect(verifyDesktopTurnProtocolBundle(appPath)).resolves.toBeUndefined();
      await fs.writeFile(path.join(resources, "app.asar"), "thread-follower-start-turn-for-host");
      await expect(verifyDesktopTurnProtocolBundle(appPath)).rejects.toThrow(
        /missing required turn routes/,
      );
    } finally {
      await fs.rm(appPath, { recursive: true, force: true });
    }
  });
});

describe("CodexDesktopIpcClient", () => {
  it("lists Desktop builds whose full turn and interrupt protocols were verified", () => {
    expect(DEFAULT_SUPPORTED_DESKTOP_VERSIONS).toEqual([
      "26.721.41059",
      "26.721.81911",
      "26.727.51351",
    ]);
  });

  it("initializes, ignores a broadcast, and sends the exact Desktop-owned turn request", async () => {
    const socket = new ScriptedDesktopSocket();
    const transport: CodexDesktopTransport = {
      connect: async () => socket,
    };
    const ids = ["initialize-request", "settings-request", "turn-request"];
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        transport,
        ...healthyFilesystem(),
        randomUUID: () => ids.shift() ?? "unexpected-id",
      },
    );

    const result = await client.startTurn({
      conversationId: "thread-123",
      prompt: "Please investigate",
      cwd: "/Users/chip/Snap/eng-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });

    expect(result).toEqual({
      requestId: "turn-request",
      result: { turn: { id: "turn-456" } },
      turnId: "turn-456",
    });
    expect(socket.requests).toEqual([
      {
        type: "request",
        requestId: "initialize-request",
        sourceClientId: "initializing-client",
        version: 0,
        method: "initialize",
        params: { clientType: "wakewire-bridge" },
      },
      {
        type: "request",
        requestId: "settings-request",
        sourceClientId: "desktop-client-1",
        version: 1,
        method: "thread-follower-update-thread-settings",
        params: {
          conversationId: "thread-123",
          threadSettings: { model: "gpt-5.6-sol", effort: "ultra" },
        },
        timeoutMs: 250,
      },
      {
        type: "request",
        requestId: "turn-request",
        sourceClientId: "desktop-client-1",
        version: 1,
        method: "thread-follower-start-turn",
        params: {
          conversationId: "thread-123",
          turnStartParams: {
            input: [{ type: "text", text: "Please investigate", text_elements: [] }],
            cwd: "/Users/chip/Snap/eng-1",
            model: "gpt-5.6-sol",
            effort: "ultra",
          },
        },
        timeoutMs: 250,
      },
    ]);
  });

  it("runs the durable dispatch barrier after settings and before writing the turn", async () => {
    const socket = new ScriptedDesktopSocket();
    const observedMethods: Array<string | undefined> = [];
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        transport: { connect: async () => socket },
        ...healthyFilesystem(),
        randomUUID: () => "request-id",
      },
    );

    await expect(
      client.startTurn({
        conversationId: "thread-123",
        prompt: "Please investigate",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        beforeDispatch: async () => {
          observedMethods.push(
            ...(socket.requests as Array<{ method?: string }>).map(({ method }) => method),
          );
          throw new Error("durable arm failed");
        },
      }),
    ).rejects.toThrow("durable arm failed");

    expect(observedMethods).toEqual(["initialize", "thread-follower-update-thread-settings"]);
    expect(socket.requests).toHaveLength(2);
  });

  it("does not start a turn when Desktop rejects its requested settings", async () => {
    const socket = new ScriptedDesktopSocket(undefined, undefined, { ok: false });
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        transport: { connect: async () => socket },
        ...healthyFilesystem(),
        randomUUID: () => "request-id",
      },
    );

    await expect(
      client.startTurn({
        conversationId: "thread-123",
        prompt: "Please investigate",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      }),
    ).rejects.toThrow(/did not confirm the requested next-turn settings/);
    expect((socket.requests as Array<{ method?: string }>).map(({ method }) => method)).toEqual([
      "initialize",
      "thread-follower-update-thread-settings",
    ]);
  });

  it("extracts the turn id from Desktop's nested follower result", async () => {
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        transport: {
          connect: async () =>
            new ScriptedDesktopSocket(undefined, { result: { turn: { id: "nested-turn" } } }),
        },
        ...healthyFilesystem(),
        randomUUID: () => "request-id",
      },
    );

    await expect(
      client.startTurn({ conversationId: "thread-123", prompt: "Please investigate" }),
    ).resolves.toEqual({
      requestId: "request-id",
      result: { result: { turn: { id: "nested-turn" } } },
      turnId: "nested-turn",
    });
  });

  it("sends the exact Desktop-owned user-stop request", async () => {
    const socket = new ScriptedDesktopSocket();
    const ids = ["initialize-request", "interrupt-request"];
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        transport: { connect: async () => socket },
        ...healthyFilesystem(),
        randomUUID: () => ids.shift() ?? "unexpected-id",
      },
    );

    await expect(client.interruptTurn("thread-123")).resolves.toEqual({
      requestId: "interrupt-request",
      result: { ok: true, interruptedTurnId: "turn-456" },
      interruptedTurnId: "turn-456",
    });
    expect(socket.requests[1]).toEqual({
      type: "request",
      requestId: "interrupt-request",
      sourceClientId: "desktop-client-1",
      version: 3,
      method: "thread-follower-interrupt-turn",
      params: { conversationId: "thread-123", mode: "user-stop" },
      timeoutMs: 250,
    });
  });

  it("does not confirm stop when Desktop returns an unsuccessful result", async () => {
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        transport: { connect: async () => new ScriptedDesktopSocket({ ok: false }) },
        ...healthyFilesystem(),
        randomUUID: () => "request-id",
      },
    );

    await expect(client.interruptTurn("thread-123")).rejects.toThrow(
      /did not confirm that the task was interrupted/,
    );
  });

  it("fails closed for an unapproved Desktop build", async () => {
    let connected = false;
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["approved"],
      },
      {
        transport: {
          connect: async () => {
            connected = true;
            return new ScriptedDesktopSocket();
          },
        },
        ...healthyFilesystem("new-unverified-build"),
      },
    );

    await expect(client.startTurn({ conversationId: "t", prompt: "p" })).rejects.toThrow(
      /not approved/,
    );
    expect(connected).toBe(false);
  });

  it("accepts a future signed build only after its required turn routes and live handshake pass", async () => {
    let applicationChecks = 0;
    let protocolChecks = 0;
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        requestTimeoutMs: 250,
      },
      {
        transport: { connect: async () => new ScriptedDesktopSocket() },
        ...healthyFilesystem("future-build"),
        verifyDesktopApplication: async () => {
          applicationChecks++;
        },
        verifyTurnProtocolBundle: async () => {
          protocolChecks++;
        },
        randomUUID: () => "request-id",
      },
    );

    await expect(client.probeDetailed()).resolves.toMatchObject({
      ok: true,
      environment: {
        desktopVersion: "future-build",
        turnCompatibility: "signed-runtime-verified",
        interruptSupported: false,
      },
    });
    expect(applicationChecks).toBe(1);
    expect(protocolChecks).toBe(1);
  });

  it("fails closed when a future signed build lacks a required turn route", async () => {
    let connected = false;
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
      },
      {
        transport: {
          connect: async () => {
            connected = true;
            return new ScriptedDesktopSocket();
          },
        },
        ...healthyFilesystem("future-incompatible-build"),
        verifyTurnProtocolBundle: async () => {
          throw new Error("missing thread-follower-start-turn-for-host");
        },
      },
    );

    await expect(client.startTurn({ conversationId: "t", prompt: "p" })).rejects.toThrow(
      /missing thread-follower-start-turn-for-host/,
    );
    expect(connected).toBe(false);
  });

  it("keeps interrupt exact-build-pinned even when a future build passes turn checks", async () => {
    let connected = false;
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
      },
      {
        transport: {
          connect: async () => {
            connected = true;
            return new ScriptedDesktopSocket();
          },
        },
        ...healthyFilesystem("future-turn-compatible-build"),
        verifyTurnProtocolBundle: async () => undefined,
      },
    );

    await expect(client.interruptTurn("thread-123")).rejects.toThrow(
      /has not been approved.*interrupt protocol/,
    );
    expect(connected).toBe(false);
  });

  it("relaunches Desktop in the background when its private socket is temporarily absent", async () => {
    let launched = false;
    let launchCalls = 0;
    const filesystem = healthyFilesystem();
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 250,
      },
      {
        ...filesystem,
        lstat: async (file) => {
          if (file === "/private/wakewire-ipc/ipc.sock" && !launched) {
            throw new Error("ENOENT");
          }
          return filesystem.lstat(file);
        },
        launchApplication: async () => {
          launchCalls++;
          launched = true;
        },
        sleep: async () => undefined,
        transport: { connect: async () => new ScriptedDesktopSocket() },
        randomUUID: () => "request-id",
      },
    );

    await expect(
      client.startTurn({ conversationId: "thread-123", prompt: "Please investigate" }),
    ).resolves.toMatchObject({ turnId: "turn-456" });
    expect(launchCalls).toBe(1);
  });

  it("relaunches once when Desktop restarts after socket connect but before initialize", async () => {
    let connectCalls = 0;
    let launchCalls = 0;
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 10,
      },
      {
        ...healthyFilesystem(),
        launchApplication: async () => {
          launchCalls++;
        },
        sleep: async () => undefined,
        transport: {
          connect: async () => {
            connectCalls++;
            return connectCalls === 1 ? new SilentSocket() : new ScriptedDesktopSocket();
          },
        },
        randomUUID: () => "request-id",
      },
    );

    await expect(
      client.startTurn({ conversationId: "thread-123", prompt: "Please investigate" }),
    ).resolves.toMatchObject({ turnId: "turn-456" });
    expect(connectCalls).toBe(2);
    expect(launchCalls).toBe(1);
  });

  it("does not relaunch Desktop when the existing endpoint fails privacy validation", async () => {
    let launchCalls = 0;
    const filesystem = healthyFilesystem();
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
      },
      {
        ...filesystem,
        lstat: async (file) => {
          const stat = await filesystem.lstat(file);
          if (file === "/private/wakewire-ipc/ipc.sock") return fakeStat("socket", 502, 0o660);
          return stat;
        },
        launchApplication: async () => {
          launchCalls++;
        },
      },
    );

    await expect(client.startTurn({ conversationId: "t", prompt: "p" })).rejects.toThrow(
      /private Unix socket/,
    );
    expect(launchCalls).toBe(0);
  });

  it("rejects a socket or parent directory not private to the current uid", async () => {
    const defaults = healthyFilesystem();
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
      },
      {
        ...defaults,
        lstat: async (file) => {
          const stat = await defaults.lstat(file);
          if (file.endsWith("ipc.sock")) return fakeStat("socket", 502, 0o660);
          return stat;
        },
      },
    );

    await expect(client.inspectEnvironment()).rejects.toThrow(/private Unix socket/);
  });

  it("times out when Desktop never answers initialize", async () => {
    const client = new CodexDesktopIpcClient(
      {
        desktopAppPath: "/Applications/Codex.app",
        socketPath: "/private/wakewire-ipc/ipc.sock",
        supportedDesktopVersions: ["test-version"],
        requestTimeoutMs: 10,
      },
      {
        transport: { connect: async () => new SilentSocket() },
        ...healthyFilesystem(),
        launchApplication: async () => undefined,
      },
    );

    await expect(client.startTurn({ conversationId: "t", prompt: "p" })).rejects.toThrow(
      /timed out/,
    );
  });
});

class ScriptedDesktopSocket extends Duplex {
  readonly requests: unknown[] = [];
  private readonly decoder = new CodexDesktopFrameDecoder();

  constructor(
    private readonly interruptResult: Record<string, unknown> = {
      ok: true,
      interruptedTurnId: "turn-456",
    },
    private readonly turnResult: Record<string, unknown> = { turn: { id: "turn-456" } },
    private readonly settingsResult: Record<string, unknown> = { ok: true },
  ) {
    super();
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      for (const request of this.decoder.push(chunk)) {
        this.requests.push(request);
        const record = request as { method?: string; requestId?: string };
        if (record.method === "initialize") {
          this.respond({
            type: "broadcast",
            event: "unrelated",
          });
          this.respond({
            type: "response",
            requestId: record.requestId,
            result: { clientId: "desktop-client-1" },
          });
        } else if (record.method === "thread-follower-interrupt-turn") {
          this.respond({
            type: "response",
            requestId: record.requestId,
            result: this.interruptResult,
          });
        } else if (record.method === "thread-follower-update-thread-settings") {
          this.respond({
            type: "response",
            requestId: record.requestId,
            result: this.settingsResult,
          });
        } else {
          this.respond({
            type: "response",
            requestId: record.requestId,
            result: this.turnResult,
          });
        }
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private respond(response: unknown): void {
    const frame = encodeCodexDesktopFrame(response);
    // Exercise response fragmentation without relying on event-loop timing.
    this.push(frame.subarray(0, 3));
    this.push(frame.subarray(3));
  }
}

class SilentSocket extends Duplex {
  override _read(): void {}
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

function healthyFilesystem(version = "test-version") {
  return {
    currentUid: () => 502,
    verifyDesktopApplication: async () => undefined,
    readFile: async (_file: PathLike | string, _encoding: "utf8") =>
      plist(version, "com.openai.codex"),
    lstat: async (file: string): Promise<DesktopPathStat> => {
      if (file === "/Applications/Codex.app") return fakeStat("directory", 0, 0o755);
      if (file === "/private/wakewire-ipc") return fakeStat("directory", 502, 0o700);
      if (file === "/private/wakewire-ipc/ipc.sock") return fakeStat("socket", 502, 0o600);
      throw new Error(`unexpected path ${file}`);
    },
  };
}

function fakeStat(type: "directory" | "socket", uid: number, mode: number): DesktopPathStat {
  return {
    uid,
    mode,
    isDirectory: () => type === "directory",
    isSocket: () => type === "socket",
  };
}

function plist(version: string, bundleId: string): string {
  return `<?xml version="1.0"?><plist><dict>
    <key>CFBundleShortVersionString</key><string>${version}</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
  </dict></plist>`;
}
