import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging.js";
import { HermesAgentAdapter } from "./hermes.js";
import { PermanentError } from "./types.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
} as unknown as Logger;

describe("HermesAgentAdapter", () => {
  it("requires hermesSession stamp", async () => {
    const adapter = new HermesAgentAdapter(logger, {
      runnerPath: "/nonexistent/runner.py",
    });
    await expect(adapter.startThread("hi", { sandbox: "workspace-write" })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it("maps busy exit from a fake runner", async () => {
    const { writeFileSync, chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hermes-adapter-"));
    const runner = join(dir, "runner.py");
    writeFileSync(
      runner,
      `#!/usr/bin/env python3
import json,sys
print(json.dumps({"ok": False, "errorClass": "busy", "message": "in flight"}))
sys.exit(3)
`,
    );
    chmodSync(runner, 0o755);
    const adapter = new HermesAgentAdapter(logger, {
      runnerPath: runner,
      hermesPython: "python3",
    });
    await expect(
      adapter.startThread("hi", {
        sandbox: "workspace-write",
        hermesSession: { platform: "github", userId: "alice" },
      }),
    ).rejects.toBeInstanceOf((await import("./types.js")).BusyError);
  });

  it("returns finalResponse from a successful fake runner", async () => {
    const { writeFileSync, chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hermes-adapter-ok-"));
    const runner = join(dir, "runner.py");
    writeFileSync(
      runner,
      `#!/usr/bin/env python3
import json,sys
assert sys.argv[1:]==["--wakewire-session-key","wakewire:linear:FRA-2818"]
req=json.load(sys.stdin)
assert req["platform"]=="linear"
assert req["userId"]=="cj@snapcorp.com"
assert req["sessionTitle"]=="FRA-2818 · polish"
assert req["sessionKey"]=="wakewire:linear:FRA-2818"
assert req["chatId"]=="wakewire:linear:FRA-2818"
print(json.dumps({"ok": True, "sessionId": "sess-1", "finalResponse": "hello from hermes"}))
sys.exit(0)
`,
    );
    chmodSync(runner, 0o755);
    const adapter = new HermesAgentAdapter(logger, {
      runnerPath: runner,
      hermesPython: "python3",
    });
    await expect(
      adapter.startThread("review please", {
        sandbox: "workspace-write",
        hermesSession: {
          platform: "linear",
          userId: "cj@snapcorp.com",
          sessionTitle: "FRA-2818 · polish",
          sessionKey: "wakewire:linear:FRA-2818",
          chatId: "wakewire:linear:FRA-2818",
          displayName: "cj@snapcorp.com",
        },
      }),
    ).resolves.toEqual({ threadId: "sess-1", finalResponse: "hello from hermes" });
  });

  it("cancels only its session-keyed runner when the delivery signal aborts", async () => {
    const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hermes-adapter-abort-"));
    const runner = join(dir, "runner.py");
    const marker = join(dir, "runner.pid");
    writeFileSync(
      runner,
      `#!/usr/bin/env python3
import json, os, sys, time
json.load(sys.stdin)
with open(${JSON.stringify(marker)}, "w", encoding="utf-8") as marker_file:
    marker_file.write(str(os.getpid()))
time.sleep(30)
`,
    );
    chmodSync(runner, 0o755);
    const adapter = new HermesAgentAdapter(logger, {
      runnerPath: runner,
      hermesPython: "python3",
    });
    const controller = new AbortController();
    const delivery = adapter.deliverToThread("sess-abort", "review", {
      sandbox: "workspace-write",
      signal: controller.signal,
      hermesSession: {
        platform: "github",
        userId: "reviewer",
        sessionKey: "wakewire:github:snapnhd/system#1097",
      },
    });

    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      controller.abort(new Error("head moved"));
      const outcome = await Promise.race([
        delivery.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      if (existsSync(marker)) {
        try {
          process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
        } catch {
          // The adapter already stopped the exact fixture process.
        }
      }
      await Promise.allSettled([delivery]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setThreadTitle and readThreadTitle round-trip via runner actions", async () => {
    const { writeFileSync, chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hermes-adapter-title-"));
    const runner = join(dir, "runner.py");
    writeFileSync(
      runner,
      `#!/usr/bin/env python3
import json,sys
req=json.load(sys.stdin)
if req["action"]=="set_title":
  assert req["sessionId"]=="sess-t"
  assert req["sessionTitle"]=="snapnhd/system#1"
  print(json.dumps({"ok": True, "sessionId": "sess-t", "finalResponse": "snapnhd/system#1", "title": "snapnhd/system#1"}))
elif req["action"]=="read_title":
  print(json.dumps({"ok": True, "sessionId": "sess-t", "finalResponse": "snapnhd/system#1", "title": "snapnhd/system#1"}))
else:
  print(json.dumps({"ok": False, "errorClass": "permanent", "message": "bad action"}))
  sys.exit(1)
sys.exit(0)
`,
    );
    chmodSync(runner, 0o755);
    const adapter = new HermesAgentAdapter(logger, {
      runnerPath: runner,
      hermesPython: "python3",
    });
    await expect(adapter.setThreadTitle("sess-t", "snapnhd/system#1")).resolves.toBeUndefined();
    await expect(adapter.readThreadTitle("sess-t")).resolves.toBe("snapnhd/system#1");
  });
});
