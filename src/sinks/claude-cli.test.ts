import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCliAdapter,
  type ClaudeCliChildProcess,
  type ClaudeCliCommand,
  type ClaudeCliCommandResult,
  type ClaudeCliRunner,
  type ClaudeCliSpawn,
  type ClaudeThreadCwdStore,
  parseClaudeCliResult,
  SpawnClaudeCliRunner,
} from "./claude-cli.js";
import { DeliveryNotSubmittedError, PermanentError, UnreachableError } from "./types.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const FULL_CAPABILITY_ARGS = [
  "-p",
  "--output-format",
  "json",
  "--permission-mode",
  "bypassPermissions",
] as const;

function resultJson(sessionId = SESSION_ID, result = "Claude finished"): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result,
  });
}

class RecordingRunner implements ClaudeCliRunner {
  readonly calls: ClaudeCliCommand[] = [];
  readonly outputs: ClaudeCliCommandResult[] = [];
  error: Error | null = null;

  async run(command: ClaudeCliCommand): Promise<ClaudeCliCommandResult> {
    this.calls.push({ ...command, args: [...command.args] });
    if (this.error) throw this.error;
    const output = this.outputs.shift();
    if (!output) throw new Error("test runner has no queued output");
    return output;
  }
}

class MemoryCwdStore implements ClaudeThreadCwdStore {
  readonly values = new Map<string, string>();

  get(threadId: string): string | undefined {
    return this.values.get(threadId);
  }

  set(threadId: string, cwd: string): void {
    this.values.set(threadId, cwd);
  }
}

class FakeChild extends EventEmitter implements ClaudeCliChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

