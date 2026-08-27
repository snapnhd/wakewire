import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "../db/repos.js";
import { type SecretStore, secretNames } from "../secrets/store.js";
import { configureSlackUserCredentials, resolveSlackCredentialInputs } from "./auth-slack.js";

describe("resolveSlackCredentialInputs", () => {
  it("uses mounted environment credentials without prompting", async () => {
    const prompt = vi.fn(async () => "unused");

    await expect(
      resolveSlackCredentialInputs(
        {},
        {
          SLACK_APP_TOKEN: "  xapp-from-environment  ",
          SLACK_USER_TOKEN: "  xoxp-from-environment  ",
        },
        prompt,
      ),
    ).resolves.toEqual({
      appToken: "xapp-from-environment",
      userToken: "xoxp-from-environment",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prefers explicit CLI values over the mounted environment", async () => {
    const prompt = vi.fn(async () => "unused");

    await expect(
      resolveSlackCredentialInputs(
        { appToken: " xapp-explicit ", userToken: " xoxp-explicit " },
        {
          SLACK_APP_TOKEN: "xapp-from-environment",
          SLACK_USER_TOKEN: "xoxp-from-environment",
        },
        prompt,
      ),
    ).resolves.toEqual({ appToken: "xapp-explicit", userToken: "xoxp-explicit" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts only for a missing or blank mounted credential", async () => {
    const prompt = vi.fn(async () => "  xapp-from-prompt  ");

    await expect(
      resolveSlackCredentialInputs(
        {},
        { SLACK_APP_TOKEN: "   ", SLACK_USER_TOKEN: "xoxp-from-environment" },
        prompt,
      ),
    ).resolves.toEqual({
      appToken: "xapp-from-prompt",
      userToken: "xoxp-from-environment",
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("App-level token (xapp-…): ");
  });

  it("passes an invalid mounted token to fail-closed validation without persisting", async () => {
    const credentials = await resolveSlackCredentialInputs(
      {},
      { SLACK_APP_TOKEN: "not-an-app-token", SLACK_USER_TOKEN: "xoxp-candidate" },
      vi.fn(async () => "unused"),
    );
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    const fetch = slackFetch();

    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        ...credentials,
        secrets,
        sources,
        fetch,
      }),
    ).rejects.toThrow(/must start with xapp-/);
    expect(fetch).not.toHaveBeenCalled();
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentAppId).toBeUndefined();
  });
});

class MemorySecrets implements SecretStore {
  readonly backend = "file" as const;
  readonly values = new Map<string, string>();

  get(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }
}

class DeleteThenThrowSecrets extends MemorySecrets {
  private failed = false;

  constructor(private readonly failingName: string) {
    super();
  }

  override delete(name: string): void {
    super.delete(name);
    if (name === this.failingName && !this.failed) {
      this.failed = true;
      throw new Error("simulated credential deletion failure");
    }
  }
}

describe("configureSlackUserCredentials", () => {
  it("validates the normal account, pins immutable ids, and stores both tokens", async () => {
    const sources = new MemorySources({ team: "Snap", agentEmail: "chip@SNAPCORP.com" });
    const secrets = new MemorySecrets();
    secrets.set(secretNames.slackBotToken("slack"), "xoxb-retired");
    const fetch = slackFetch();

    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-socket",
        userToken: "xoxp-chip",
        secrets,
        sources,
        fetch,
      }),
    ).resolves.toEqual({
      appId: "A0SNAP",
      teamId: "T-SNAP",
      userId: "U-CHIP",
      email: "Chip@snapcorp.com",
      name: "Chip Byte",
    });

    expect(sources.get("slack")?.config).toMatchObject({
      agentEmail: "chip@SNAPCORP.com",
      agentAppId: "A0SNAP",
      agentTeamId: "T-SNAP",
      agentUserId: "U-CHIP",
    });
    expect(secrets.get(secretNames.slackAppToken("slack"))).toBe("xapp-1-A0SNAP-socket");
    expect(secrets.get(secretNames.slackUserToken("slack"))).toBe("xoxp-chip");
    expect(secrets.get(secretNames.slackBotToken("slack"))).toBeNull();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/apps.connections.open",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer xapp-1-A0SNAP-socket" }),
      }),
    );
  });

  it("rejects app-level and user tokens issued to different Slack apps", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch({ userAppId: "A0USER" }),
      }),
    ).rejects.toThrow(/app\/user token mismatch/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentAppId).toBeUndefined();
  });

  it("fails closed when the app token does not encode an app id", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch(),
      }),
    ).rejects.toThrow(/does not encode a verifiable app_id/);
    expect(secrets.values.size).toBe(0);
  });

  it("rejects an email mismatch without persisting candidate tokens", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch({ email: "someone@snapcorp.com" }),
      }),
    ).rejects.toThrow(/does not match configured agentEmail/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentUserId).toBeUndefined();
  });

  it("rejects bot identities without replacing existing credentials", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    secrets.set(secretNames.slackAppToken("slack"), "xapp-working");
    secrets.set(secretNames.slackUserToken("slack"), "xoxp-working");
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch({ isBot: true }),
      }),
    ).rejects.toThrow(/bot\/app identity/);
    expect(secrets.get(secretNames.slackAppToken("slack"))).toBe("xapp-working");
    expect(secrets.get(secretNames.slackUserToken("slack"))).toBe("xoxp-working");
  });

  it("rejects a normal user token without chat:write before persisting it", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch({
          userScopes: ["users:read", "reactions:write", "mpim:history"],
        }),
      }),
    ).rejects.toThrow(/missing required OAuth scope: chat:write/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentUserId).toBeUndefined();
  });

  it("rejects a normal user token without reactions:write before persisting it", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch({ userScopes: ["chat:write", "mpim:history"] }),
      }),
    ).rejects.toThrow(/missing required OAuth scope: reactions:write/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentUserId).toBeUndefined();
  });

  it("rejects a normal user token without mpim:history before persisting it", async () => {
    const sources = sourceFixture();
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch({ userScopes: ["chat:write", "reactions:write"] }),
      }),
    ).rejects.toThrow(/missing required OAuth scope: mpim:history/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentUserId).toBeUndefined();
  });

  it("rejects a different immutable user or workspace than an existing pin", async () => {
    const sources = new MemorySources({
      team: "Snap",
      agentEmail: "chip@snapcorp.com",
      agentTeamId: "T-SNAP",
      agentUserId: "U-PINNED",
    });
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch(),
      }),
    ).rejects.toThrow(/agentUserId pin mismatch/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentUserId).toBe("U-PINNED");
  });

  it("rejects a different Slack app than an existing immutable pin", async () => {
    const sources = new MemorySources({
      team: "Snap",
      agentEmail: "chip@snapcorp.com",
      agentAppId: "A-PINNED",
      agentTeamId: "T-SNAP",
      agentUserId: "U-CHIP",
    });
    const secrets = new MemorySecrets();
    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch(),
      }),
    ).rejects.toThrow(/agentAppId pin mismatch/);
    expect(secrets.values.size).toBe(0);
    expect(sources.get("slack")?.config.agentAppId).toBe("A-PINNED");
  });

  it("restores the source and all old tokens when legacy cleanup fails", async () => {
    const sources = sourceFixture();
    const botTokenName = secretNames.slackBotToken("slack");
    const secrets = new DeleteThenThrowSecrets(botTokenName);
    secrets.set(secretNames.slackAppToken("slack"), "xapp-old");
    secrets.set(secretNames.slackUserToken("slack"), "xoxp-old");
    secrets.set(botTokenName, "xoxb-old");

    await expect(
      configureSlackUserCredentials({
        sourceId: "slack",
        appToken: "xapp-1-A0SNAP-candidate",
        userToken: "xoxp-candidate",
        secrets,
        sources,
        fetch: slackFetch(),
      }),
    ).rejects.toThrow(/simulated credential deletion failure/);

    expect(sources.get("slack")?.config).toEqual({
      team: "Snap",
      agentEmail: "chip@snapcorp.com",
    });
    expect(secrets.get(secretNames.slackAppToken("slack"))).toBe("xapp-old");
    expect(secrets.get(secretNames.slackUserToken("slack"))).toBe("xoxp-old");
    expect(secrets.get(botTokenName)).toBe("xoxb-old");
  });
});

