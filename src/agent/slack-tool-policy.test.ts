import { describe, expect, it } from "vitest";
import {
  ALLOWED_SLACK_CODEX_APP_TOOLS,
  ALLOWED_SLACK_CONNECTOR_TOOLS,
  codexPreToolUseOutput,
  decideSlackConnectorToolUse,
} from "./slack-tool-policy.js";

const tool = (operation: string, toolInput: unknown = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: `mcp__codex_apps__slack_slack_${operation}`,
  tool_input: toolInput,
});

describe("Slack connector tool policy", () => {
  it.each([
    "get_file_upload_url",
    "complete_file_upload",
    "send_message",
    "read_thread",
    "add_reaction",
  ])("allows non-destructive operation %s", (operation) => {
    expect(decideSlackConnectorToolUse(tool(operation))).toEqual({
      applies: true,
      allowed: true,
    });
    expect(ALLOWED_SLACK_CONNECTOR_TOOLS.has(operation)).toBe(true);
  });

  it.each([
    "delete_message",
    "edit_message",
    "leave_conversation",
    "update_canvas",
    "update_user_profile",
  ])("blocks destructive or overwrite-style operation %s", (operation) => {
    const decision = decideSlackConnectorToolUse(tool(operation));
    expect(decision.allowed).toBe(false);
    expect(JSON.stringify(codexPreToolUseOutput(decision))).toContain(
      '"permissionDecision":"deny"',
    );
  });

  it("exports exact default-deny Codex app tool names including upload", () => {
    expect(ALLOWED_SLACK_CODEX_APP_TOOLS).toContain("slack.slack_complete_file_upload");
    expect(ALLOWED_SLACK_CODEX_APP_TOOLS).toContain("slack.slack_get_file_upload_url");
    expect(ALLOWED_SLACK_CODEX_APP_TOOLS).not.toContain("slack.slack_delete_message");
    expect(ALLOWED_SLACK_CODEX_APP_TOOLS).not.toContain("slack.slack_update_canvas");
  });

  it("fails closed for unknown Slack methods and malformed hook input", () => {
    expect(decideSlackConnectorToolUse(tool("future_method")).allowed).toBe(false);
    expect(decideSlackConnectorToolUse({}).allowed).toBe(false);
  });

  it("does not affect non-Slack tools", () => {
    expect(
      decideSlackConnectorToolUse({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__codex_apps__github_get_repo",
        tool_input: {},
      }),
    ).toEqual({ applies: false, allowed: true });
  });
});
