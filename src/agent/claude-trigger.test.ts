import { describe, expect, it } from "vitest";
import {
  isClaudeProxyExitDirective,
  parseClaudeProxyDirective,
  parseCodexOverrideDirective,
  parseDispatcherDefaultDirective,
} from "./claude-trigger.js";

describe("parseClaudeProxyDirective", () => {
  it.each([
    ["run on Claude: inspect the retry behavior", "inspect the retry behavior"],
    ["RUN THIS ON CLAUDE — inspect the retry behavior", "inspect the retry behavior"],
    ["run in Claude\ninspect the retry behavior", "inspect the retry behavior"],
    ["Run this in claude, inspect the retry behavior", "inspect the retry behavior"],
    ["use Claude to inspect the retry behavior", "inspect the retry behavior"],
    ["ASK CLAUDE TO: inspect the retry behavior", "inspect the retry behavior"],
    ["send this to Claude; inspect the retry behavior", "inspect the retry behavior"],
    ["Claude: inspect the retry behavior", "inspect the retry behavior"],
    ["cLaUdE:inspect the retry behavior", "inspect the retry behavior"],
  ] as const)("parses the anchored command in %s", (text, prompt) => {
    expect(parseClaudeProxyDirective(text)).toEqual({
      matched: true,
      prompt,
      adapterMode: "print",
    });
  });

  it.each([
    ["Claude RC: inspect the retry behavior", "inspect the retry behavior"],
    ["Claude tmux: inspect the retry behavior", "inspect the retry behavior"],
    ["Claude RC tmux: inspect the retry behavior", "inspect the retry behavior"],
    ["run on Claude RC: inspect the retry behavior", "inspect the retry behavior"],
    ["run on Claude tmux: inspect the retry behavior", "inspect the retry behavior"],
    ["RUN THIS ON CLAUDE RC — inspect the retry behavior", "inspect the retry behavior"],
    ["run this in Claude RC tmux: inspect the retry behavior", "inspect the retry behavior"],
    ["run in Claude RC\ninspect the retry behavior", "inspect the retry behavior"],
    ["Run this in claude rc, inspect the retry behavior", "inspect the retry behavior"],
    ["use Claude RC to inspect the retry behavior", "inspect the retry behavior"],
    ["use Claude RC tmux to inspect the retry behavior", "inspect the retry behavior"],
    ["ASK CLAUDE RC TO: inspect the retry behavior", "inspect the retry behavior"],
    ["ask Claude tmux to inspect the retry behavior", "inspect the retry behavior"],
    ["send this to Claude RC; inspect the retry behavior", "inspect the retry behavior"],
    ["send this to Claude RC tmux: inspect the retry behavior", "inspect the retry behavior"],
  ] as const)("selects the RC tmux adapter for the explicit command in %s", (text, prompt) => {
    expect(parseClaudeProxyDirective(text)).toEqual({
      matched: true,
      prompt,
      adapterMode: "rc-tmux",
    });
  });

  it.each([
    ["Please run on Claude: inspect this", "inspect this"],
    ["Chip, run this on Claude: inspect this", "inspect this"],
    ["Hey Chip, please run this in Claude: inspect this", "inspect this"],
    ["<@U012ABC>, could you use Claude to inspect this?", "inspect this?"],
    ["@Chip Byte: can you please ask Claude to inspect this?", "inspect this?"],
    ["Please, Chip, send this to Claude: inspect this", "inspect this"],
    ["Hello, <@U012ABC|chip> — Claude: inspect this", "inspect this"],
  ] as const)("allows a narrow address or polite prefix in %s", (text, prompt) => {
    expect(parseClaudeProxyDirective(text)).toEqual({
      matched: true,
      prompt,
      adapterMode: "print",
    });
  });

  it.each([
    ["Please run on Claude RC: inspect this", "inspect this"],
    ["Chip, run this on Claude RC: inspect this", "inspect this"],
    ["Hey Chip, please ask Claude RC to inspect this?", "inspect this?"],
  ] as const)("allows addressing while selecting RC in %s", (text, prompt) => {
    expect(parseClaudeProxyDirective(text)).toEqual({
      matched: true,
      prompt,
      adapterMode: "rc-tmux",
    });
  });

  it("preserves the prompt's internal formatting and content", () => {
    const prompt = 'Review this exactly:\n\n```ts\nconst phrase = "run on Claude";\n```';
    expect(parseClaudeProxyDirective(`Run this on Claude:\n${prompt}\n`)).toEqual({
      matched: true,
      prompt,
      adapterMode: "print",
    });

    expect(parseClaudeProxyDirective('Claude: "Keep these quotation marks."')).toEqual({
      matched: true,
      prompt: '"Keep these quotation marks."',
      adapterMode: "print",
    });
  });

  it("removes only the leading command phrase", () => {
    expect(parseClaudeProxyDirective("Run on Claude: Ask Claude to investigate this")).toEqual({
      matched: true,
      prompt: "Ask Claude to investigate this",
      adapterMode: "print",
    });
  });

  it("strips only the pinned Slack recipient when one is supplied", () => {
    expect(parseClaudeProxyDirective("<@UCHIP> run on Claude: inspect this", "UCHIP")).toEqual({
      matched: true,
      prompt: "inspect this",
      adapterMode: "print",
    });
    expect(parseClaudeProxyDirective("<@UOTHER> run on Claude: inspect this", "UCHIP")).toBeNull();
  });

  it.each([
    "run on Claude",
    "run this on Claude:   ",
    "run in Claude?",
    "use Claude to",
    "ask Claude to --",
    "send this to Claude, please.",
    "Claude:",
    "Claude: ...",
    "Can you run on Claude?",
    "run on Claude RC",
    "run on Claude tmux",
    "run this in Claude RC tmux",
    "run this in Claude RC:   ",
    "use Claude RC to",
    "ask Claude RC to --",
    "send this to Claude RC, please.",
    "Claude RC:",
    "Claude RC: ...",
    "Claude tmux:",
    "Claude RC tmux: ...",
  ])("rejects an empty command: %s", (text) => {
    expect(parseClaudeProxyDirective(text)).toBeNull();
  });

  it.each([
    '"run on Claude: inspect this"',
    "'run this in Claude: inspect this'",
    "`use Claude to inspect this`",
    "```text\nask Claude to inspect this\n```",
    "> send this to Claude: inspect this",
    'Please, "run on Claude: inspect this"',
    "Here is an example:\nClaude: inspect this",
    "- run on Claude: inspect this",
  ])("rejects quoted, fenced, or example commands: %s", (text) => {
    expect(parseClaudeProxyDirective(text)).toBeNull();
  });

  it.each([
    "Do not run on Claude: inspect this",
    "Don't run this on Claude: inspect this",
    "Never use Claude to inspect this",
    "Instead of run on Claude: inspect this",
    "Please do not ask Claude to inspect this",
    "Chip, don't send this to Claude: inspect this",
    "Can you not run this in Claude: inspect this",
    "No, run on Claude: inspect this",
  ])("rejects a negated command: %s", (text) => {
    expect(parseClaudeProxyDirective(text)).toBeNull();
  });

  it.each([
    "How do we run on Claude?",
    "Phrases like run on Claude should activate it.",
    "Can WakeWire support run on Claude?",
    "Please explain how to run on Claude.",
    "Would support for run on Claude be useful?",
    'The phrase "run on Claude" should trigger it.',
    "We should run this on Claude: inspect this",
    "I want you to use Claude to inspect this",
    "The command is Claude: inspect this",
    "Run on Claude? Then what happens?",
  ])("rejects descriptive, incidental, or question-form wording: %s", (text) => {
    expect(parseClaudeProxyDirective(text)).toBeNull();
  });

  it.each([
    "run using Claude: inspect this",
    "send to Claude: inspect this",
    "run on Claudette: inspect this",
    "Claude says: inspect this",
    "@chipmunk, run on Claude: inspect this",
    "run on Claude-based tooling",
    "runner on Claude: inspect this",
  ])("rejects unsupported lookalikes: %s", (text) => {
    expect(parseClaudeProxyDirective(text)).toBeNull();
  });
});

