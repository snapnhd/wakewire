import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchdEnvironment, launchdPlist } from "./service.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("launchdEnvironment", () => {
  it("uses a stable toolchain path without inheriting ephemeral paths or secrets", () => {
    const environment = launchdEnvironment({
      homeDir: "/Users/example",
      nodePath: "/Users/example/.config/mise/installs/node/24/bin/node",
      environment: {
        LINEAR_API_KEY: "must-not-be-serialized",
        MISE_DATA_DIR: "/Users/example/.config/mise",
        PATH: "/private/tmp/codex-ephemeral:/secret/bin",
      },
    });

    expect(environment).toEqual({
      MISE_DATA_DIR: "/Users/example/.config/mise",
      PATH: [
        "/Users/example/.config/mise/shims",
        "/Users/example/.config/mise/installs/node/24/bin",
        "/Users/example/.local/bin",
        "/Users/example/.homebrew/bin",
        "/Users/example/.homebrew/sbin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/Applications/ChatGPT.app/Contents/Resources",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    });
    expect(JSON.stringify(environment)).not.toContain("must-not-be-serialized");
    expect(environment.PATH).not.toContain("codex-ephemeral");
    expect(environment.PATH).not.toContain("/secret/bin");
  });

  it("infers the mise data directory from the installed Node runtime", () => {
    const environment = launchdEnvironment({
      homeDir: "/Users/example",
      nodePath: "/Users/example/.homebrew/installs/node/24/bin/node",
      environment: {},
    });

    expect(environment.MISE_DATA_DIR).toBe("/Users/example/.homebrew");
    expect(environment.PATH.split(":")).toEqual([
      "/Users/example/.homebrew/shims",
      "/Users/example/.homebrew/installs/node/24/bin",
      "/Users/example/.local/bin",
      "/Users/example/.homebrew/bin",
      "/Users/example/.homebrew/sbin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/Applications/ChatGPT.app/Contents/Resources",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
  });

  it("deduplicates a Node directory already present in the stable path", () => {
    const environment = launchdEnvironment({
      homeDir: "/Users/example",
      nodePath: "/usr/local/bin/node",
      environment: { MISE_DATA_DIR: "/Users/example/.config/mise" },
    });

    expect(environment.PATH.split(":").filter((entry) => entry === "/usr/local/bin")).toEqual([
      "/usr/local/bin",
    ]);
  });

  it("rejects a relative configured mise directory", () => {
    expect(() =>
      launchdEnvironment({
        homeDir: "/Users/example",
        nodePath: "/usr/local/bin/node",
        environment: { MISE_DATA_DIR: "relative/mise" },
      }),
    ).toThrow("MISE_DATA_DIR must be an absolute path");
  });
});

describe("launchdPlist", () => {
  it("escapes interpolated values and renders a valid macOS plist", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-service-"));
    cleanup.push(parent);
    const plist = launchdPlist("/Users/example/Wake & Wire/<dist>/cli.js", {
      homeDir: "/Users/example",
      nodePath: "/Users/example/.config/mise/installs/node/24/bin/node",
      logsDirectory: path.join(parent, "Logs & State"),
      environment: { MISE_DATA_DIR: "/Users/example/.config/mise" },
    });

    expect(plist).toContain("/Users/example/Wake &amp; Wire/&lt;dist&gt;/cli.js");
    expect(plist).toContain("Logs &amp; State/launchd.out.log");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("/Users/example/.config/mise/installs/node/24/bin/node");
    expect(plist).not.toContain("wakewire-launchd");

    if (process.platform === "darwin") {
      const plistPath = path.join(parent, "io.wakewire.daemon.plist");
      fs.writeFileSync(plistPath, plist);
      expect(() => execFileSync("/usr/bin/plutil", ["-lint", plistPath])).not.toThrow();
    }
  });

  it("uses a host wrapper when ~/.local/bin/wakewire-launchd exists", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-service-wrap-"));
    cleanup.push(parent);
    const bin = path.join(parent, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const wrapper = path.join(bin, "wakewire-launchd");
    fs.writeFileSync(wrapper, "#!/bin/bash\n");
    const plist = launchdPlist("/Users/example/cli.js", {
      homeDir: parent,
      nodePath: "/Users/example/.config/mise/installs/node/24/bin/node",
      logsDirectory: path.join(parent, "logs"),
      environment: { MISE_DATA_DIR: path.join(parent, ".config", "mise") },
    });
    expect(plist).toContain(wrapper);
    expect(plist).not.toContain("cli.js");
  });
});
