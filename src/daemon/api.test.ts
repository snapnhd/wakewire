import { describe, expect, it } from "vitest";
import { InvalidSourceReplyEventError, UnsupportedSourceReplyEventError } from "../agent/reply.js";
import {
  InvalidScheduledChannelDeliveryError,
  ScheduledChannelDeliveryAuthorizationError,
  ScheduledChannelDeliveryConflictError,
  ScheduledChannelDeliveryNotFoundError,
  type ScheduledChannelDeliveryService,
} from "../agent/scheduled-channel-delivery.js";
import {
  InvalidScheduledFollowupError,
  ScheduledFollowupAuthorizationError,
  ScheduledFollowupConflictError,
  ScheduledFollowupNotFoundError,
  type ScheduledFollowupService,
} from "../agent/scheduled-followup.js";
import type { SourceRecord } from "../db/repos.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import {
  createApi,
  removeSourceSecrets,
  resolveSlackSetupConfig,
  slackSetupInstructions,
} from "./api.js";

class RecordingSecretStore implements SecretStore {
  readonly backend = "file" as const;
  readonly deleted: string[] = [];

  get(): string | null {
    return null;
  }

  set(): void {}

  delete(name: string): void {
    this.deleted.push(name);
  }
}

function source(kind: SourceRecord["kind"], config: Record<string, unknown> = {}): SourceRecord {
  return { id: "source-1", kind, config, enabled: true };
}

describe("Slack setup instructions", () => {
  it("configures user events for Chip's existing normal account", () => {
    const instructions = slackSetupInstructions("slack-snap").join("\n");

    expect(instructions).toContain("users:read.email");
    expect(instructions).toContain("reactions:write");
    expect(instructions).toContain("im:history");
    expect(instructions).toContain("mpim:history");
    expect(instructions).toContain("chat:write");
    expect(instructions).toContain("message.im");
    expect(instructions).toContain("message.mpim");
    expect(instructions).toContain("events on behalf of users");
    expect(instructions).toContain("xoxp-");
    expect(instructions).toContain("do not add a bot user");
    expect(instructions).not.toContain("Bot Token Scopes");
    expect(instructions).not.toContain("enable the Messages Tab");
  });
});

describe("resolveSlackSetupConfig", () => {
  it("uses delivery defaults for a new source", () => {
    expect(resolveSlackSetupConfig(null, { team: "snap" })).toEqual({
      team: "snap",
      agentEmail: "chip@snapcorp.com",
      includeBotMessages: false,
      includeDirectMessages: true,
      includeChannelMentions: true,
    });
  });

  it("preserves omitted delivery settings and every identity pin on repeat setup", () => {
    const existing = source("slack", {
      team: "snap",
      agentEmail: "chip@snapcorp.com",
      includeBotMessages: true,
      includeDirectMessages: false,
      includeChannelMentions: false,
      agentTeamId: "T123",
      agentUserId: "U123",
      agentAppId: "A123",
    });

    expect(resolveSlackSetupConfig(existing, { team: "snap" })).toEqual(existing.config);
  });

  it("honors explicit delivery changes while preserving pins for the same email", () => {
    const existing = source("slack", {
      team: "snap",
      agentEmail: "chip@snapcorp.com",
      includeBotMessages: false,
      includeDirectMessages: false,
      includeChannelMentions: true,
      agentTeamId: "T123",
      agentUserId: "U123",
      agentAppId: "A123",
    });

    expect(
      resolveSlackSetupConfig(existing, {
        team: "snap",
        agentEmail: "CHIP@snapcorp.com",
        includeDirectMessages: true,
      }),
    ).toEqual({
      ...existing.config,
      agentEmail: "CHIP@snapcorp.com",
      includeDirectMessages: true,
    });
  });

  it("drops identity pins when the agent email changes", () => {
    const existing = source("slack", {
      team: "snap",
      agentEmail: "chip@snapcorp.com",
      includeBotMessages: true,
      includeDirectMessages: false,
      includeChannelMentions: false,
      agentTeamId: "T123",
      agentUserId: "U123",
      agentAppId: "A123",
    });

    expect(
      resolveSlackSetupConfig(existing, {
        team: "snap",
        agentEmail: "someone-else@snapcorp.com",
      }),
    ).toEqual({
      team: "snap",
      agentEmail: "someone-else@snapcorp.com",
      includeBotMessages: true,
      includeDirectMessages: false,
      includeChannelMentions: false,
    });
  });
});

