import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logsDir } from "../paths.js";

const execFileAsync = promisify(execFile);

const LAUNCHD_LABEL = "io.wakewire.daemon";

export interface LaunchdEnvironmentOptions {
  homeDir?: string;
  nodePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface LaunchdPlistOptions extends LaunchdEnvironmentOptions {
  logsDirectory?: string;
}

/**
 * launchd (macOS) / systemd user unit (Linux) registration so the daemon
 * starts at login. Windows: run under a terminal or NSSM — documented in the
 * README, no service wrapper in v1.
 */
export async function installService(cliPath: string): Promise<void> {
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(plist, launchdPlist(cliPath));
    await execFileAsync("launchctl", ["unload", plist]).catch(() => undefined);
    await execFileAsync("launchctl", ["load", plist]);
    console.log(`Installed and loaded launchd agent: ${plist}`);
    return;
  }
  if (process.platform === "linux") {
    const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
    const unit = path.join(unitDir, "wakewire.service");
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unit, systemdUnit(cliPath));
    console.log(`Wrote ${unit}`);
    console.log(
      "Enable it with:\n  systemctl --user daemon-reload && systemctl --user enable --now wakewire",
    );
    return;
  }
  console.log(
    "No service wrapper for this platform in v1. Run `wakewire start` in a terminal, " +
      "or on Windows use NSSM: nssm install wakewire <node> <cli.js> start",
  );
}

export async function uninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await execFileAsync("launchctl", ["unload", plist]).catch(() => undefined);
    fs.rmSync(plist, { force: true });
    console.log(`Removed ${plist}`);
    return;
  }
  if (process.platform === "linux") {
    const unit = path.join(os.homedir(), ".config", "systemd", "user", "wakewire.service");
    await execFileAsync("systemctl", ["--user", "disable", "--now", "wakewire"]).catch(
      () => undefined,
    );
    fs.rmSync(unit, { force: true });
    console.log(`Removed ${unit}`);
    return;
  }
  console.log("Nothing to uninstall on this platform.");
}

export function launchdEnvironment(options: LaunchdEnvironmentOptions = {}): {
  MISE_DATA_DIR: string;
  PATH: string;
} {
  const homeDir = options.homeDir ?? os.homedir();
  const nodePath = options.nodePath ?? process.execPath;
  const environment = options.environment ?? process.env;
  const miseDataDir = resolveMiseDataDir(homeDir, nodePath, environment);
  const pathEntries = [
    path.join(miseDataDir, "shims"),
    path.dirname(nodePath),
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".homebrew", "bin"),
    path.join(homeDir, ".homebrew", "sbin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/Applications/ChatGPT.app/Contents/Resources",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  return {
    MISE_DATA_DIR: miseDataDir,
    PATH: [...new Set(pathEntries.map((entry) => path.normalize(entry)))].join(":"),
  };
}

export function launchdPlist(cliPath: string, options: LaunchdPlistOptions = {}): string {
  const nodePath = options.nodePath ?? process.execPath;
  const homeDir = options.homeDir ?? os.homedir();
  const serviceEnvironment = launchdEnvironment(options);
  const logDirectory = options.logsDirectory ?? logsDir();
  const stdout = path.join(logDirectory, "launchd.out.log");
  const stderr = path.join(logDirectory, "launchd.err.log");
  const wrapper = path.join(homeDir, ".local", "bin", "wakewire-launchd");
  const programArguments = fs.existsSync(wrapper)
    ? `    <string>${escapeXml(wrapper)}</string>`
    : `    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>start</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MISE_DATA_DIR</key><string>${escapeXml(serviceEnvironment.MISE_DATA_DIR)}</string>
    <key>PATH</key><string>${escapeXml(serviceEnvironment.PATH)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(stderr)}</string>
</dict>
</plist>
`;
}

function resolveMiseDataDir(
  homeDir: string,
  nodePath: string,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.MISE_DATA_DIR?.trim();
  if (configured) return absoluteDirectory("MISE_DATA_DIR", configured);

  const installsSegment = `${path.sep}installs${path.sep}`;
  const installsIndex = nodePath.lastIndexOf(installsSegment);
  if (installsIndex > 0) return path.normalize(nodePath.slice(0, installsIndex));

  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return path.join(absoluteDirectory("XDG_DATA_HOME", xdgDataHome), "mise");
  }

  const configuredHome = path.join(homeDir, ".config", "mise");
  if (fs.existsSync(configuredHome)) return configuredHome;
  return path.join(homeDir, ".local", "share", "mise");
}

function absoluteDirectory(name: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdUnit(cliPath: string): string {
  return `[Unit]
Description=wakewire - push external events into Codex threads
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliPath} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