describe("ClaudeCliAdapter", () => {
  it("starts a UUID-bound JSON session with the prompt only on stdin", async () => {
    const runner = new RecordingRunner();
    runner.outputs.push({ stdout: resultJson(), stderr: "" });
    const cwdStore = new MemoryCwdStore();
    const adapter = new ClaudeCliAdapter(
      pino({ level: "silent" }),
      { claudePath: "/opt/bin/claude", turnTimeoutMs: 1234 },
      { runner, randomUuid: () => SESSION_ID, cwdStore },
    );
    const prompt = "provider text with spaces; $(touch /tmp/never)";

    await expect(
      adapter.startThread(prompt, { sandbox: "read-only", cwd: "/tmp" }),
    ).resolves.toEqual({ threadId: SESSION_ID, finalResponse: "Claude finished" });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/bin/claude",
      args: [...FULL_CAPABILITY_ARGS, "--session-id", SESSION_ID],
      cwd: "/tmp",
      stdin: prompt,
      timeoutMs: 1234,
    });
    expect(runner.calls[0]?.args).not.toContain(prompt);
    expect(runner.calls[0]?.args).not.toContain("--continue");
    expect(runner.calls[0]?.args).not.toContain("--dangerously-skip-permissions");
    expect(runner.calls[0]?.args).not.toContain("--safe-mode");
    expect(runner.calls[0]?.args).not.toContain("--strict-mcp-config");
    expect(runner.calls[0]?.args).not.toContain("--tools");
    expect(runner.calls[0]?.args).not.toContain("--allowedTools");
    expect(runner.calls[0]?.args).not.toContain("--disable-slash-commands");
    expect(runner.calls[0]?.args).not.toContain("--no-chrome");
    expect(cwdStore.values.get(SESSION_ID)).toBe("/tmp");
  });

  it("uses a valid idempotency key as the exact session id instead of generating one", async () => {
    const runner = new RecordingRunner();
    runner.outputs.push({ stdout: resultJson(), stderr: "" });
    const randomUuid = vi.fn(() => "c56a4180-65aa-42ec-a945-5fd21dec0538");
    const adapter = new ClaudeCliAdapter(pino({ level: "silent" }), {}, { runner, randomUuid });

    await expect(
      adapter.startThread("deterministic", {
        sandbox: "read-only",
        cwd: "/tmp",
        idempotencyKey: SESSION_ID,
      }),
    ).resolves.toEqual({ threadId: SESSION_ID, finalResponse: "Claude finished" });

    expect(randomUuid).not.toHaveBeenCalled();
    expect(runner.calls[0]?.args).toEqual([...FULL_CAPABILITY_ARGS, "--session-id", SESSION_ID]);
  });

  it("rejects an invalid provided idempotency key before invoking the runner", async () => {
    const runner = new RecordingRunner();
    const randomUuid = vi.fn(() => SESSION_ID);
    const adapter = new ClaudeCliAdapter(pino({ level: "silent" }), {}, { runner, randomUuid });

    await expect(
      adapter.startThread("must not run", {
        sandbox: "read-only",
        cwd: "/tmp",
        idempotencyKey: "slack:not-a-uuid",
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(randomUuid).not.toHaveBeenCalled();
    expect(runner.calls).toHaveLength(0);
  });

  it("resumes the exact session in its pinned cwd without putting the prompt in argv", async () => {
    const runner = new RecordingRunner();
    runner.outputs.push({ stdout: resultJson(SESSION_ID, "Follow-up done"), stderr: "" });
    const cwdStore = new MemoryCwdStore();
    cwdStore.values.set(SESSION_ID, "/tmp");
    const adapter = new ClaudeCliAdapter(pino({ level: "silent" }), {}, { runner, cwdStore });

    await expect(
      adapter.deliverToThread(SESSION_ID, "second turn", { sandbox: "read-only" }),
    ).resolves.toEqual({ threadId: SESSION_ID, finalResponse: "Follow-up done" });

    expect(runner.calls[0]).toMatchObject({
      args: [...FULL_CAPABILITY_ARGS, "--resume", SESSION_ID],
      cwd: "/tmp",
      stdin: "second turn",
    });
    expect(runner.calls[0]?.args).not.toContain("second turn");
    expect(runner.calls[0]?.args).not.toContain("--continue");
  });

  it("rehydrates a fixed cwd from delivery options after an adapter restart", async () => {
    const runner = new RecordingRunner();
    runner.outputs.push({ stdout: resultJson(), stderr: "" });
    const cwdStore = new MemoryCwdStore();
    const adapter = new ClaudeCliAdapter(pino({ level: "silent" }), {}, { runner, cwdStore });

    await adapter.deliverToThread(SESSION_ID, "resume", {
      sandbox: "read-only",
      cwd: "/tmp",
    });

    expect(runner.calls[0]?.cwd).toBe("/tmp");
    expect(cwdStore.values.get(SESSION_ID)).toBe("/tmp");
  });

  it("fails closed when a resumed session is directed at a different cwd", async () => {
    const runner = new RecordingRunner();
    const cwdStore = new MemoryCwdStore();
    cwdStore.values.set(SESSION_ID, "/tmp");
    const adapter = new ClaudeCliAdapter(pino({ level: "silent" }), {}, { runner, cwdStore });

    await expect(
      adapter.deliverToThread(SESSION_ID, "do not run", {
        sandbox: "read-only",
        cwd: "/",
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(runner.calls).toHaveLength(0);
  });

  it("passes cancellation to the runner", async () => {
    const reason = new Error("authenticated stop");
    const runner: ClaudeCliRunner = {
      run: vi.fn(
        (command: ClaudeCliCommand) =>
          new Promise<ClaudeCliCommandResult>((_resolve, reject) => {
            command.signal?.addEventListener("abort", () => reject(command.signal?.reason), {
              once: true,
            });
          }),
      ),
    };
    const adapter = new ClaudeCliAdapter(
      pino({ level: "silent" }),
      {},
      { runner, randomUuid: () => SESSION_ID },
    );
    const controller = new AbortController();

    const delivery = adapter.startThread("long turn", {
      sandbox: "read-only",
      cwd: "/tmp",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(delivery).rejects.toBe(reason);
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal, stdin: "long turn" }),
    );
  });

  it("classifies cancellation observed before runner invocation as not submitted", async () => {
    const runner = new RecordingRunner();
    const adapter = new ClaudeCliAdapter(
      pino({ level: "silent" }),
      {},
      { runner, randomUuid: () => SESSION_ID },
    );
    const controller = new AbortController();
    controller.abort(new Error("stop before start"));

    await expect(
      adapter.startThread("never sent", {
        sandbox: "read-only",
        cwd: "/tmp",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
    expect(runner.calls).toHaveLength(0);
  });

  it("uses a bounded version command for its reachability probe", async () => {
    const runner = new RecordingRunner();
    runner.outputs.push({ stdout: "2.1.220 (Claude Code)\n", stderr: "" });
    const adapter = new ClaudeCliAdapter(
      pino({ level: "silent" }),
      { claudePath: "/opt/bin/claude", probeTimeoutMs: 4321 },
      { runner },
    );

    await expect(adapter.probe()).resolves.toBe(true);
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/bin/claude",
      args: ["--version"],
      stdin: "",
      timeoutMs: 4321,
    });
  });

  it("keeps the full ambient Claude environment available for the owner proxy", async () => {
    const runner = new RecordingRunner();
    runner.outputs.push({ stdout: resultJson(), stderr: "" });
    const adapter = new ClaudeCliAdapter(
      pino({ level: "silent" }),
      {},
      { runner, randomUuid: () => SESSION_ID },
    );

    await adapter.startThread("make a reversible edit", {
      sandbox: "workspace-write",
      cwd: "/tmp",
    });

    expect(runner.calls[0]?.args).toEqual([...FULL_CAPABILITY_ARGS, "--session-id", SESSION_ID]);
    expect(runner.calls[0]?.args).not.toContain("--tools");
    expect(runner.calls[0]?.args).not.toContain("--allowedTools");
    expect(runner.calls[0]?.args).not.toContain("--safe-mode");
    expect(runner.calls[0]?.args).not.toContain("--strict-mcp-config");
    expect(runner.calls[0]?.args).not.toContain("--disable-slash-commands");
    expect(runner.calls[0]?.args).not.toContain("--dangerously-skip-permissions");
    expect(runner.calls[0]?.args).not.toContain("--no-chrome");
  });

  it("rejects unsupported sandbox input before invoking the runner", async () => {
    const runner = new RecordingRunner();
    const adapter = new ClaudeCliAdapter(pino({ level: "silent" }), {}, { runner });

    await expect(
      adapter.startThread("must not run", {
        sandbox: "danger-full-access" as never,
        cwd: "/tmp",
      }),
    ).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a missing cwd as definitely not submitted", async () => {
    const runner = new RecordingRunner();
    const adapter = new ClaudeCliAdapter(
      pino({ level: "silent" }),
      {},
      { runner, randomUuid: () => SESSION_ID },
    );

    await expect(
      adapter.startThread("must not run", {
        sandbox: "read-only",
        cwd: `/tmp/wakewire-missing-${SESSION_ID}`,
      }),
    ).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("parseClaudeCliResult", () => {
  it("accepts only a successful result for the expected session", () => {
    expect(parseClaudeCliResult(resultJson(), SESSION_ID)).toEqual({
      threadId: SESSION_ID,
      finalResponse: "Claude finished",
    });
  });

  it.each([
    ["non-JSON", "diagnostic before JSON\n{}"],
    ["wrong session", resultJson("c56a4180-65aa-42ec-a945-5fd21dec0538", "wrong session")],
    [
      "error result",
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: SESSION_ID,
        result: "failed",
      }),
    ],
    [
      "missing final response",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: SESSION_ID,
      }),
    ],
    [
      "blank final response",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: SESSION_ID,
        result: " \n\t ",
      }),
    ],
  ])("rejects %s output", (_label, stdout) => {
    expect(() => parseClaudeCliResult(stdout, SESSION_ID)).toThrow(UnreachableError);
  });
});

describe("SpawnClaudeCliRunner", () => {
  function fixture() {
    const child = new FakeChild();
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: Parameters<ClaudeCliSpawn>[2];
    }> = [];
    const spawnProcess: ClaudeCliSpawn = (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      return child;
    };
    return { child, calls, runner: new SpawnClaudeCliRunner(spawnProcess) };
  }

  function command(overrides: Partial<ClaudeCliCommand> = {}): ClaudeCliCommand {
    return {
      executable: "/opt/bin/claude",
      args: ["-p", "--output-format", "json", "--session-id", SESSION_ID],
      cwd: "/tmp/project",
      stdin: "private prompt",
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      terminationGraceMs: 100,
      ...overrides,
    };
  }

  it("spawns without a shell and waits for child exit after abort", async () => {
    const { child, calls, runner } = fixture();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    let stdin = "";
    child.stdin.on("data", (chunk) => {
      stdin += chunk.toString();
    });

    const running = runner.run(command({ signal: controller.signal }));
    controller.abort(reason);

    let rejected = false;
    void running.catch(() => {
      rejected = true;
    });
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(calls).toEqual([
      {
        executable: "/opt/bin/claude",
        args: ["-p", "--output-format", "json", "--session-id", SESSION_ID],
        options: { cwd: "/tmp/project", shell: false, stdio: ["pipe", "pipe", "pipe"] },
      },
    ]);
    expect(stdin).toBe("private prompt");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(running).rejects.toBe(reason);
  });

  it("terminates when stdout exceeds its byte bound", async () => {
    const { child, runner } = fixture();
    const running = runner.run(command({ maxStdoutBytes: 4 }));

    child.stdout.write("12345");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(running).rejects.toThrow("stdout exceeded 4 bytes");
  });

  it("terminates a timed-out process", async () => {
    const { child, runner } = fixture();
    vi.useFakeTimers();

    const running = runner.run(command({ timeoutMs: 5 }));

    await vi.advanceTimersByTimeAsync(5);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(running).rejects.toThrow("timed out after 5ms");
    vi.useRealTimers();
  });

  it("escalates from SIGTERM to SIGKILL after a bounded grace period", async () => {
    const { child, runner } = fixture();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    vi.useFakeTimers();

    const running = runner.run(command({ signal: controller.signal, terminationGraceMs: 25 }));
    controller.abort(reason);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(24);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    child.emit("close", null, "SIGKILL");
    await expect(running).rejects.toBe(reason);
    vi.useRealTimers();
  });

  it("classifies synchronous spawn failures as definitely not submitted", async () => {
    const runner = new SpawnClaudeCliRunner(() => {
      throw new Error("spawn exploded");
    });

    await expect(runner.run(command())).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
  });

  it("classifies the child-process error emitted before spawn as definitely not submitted", async () => {
    const { child, runner } = fixture();
    const running = runner.run(command());

    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

    await expect(running).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
  });

  it("keeps an error after the spawn event in the ambiguous failure class", async () => {
    const { child, runner } = fixture();
    const running = runner.run(command());
    const error = new Error("child IPC failed");

    child.emit("spawn");
    child.emit("error", error);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(running).rejects.toBe(error);
  });
});