describe("parseCodexOverrideDirective", () => {
  it.each([
    "run on Codex: inspect the retry behavior",
    "RUN THIS ON GPT — inspect the retry behavior",
    "run in Codex\ninspect the retry behavior",
    "Run this in gpt, inspect the retry behavior",
    "use Codex to inspect the retry behavior",
    "ASK GPT TO: inspect the retry behavior",
    "send this to Codex; inspect the retry behavior",
    "Codex: inspect the retry behavior",
    "gPt:inspect the retry behavior",
  ])("matches the anchored one-message override in %s", (requestText) => {
    expect(parseCodexOverrideDirective(requestText)).toEqual({ matched: true, requestText });
  });

  it("uses host addressing only for routing and preserves the full request text", () => {
    const requestText =
      "  <@UCHIP>, could you run this on GPT:\nReview this exactly.\n\nKeep the formatting.";
    expect(parseCodexOverrideDirective(requestText, "UCHIP")).toEqual({
      matched: true,
      requestText,
    });
    expect(parseCodexOverrideDirective("<@UOTHER> run on Codex: inspect this", "UCHIP")).toBeNull();
  });

  it.each([
    "run on Codex",
    "run this on GPT:   ",
    "run in Codex?",
    "use GPT to",
    "ask Codex to --",
    "send this to GPT, please.",
    "Codex:",
    "GPT: ...",
    "Can you run on Codex?",
  ])("rejects an empty override: %s", (requestText) => {
    expect(parseCodexOverrideDirective(requestText)).toBeNull();
  });

  it.each([
    '"run on Codex: inspect this"',
    "```text\nask GPT to inspect this\n```",
    "> send this to Codex: inspect this",
    "Do not run on Codex: inspect this",
    "Please do not ask GPT to inspect this",
    "How do we run on Codex?",
    "Phrases like run on GPT should activate it.",
    "We should run this on Codex: inspect this",
    "run using Codex: inspect this",
    "send to GPT: inspect this",
    "run on GPT-5: inspect this",
    "Claude: inspect this",
  ])("rejects prose, negation, or unsupported lookalikes: %s", (requestText) => {
    expect(parseCodexOverrideDirective(requestText)).toBeNull();
  });
});

