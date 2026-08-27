import { describe, expect, it, vi } from "vitest";
import { PermanentSourceReplyError } from "../reply-responders.js";
import type { SourceReplyJob } from "../store.js";
import type { SlackFinalReplyClient } from "./slack-reply.js";
import { SlackFinalReplyResponder } from "./slack-reply.js";

const IDENTITY = { teamId: "T1", userId: "U-CHIP" };

function job(overrides: Partial<SourceReplyJob> = {}): SourceReplyJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requestId: "request-1",
    sourceId: "slack-snap",
    provider: "slack",
    replyKind: "thread-reply",
    destination: "T1:C1:1.0",
    payload: { channel: "C1", threadTs: "1.0", text: "Hello <@U123>" },
    requestOutcome: "completed",
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: null,
    providerResultId: null,
    error: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function client(
  overrides: {
    postMessage?: SlackFinalReplyClient["chat"]["postMessage"];
    replies?: SlackFinalReplyClient["conversations"]["replies"];
    history?: NonNullable<SlackFinalReplyClient["conversations"]["history"]>;
  } = {},
): SlackFinalReplyClient {
  return {
    chat: {
      postMessage:
        overrides.postMessage ?? vi.fn(async () => ({ ok: true, channel: "C1", ts: "2.0" })),
    },
    conversations: {
      replies: overrides.replies ?? vi.fn(async () => ({ ok: true, messages: [] })),
      history: overrides.history ?? vi.fn(async () => ({ ok: true, messages: [] })),
    },
  };
}

