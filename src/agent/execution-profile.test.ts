import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_PROFILE,
  ExecutionProfileSchema,
  parseExecutionProfile,
} from "./execution-profile.js";

describe("parseExecutionProfile", () => {
  it("uses Luna with low effort by default", () => {
    expect(parseExecutionProfile("Please review the retry behavior.")).toEqual(
      DEFAULT_EXECUTION_PROFILE,
    );
  });

  it("does not treat ordinary model names or adjectives as directives", () => {
    expect(
      parseExecutionProfile(
        "The Luna project is high priority. Explain how the new chat feature should work.",
      ),
    ).toEqual(DEFAULT_EXECUTION_PROFILE);
  });

  it.each([
    ["model: Sol", "gpt-5.6-sol"],
    ["MODEL=gpt-5.6-terra", "gpt-5.6-terra"],
    ["use the Luna model", "gpt-5.6-luna"],
    ["use GPT-5.6 Sol", "gpt-5.6-sol"],
    ["using Terra at max effort", "gpt-5.6-terra"],
    ["model: GPT-5.5", "gpt-5.5"],
    ["use GPT-5.4", "gpt-5.4"],
    ["model: GPT-5.4 Mini", "gpt-5.4-mini"],
    ["use GPT-5.3 Codex Spark", "gpt-5.3-codex-spark"],
  ] as const)("parses the explicit model in %s", (text, model) => {
    expect(parseExecutionProfile(text)).toMatchObject({
      model,
      source: "explicit",
      clarification: null,
    });
  });

  it.each([
    ["effort: light", "low"],
    ["thinking=x-high", "xhigh"],
    ["at extra high effort", "xhigh"],
    ["reasoning: maximum", "max"],
    ["model: Sol; with ultra effort", "ultra"],
  ] as const)("normalizes the explicit effort in %s", (text, reasoningEffort) => {
    expect(parseExecutionProfile(text)).toMatchObject({
      reasoningEffort,
      source: "explicit",
      clarification: null,
    });
  });

  it("extracts an effort adjacent to a cued model", () => {
    expect(parseExecutionProfile("use 5.6 Luna High")).toEqual({
      version: 1,
      mode: "current",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      source: "explicit",
      clarification: null,
    });
    expect(parseExecutionProfile("using Terra at max effort")).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      clarification: null,
    });
  });

  it.each(["Ultracode", "ULTRACODE", "uLtRaCoDe"])(
    "maps the whole-word %s keyword to Sol with ultra effort",
    (keyword) => {
      expect(parseExecutionProfile(`Please ${keyword} this.`)).toEqual({
        version: 1,
        mode: "current",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        source: "ultracode",
        clarification: null,
      });
    },
  );

  it("does not match Ultracode as part of a longer word", () => {
    expect(parseExecutionProfile("Please run the ultracoder check.")).toEqual(
      DEFAULT_EXECUTION_PROFILE,
    );
  });

  it("gives Ultracode hard precedence over other model and effort wording", () => {
    expect(parseExecutionProfile("Ultracode this; model: Luna; effort: low.")).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      source: "ultracode",
      clarification: null,
    });
  });

  it.each([
    "Please do this in a separate chat.",
    "Create a new task for the investigation.",
    "Open a separate Codex thread to investigate.",
    "Please use a seperate chat with model: Sol.",
    "Please ask for a separate chat to investigate.",
    "Ask another task to investigate.",
    "Run this in another chat.",
    "New chat: investigate the regression.",
  ])("detects an explicit separate-task request: %s", (text) => {
    expect(parseExecutionProfile(text)).toMatchObject({ mode: "separate", clarification: null });
  });

  it.each([
    "Do not create a separate chat; answer here.",
    "No new task, please.",
    "Handle this without a separate thread.",
    "Tell me how a new chat works.",
    "We need the ability to ask for a separate chat.",
  ])("does not route negated or descriptive wording to a separate task: %s", (text) => {
    expect(parseExecutionProfile(text)).toMatchObject({ mode: "current" });
  });

  it("scopes explicit settings to a requested separate task", () => {
    expect(parseExecutionProfile("Handle this in another task using Terra at max effort.")).toEqual(
      {
        version: 1,
        mode: "separate",
        model: "gpt-5.6-terra",
        reasoningEffort: "max",
        source: "explicit",
        clarification: null,
      },
    );
  });

  it.each([
    ["Use a separate chat with Sol at high effort", "gpt-5.6-sol", "high"],
    ["Create a new task with Terra at max effort", "gpt-5.6-terra", "max"],
    ["open another thread using Luna light", "gpt-5.6-luna", "low"],
    ["ask for a seperate chat with Terra at high effort", "gpt-5.6-terra", "high"],
  ] as const)(
    "parses natural settings scoped to a separate-task request: %s",
    (text, model, reasoningEffort) => {
      expect(parseExecutionProfile(text)).toEqual({
        version: 1,
        mode: "separate",
        model,
        reasoningEffort,
        source: "explicit",
        clarification: null,
      });
    },
  );

  it("keeps Ultracode precedence for a natural separate-task request", () => {
    expect(
      parseExecutionProfile("Use a separate chat with Luna at low effort. Ultracode it."),
    ).toEqual({
      version: 1,
      mode: "separate",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      source: "ultracode",
      clarification: null,
    });
  });

  it.each([
    "The separate chat with Sol at high effort was helpful.",
    "Compare a separate chat with Sol at high effort to the current chat.",
    "Explain how to use a separate chat with Sol at high effort.",
    "We need the ability to create a new task with Terra at max effort.",
  ])("does not parse natural settings from descriptive prose: %s", (text) => {
    expect(parseExecutionProfile(text)).toEqual(DEFAULT_EXECUTION_PROFILE);
  });

  it.each([
    "model: Sol; model: Terra",
    "effort: high; thinking: low",
    "model: banana",
    "effort: extreme",
    "model: Luna; effort: ultra",
    "model: GPT-5.5; effort: max",
    "model: Spark; effort: ultra",
  ])("returns a safe typed clarification for conflicting or invalid input: %s", (text) => {
    const profile = parseExecutionProfile(text);
    expect(profile).toMatchObject({
      version: 1,
      mode: "current",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      source: "explicit",
    });
    expect(profile.clarification).toEqual(expect.any(String));
    expect(ExecutionProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("accepts duplicate directives that resolve to the same value", () => {
    expect(
      parseExecutionProfile("model: Sol; use the Sol model; effort: high; thinking: high"),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      source: "explicit",
      clarification: null,
    });
  });

  it("never forwards arbitrary keyed model or effort strings", () => {
    const profile = parseExecutionProfile("model: $(danger); effort: impossible");
    expect(profile).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      clarification: expect.any(String),
    });
    expect(ExecutionProfileSchema.safeParse(profile).success).toBe(true);
  });
});

describe("ExecutionProfileSchema", () => {
  it("rejects arbitrary model identifiers", () => {
    expect(
      ExecutionProfileSchema.safeParse({
        ...DEFAULT_EXECUTION_PROFILE,
        model: "sender-controlled-model",
      }).success,
    ).toBe(false);
  });

  it("requires clarification profiles to use the current task and safe defaults", () => {
    expect(
      ExecutionProfileSchema.safeParse({
        version: 1,
        mode: "separate",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        source: "explicit",
        clarification: "Which settings should I use?",
      }).success,
    ).toBe(false);
  });
});
