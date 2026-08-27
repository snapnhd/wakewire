import { describe, expect, it } from "vitest";
import {
  isPinnedSlackAgentAuthoredEvent,
  isPinnedSlackAuthIdentity,
  isPinnedSlackUserAuthorization,
  SlackSourceConfigSchema,
} from "./source.js";

const config = SlackSourceConfigSchema.parse({
  team: "Snap",
  agentEmail: "chip@snapcorp.com",
  agentAppId: "A-SNAP",
  agentTeamId: "T-SNAP",
  agentUserId: "U-CHIP",
});

describe("isPinnedSlackUserAuthorization", () => {
  it("accepts only a matching non-bot user authorization", () => {
    expect(
      isPinnedSlackUserAuthorization(
        {
          api_app_id: "A-SNAP",
          team_id: "T-SNAP",
          authorizations: [{ team_id: "T-SNAP", user_id: "U-CHIP", is_bot: false }],
        },
        config,
      ),
    ).toBe(true);
  });

  it.each([
    { api_app_id: "A-SNAP", team_id: "T-OTHER", authorizations: [] },
    { api_app_id: "A-SNAP", team_id: "T-SNAP" },
    {
      team_id: "T-SNAP",
      authorizations: [{ team_id: "T-SNAP", user_id: "U-CHIP", is_bot: false }],
    },
    {
      api_app_id: "A-OTHER",
      team_id: "T-SNAP",
      authorizations: [{ team_id: "T-SNAP", user_id: "U-CHIP", is_bot: false }],
    },
    {
      api_app_id: "A-SNAP",
      team_id: "T-SNAP",
      authorizations: [{ team_id: "T-SNAP", user_id: "U-OTHER", is_bot: false }],
    },
    {
      api_app_id: "A-SNAP",
      team_id: "T-SNAP",
      authorizations: [{ team_id: "T-SNAP", user_id: "U-CHIP", is_bot: true }],
    },
    {
      api_app_id: "A-SNAP",
      team_id: "T-SNAP",
      authorizations: [{ team_id: "T-OTHER", user_id: "U-CHIP", is_bot: false }],
    },
  ])("rejects a mismatched or incomplete authorization: %j", (body) => {
    expect(isPinnedSlackUserAuthorization(body, config)).toBe(false);
  });

  it("fails closed before the Slack app/agent identity has been pinned", () => {
    const unpinnedApp = SlackSourceConfigSchema.parse({
      team: "Snap",
      agentEmail: "chip@snapcorp.com",
    });
    expect(
      SlackSourceConfigSchema.safeParse({
        team: "Snap",
        agentTeamId: "T-SNAP",
        agentUserId: "U-CHIP",
      }).success,
    ).toBe(false);
    expect(
      isPinnedSlackUserAuthorization(
        {
          api_app_id: "A-SNAP",
          team_id: "T-SNAP",
          authorizations: [{ team_id: "T-SNAP", user_id: "U-CHIP", is_bot: false }],
        },
        unpinnedApp,
      ),
    ).toBe(false);
  });
});

describe("isPinnedSlackAuthIdentity", () => {
  it("accepts Slack's standard user-token response without app_id", () => {
    expect(isPinnedSlackAuthIdentity({ team_id: "T-SNAP", user_id: "U-CHIP" }, config)).toBe(true);
  });

  it("rejects an explicit app mismatch or incomplete normal-user identity", () => {
    expect(
      isPinnedSlackAuthIdentity(
        { app_id: "A-OTHER", team_id: "T-SNAP", user_id: "U-CHIP" },
        config,
      ),
    ).toBe(false);
    expect(
      isPinnedSlackAuthIdentity({ team_id: "T-SNAP", user_id: "U-CHIP", bot_id: "B-BOT" }, config),
    ).toBe(false);
    expect(isPinnedSlackAuthIdentity({ team_id: "T-SNAP" }, config)).toBe(false);
  });
});

describe("isPinnedSlackAgentAuthoredEvent", () => {
  it("rejects messages authored by Chip's pinned normal account", () => {
    expect(isPinnedSlackAgentAuthoredEvent({ type: "message", user: "U-CHIP" }, config)).toBe(true);
    expect(isPinnedSlackAgentAuthoredEvent({ type: "message", user: "U-CJ" }, config)).toBe(false);
  });

  it("fails closed only after an agent user has been pinned", () => {
    const unpinned = SlackSourceConfigSchema.parse({ team: "Snap" });
    expect(isPinnedSlackAgentAuthoredEvent({ type: "message", user: "U-CHIP" }, unpinned)).toBe(
      false,
    );
  });
});
