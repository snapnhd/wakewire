import { z } from "zod";

const SLACK_CONNECTOR_TOOL_PREFIX = "mcp__codex_apps__slack_slack_";

export const CODEX_SLACK_APP_ID = "asdk_app_69a1d78e929881919bba0dbda1f6436d";

/**
 * Slack connector operations that create or append data without deleting,
 * replacing, or relinquishing access. Any new Slack connector method is denied
 * until an operator explicitly classifies it here.
 */
export const ALLOWED_SLACK_CONNECTOR_TOOLS = new Set([
  "add_reaction",
  "complete_file_upload",
  "create_canvas",
  "create_conversation",
  "create_reminder",
  "get_file_upload_url",
  "get_reactions",
  "invite_to_conversation",
  "join_conversation",
  "list_channel_members",
  "list_starred_items",
  "list_user_conversations",
  "list_user_groups",
  "list_workspaces",
  "read_canvas",
  "read_channel",
  "read_file",
  "read_thread",
  "read_user_profile",
  "schedule_message",
  "search_channels",
  "search_emojis",
  "search_public",
  "search_public_and_private",
  "search_users",
  "send_message",
  "send_message_draft",
]);

/** Exact raw tool names used by Codex's native per-app exposure policy. */
export const ALLOWED_SLACK_CODEX_APP_TOOLS = [...ALLOWED_SLACK_CONNECTOR_TOOLS]
  .map((operation) => `slack.slack_${operation}`)
  .sort();

const HookInputSchema = z
  .object({
    hook_event_name: z.literal("PreToolUse"),
    tool_name: z.string().min(1),
    tool_input: z.unknown(),
  })
  .passthrough();

export interface SlackToolPolicyDecision {
  applies: boolean;
  allowed: boolean;
  reason?: string | undefined;
}

/**
 * Fail-closed policy for OpenAI's Slack connector surface. Upload is a
 * two-step get/complete flow and is intentionally allowed. Destructive and
 * overwrite-style methods (including message edit/delete, channel leave,
 * canvas update, and profile update) are rejected before the MCP call reaches
 * Slack. This hook is defense in depth; the enforceable boundary for Codex's
 * bundled app connector is its native default-deny per-app tool policy.
 */
export function decideSlackConnectorToolUse(input: unknown): SlackToolPolicyDecision {
  const parsed = HookInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      applies: true,
      allowed: false,
      reason: "WakeWire blocked a malformed Slack connector tool request.",
    };
  }

  const { tool_name: toolName } = parsed.data;
  if (!toolName.startsWith(SLACK_CONNECTOR_TOOL_PREFIX)) {
    return { applies: false, allowed: true };
  }

  const operation = toolName.slice(SLACK_CONNECTOR_TOOL_PREFIX.length);
  if (ALLOWED_SLACK_CONNECTOR_TOOLS.has(operation)) {
    return { applies: true, allowed: true };
  }

  return {
    applies: true,
    allowed: false,
    reason: `WakeWire blocked Slack connector operation ${operation || "unknown"}; it is not on the non-destructive allowlist.`,
  };
}

export function codexPreToolUseOutput(decision: SlackToolPolicyDecision): Record<string, unknown> {
  if (!decision.applies || decision.allowed) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        decision.reason ?? "WakeWire blocked a non-allowlisted Slack connector operation.",
    },
  };
}
