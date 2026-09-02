import { access, chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidSnapWorkspaceInputError,
  readPrivateWorkspaceMetadata,
  resolveSnapWorkspace,
  runBoundedSnapWorkspaceCommand,
  SNAP_ROOT,
  SnapWorkspaceCommandError,
  type SnapWorkspaceCommandRunner,
  type SnapWorkspaceInspector,
  SnapWorkspaceValidationError,
} from "./snap-workspace.js";

const ticket = "eng-4610";
const workspacePath = `${SNAP_ROOT}/workspaces/${ticket}`;
const headSha = "c".repeat(40);

describe("readPrivateWorkspaceMetadata", () => {
  it("reads only a small owner-private regular file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wakewire-metadata-"));
    const metadata = path.join(directory, "workspace.env");
    try {
      await writeFile(metadata, "TICKET=eng-4610\n", { mode: 0o600 });
      await expect(readPrivateWorkspaceMetadata(metadata)).resolves.toBe("TICKET=eng-4610\n");

      await chmod(metadata, 0o644);
      await expect(readPrivateWorkspaceMetadata(metadata)).rejects.toBeInstanceOf(
        SnapWorkspaceValidationError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects symlinked metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wakewire-metadata-link-"));
    const target = path.join(directory, "target.env");
    const metadata = path.join(directory, "workspace.env");
    try {
      await writeFile(target, "TICKET=eng-4610\n", { mode: 0o600 });
      await symlink(target, metadata);
      await expect(readPrivateWorkspaceMetadata(metadata)).rejects.toBeInstanceOf(
        SnapWorkspaceValidationError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized metadata and returns null when it is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wakewire-metadata-size-"));
    const metadata = path.join(directory, "workspace.env");
    try {
      await expect(readPrivateWorkspaceMetadata(metadata)).resolves.toBeNull();
      await writeFile(metadata, "x".repeat(16 * 1_024 + 1), { mode: 0o600 });
      await expect(readPrivateWorkspaceMetadata(metadata)).rejects.toBeInstanceOf(
        SnapWorkspaceValidationError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function statusOutput(overrides: Partial<Record<string, string>> = {}): string {
  return [
    `ticket=${overrides.ticket ?? ticket}`,
    `app=${overrides.app ?? `https://${ticket}.ws.chipbyte.dev`}`,
    `data=${overrides.data ?? `https://data-${ticket}.ws.chipbyte.dev`}`,
    `snapcorp=${overrides.snapcorp ?? `https://snapcorp-${ticket}.ws.chipbyte.dev`}`,
    `overmind=${overrides.overmind ?? "running"}`,
  ].join("\n");
}

function harness(overrides: Partial<SnapWorkspaceInspector> = {}) {
  const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, args) => {
    if (args.includes("status")) return { stdout: statusOutput(), stderr: "" };
    if (args.includes("rev-parse")) {
      return { stdout: `${ticket}\n${headSha}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  const inspector: SnapWorkspaceInspector = {
    isDirectory: vi.fn(async () => true),
    realpath: vi.fn(async () => workspacePath),
    readTextFileIfExists: vi.fn(async () => `TICKET=${ticket}\nSYSTEM=ice\n`),
    ...overrides,
  };
  return { runner, inspector };
}

describe("resolveSnapWorkspace", () => {
  it("prefers and normalizes an authoritative ticket through the dispatcher", async () => {
    const ticket = "fra-2967";
    const ticketWorkspace = `${SNAP_ROOT}/workspaces/${ticket}`;
    const runner = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.includes("status")) {
        return {
          stdout: [
            `ticket=${ticket}`,
            `app=https://${ticket}.ws.chipbyte.dev`,
            `data=https://data-${ticket}.ws.chipbyte.dev`,
            `snapcorp=https://snapcorp-${ticket}.ws.chipbyte.dev`,
            "overmind=running",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) {
        return { stdout: `${ticket}\n${"a".repeat(40)}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const inspector: SnapWorkspaceInspector = {
      isDirectory: vi.fn(async () => true),
      realpath: vi.fn(async () => ticketWorkspace),
      readTextFileIfExists: vi.fn(async () => `TICKET=${ticket}\nSYSTEM=ice\n`),
    };

    await expect(
      resolveSnapWorkspace(
        {
          authoritativeLinearInput: "FRA-2967",
          pullRequestUrl: "https://github.com/snapnhd/system/pull/1113",
        },
        { runner, inspector },
      ),
    ).resolves.toEqual({
      ticket,
      cwd: ticketWorkspace,
      headSha: "a".repeat(40),
      urls: {
        app: `https://${ticket}.ws.chipbyte.dev`,
        data: `https://data-${ticket}.ws.chipbyte.dev`,
        snapcorp: `https://snapcorp-${ticket}.ws.chipbyte.dev`,
      },
    });
    expect(runner.mock.calls.slice(0, 3).map((call) => call[1])).toEqual([
      ["-C", "/Users/chip/Snap/workspaces", "dev", ticket],
      [
        "-C",
        "/Users/chip/Snap/workspaces",
        "status",
        "https://github.com/snapnhd/system/pull/1113",
      ],
      ["-C", "/Users/chip/Snap/workspaces", "status", ticket],
    ]);
  });

  it("rejects an authoritative ticket that does not match the originating PR mapping", async () => {
    const pullRequestUrl = "https://github.com/snapnhd/system/pull/1113";
    const { inspector } = harness();
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, args) => {
      if (args.includes("status")) {
        const input = args.at(-1);
        return {
          stdout:
            input === pullRequestUrl
              ? statusOutput({
                  ticket: "eng-9999",
                  app: "https://eng-9999.ws.chipbyte.dev",
                  data: "https://data-eng-9999.ws.chipbyte.dev",
                  snapcorp: "https://snapcorp-eng-9999.ws.chipbyte.dev",
                })
              : statusOutput(),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      resolveSnapWorkspace(
        { authoritativeLinearInput: "ENG-4610", pullRequestUrl },
        { runner, inspector },
      ),
    ).rejects.toThrow(/pull request.*ticket|ticket.*pull request/iu);
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it("falls back to the exact authenticated system pull request URL", async () => {
    const ticket = "fra-2967";
    const pullRequestUrl = "https://github.com/snapnhd/system/pull/1113";
    const ticketWorkspace = `${SNAP_ROOT}/workspaces/${ticket}`;
    const runner = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.includes("status")) {
        return {
          stdout: [
            `ticket=${ticket}`,
            `app=https://${ticket}.ws.chipbyte.dev`,
            `data=https://data-${ticket}.ws.chipbyte.dev`,
            `snapcorp=https://snapcorp-${ticket}.ws.chipbyte.dev`,
            "overmind=running",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) {
        return { stdout: `${ticket}\n${"b".repeat(40)}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const inspector: SnapWorkspaceInspector = {
      isDirectory: vi.fn(async () => true),
      realpath: vi.fn(async () => ticketWorkspace),
      readTextFileIfExists: vi.fn(async () => `TICKET=${ticket}\nSYSTEM=ice\n`),
    };

    await expect(
      resolveSnapWorkspace({ pullRequestUrl }, { runner: runner as never, inspector }),
    ).resolves.toMatchObject({ ticket, cwd: ticketWorkspace, headSha: "b".repeat(40) });
    expect(runner.mock.calls.slice(0, 3).map((call) => call[1])).toEqual([
      ["-C", "/Users/chip/Snap/workspaces", "dev", pullRequestUrl],
      ["-C", "/Users/chip/Snap/workspaces", "status", pullRequestUrl],
      ["-C", "/Users/chip/Snap/workspaces", "status", ticket],
    ]);
  });

  it("recognizes the current Overmind process status format as running", async () => {
    const { inspector } = harness();
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, args) => {
      if (args.includes("status")) {
        return {
          stdout: `${statusOutput().replace("overmind=running", "")}\n${[
            "redis",
            "app-web",
            "app-vite",
            "app-workers",
            "data-web",
            "snapcorp-web",
            "snapcorp-workers",
          ]
            .map((name, index) => `${name} ${index + 100} running`)
            .join("\n")}`,
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) {
        return { stdout: `${ticket}\n${headSha}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      resolveSnapWorkspace({ authoritativeLinearInput: ticket }, { runner, inspector }),
    ).resolves.toMatchObject({ ticket });
  });

  it.each([
    "",
    "ENG-4610-title",
    "-eng-4610",
    "eng-4610-",
    "eng_4610",
    "eng-4610/title",
    "../eng-4610",
    " eng-4610",
    `eng-${"a".repeat(60)}`,
  ])("rejects an inexact Linear input before invoking Make: %j", async (invalidInput) => {
    const { runner, inspector } = harness();

    await expect(
      resolveSnapWorkspace({ authoritativeLinearInput: invalidInput }, { runner, inspector }),
    ).rejects.toBeInstanceOf(InvalidSnapWorkspaceInputError);
    expect(runner).not.toHaveBeenCalled();
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it.each([
    "http://github.com/snapnhd/system/pull/1113",
    "https://github.com/other/system/pull/1113",
    "https://github.com/snapnhd/system/issues/1113",
    "https://github.com/snapnhd/system/pull/0",
    "https://github.com/snapnhd/system/pull/1113/files",
  ])("rejects a malformed or unrelated fallback PR URL: %s", async (invalidUrl) => {
    const { runner, inspector } = harness();
    await expect(
      resolveSnapWorkspace({ pullRequestUrl: invalidUrl }, { runner, inspector }),
    ).rejects.toBeInstanceOf(InvalidSnapWorkspaceInputError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("retains bounded command diagnostics without exposing them in the public error", async () => {
    const { inspector } = harness();
    const stdout = `stdout-prefix:${"o".repeat(5_000)}:stdout-tail`;
    const stderr = `stderr-prefix:${"e".repeat(5_000)}:stderr-tail`;
    const cause = Object.assign(
      new Error("simulated failure with output that must not be copied"),
      {
        code: 2,
        signal: "SIGTERM",
        stdout,
        stderr,
      },
    );
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async () => {
      throw cause;
    });

    const error = await resolveSnapWorkspace(
      { authoritativeLinearInput: ticket },
      { runner, inspector },
    ).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SnapWorkspaceCommandError);
    const commandError = error as SnapWorkspaceCommandError;
    expect(commandError.message).toBe(`workspace dispatcher could not prepare ${ticket}`);
    expect(commandError.message).not.toContain("simulated failure");
    expect(commandError.cause).toBe(cause);
    expect(commandError.diagnostics).toEqual({
      code: 2,
      signal: "SIGTERM",
      stdout: stdout.slice(-4_096),
      stderr: stderr.slice(-4_096),
    });
    expect(Object.isFrozen(commandError.diagnostics)).toBe(true);
    expect(JSON.stringify(commandError)).not.toContain("stdout-tail");
    expect(JSON.stringify(commandError)).not.toContain("stderr-tail");
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it("forwards cooperative cancellation to both dispatcher child processes", async () => {
    const { inspector } = harness();
    const controller = new AbortController();
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, args, signal) => {
      expect(signal).toBe(controller.signal);
      if (args.includes("status")) {
        controller.abort();
        signal?.throwIfAborted();
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      resolveSnapWorkspace(
        { authoritativeLinearInput: ticket },
        { runner, inspector, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(SnapWorkspaceCommandError);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(inspector.isDirectory).not.toHaveBeenCalled();
  });

  it("rejects a missing or redirected workspace directory after Make returns", async () => {
    const missing = harness({ isDirectory: vi.fn(async () => false) });
    await expect(
      resolveSnapWorkspace(
        { authoritativeLinearInput: ticket },
        { runner: missing.runner, inspector: missing.inspector },
      ),
    ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);

    const redirected = harness({ realpath: vi.fn(async () => "/private/tmp/eng-4610") });
    await expect(
      resolveSnapWorkspace(
        { authoritativeLinearInput: ticket },
        { runner: redirected.runner, inspector: redirected.inspector },
      ),
    ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
  });

  it("rejects missing, duplicate, or mismatched ticket metadata", async () => {
    for (const metadata of [
      null,
      "SYSTEM=ice\n",
      `TICKET=${ticket}\nTICKET=${ticket}\n`,
      "TICKET=fra-9999\n",
    ]) {
      const current = harness({ readTextFileIfExists: vi.fn(async () => metadata) });
      await expect(
        resolveSnapWorkspace(
          { authoritativeLinearInput: ticket },
          { runner: current.runner, inspector: current.inspector },
        ),
      ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
    }
  });

  it.each([
    { label: "stopped runtime", output: statusOutput({ overmind: "stopped" }) },
    {
      label: "duplicate ticket key",
      output: `${statusOutput()}\nticket=${ticket}`,
    },
    {
      label: "unexpected app host",
      output: statusOutput({ app: "https://attacker.invalid" }),
    },
    {
      label: "missing project summary",
      output: statusOutput().replace(/^data=.*$/m, ""),
    },
  ])("rejects malformed status: $label", async ({ output }) => {
    const { inspector } = harness();
    const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, args) => {
      if (args.includes("status")) return { stdout: output, stderr: "" };
      if (args.includes("rev-parse")) {
        return { stdout: `${ticket}\n${headSha}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await expect(
      resolveSnapWorkspace({ authoritativeLinearInput: ticket }, { runner, inspector }),
    ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
  });

  it.each([`${ticket}\nnot-a-sha\n`, `fra-9999\n${headSha}\n`, `${ticket}\n${headSha}\nextra\n`])(
    "rejects a mismatched or malformed Git identity",
    async (gitOutput) => {
      const { inspector } = harness();
      const runner = vi.fn<SnapWorkspaceCommandRunner>(async (_executable, args) => {
        if (args.includes("status")) return { stdout: statusOutput(), stderr: "" };
        if (args.includes("rev-parse")) return { stdout: gitOutput, stderr: "" };
        return { stdout: "", stderr: "" };
      });
      await expect(
        resolveSnapWorkspace({ authoritativeLinearInput: ticket }, { runner, inspector }),
      ).rejects.toBeInstanceOf(SnapWorkspaceValidationError);
    },
  );
});

describe("runBoundedSnapWorkspaceCommand", () => {
  it("scrubs inherited build controls", async () => {
    vi.stubEnv("MAKEFILES", "/hostile/makefile");
    vi.stubEnv("PYTHONPATH", "/hostile/python");
    vi.stubEnv("SYSTEM", "snap");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    try {
      const result = await runBoundedSnapWorkspaceCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write([process.env.MAKEFILES ?? '', process.env.PYTHONPATH ?? '', process.env.SYSTEM ?? '', process.env.AWS_SECRET_ACCESS_KEY ?? '', 'ok'].join('|'))",
        ],
        new AbortController().signal,
      );

      expect(result.stdout).toBe("||||ok");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a fixed trusted command path", async () => {
    vi.stubEnv("PATH", "/tmp/attacker-controlled");
    try {
      const result = await runBoundedSnapWorkspaceCommand(
        process.execPath,
        ["-e", "process.stdout.write(process.env.PATH ?? '')"],
        new AbortController().signal,
      );

      expect(result.stdout).toBe(
        "/Users/chip/.homebrew/bin:/Users/chip/.homebrew/sbin:/Users/chip/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds command output", async () => {
    const result = await runBoundedSnapWorkspaceCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(6000))"],
      new AbortController().signal,
    );

    expect(Buffer.byteLength(result.stdout)).toBe(4_096);
  });

  it("cancels the active command", async () => {
    const controller = new AbortController();
    const operation = runBoundedSnapWorkspaceCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);

    await expect(operation).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "cancelled by test" }),
    });
  });

  it("kills a resistant descendant after the direct command exits", async () => {
    const marker = path.join(tmpdir(), `wakewire-workspace-descendant-${process.pid}`);
    await rm(marker, { force: true });
    const descendant = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(
      marker,
    )}, 'alive'), 300); setInterval(() => {}, 1000)`;
    const parent = `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(
      descendant,
    )}], {stdio:'ignore'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`;
    const controller = new AbortController();
    const operation = runBoundedSnapWorkspaceCommand(
      process.execPath,
      ["-e", parent],
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("cancelled by test")), 100);

    try {
      await expect(operation).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "cancelled by test" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(marker, { force: true });
    }
  });
});
