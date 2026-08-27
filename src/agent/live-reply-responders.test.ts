import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import {
  type GmailFinalAccessTokenProvider,
  type SlackFinalWebClientFactory,
  SourceScopedGmailFinalResponder,
  SourceScopedSlackFinalResponder,
} from "./live-reply-responders.js";
import { PermanentSourceReplyError } from "./reply-responders.js";
import type { SourceReplyJob } from "./store.js";

function job(id: string, threadTs: string): SourceReplyJob {
  return {
    id,
    requestId: `request-${threadTs}`,
    sourceId: "slack-snap",
    provider: "slack",
    replyKind: "thread-reply",
    destination: `T1:C1:${threadTs}`,
    payload: { channel: "C1", threadTs, text: `reply ${threadTs}` },
    requestOutcome: "completed",
    status: "sending",
    attemptCount: 1,
    nextAttemptAt: null,
    providerResultId: null,
    error: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-07-28T00:01:00.000Z",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function channelJob(): SourceReplyJob {
  return {
    ...job("44444444-4444-4444-8444-444444444444", "unused"),
    requestId: "request-daily-report",
    replyKind: "channel-message",
    destination: "T1:C1",
    payload: { channel: "C1", text: "Daily report" },
  };
}

function secretStore(token: string): SecretStore {
  const values = new Map([[secretNames.slackUserToken("slack-snap"), token]]);
  return {
    backend: "file",
    get: (name) => values.get(name) ?? null,
    set: (name, value) => {
      values.set(name, value);
    },
    delete: (name) => {
      values.delete(name);
    },
  };
}

function gmailSecretStore(): SecretStore {
  const values = new Map([
    [secretNames.gmailClientId("gmail-chip"), "client-id"],
    [secretNames.gmailClientSecret("gmail-chip"), "client-secret"],
    [secretNames.gmailRefreshToken("gmail-chip"), "refresh-token"],
  ]);
  return {
    backend: "file",
    get: (name) => values.get(name) ?? null,
    set: (name, value) => {
      values.set(name, value);
    },
    delete: (name) => {
      values.delete(name);
    },
  };
}

function gmailJob(): SourceReplyJob {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    requestId: "request-gmail",
    sourceId: "gmail-chip",
    provider: "gmail",
    replyKind: "thread-reply",
    destination: "<incoming@example.com>",
    payload: {
      originalMessageId: "<incoming@example.com>",
      to: "cj@snapcorp.com",
      subject: "Re: Test",
      text: "Completed answer",
      inReplyTo: "<incoming@example.com>",
      references: ["<root@example.com>", "<incoming@example.com>"],
    },
    requestOutcome: "completed",
    status: "sending",
    attemptCount: 1,
    nextAttemptAt: null,
    providerResultId: null,
    error: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-07-28T00:01:00.000Z",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("SourceScopedSlackFinalResponder", () => {
  it("shares a no-retry client and serializes all sends for one source", async () => {
    const sources = createStores(openDatabase(":memory:")).sources;
    sources.upsert({
      id: "slack-snap",
      kind: "slack",
      enabled: true,
      config: {
        team: "Snap",
        agentEmail: "chip@snapcorp.com",
        agentAppId: "A1",
        agentTeamId: "T1",
        agentUserId: "U-CHIP",
      },
    });

    const calls: string[] = [];
    let releaseFirstPost: () => void = () => {};
    let markFirstPostStarted: () => void = () => {};
    const firstPostGate = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    const firstPostStarted = new Promise<void>((resolve) => {
      markFirstPostStarted = resolve;
    });
    const factory = vi.fn<SlackFinalWebClientFactory>((_token, _options) => ({
      async apiCall(method, input) {
        if (method === "conversations.replies") {
          const threadTs = String(input.ts);
          calls.push(`reconcile:${threadTs}`);
          return { ok: true, messages: [] };
        }
        const threadTs = String(input.thread_ts);
        calls.push(`post:${threadTs}`);
        if (threadTs === "1.0") {
          markFirstPostStarted();
          await firstPostGate;
        }
        return { ok: true, channel: "C1", ts: `${threadTs}-reply` };
      },
    }));
    const responder = new SourceScopedSlackFinalResponder(
      secretStore("xoxp-test"),
      sources,
      factory,
    );

    const first = responder.send(job("11111111-1111-4111-8111-111111111111", "1.0"));
    const second = responder.send(job("22222222-2222-4222-8222-222222222222", "2.0"));
    await firstPostStarted;
    expect(calls).toEqual(["reconcile:1.0", "post:1.0"]);

    releaseFirstPost();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { providerResultId: "slack:C1:1.0-reply" },
      { providerResultId: "slack:C1:2.0-reply" },
    ]);
    expect(calls).toEqual(["reconcile:1.0", "post:1.0", "reconcile:2.0", "post:2.0"]);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[1]).toEqual({
      timeout: 5_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  });

  it("routes a channel-message through conversations.history and top-level chat.postMessage", async () => {
    const sources = createStores(openDatabase(":memory:")).sources;
    sources.upsert({
      id: "slack-snap",
      kind: "slack",
      enabled: true,
      config: {
        team: "Snap",
        agentEmail: "chip@snapcorp.com",
        agentAppId: "A1",
        agentTeamId: "T1",
        agentUserId: "U-CHIP",
      },
    });
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const factory = vi.fn<SlackFinalWebClientFactory>((_token, _options) => ({
      async apiCall(method, input) {
        calls.push({ method, input });
        if (method === "conversations.history") return { ok: true, messages: [] };
        return { ok: true, channel: "C1", ts: "3.0" };
      },
    }));
    const responder = new SourceScopedSlackFinalResponder(
      secretStore("xoxp-test"),
      sources,
      factory,
    );

    await expect(responder.send(channelJob())).resolves.toEqual({
      providerResultId: "slack:C1:3.0",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: "conversations.history",
      input: {
        channel: "C1",
        limit: 100,
        oldest: expect.any(String),
        inclusive: true,
      },
    });
    expect(calls[1]).toEqual({
      method: "chat.postMessage",
      input: {
        channel: "C1",
        text: "Daily report",
        client_msg_id: "44444444-4444-4444-8444-444444444444",
        mrkdwn: false,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      },
    });
    expect(calls[1]?.input).not.toHaveProperty("thread_ts");
  });
});

