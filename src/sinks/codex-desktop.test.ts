import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging.js";
import {
  appendDesktopCorrelationMarker,
  buildNewDesktopTaskUrl,
  CodexDesktopAdapter,
  type CommandRunner,
  DesktopExecutionProfileMismatchError,
  DesktopResumeProfilePendingError,
  DesktopResumeStateError,
  DesktopTaskDiscoveryError,
  type DesktopTaskFinder,
  type DesktopThreadCreateInput,
  desktopCorrelationMarker,
  HelperDesktopThreadCreator,
  OpenUrlDesktopThreadActivator,
  parseDesktopHelperResult,
  SqliteDesktopResumeDeliveryGuard,
  SqliteDesktopTaskFinder,
  SqliteDesktopThreadTitleReader,
} from "./codex-desktop.js";
import { CodexDesktopRemoteError } from "./codex-desktop-ipc.js";
import type { DeliveryOptions, PrepareThreadOptions } from "./types.js";
import { PermanentError, UnreachableError } from "./types.js";

const THREAD_ID = "019fa994-d602-76a3-911c-a349c4caceba";

function startedRollout(marker: string, turnId = "turn-1"): string {
  return [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model: "gpt-5.6-sol",
        collaboration_mode: { settings: { reasoning_effort: "ultra" } },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `prompt ${marker}` }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    "",
  ].join("\n");
}

function resumeGuardDatabase() {
  const db = new DatabaseConstructor(":memory:");
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(
    "task-1",
    "/tmp/task-1.jsonl",
  );
  return db;
}

describe("Desktop task correlation", () => {
  it("prefers a stable delivery id and has a deterministic legacy fallback", () => {
    const keyed = desktopCorrelationMarker({
      prompt: "same prompt",
      cwd: "/one",
      idempotencyKey: "github:delivery-123",
    });
    expect(keyed).toMatch(/^wakewire:event:v1:[a-f0-9]{64}$/);
    expect(
      desktopCorrelationMarker({
        prompt: "changed prompt",
        cwd: "/two",
        idempotencyKey: "github:delivery-123",
      }),
    ).toBe(keyed);

    const legacy = desktopCorrelationMarker({ prompt: "same prompt", cwd: "/one" });
    expect(desktopCorrelationMarker({ prompt: "same prompt", cwd: "/one" })).toBe(legacy);
    expect(desktopCorrelationMarker({ prompt: "same prompt", cwd: "/two" })).not.toBe(legacy);
  });

  it("appends the marker exactly once and encodes the new-task URL", () => {
    const marker = desktopCorrelationMarker({ prompt: "hello", cwd: "/tmp/a b" });
    const marked = appendDesktopCorrelationMarker("hello", marker);
    expect(marked.match(new RegExp(marker, "g"))).toHaveLength(1);
    expect(appendDesktopCorrelationMarker(marked, marker)).toBe(marked);

    const url = new URL(buildNewDesktopTaskUrl("/tmp/a b", marked));
    expect(url.protocol).toBe("codex:");
    expect(url.hostname).toBe("threads");
    expect(url.pathname).toBe("/new");
    expect(url.searchParams.get("path")).toBe("/tmp/a b");
    expect(url.searchParams.get("prompt")).toBe(marked);
  });

  it("trusts helper output only when task id, cwd, and marker are bound together", () => {
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    expect(
      parseDesktopHelperResult(
        `diagnostic\n${JSON.stringify({ threadId: THREAD_ID, marker, cwd: "/cwd" })}\n`,
        marker,
        "/cwd",
      ),
    ).toBe(THREAD_ID);
    expect(
      parseDesktopHelperResult(
        JSON.stringify({ threadId: "stale", marker: `${marker}bad`, cwd: "/cwd" }),
        marker,
        "/cwd",
      ),
    ).toBeNull();
  });
});

