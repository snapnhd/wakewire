import { describe, expect, it, vi } from "vitest";
import { PermanentSourceReplyError } from "../reply-responders.js";
import type { SourceReplyJob } from "../store.js";
import { GmailFinalReplyResponder } from "./gmail-reply.js";

function job(overrides: Partial<SourceReplyJob> = {}): SourceReplyJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requestId: "request-1",
    sourceId: "gmail-chip",
    provider: "gmail",
    replyKind: "thread-reply",
    destination: "<message@example.com>",
    payload: {
      originalMessageId: "<message@example.com>",
      to: "cj@snapcorp.com",
      subject: "Re: Help",
      text: "Done.\n\n**Sent using** ChatGPT",
      inReplyTo: "<message@example.com>",
      references: ["<root@example.com>", "<message@example.com>"],
    },
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

describe("GmailFinalReplyResponder", () => {
  it("hands the transport an exact same-thread reply with a stable Message-ID", async () => {
    const replySameThread = vi.fn(async () => ({ messageId: "gmail-message-1" }));
    const responder = new GmailFinalReplyResponder({ replySameThread });

    await expect(responder.send(job())).resolves.toEqual({
      providerResultId: "gmail:gmail-message-1",
    });
    expect(replySameThread).toHaveBeenCalledWith({
      sourceId: "gmail-chip",
      generatedMessageId: "<wakewire-reply-11111111-1111-4111-8111-111111111111@wakewire.local>",
      originalMessageId: "<message@example.com>",
      to: "cj@snapcorp.com",
      subject: "Re: Help",
      text: "Done.",
      inReplyTo: "<message@example.com>",
      references: ["<root@example.com>", "<message@example.com>"],
    });
  });

  it("strips linked ChatGPT attribution from a persisted payload before sending", async () => {
    const replySameThread = vi.fn(async () => ({ messageId: "gmail-message-1" }));
    const responder = new GmailFinalReplyResponder({ replySameThread });
    const persisted = job();
    persisted.payload = {
      ...persisted.payload,
      text: "Done.\n\n**Sent using** [**@ChatGPT**](https://snapnhd.slack.com/team/U0BKXQ0M4AK)",
    };

    await responder.send(persisted);

    expect(replySameThread).toHaveBeenCalledWith(expect.objectContaining({ text: "Done." }));
  });

  it("fails closed before transport when the durable target changes", async () => {
    const replySameThread = vi.fn(async () => ({ messageId: "should-not-send" }));
    const responder = new GmailFinalReplyResponder({ replySameThread });

    await expect(
      responder.send(job({ destination: "<other@example.com>" })),
    ).rejects.toBeInstanceOf(PermanentSourceReplyError);
    expect(replySameThread).not.toHaveBeenCalled();
  });

  it("requires a provider message id so an ambiguous send is retried through reconciliation", async () => {
    const responder = new GmailFinalReplyResponder({
      replySameThread: vi.fn(async () => ({})),
    });

    await expect(responder.send(job())).rejects.toThrow(
      "Gmail messages.send returned no message id; reconcile before retrying",
    );
  });
});
