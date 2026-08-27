import { describe, expect, it } from "vitest";
import { codexExecExecutionSettingArgs, parseThreadId } from "./codex-exec.js";

describe("codexExecExecutionSettingArgs", () => {
  it("prefers per-delivery model and passes current efforts through CLI config", () => {
    expect(
      codexExecExecutionSettingArgs(
        { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
        "gpt-5.6-luna",
      ),
    ).toEqual(["--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="ultra"']);
  });

  it("retains the configured model fallback when a delivery does not override it", () => {
    expect(codexExecExecutionSettingArgs({}, "gpt-5.6-luna")).toEqual(["--model", "gpt-5.6-luna"]);
  });
});

describe("parseThreadId", () => {
  it("finds the thread id in a --json event stream", () => {
    const jsonl = [
      '{"type":"session.created"}',
      "not json noise",
      '{"type":"thread.started","thread_id":"0197-abc"}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    expect(parseThreadId(jsonl)).toBe("0197-abc");
  });

  it("returns null when absent", () => {
    expect(parseThreadId('{"type":"turn.completed"}')).toBeNull();
    expect(parseThreadId("")).toBeNull();
  });
});