describe("removeSourceSecrets", () => {
  it("removes both GitHub ingress and acknowledgment credentials", () => {
    const secrets = new RecordingSecretStore();

    removeSourceSecrets(secrets, source("github"));

    expect(secrets.deleted).toEqual([
      secretNames.githubWebhookSecret("source-1"),
      secretNames.githubApiToken("source-1"),
    ]);
  });

  it("removes Slack's app and user tokens plus the retired bot-token slot", () => {
    const secrets = new RecordingSecretStore();

    removeSourceSecrets(secrets, source("slack"));

    expect(secrets.deleted).toEqual([
      secretNames.slackAppToken("source-1"),
      secretNames.slackUserToken("source-1"),
      secretNames.slackBotToken("source-1"),
    ]);
  });

  it("removes the Linear agent token for a Linear-named webhook", () => {
    const secrets = new RecordingSecretStore();

    removeSourceSecrets(secrets, source("webhook", { name: " Linear " }));

    expect(secrets.deleted).toEqual([
      secretNames.webhookSecret("source-1"),
      secretNames.linearAgentToken("source-1"),
      secretNames.linearAgentTokenExpiresAt("source-1"),
      secretNames.linearAgentClientId("source-1"),
      secretNames.linearAgentClientSecret("source-1"),
    ]);
  });

  it("does not remove a Linear token for an unrelated generic webhook", () => {
    const secrets = new RecordingSecretStore();

    removeSourceSecrets(secrets, source("webhook", { name: "sentry" }));

    expect(secrets.deleted).toEqual([secretNames.webhookSecret("source-1")]);
  });
});