describe("parseDispatcherDefaultDirective", () => {
  it.each([
    ["set default to Claude RC", "claude-rc"],
    ["set the default agent to Claude", "claude-rc"],
    ["make Claude tmux the default", "claude-rc"],
    ["use Claude RC tmux by default.", "claude-rc"],
    ["set default to Codex", "codex"],
    ["make GPT Desktop the default", "codex"],
    ["use GPT by default!", "codex"],
  ] as const)("parses the exact default control %s", (text, defaultAgent) => {
    expect(parseDispatcherDefaultDirective(`<@UCHIP> ${text}`, "UCHIP")).toEqual({
      matched: true,
      defaultAgent,
    });
  });

  it("allows the pinned Chip mention and a polite prefix", () => {
    expect(
      parseDispatcherDefaultDirective(
        "<@UCHIP>, could you please make Claude RC the default?",
        "UCHIP",
      ),
    ).toEqual({ matched: true, defaultAgent: "claude-rc" });
    expect(parseDispatcherDefaultDirective("<@UOTHER> set default to GPT", "UCHIP")).toBeNull();
  });

  it.each([
    "set default to Claude RC",
    "Chip, set default to Claude RC",
    "@Chip set default to Claude RC",
    "set default to",
    "set default to Claude print",
    "make Claude the default and run this",
    "use GPT by default for this message",
    "do not set default to Claude RC",
    "should we make Claude the default?",
    'the phrase "set default to Claude RC" should work',
    "> set default to Codex",
    "set default to GPT-5",
  ])("rejects ambiguous or unsupported controls: %s", (text) => {
    expect(parseDispatcherDefaultDirective(text, "UCHIP")).toBeNull();
  });
});

describe("isClaudeProxyExitDirective", () => {
  it.each([
    "back to Chip",
    "Back to chip.",
    "/claude end",
    "/claude stop",
    "stop Claude proxy",
    "stop the claude proxy!",
  ])("accepts the exact active-session escape %s", (text) => {
    expect(isClaudeProxyExitDirective(text)).toBe(true);
  });

  it("allows only the pinned Slack recipient mention as transport addressing", () => {
    expect(isClaudeProxyExitDirective("<@UCHIP> back to Chip", "UCHIP")).toBe(true);
    expect(isClaudeProxyExitDirective("<@UOTHER> back to Chip", "UCHIP")).toBe(false);
  });

  it.each([
    "please go back to Chip",
    "back to Chip and summarize",
    "do not stop Claude proxy",
    'the phrase "back to Chip" closes it',
    "stop Claude",
    "Claude stop",
    "",
  ])("rejects prose or ambiguous controls: %s", (text) => {
    expect(isClaudeProxyExitDirective(text)).toBe(false);
  });
});
