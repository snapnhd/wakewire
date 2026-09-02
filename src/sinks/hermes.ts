import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { BusyError, PermanentError, UnreachableError } from "./types.js";

export interface HermesAdapterConfig {
  /** Absolute path to scripts/hermes_sink_runner.py */
  runnerPath?: string | undefined;
  hermesBin?: string | undefined;
  hermesPython?: string | undefined;
  defaultTimeoutSeconds?: number | undefined;
  profile?: string | undefined;
}

const DEFAULT_RUNNER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/hermes_sink_runner.py",
);

interface RunnerOk {
  ok: true;
  sessionId: string;
  finalResponse: string;
  endedReason?: string;
  title?: string;
}

interface RunnerErr {
  ok: false;
  errorClass: "busy" | "unreachable" | "permanent" | string;
  message: string;
}

type RunnerResult = RunnerOk | RunnerErr;

/**
 * Path D sink: run Hermes in a stamped gateway-like session and return the
 * final assistant text for WakeWire's source reply outbox.
 */
export class HermesAgentAdapter implements AgentAdapter {
  readonly name = "hermes";

  constructor(
    private readonly logger: Logger,
    private readonly config: HermesAdapterConfig = {},
  ) {}

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const stamp = requireHermesStamp(opts);
    const result = await this.invoke(
      {
        action: "start",
        prompt,
        ...stampToRunnerBody(stamp),
        cwd: opts.cwd,
        timeoutSeconds: this.config.defaultTimeoutSeconds ?? 1500,
        hermesBin: this.config.hermesBin,
        profile: this.config.profile,
        sessionId: null,
      },
      opts.signal,
    );
    return { threadId: result.sessionId, finalResponse: result.finalResponse };
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const stamp = requireHermesStamp(opts);
    const result = await this.invoke(
      {
        action: "resume",
        prompt,
        ...stampToRunnerBody(stamp),
        cwd: opts.cwd,
        timeoutSeconds: this.config.defaultTimeoutSeconds ?? 1500,
        hermesBin: this.config.hermesBin,
        profile: this.config.profile,
        sessionId: threadId,
      },
      opts.signal,
    );
    return { threadId: result.sessionId || threadId, finalResponse: result.finalResponse };
  }

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    // Title-only: never fabricate platform/userId peer stamps (that would
    // stomp github/linear identity written on start/resume).
    const parsed = await this.invokeRaw(
      {
        action: "set_title",
        sessionId: threadId,
        sessionTitle: title,
      },
      20_000,
    );
    if (!parsed.ok) {
      throw new PermanentError(parsed.message || "hermes set_title failed");
    }
  }

  async readThreadTitle(threadId: string): Promise<string | null> {
    const parsed = await this.invokeRaw(
      {
        action: "read_title",
        sessionId: threadId,
      },
      15_000,
    );
    if (!parsed.ok) {
      throw new PermanentError(parsed.message || "hermes read_title failed");
    }
    const title = (parsed.title ?? parsed.finalResponse ?? "").trim();
    return title || null;
  }

  async probe(): Promise<boolean> {
    try {
      await this.invokeRaw({ action: "probe", hermesBin: this.config.hermesBin }, 20_000);
      return true;
    } catch {
      return false;
    }
  }

  private async invoke(body: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerOk> {
    const timeoutMs = Math.max(
      5_000,
      (Number(body.timeoutSeconds) || this.config.defaultTimeoutSeconds || 1500) * 1000 + 5_000,
    );
    const parsed = await this.invokeRaw(body, timeoutMs, signal);
    if (!parsed.ok) {
      const message = parsed.message || "hermes runner failed";
      if (parsed.errorClass === "busy") throw new BusyError(message);
      if (parsed.errorClass === "unreachable") throw new UnreachableError(message);
      throw new PermanentError(message);
    }
    if (!parsed.finalResponse?.trim()) {
      throw new PermanentError("hermes runner returned empty finalResponse");
    }
    return parsed;
  }

  private invokeRaw(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RunnerResult> {
    signal?.throwIfAborted();
    const runner = this.config.runnerPath ?? DEFAULT_RUNNER;
    const python =
      this.config.hermesPython ??
      process.env.HERMES_PYTHON ??
      path.join(process.env.HOME ?? "", ".hermes/hermes-agent/venv/bin/python");
    const bin = fs.existsSync(python) ? python : "python3";

    return new Promise((resolve, reject) => {
      const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
      const runnerArgs = sessionKey ? [runner, "--wakewire-session-key", sessionKey] : [runner];
      const child = spawn(bin, runnerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let abortReason: unknown;
      const onAbort = (): void => {
        abortReason = signal?.reason ?? new Error("hermes runner aborted");
        child.kill("SIGTERM");
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new UnreachableError(`hermes runner timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new UnreachableError(`hermes runner spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (abortReason) {
          reject(abortReason);
          return;
        }
        const line = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1);
        if (!line) {
          reject(
            new UnreachableError(
              `hermes runner exit ${code}: ${stderr.slice(-800) || "no output"}`,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(line) as RunnerResult;
          if (code === 3 || (!parsed.ok && parsed.errorClass === "busy")) {
            resolve(
              parsed.ok ? parsed : { ok: false, errorClass: "busy", message: parsed.message },
            );
            return;
          }
          if (code === 2 || code === 124) {
            resolve(
              parsed.ok
                ? parsed
                : {
                    ok: false,
                    errorClass: "unreachable",
                    message: parsed.message || `exit ${code}`,
                  },
            );
            return;
          }
          resolve(parsed);
        } catch (err) {
          this.logger.debug(
            { stdout: stdout.slice(-1000), stderr: stderr.slice(-1000) },
            "hermes runner parse failed",
          );
          reject(
            new PermanentError(`hermes runner returned non-JSON (exit ${code}): ${String(err)}`),
          );
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdin.end(JSON.stringify(body));
    });
  }
}

function requireHermesStamp(opts: DeliveryOptions): {
  platform: "github" | "linear";
  userId: string;
  userName?: string | undefined;
  chatId?: string | undefined;
  sessionTitle?: string | undefined;
  sessionKey?: string | undefined;
  displayName?: string | undefined;
} {
  const stamp = opts.hermesSession;
  if (!stamp?.platform || !stamp.userId) {
    throw new PermanentError(
      "HermesAgentAdapter requires DeliveryOptions.hermesSession { platform, userId }",
    );
  }
  if (stamp.platform !== "github" && stamp.platform !== "linear") {
    throw new PermanentError(`unsupported hermes platform ${stamp.platform}`);
  }
  return stamp;
}

function stampToRunnerBody(stamp: {
  platform: "github" | "linear";
  userId: string;
  userName?: string | undefined;
  chatId?: string | undefined;
  sessionTitle?: string | undefined;
  sessionKey?: string | undefined;
  displayName?: string | undefined;
}): Record<string, unknown> {
  return {
    platform: stamp.platform,
    userId: stamp.userId,
    userName: stamp.userName,
    chatId: stamp.chatId,
    sessionTitle: stamp.sessionTitle,
    sessionKey: stamp.sessionKey,
    displayName: stamp.displayName ?? stamp.userName ?? stamp.userId,
  };
}
