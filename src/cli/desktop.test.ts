import { constants as fsConstants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopHelperProbeResult,
  inspectDesktopReadiness,
  probeDesktopHelper,
} from "./desktop.js";

describe("desktop doctor readiness", () => {
  it("requires IPC, readable state, executable helper, and helper preflight", async () => {
    const probeHelper = vi.fn(async (): Promise<DesktopHelperProbeResult> => ({ ok: true }));
    const result = await inspectDesktopReadiness(
      {
        helperPath: "/helper",
        stateDatabasePath: "/state.sqlite",
        ipc: { ok: true, environment: environment() },
      },
      {
        access: async () => undefined,
        probeHelper,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.firstTaskHelper).toEqual({
      ok: true,
      path: "/helper",
      executable: true,
      accessibilityReady: true,
    });
    expect(probeHelper).toHaveBeenCalledWith("/helper");
  });

  it("does not execute a missing helper", async () => {
    const probeHelper = vi.fn(async (): Promise<DesktopHelperProbeResult> => ({ ok: true }));
    const result = await inspectDesktopReadiness(
      {
        helperPath: "/missing-helper",
        stateDatabasePath: "/state.sqlite",
        ipc: { ok: true, environment: environment() },
      },
      {
        access: async (file, mode) => {
          if (file === "/missing-helper" && mode === fsConstants.X_OK) throw new Error("ENOENT");
        },
        probeHelper,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.firstTaskHelper).toEqual({
      ok: false,
      path: "/missing-helper",
      executable: false,
      accessibilityReady: false,
      reason: "helper is missing or not executable",
    });
    expect(probeHelper).not.toHaveBeenCalled();
  });

  it("surfaces missing Accessibility or locked-session readiness", async () => {
    const result = await inspectDesktopReadiness(
      {
        helperPath: "/helper",
        stateDatabasePath: "/state.sqlite",
        ipc: { ok: true, environment: environment() },
      },
      {
        access: async () => undefined,
        probeHelper: async () => ({
          ok: false,
          reason: "Accessibility permission is not granted to the Codex Desktop helper",
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.firstTaskHelper.accessibilityReady).toBe(false);
    expect(result.firstTaskHelper.reason).toMatch(/Accessibility permission/);
  });

  it("reports an unreadable Desktop state database independently", async () => {
    const result = await inspectDesktopReadiness(
      {
        helperPath: "/helper",
        stateDatabasePath: "/missing-state.sqlite",
        ipc: { ok: true, environment: environment() },
      },
      {
        access: async (file, mode) => {
          if (file.endsWith("state.sqlite") && mode === fsConstants.R_OK) throw new Error("ENOENT");
        },
        probeHelper: async () => ({ ok: true }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stateDatabase.reason).toMatch(/missing or unreadable/);
    expect(result.firstTaskHelper.ok).toBe(true);
  });
});

describe("probeDesktopHelper", () => {
  it("accepts only the helper's explicit readiness JSON", async () => {
    await expect(
      probeDesktopHelper("/helper", {
        run: async () => ({ stdout: '{"ok":true}\n', stderr: "" }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      probeDesktopHelper("/helper", {
        run: async () => ({ stdout: "not-json", stderr: "" }),
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("JSON") });
  });
});

function environment() {
  return {
    appPath: "/Applications/ChatGPT.app",
    desktopVersion: "test",
    socketPath: "/tmp/ipc.sock",
    turnCompatibility: "pinned" as const,
    interruptSupported: true,
  };
}