describe("HelperDesktopThreadCreator", () => {
  it("probes the helper's non-mutating Accessibility preflight", async () => {
    const run = vi.fn(async () => ({ stdout: '{"ok":true}\n', stderr: "" }));
    const creator = new HelperDesktopThreadCreator(
      { helperPath: "/bin/wakewire-helper" },
      {
        runner: { run },
        finder: { find: async () => null, probe: async () => true },
        access: async () => undefined,
      },
    );

    await expect(creator.probe()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith("/bin/wakewire-helper", ["probe"], 3_000);
  });

  it("fails closed before opening Desktop when the helper is absent", async () => {
    const run = vi.fn();
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    const creator = new HelperDesktopThreadCreator(
      { helperPath: "/missing/helper" },
      {
        runner: { run },
        finder: { find: async () => null },
        access: async () => {
          throw new Error("ENOENT");
        },
        stat: async () => ({ isDirectory: () => true }),
      },
    );

    await expect(
      creator.create({ prompt: appendDesktopCorrelationMarker("p", marker), cwd: "/cwd", marker }),
    ).rejects.toThrow(/helper is missing or not executable/);
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers a task submitted by a prior attempt without touching the UI", async () => {
    const run = vi.fn();
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    const creator = new HelperDesktopThreadCreator(
      {},
      {
        runner: { run },
        finder: { find: async () => "existing-task" },
        access: async () => {
          throw new Error("helper deliberately absent");
        },
      },
    );

    await expect(
      creator.create({ prompt: appendDesktopCorrelationMarker("p", marker), cwd: "/cwd", marker }),
    ).resolves.toEqual({ threadId: "existing-task" });
    expect(run).not.toHaveBeenCalled();
  });

  it("asks the exact-marker helper to open, submit, and correlate durable state", async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      timeoutMs: number;
      stdin?: string | undefined;
    }> = [];
    const runner: CommandRunner = {
      run: async (executable, args, timeoutMs, stdin) => {
        calls.push({ executable, args, timeoutMs, stdin });
        return { stdout: "helper submitted\n", stderr: "" };
      },
    };
    let finderCalls = 0;
    const finder: DesktopTaskFinder = {
      find: async () => {
        finderCalls++;
        return finderCalls >= 3 ? "desktop-task-123" : null;
      },
    };
    let now = 1_000;
    const marker = desktopCorrelationMarker({ prompt: "do work", cwd: "/cwd" });
    const prompt = appendDesktopCorrelationMarker("do work", marker);
    const creator = new HelperDesktopThreadCreator(
      {
        helperPath: "/bin/wakewire-helper",
        helperTimeoutMs: 200,
        discoveryTimeoutMs: 1_000,
        discoveryPollMs: 25,
      },
      {
        runner,
        finder,
        access: async () => undefined,
        stat: async () => ({ isDirectory: () => true }),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    await expect(creator.create({ prompt, cwd: "/cwd", marker })).resolves.toEqual({
      threadId: "desktop-task-123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      executable: "/bin/wakewire-helper",
      args: ["open-and-submit", "--request-json-stdin"],
      timeoutMs: 3_200,
      stdin: expect.any(String),
    });
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual({
      url: expect.stringContaining("codex://threads/new?"),
      marker,
      cwd: "/cwd",
      stateDatabasePath: expect.any(String),
      notBeforeMilliseconds: 1_000,
      uiTimeoutMilliseconds: 200,
      discoveryTimeoutMilliseconds: 1_000,
    });
    expect(finderCalls).toBe(3);
  });
});

describe("SqliteDesktopTaskFinder", () => {
  it("requires marker, exact cwd, and creation boundary", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      first_user_message TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      rollout_path TEXT
    )`);
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/right" });
    const insert = db.prepare(
      "INSERT INTO threads (id, archived, cwd, created_at, created_at_ms, first_user_message, rollout_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("wrong-cwd", 0, "/wrong", 2, 2_000, marker, "/rollouts/wrong-cwd");
    insert.run("too-old", 0, "/right", 1, 1_000, marker, "/rollouts/too-old");
    insert.run("archived", 1, "/right", 3, 3_000, marker, "/rollouts/archived");
    insert.run("match", 0, "/right", 4, 4_000, `prompt ${marker}`, "/rollouts/match");
    const finder = new SqliteDesktopTaskFinder(
      { stateDatabasePath: "ignored" },
      {
        openDatabase: () => db,
        readFile: async (file) => (file === "/rollouts/match" ? startedRollout(marker) : ""),
      },
    );

    await expect(finder.find({ marker, cwd: "/right", notBeforeMs: 2_000 })).resolves.toBe("match");
  });

  it("rejects an ambiguous marker instead of guessing", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      first_user_message TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      rollout_path TEXT
    )`);
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    const insert = db.prepare(
      "INSERT INTO threads (id, archived, cwd, created_at, created_at_ms, first_user_message, rollout_path) VALUES (?, 0, '/cwd', 1, ?, ?, ?)",
    );
    insert.run("one", 1_000, marker, "/rollouts/one");
    insert.run("two", 1_001, marker, "/rollouts/two");
    const finder = new SqliteDesktopTaskFinder(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => db, readFile: async () => startedRollout(marker) },
    );

    await expect(finder.find({ marker, cwd: "/cwd" })).rejects.toBeInstanceOf(
      DesktopTaskDiscoveryError,
    );
  });

  it("does not treat an early marker-bearing preview as a submitted turn", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      first_user_message TEXT NOT NULL,
      preview TEXT NOT NULL,
      rollout_path TEXT
    )`);
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    db.prepare(
      "INSERT INTO threads (id, archived, cwd, created_at, created_at_ms, first_user_message, preview) VALUES ('early', 0, '/cwd', 1, 1000, '', ?)",
    ).run(`prompt ${marker}`);
    const finder = new SqliteDesktopTaskFinder(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => db },
    );

    await expect(finder.find({ marker, cwd: "/cwd" })).resolves.toBeNull();
  });

  it("requires marker, task_started, and matching turn context in the rollout", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      first_user_message TEXT NOT NULL,
      preview TEXT NOT NULL,
      rollout_path TEXT
    )`);
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    db.prepare(
      "INSERT INTO threads (id, archived, cwd, created_at, created_at_ms, first_user_message, preview, rollout_path) VALUES ('draft', 0, '/cwd', 1, 1000, ?, ?, '/rollouts/draft')",
    ).run(marker, marker);
    const finder = new SqliteDesktopTaskFinder(
      { stateDatabasePath: "ignored" },
      {
        openDatabase: () => db,
        readFile: async () =>
          [
            JSON.stringify({
              type: "event_msg",
              payload: { type: "task_started", turn_id: "turn-1" },
            }),
            JSON.stringify({ type: "turn_context", payload: { turn_id: "different-turn" } }),
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: marker }],
              },
            }),
            "",
          ].join("\n"),
      },
    );

    await expect(finder.find({ marker, cwd: "/cwd" })).resolves.toBeNull();
  });

  it("fails closed when a rollout proof exceeds its bounded read budget", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      first_user_message TEXT NOT NULL,
      preview TEXT NOT NULL,
      rollout_path TEXT
    )`);
    const marker = desktopCorrelationMarker({ prompt: "p", cwd: "/cwd" });
    db.prepare(
      "INSERT INTO threads (id, archived, cwd, created_at, created_at_ms, first_user_message, preview, rollout_path) VALUES ('oversized', 0, '/cwd', 1, 1000, ?, ?, '/rollouts/oversized')",
    ).run(marker, marker);
    const finder = new SqliteDesktopTaskFinder(
      { stateDatabasePath: "ignored" },
      {
        openDatabase: () => db,
        readFile: async () => "x".repeat(4 * 1024 * 1024 + 1),
      },
    );

    await expect(finder.find({ marker, cwd: "/cwd" })).rejects.toThrow(/exceeds 4194304 bytes/);
  });
});

describe("SqliteDesktopThreadTitleReader", () => {
  it("reads the exact persisted title without mutating Desktop state", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    db.prepare("INSERT INTO threads (id, title) VALUES (?, ?)").run(
      "thread-1",
      "Slack — Check the deploy",
    );
    const reader = new SqliteDesktopThreadTitleReader(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => db },
    );

    await expect(reader.read("thread-1")).resolves.toBe("Slack — Check the deploy");

    const missingDb = new DatabaseConstructor(":memory:");
    missingDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    const missingReader = new SqliteDesktopThreadTitleReader(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => missingDb },
    );
    await expect(missingReader.read("missing")).resolves.toBeNull();
  });
});

describe("SqliteDesktopResumeDeliveryGuard", () => {
  it("finds an existing delivery marker in the task's durable rollout", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(
      "task-1",
      "/tmp/task-1.jsonl",
    );
    const marker = desktopCorrelationMarker({
      prompt: "hello",
      cwd: "/cwd",
      idempotencyKey: "delivery-1",
    });
    const readFile = vi.fn(async () => startedRollout(marker));
    const guard = new SqliteDesktopResumeDeliveryGuard(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => db, readFile },
    );

    await expect(
      guard.hasMarker({
        threadId: "task-1",
        marker,
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      }),
    ).resolves.toBe(true);
    expect(readFile).toHaveBeenCalledWith("/tmp/task-1.jsonl");
  });

  it("distinguishes an incomplete profile proof from a realized profile mismatch", async () => {
    const marker = desktopCorrelationMarker({ prompt: "hello", cwd: "/cwd" });
    const pendingRollout = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: marker }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    });
    const pendingDb = resumeGuardDatabase();
    const pendingGuard = new SqliteDesktopResumeDeliveryGuard(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => pendingDb, readFile: async () => `${pendingRollout}\n` },
    );

    await expect(
      pendingGuard.hasMarker({ threadId: "task-1", marker, reasoningEffort: "ultra" }),
    ).rejects.toBeInstanceOf(DesktopResumeProfilePendingError);

    const mismatchDb = resumeGuardDatabase();
    const mismatchGuard = new SqliteDesktopResumeDeliveryGuard(
      { stateDatabasePath: "ignored" },
      {
        openDatabase: () => mismatchDb,
        readFile: async () =>
          startedRollout(marker).replace('"reasoning_effort":"ultra"', '"reasoning_effort":"low"'),
      },
    );
    await expect(
      mismatchGuard.hasMarker({ threadId: "task-1", marker, reasoningEffort: "ultra" }),
    ).rejects.toBeInstanceOf(DesktopExecutionProfileMismatchError);
  });

  it("fails closed when task state is missing or its rollout cannot be read", async () => {
    const missingDb = new DatabaseConstructor(":memory:");
    missingDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    const marker = desktopCorrelationMarker({ prompt: "hello", cwd: "/cwd" });
    const missing = new SqliteDesktopResumeDeliveryGuard(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => missingDb },
    );
    await expect(missing.hasMarker({ threadId: "unknown", marker })).rejects.toBeInstanceOf(
      DesktopResumeStateError,
    );

    const invalidDb = new DatabaseConstructor(":memory:");
    invalidDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    invalidDb
      .prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("task-2", "/tmp/missing.jsonl");
    const invalid = new SqliteDesktopResumeDeliveryGuard(
      { stateDatabasePath: "ignored" },
      {
        openDatabase: () => invalidDb,
        readFile: async () => {
          throw new Error("invalid rollout");
        },
      },
    );
    await expect(invalid.hasMarker({ threadId: "task-2", marker })).rejects.toBeInstanceOf(
      DesktopResumeStateError,
    );
  });

  it("treats a known prepared task without a rollout as safe for its first send", async () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, NULL)").run("prepared-task");
    const guard = new SqliteDesktopResumeDeliveryGuard(
      { stateDatabasePath: "ignored" },
      { openDatabase: () => db },
    );
    const marker = desktopCorrelationMarker({ prompt: "hello", cwd: "/cwd" });

    await expect(guard.hasMarker({ threadId: "prepared-task", marker })).resolves.toBe(false);
  });
});

describe("CodexDesktopAdapter", () => {
  it("uses the Desktop helper for a new task without coupling UI creation to private IPC", async () => {
    const inspectEnvironment = vi.fn(async () => {
      throw new Error("unsupported build or missing socket");
    });
    const prepareThread = vi.fn(async (_options: PrepareThreadOptions) => ({
      threadId: "unowned-app-server-task",
    }));
    const startTurn = vi.fn(async () => ({ requestId: "unused", result: {} }));
    const create = vi.fn(async () => ({ threadId: "ui-task" }));
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: { inspectEnvironment, probe: async () => true, startTurn },
        creator: { create },
        threadMetadata: { setThreadTitle: async () => undefined, prepareThread },
      },
    );

    await expect(
      adapter.startThread("Investigate this", {
        sandbox: "workspace-write",
        cwd: "/Users/chip/Snap/ENG-1",
        idempotencyKey: "provider-delivery-1",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      }),
    ).resolves.toEqual({
      threadId: "ui-task",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });

    const marker = desktopCorrelationMarker({
      prompt: "Investigate this",
      cwd: "/Users/chip/Snap/ENG-1",
      idempotencyKey: "provider-delivery-1",
    });
    expect(inspectEnvironment).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      cwd: "/Users/chip/Snap/ENG-1",
      marker,
      prompt: appendDesktopCorrelationMarker("Investigate this", marker),
    });
    expect(prepareThread).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("requires the Desktop helper probe even when app-server preparation is available", async () => {
    const creatorProbe = vi.fn(async () => false);
    const prepareThread = vi.fn(async () => ({ threadId: "unowned-app-server-task" }));
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => true,
          startTurn: async () => ({ requestId: "unused", result: {} }),
        },
        creator: { create: async () => ({ threadId: "unused" }), probe: creatorProbe },
        threadMetadata: { setThreadTitle: async () => undefined, prepareThread },
      },
    );
    await expect(adapter.probe()).resolves.toBe(false);
    expect(creatorProbe).toHaveBeenCalledOnce();
    expect(prepareThread).not.toHaveBeenCalled();
  });

  it("delegates cosmetic titles to Codex's persisted metadata seam", async () => {
    const setThreadTitle = vi.fn(async () => undefined);
    const readSqliteTitle = vi.fn(async () => "stale auto-title");
    const close = vi.fn();
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => true,
          startTurn: async () => ({ requestId: "unused", result: {} }),
        },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: { hasMarker: async () => false },
        threadMetadata: { setThreadTitle, close },
        threadTitleReader: { read: readSqliteTitle },
      },
    );

    await adapter.setThreadTitle("task-1", "CJ — Check this");
    await expect(adapter.readThreadTitle("task-1")).resolves.toBe("stale auto-title");
    adapter.close();

    expect(setThreadTitle).toHaveBeenCalledWith("task-1", "CJ — Check this");
    expect(readSqliteTitle).toHaveBeenCalledWith("task-1");
    expect(close).toHaveBeenCalledOnce();
  });

  it("serializes title metadata changes with every other Desktop UI operation", async () => {
    const calls: string[] = [];
    let releaseFirst = (): void => {};
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => true,
          startTurn: async () => ({ requestId: "unused", result: {} }),
        },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: { hasMarker: async () => false },
        threadMetadata: {
          setThreadTitle: async (threadId) => {
            calls.push(threadId);
            if (threadId === "task-1") await firstPending;
          },
        },
      },
    );

    const first = adapter.setThreadTitle("task-1", "Slack — one");
    const second = adapter.setThreadTitle("task-2", "Slack — two");
    await vi.waitFor(() => expect(calls).toEqual(["task-1"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(["task-1", "task-2"]);
  });

  it("interrupts an active Desktop turn through the version-gated IPC route", async () => {
    const interruptTurn = vi.fn(async () => ({
      requestId: "stop-request",
      interruptedTurnId: "turn-1",
      result: { ok: true },
    }));
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => true,
          startTurn: async () => ({ requestId: "unused", result: {} }),
          interruptTurn,
        },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: { hasMarker: async () => false },
      },
    );

    await expect(adapter.interruptThread("task-1")).resolves.toEqual({
      threadId: "task-1",
      interruptedTurnId: "turn-1",
    });
    expect(interruptTurn).toHaveBeenCalledWith("task-1");
  });

  it("marks and sends a first delivery to an existing Desktop task", async () => {
    const startTurn = vi.fn(async () => ({ requestId: "r", turnId: "turn-1", result: {} }));
    const hasMarker = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: { inspectEnvironment: async () => ({}), probe: async () => true, startTurn },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: { hasMarker },
      },
    );

    const opts = {
      sandbox: "workspace-write",
      idempotencyKey: "delivery-existing-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    } as DeliveryOptions;
    await expect(adapter.deliverToThread("task-1", "hello", opts)).resolves.toEqual({
      threadId: "task-1",
      turnId: "turn-1",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });
    const marker = desktopCorrelationMarker({
      prompt: "hello",
      cwd: process.cwd(),
      idempotencyKey: "delivery-existing-1",
    });
    expect(hasMarker).toHaveBeenNthCalledWith(1, {
      threadId: "task-1",
      marker,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    expect(hasMarker).toHaveBeenNthCalledWith(2, {
      threadId: "task-1",
      marker,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    expect(startTurn).toHaveBeenCalledWith({
      conversationId: "task-1",
      prompt: appendDesktopCorrelationMarker("hello", marker),
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
  });

  it("recovers an already persisted delivery without resending it over IPC", async () => {
    const startTurn = vi.fn(async () => ({ requestId: "unused", result: {} }));
    const hasMarker = vi.fn(async () => true);
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: { inspectEnvironment: async () => ({}), probe: async () => true, startTurn },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: { hasMarker },
      },
    );

    await expect(
      adapter.deliverToThread("task-recovered", "hello", {
        sandbox: "read-only",
        idempotencyKey: "delivery-recovered",
      } as DeliveryOptions),
    ).resolves.toEqual({
      threadId: "task-recovered",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });
    expect(hasMarker).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("fails closed without IPC when durable Desktop state cannot be inspected", async () => {
    const startTurn = vi.fn(async () => ({ requestId: "unused", result: {} }));
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: { inspectEnvironment: async () => ({}), probe: async () => true, startTurn },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: {
          hasMarker: async () => {
            throw new DesktopResumeStateError("state unavailable");
          },
        },
      },
    );

    await expect(
      adapter.deliverToThread("task-uncertain", "hello", { sandbox: "read-only" }),
    ).rejects.toBeInstanceOf(UnreachableError);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("permanently fails a recovered turn whose realized profile does not match", async () => {
    const startTurn = vi.fn(async () => ({ requestId: "unused", result: {} }));
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: { inspectEnvironment: async () => ({}), probe: async () => true, startTurn },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: {
          hasMarker: async () => {
            throw new DesktopExecutionProfileMismatchError("expected ultra, recorded low");
          },
        },
      },
    );

    await expect(
      adapter.deliverToThread("task-mismatch", "hello", {
        sandbox: "read-only",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy missing-owner error", "no request handler owns conversation"],
    ["Desktop 26.721.81911 missing-owner error", "no-client-found"],
  ])("opens an unowned task and retries IPC once for %s", async (_label, remoteMessage) => {
    const startTurn = vi
      .fn()
      .mockRejectedValueOnce(new CodexDesktopRemoteError(remoteMessage, { code: remoteMessage }))
      .mockResolvedValueOnce({ requestId: "r2", result: {} });
    const activate = vi.fn(async () => undefined);
    const adapter = new CodexDesktopAdapter(
      logger(),
      { activationDelayMs: 1 },
      {
        ipc: { inspectEnvironment: async () => ({}), probe: async () => true, startTurn },
        creator: { create: async () => ({ threadId: "unused" }) },
        activator: { activate },
        resumeDeliveryGuard: {
          hasMarker: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        },
        sleep: async () => undefined,
      },
    );

    const options: DeliveryOptions = {
      sandbox: "read-only",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    };
    await expect(adapter.deliverToThread("task-2", "hello", options)).resolves.toEqual({
      threadId: "task-2",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });
    expect(activate).toHaveBeenCalledWith("task-2");
    expect(startTurn).toHaveBeenCalledTimes(2);
    const marker = desktopCorrelationMarker({ prompt: "hello", cwd: process.cwd() });
    expect(startTurn).toHaveBeenNthCalledWith(1, {
      conversationId: "task-2",
      prompt: appendDesktopCorrelationMarker("hello", marker),
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    });
    expect(startTurn).toHaveBeenNthCalledWith(2, {
      conversationId: "task-2",
      prompt: appendDesktopCorrelationMarker("hello", marker),
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    });
  });

  it("does not retry the unverified literal missing-owner response", async () => {
    const startTurn = vi.fn(async () => {
      throw new CodexDesktopRemoteError("missing-owner", { code: "missing-owner" });
    });
    const activate = vi.fn(async () => undefined);
    const adapter = new CodexDesktopAdapter(
      logger(),
      { activationDelayMs: 1 },
      {
        ipc: { inspectEnvironment: async () => ({}), probe: async () => true, startTurn },
        creator: { create: async () => ({ threadId: "unused" }) },
        activator: { activate },
        resumeDeliveryGuard: { hasMarker: async () => false },
        sleep: async () => undefined,
      },
    );

    await expect(
      adapter.deliverToThread("task-2", "hello", { sandbox: "read-only" }),
    ).rejects.toBeInstanceOf(UnreachableError);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
  });

  it("passes a delivery-stable marker to the injectable new-task creator", async () => {
    const create = vi.fn(async (_input: DesktopThreadCreateInput) => ({ threadId: "new-task" }));
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => true,
          startTurn: async () => ({ requestId: "unused", result: {} }),
        },
        creator: { create },
        threadMetadata: { setThreadTitle: async () => undefined },
      },
    );
    const opts = {
      sandbox: "workspace-write",
      cwd: "/Users/chip/Snap/ENG-1",
      idempotencyKey: "delivery-abc",
    } as DeliveryOptions;

    await expect(adapter.startThread("do it", opts)).resolves.toEqual({
      threadId: "new-task",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });
    const input = create.mock.calls[0]?.[0];
    const expectedMarker = desktopCorrelationMarker({
      prompt: "do it",
      cwd: "/Users/chip/Snap/ENG-1",
      idempotencyKey: "delivery-abc",
    });
    expect(input).toEqual({
      cwd: "/Users/chip/Snap/ENG-1",
      marker: expectedMarker,
      prompt: appendDesktopCorrelationMarker("do it", expectedMarker),
    });
  });

  it("serializes new-task UI operations across concurrent source deliveries", async () => {
    let releaseFirst: (() => void) | undefined;
    let invocation = 0;
    const create = vi.fn(async () => {
      invocation++;
      if (invocation === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { threadId: `new-task-${invocation}` };
    });
    const adapter = new CodexDesktopAdapter(
      logger(),
      {},
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => true,
          startTurn: async () => ({ requestId: "unused", result: {} }),
        },
        creator: { create },
      },
    );

    const first = adapter.startThread("first", { sandbox: "read-only", cwd: "/tmp" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = adapter.startThread("second", { sandbox: "read-only", cwd: "/tmp" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(create).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await expect(first).resolves.toEqual({
      threadId: "new-task-1",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });
    await expect(second).resolves.toEqual({
      threadId: "new-task-2",
      correlationMarker: expect.stringMatching(/^wakewire:event:v1:[a-f0-9]{64}$/),
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("maps unavailable private IPC to the queue's retry-forever error", async () => {
    const adapter = new CodexDesktopAdapter(
      logger(),
      { activateUnownedThreads: false },
      {
        ipc: {
          inspectEnvironment: async () => ({}),
          probe: async () => false,
          startTurn: async () => {
            throw new CodexDesktopRemoteError("Desktop router unavailable", {});
          },
        },
        creator: { create: async () => ({ threadId: "unused" }) },
        resumeDeliveryGuard: { hasMarker: async () => false },
      },
    );

    await expect(
      adapter.deliverToThread("task", "prompt", { sandbox: "read-only" }),
    ).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe("OpenUrlDesktopThreadActivator", () => {
  it("loads the exact prepared task in Desktop without bringing it to the foreground", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const activator = new OpenUrlDesktopThreadActivator("/usr/bin/open", { run });

    await activator.activate("task/id");

    expect(run).toHaveBeenCalledWith("/usr/bin/open", ["-g", "codex://threads/task%2Fid"], 5_000);
  });
});

function logger(): Logger {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}