describe("SlackFinalReplyResponder", () => {
  it("reconciles, then posts once to the exact thread with inert text and stable identity", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "2.0" }));
    const replies = vi.fn(async () => ({ ok: true, messages: [] }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);

    await expect(responder.send(job())).resolves.toEqual({
      providerResultId: "slack:C1:2.0",
    });
    expect(replies).toHaveBeenCalledWith({ channel: "C1", ts: "1.0", limit: 100 });
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1.0",
      text: "Hello <@U123>",
      client_msg_id: "11111111-1111-4111-8111-111111111111",
      reply_broadcast: false,
      mrkdwn: false,
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("strips linked ChatGPT attribution from a persisted payload before posting", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "2.0" }));
    const replies = vi.fn(async () => ({ ok: true, messages: [] }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);

    await responder.send(
      job({
        payload: {
          channel: "C1",
          threadTs: "1.0",
          text: "Done.\n\n**Sent using** [**@ChatGPT**](https://snapnhd.slack.com/team/U0BKXQ0M4AK)",
        },
      }),
    );

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Done." }));
  });

  it("posts a recurring channel message without a thread through the pinned Chip identity", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "3.0" }));
    const history = vi.fn(async () => ({ ok: true, messages: [] }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, history }), IDENTITY);

    await expect(
      responder.send(
        job({
          replyKind: "channel-message",
          destination: "T1:C1",
          payload: { channel: "C1", text: "Daily report" },
        }),
      ),
    ).resolves.toEqual({ providerResultId: "slack:C1:3.0" });

    expect(history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 100,
      oldest: expect.any(String),
      inclusive: true,
    });
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "Daily report",
      client_msg_id: "11111111-1111-4111-8111-111111111111",
      mrkdwn: false,
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("reconciles an exact prior top-level channel message without posting again", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "new" }));
    const history = vi.fn(async () => ({
      ok: true,
      messages: [
        {
          ts: "3.0",
          user: "U-CHIP",
          text: "Daily report",
          client_msg_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, history }), IDENTITY);

    await expect(
      responder.send(
        job({
          replyKind: "channel-message",
          destination: "T1:C1",
          payload: { channel: "C1", text: "Daily report" },
        }),
      ),
    ).resolves.toEqual({ providerResultId: "slack:C1:3.0" });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("fails closed when a channel-message id resolves to a thread reply", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "new" }));
    const history = vi.fn(async () => ({
      ok: true,
      messages: [
        {
          ts: "3.1",
          thread_ts: "3.0",
          user: "U-CHIP",
          text: "Daily report",
          client_msg_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, history }), IDENTITY);

    await expect(
      responder.send(
        job({
          replyKind: "channel-message",
          destination: "T1:C1",
          payload: { channel: "C1", text: "Daily report" },
        }),
      ),
    ).rejects.toBeInstanceOf(PermanentSourceReplyError);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("recovers an exact prior reply through bounded pagination without posting again", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "new" }));
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [],
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            ts: "2.0",
            thread_ts: "1.0",
            user: "U-CHIP",
            text: "Hello <@U123>",
            client_msg_id: "11111111-1111-4111-8111-111111111111",
          },
        ],
      });
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);

    await expect(responder.send(job())).resolves.toEqual({
      providerResultId: "slack:C1:2.0",
    });
    expect(replies).toHaveBeenNthCalledWith(2, {
      channel: "C1",
      ts: "1.0",
      limit: 100,
      cursor: "page-2",
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("fails closed when the stable id belongs to different text or author", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "new" }));
    const replies = vi.fn(async () => ({
      ok: true,
      messages: [
        {
          ts: "2.0",
          thread_ts: "1.0",
          user: "U-OTHER",
          text: "different",
          client_msg_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);

    await expect(responder.send(job())).rejects.toBeInstanceOf(PermanentSourceReplyError);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("fails closed when bounded pagination cannot prove the id is absent", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "new" }));
    const replies = vi.fn(async () => ({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "more" },
    }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);

    await expect(responder.send(job())).rejects.toBeInstanceOf(PermanentSourceReplyError);
    expect(replies).toHaveBeenCalledTimes(5);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("rejects destination/payload/workspace disagreement before any Slack call", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, channel: "C1", ts: "new" }));
    const replies = vi.fn(async () => ({ ok: true, messages: [] }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);

    await expect(responder.send(job({ destination: "T-OTHER:C1:1.0" }))).rejects.toBeInstanceOf(
      PermanentSourceReplyError,
    );
    expect(replies).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("extracts Slack platform data.error before the SDK's generic code", async () => {
    const platformError = Object.assign(new Error("An API error occurred: missing_scope"), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "missing_scope" },
    });
    const responder = new SlackFinalReplyResponder(
      client({ replies: vi.fn(async () => Promise.reject(platformError)) }),
      IDENTITY,
    );

    await expect(responder.send(job())).rejects.toBeInstanceOf(PermanentSourceReplyError);
  });

  it("preserves the SDK retry-after delay as a typed transient failure", async () => {
    const rateLimit = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_rate_limited_error",
      retryAfter: 3,
    });
    const responder = new SlackFinalReplyResponder(
      client({ replies: vi.fn(async () => Promise.reject(rateLimit)) }),
      IDENTITY,
    );

    await expect(responder.send(job())).rejects.toMatchObject({
      retryAfterMs: 3_000,
    });
  });

  it("records provider success even when shutdown aborts during postMessage", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const postMessage = vi.fn(async () => {
      started();
      await gate;
      return { ok: true, channel: "C1", ts: "2.0" };
    });
    const controller = new AbortController();
    const responder = new SlackFinalReplyResponder(client({ postMessage }), IDENTITY);

    const sending = responder.send(job(), controller.signal);
    await posted;
    controller.abort();
    release();

    await expect(sending).resolves.toEqual({ providerResultId: "slack:C1:2.0" });
  });

  it("does not contact Slack for a malformed non-UUID id", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: "2.0" }));
    const replies = vi.fn(async () => ({ ok: true, messages: [] }));
    const responder = new SlackFinalReplyResponder(client({ postMessage, replies }), IDENTITY);
    await expect(responder.send(job({ id: "not-a-uuid" }))).rejects.toBeInstanceOf(
      PermanentSourceReplyError,
    );
    expect(replies).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