describe("scheduled follow-up API", () => {
  it("forwards exact registration and completion fields to the service", async () => {
    const calls: unknown[] = [];
    const service = {
      register(input: unknown) {
        calls.push(["register", input]);
        return {
          binding: {
            id: "followup-1",
            automationId: "monitor-sheet",
            originRequestId: "must-not-leak",
            originCodexTurnId: "must-not-leak",
            originCorrelationMarker: "must-not-leak",
          },
          duplicate: false,
          source: "slack",
        };
      },
      complete(input: unknown) {
        calls.push(["complete", input]);
        return {
          binding: { id: "followup-1", automationId: "monitor-sheet" },
          request: { id: "terminal-1", event: { payload: "must-not-leak" } },
          reply: {
            id: "reply-1",
            status: "pending",
            provider: "slack",
            error: null,
            spec: { channel: "must-not-leak", threadTs: "must-not-leak" },
          },
          duplicate: false,
        };
      },
      status(id: string) {
        calls.push(["status", id]);
        return {
          binding: {
            id,
            automationId: "monitor-sheet",
            originCodexThreadId: "thread-1",
            originRequestId: "must-not-leak",
            originCodexTurnId: "must-not-leak",
            originCorrelationMarker: "must-not-leak",
            completedAt: null,
          },
          terminal: null,
        };
      },
    } as unknown as ScheduledFollowupService;
    const app = scheduledFollowupApi(service);

    const registered = await authorizedRequest(app, "/api/scheduled-followups/register", {
      automationId: "monitor-sheet",
      originRequestId: "request-1",
      currentCodexThreadId: "thread-1",
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({
      followupId: "followup-1",
      automationId: "monitor-sheet",
      source: "slack",
      duplicate: false,
    });

    const completed = await authorizedRequest(app, "/api/scheduled-followups/followup-1/complete", {
      automationId: "monitor-sheet",
      currentCodexThreadId: "thread-1",
      message: "Access approved",
    });
    expect(completed.status).toBe(201);
    expect(await completed.json()).toEqual({
      followupId: "followup-1",
      automationId: "monitor-sheet",
      accepted: true,
      duplicate: false,
      terminalRequestId: "terminal-1",
      sourceReply: {
        id: "reply-1",
        status: "pending",
        provider: "slack",
        error: null,
      },
    });

    const status = await app.request("/api/scheduled-followups/followup-1", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(status.status).toBe(200);
    const publicStatus = await status.json();
    expect(publicStatus).toEqual({
      followupId: "followup-1",
      automationId: "monitor-sheet",
      originCodexThreadId: "thread-1",
      completedAt: null,
      terminal: null,
    });
    expect(JSON.stringify(publicStatus)).not.toContain("must-not-leak");
    expect(calls).toEqual([
      [
        "register",
        {
          automationId: "monitor-sheet",
          originRequestId: "request-1",
          currentCodexThreadId: "thread-1",
        },
      ],
      [
        "complete",
        {
          followupId: "followup-1",
          automationId: "monitor-sheet",
          currentCodexThreadId: "thread-1",
          message: "Access approved",
        },
      ],
      ["status", "followup-1"],
    ]);
  });

  it.each([
    [new ScheduledFollowupNotFoundError("missing"), 404],
    [new ScheduledFollowupAuthorizationError("denied"), 403],
    [new ScheduledFollowupConflictError("conflict"), 409],
    [new InvalidScheduledFollowupError("invalid"), 400],
    [new InvalidSourceReplyEventError("malformed source"), 400],
    [new UnsupportedSourceReplyEventError("unsupported source"), 400],
  ])("maps %s to HTTP %i", async (error, expectedStatus) => {
    const service = {
      status() {
        throw error;
      },
    } as unknown as ScheduledFollowupService;
    const response = await scheduledFollowupApi(service).request(
      "/api/scheduled-followups/followup-1",
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ error: error.message });
  });

  it("rejects unauthenticated and malformed requests", async () => {
    const service = {} as ScheduledFollowupService;
    const app = scheduledFollowupApi(service);
    const unauthenticated = await app.request("/api/scheduled-followups/followup-1");
    expect(unauthenticated.status).toBe(401);

    const malformed = await authorizedRequest(app, "/api/scheduled-followups/register", {
      automationId: "monitor-sheet",
    });
    expect(malformed.status).toBe(400);
  });
});

describe("scheduled channel delivery API", () => {
  it("forwards exact callback fields and exposes only safe recurring status", async () => {
    const calls: unknown[] = [];
    const service = {
      register(input: unknown) {
        calls.push(["register", input]);
        return {
          binding: {
            id: "delivery-1",
            automationId: "daily-fraud-report",
            originRequestId: "must-not-leak",
            slackTeamId: "must-not-leak",
            slackChannelId: "must-not-leak",
          },
          duplicate: false,
          source: "slack",
        };
      },
      send(input: unknown) {
        calls.push(["send", input]);
        return {
          binding: { id: "delivery-1", automationId: "daily-fraud-report" },
          occurrenceKey: "2026-07-29@America/Chicago",
          request: { id: "request-1", event: { payload: "must-not-leak" } },
          reply: {
            id: "reply-1",
            status: "pending",
            provider: "slack",
            error: null,
            payload: { channel: "must-not-leak", text: "must-not-leak" },
          },
          duplicate: false,
        };
      },
      status(id: string) {
        calls.push(["status", id]);
        return {
          binding: {
            id,
            automationId: "daily-fraud-report",
            originCodexThreadId: "thread-1",
            originRequestId: "must-not-leak",
            slackTeamId: "must-not-leak",
            slackChannelId: "must-not-leak",
          },
          source: "slack",
          occurrences: [
            {
              occurrence: {
                occurrenceKey: "2026-07-29@America/Chicago",
                createdAt: "2026-07-30T13:00:00.000Z",
                requestId: "must-not-leak",
                messageSha256: "must-not-leak",
              },
              request: { id: "request-1", status: "submitted" },
              sourceReply: {
                id: "reply-1",
                status: "pending",
                provider: "slack",
                error: null,
              },
            },
          ],
        };
      },
    } as unknown as ScheduledChannelDeliveryService;
    const app = scheduledChannelDeliveryApi(service);

    const registered = await authorizedRequest(app, "/api/scheduled-channel-deliveries/register", {
      automationId: "daily-fraud-report",
      originRequestId: "origin-1",
      currentCodexThreadId: "thread-1",
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({
      deliveryId: "delivery-1",
      automationId: "daily-fraud-report",
      source: "slack",
      duplicate: false,
    });

    const sent = await authorizedRequest(app, "/api/scheduled-channel-deliveries/delivery-1/send", {
      automationId: "daily-fraud-report",
      currentCodexThreadId: "thread-1",
      occurrenceKey: "2026-07-29@America/Chicago",
      message: "Daily fraud report",
    });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toEqual({
      deliveryId: "delivery-1",
      automationId: "daily-fraud-report",
      occurrenceKey: "2026-07-29@America/Chicago",
      accepted: true,
      duplicate: false,
      requestId: "request-1",
      sourceReply: {
        id: "reply-1",
        status: "pending",
        provider: "slack",
        error: null,
      },
    });

    const status = await app.request("/api/scheduled-channel-deliveries/delivery-1", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(status.status).toBe(200);
    const publicStatus = await status.json();
    expect(publicStatus).toEqual({
      deliveryId: "delivery-1",
      automationId: "daily-fraud-report",
      originCodexThreadId: "thread-1",
      source: "slack",
      occurrences: [
        {
          occurrenceKey: "2026-07-29@America/Chicago",
          createdAt: "2026-07-30T13:00:00.000Z",
          request: { id: "request-1", status: "submitted" },
          sourceReply: {
            id: "reply-1",
            status: "pending",
            provider: "slack",
            error: null,
          },
        },
      ],
    });
    expect(JSON.stringify(publicStatus)).not.toContain("must-not-leak");
    expect(calls).toEqual([
      [
        "register",
        {
          automationId: "daily-fraud-report",
          originRequestId: "origin-1",
          currentCodexThreadId: "thread-1",
        },
      ],
      [
        "send",
        {
          deliveryId: "delivery-1",
          automationId: "daily-fraud-report",
          currentCodexThreadId: "thread-1",
          occurrenceKey: "2026-07-29@America/Chicago",
          message: "Daily fraud report",
        },
      ],
      ["status", "delivery-1"],
    ]);
  });

  it.each([
    [new ScheduledChannelDeliveryNotFoundError("missing"), 404],
    [new ScheduledChannelDeliveryAuthorizationError("denied"), 403],
    [new ScheduledChannelDeliveryConflictError("conflict"), 409],
    [new InvalidScheduledChannelDeliveryError("invalid"), 400],
    [new InvalidSourceReplyEventError("malformed source"), 400],
    [new UnsupportedSourceReplyEventError("unsupported source"), 400],
  ])("maps %s to HTTP %i", async (error, expectedStatus) => {
    const service = {
      status() {
        throw error;
      },
    } as unknown as ScheduledChannelDeliveryService;
    const response = await scheduledChannelDeliveryApi(service).request(
      "/api/scheduled-channel-deliveries/delivery-1",
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ error: error.message });
  });

  it("rejects unauthenticated and destination-bearing callback requests", async () => {
    const service = {} as ScheduledChannelDeliveryService;
    const app = scheduledChannelDeliveryApi(service);
    const unauthenticated = await app.request("/api/scheduled-channel-deliveries/delivery-1");
    expect(unauthenticated.status).toBe(401);

    const destinationBearing = await authorizedRequest(
      app,
      "/api/scheduled-channel-deliveries/delivery-1/send",
      {
        automationId: "daily-fraud-report",
        currentCodexThreadId: "thread-1",
        occurrenceKey: "2026-07-29@America/Chicago",
        message: "Daily fraud report",
        channel: "C-RETARGETED",
      },
    );
    expect(destinationBearing.status).toBe(400);
  });
});

function scheduledFollowupApi(scheduledFollowups: ScheduledFollowupService) {
  return createApi({
    config: { apiToken: "test-token" },
    scheduledFollowups,
  } as unknown as Parameters<typeof createApi>[0]);
}

function scheduledChannelDeliveryApi(scheduledChannelDeliveries: ScheduledChannelDeliveryService) {
  return createApi({
    config: { apiToken: "test-token" },
    scheduledChannelDeliveries,
  } as unknown as Parameters<typeof createApi>[0]);
}

function authorizedRequest(
  app: ReturnType<typeof createApi>,
  path: string,
  body: unknown,
): Response | Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