class MemorySources {
  private source: SourceRecord;

  constructor(config: Record<string, unknown>) {
    this.source = { id: "slack", kind: "slack", config, enabled: true };
  }

  get(id: string): SourceRecord | null {
    return id === this.source.id ? structuredClone(this.source) : null;
  }

  upsert(record: {
    id?: string;
    kind: SourceRecord["kind"];
    config: Record<string, unknown>;
    enabled?: boolean;
  }): SourceRecord {
    this.source = {
      id: record.id ?? this.source.id,
      kind: record.kind,
      config: structuredClone(record.config),
      enabled: record.enabled ?? true,
    };
    return this.get(this.source.id) as SourceRecord;
  }
}

function sourceFixture(): MemorySources {
  return new MemorySources({ team: "Snap", agentEmail: "chip@snapcorp.com" });
}

function slackFetch(
  options: {
    email?: string;
    isBot?: boolean;
    botId?: string;
    userAppId?: string | null;
    userScopes?: string[];
  } = {},
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/apps.connections.open")) {
      return Response.json({
        ok: true,
        url: "wss://wss-primary.slack.com/link/?ticket=test&app_id=opaque-connection-id",
      });
    }
    if (url.endsWith("/auth.test")) {
      const appId = options.userAppId ?? null;
      return Response.json(
        {
          ok: true,
          ...(appId ? { app_id: appId } : {}),
          team_id: "T-SNAP",
          user_id: "U-CHIP",
          ...(options.botId ? { bot_id: options.botId } : {}),
        },
        {
          headers: {
            "x-oauth-scopes": (
              options.userScopes ?? ["chat:write", "reactions:write", "mpim:history"]
            ).join(","),
          },
        },
      );
    }
    if (url.endsWith("/users.info")) {
      return Response.json({
        ok: true,
        user: {
          id: "U-CHIP",
          name: "chip",
          is_bot: options.isBot ?? false,
          is_app_user: false,
          profile: {
            email: options.email ?? "Chip@snapcorp.com",
            display_name: "Chip Byte",
          },
        },
      });
    }
    return Response.json({ ok: false, error: "unknown_method" });
  });
}