describe("SourceScopedGmailFinalResponder", () => {
  it("uses source OAuth, sends once in the original thread, and reconciles a retry", async () => {
    const sources = createStores(openDatabase(":memory:")).sources;
    sources.upsert({
      id: "gmail-chip",
      kind: "gmail",
      enabled: true,
      config: {
        label: "Chip",
        auth: { kind: "gmail-oauth", user: "chip@snapcorp.com" },
        state: {},
      },
    });
    const accessToken = vi.fn<GmailFinalAccessTokenProvider>(async () => "access-token");
    let sent = false;
    let postedRaw = "";
    let postCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST") {
        postCount += 1;
        const body = JSON.parse(String(init?.body)) as { raw: string; threadId: string };
        expect(body.threadId).toBe("thread-1");
        postedRaw = Buffer.from(body.raw, "base64url").toString("utf8");
        sent = true;
        return Response.json({ id: "sent-1", threadId: "thread-1" });
      }
      const query = url.searchParams.get("q");
      if (query === "rfc822msgid:<incoming@example.com>") {
        return Response.json({ messages: [{ id: "incoming-1", threadId: "thread-1" }] });
      }
      if (
        query === "rfc822msgid:<wakewire-reply-33333333-3333-4333-8333-333333333333@wakewire.local>"
      ) {
        return Response.json(sent ? { messages: [{ id: "sent-1", threadId: "thread-1" }] } : {});
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const responder = new SourceScopedGmailFinalResponder(
      gmailSecretStore(),
      sources,
      fetchImpl,
      accessToken,
    );

    await expect(responder.send(gmailJob())).resolves.toEqual({
      providerResultId: "gmail:sent-1",
    });
    await expect(responder.send(gmailJob())).resolves.toEqual({
      providerResultId: "gmail:sent-1",
    });

    expect(postCount).toBe(1);
    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(accessToken).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(postedRaw).toContain("From: chip@snapcorp.com\r\n");
    expect(postedRaw).toContain("To: cj@snapcorp.com\r\n");
    expect(postedRaw).toContain(
      "Message-ID: <wakewire-reply-33333333-3333-4333-8333-333333333333@wakewire.local>\r\n",
    );
    expect(postedRaw).toContain("In-Reply-To: <incoming@example.com>\r\n");
    expect(postedRaw).toContain("\r\n\r\nCompleted answer\r\n");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("reconciles a recorded Gmail send after the client loses the POST response", async () => {
    const sources = createStores(openDatabase(":memory:")).sources;
    sources.upsert({
      id: "gmail-chip",
      kind: "gmail",
      enabled: true,
      config: {
        label: "Chip",
        auth: { kind: "gmail-oauth", user: "chip@snapcorp.com" },
        state: {},
      },
    });
    let providerRecordedSend = false;
    let postCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST") {
        postCount += 1;
        providerRecordedSend = true;
        throw new Error("connection reset after provider accepted the message");
      }
      const query = url.searchParams.get("q");
      if (query === "rfc822msgid:<incoming@example.com>") {
        return Response.json({ messages: [{ id: "incoming-1", threadId: "thread-1" }] });
      }
      if (
        query === "rfc822msgid:<wakewire-reply-33333333-3333-4333-8333-333333333333@wakewire.local>"
      ) {
        return Response.json(
          providerRecordedSend
            ? { messages: [{ id: "sent-after-reset", threadId: "thread-1" }] }
            : {},
        );
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const responder = new SourceScopedGmailFinalResponder(
      gmailSecretStore(),
      sources,
      fetchImpl,
      async () => "access-token",
    );

    await expect(responder.send(gmailJob())).rejects.toThrow(
      "connection reset after provider accepted the message",
    );
    await expect(responder.send(gmailJob())).resolves.toEqual({
      providerResultId: "gmail:sent-after-reset",
    });
    expect(postCount).toBe(1);
  });

  it("refuses password-authenticated Gmail sources for final replies", async () => {
    const sources = createStores(openDatabase(":memory:")).sources;
    sources.upsert({
      id: "gmail-chip",
      kind: "gmail",
      enabled: true,
      config: {
        label: "Chip",
        auth: {
          kind: "imap-password",
          user: "chip@snapcorp.com",
          host: "imap.gmail.com",
          port: 993,
          secure: true,
        },
        state: {},
      },
    });
    const accessToken = vi.fn<GmailFinalAccessTokenProvider>(async () => "unused");
    const responder = new SourceScopedGmailFinalResponder(
      gmailSecretStore(),
      sources,
      globalThis.fetch,
      accessToken,
    );

    await expect(responder.send(gmailJob())).rejects.toBeInstanceOf(PermanentSourceReplyError);
    expect(accessToken).not.toHaveBeenCalled();
  });
});
