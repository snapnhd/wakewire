import { describe, expect, it } from "vitest";
import { codexSdkThreadOptions } from "./codex-sdk.js";

describe("codexSdkThreadOptions", () => {
  it("propagates per-delivery Sol Ultra through the SDK's stale effort type", () => {
    expect(
      codexSdkThreadOptions(
        {
          sandbox: "workspace-write",
          cwd: "/Users/chip/Snap/eng-1",
          model: "gpt-5.6-sol",
          reasoningEffort: "ultra",
        },
        "gpt-5.6-luna",
      ),
    ).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      workingDirectory: "/Users/chip/Snap/eng-1",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "ultra",
    });
  });

  it("retains the configured model fallback without inventing an effort", () => {
    expect(codexSdkThreadOptions({ sandbox: "read-only" }, "gpt-5.6-luna")).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      model: "gpt-5.6-luna",
    });
  });
});
