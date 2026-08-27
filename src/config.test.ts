import { describe, expect, it } from "vitest";
import { loadConfig, settingKeys } from "./config.js";
import { openDatabase } from "./db/db.js";
import { createStores } from "./db/repos.js";

describe("loadConfig", () => {
  it("keeps tmux discovery automatic unless an explicit binary path is configured", () => {
    const db = openDatabase(":memory:");
    const settings = createStores(db).settings;

    expect(loadConfig(settings).tmuxPath).toBeUndefined();

    settings.set(settingKeys.tmuxPath, "/opt/homebrew/bin/tmux");
    expect(loadConfig(settings).tmuxPath).toBe("/opt/homebrew/bin/tmux");
    db.close();
  });

  it("defaults dispatcher routing to Codex and accepts an explicit Claude RC default", () => {
    const db = openDatabase(":memory:");
    const settings = createStores(db).settings;

    expect(loadConfig(settings).dispatcherDefaultAgent).toBe("codex");

    settings.set(settingKeys.dispatcherDefaultAgent, "claude-rc");
    expect(loadConfig(settings).dispatcherDefaultAgent).toBe("claude-rc");

    settings.set(settingKeys.dispatcherDefaultAgent, "unsupported");
    expect(loadConfig(settings).dispatcherDefaultAgent).toBe("codex");
    db.close();
  });
});
