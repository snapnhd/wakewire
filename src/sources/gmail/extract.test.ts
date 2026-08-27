import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { emailToWakeEvent, extractAtHandles, extractAuthoredBody, extractBody } from "./extract.js";

describe("extractBody", () => {
  it("prefers plain text when present", () => {
    expect(extractBody({ text: "hello plain", html: "<b>hello html</b>" })).toBe("hello plain");
  });

  it("converts HTML with a real parser (no tags in output)", () => {
    const body = extractBody({
      text: "",
      html: '<html><body><p>Hi <b>there</b></p><a href="https://x.test/a">click</a><img src="x.png"></body></html>',
    });
    expect(body).toContain("Hi there");
    expect(body).toContain("https://x.test/a");
    expect(body).not.toMatch(/<[a-z]+[ >]/i);
  });

  it("truncates the body at 4000 chars", () => {
    const body = extractBody({ text: "x".repeat(10_000), html: false });
    expect(body.length).toBeLessThanOrEqual(4_000 + "… [truncated]".length);
    expect(body).toContain("[truncated]");
  });
});

describe("sender-authored Gmail mentions", () => {
  it("extracts exact standalone handles without accepting lookalikes or email addresses", () => {
    expect(
      extractAtHandles(
        "Hey @Chip, please help @chip-byte, a@chip.example, @chip@example.com, @chip.example, and @chip/away",
      ),
    ).toEqual(["chip", "chip-byte"]);
    expect(extractAtHandles("@chipmunk @chip_away")).toEqual(["chipmunk", "chip_away"]);
  });

  it("removes quoted history before mention extraction", () => {
    const authored = extractAuthoredBody(
      ["Thanks, no action needed.", "", "On Tue, Jul 28, CJ wrote:", "> @Chip do this"].join("\n"),
    );
    expect(authored).toBe("Thanks, no action needed.");
    expect(extractAtHandles(authored)).toEqual([]);
  });
});

describe("emailToWakeEvent", () => {
  it("builds a trimmed event from a parsed message", async () => {
    const raw = [
      "Message-ID: <msg-1@example.com>",
      "From: Boss <boss@corp.example>",
      "To: me@corp.example",
      "Authentication-Results: mx.google.com; dmarc=pass header.from=corp.example",
      "Subject: Deploy tonight",
      "Date: Fri, 03 Jul 2026 10:00:00 +0000",
      "Content-Type: text/plain",
      "",
      "@Chip Please deploy after 6pm.",
    ].join("\r\n");
    const mail = await simpleParser(raw);
    const event = emailToWakeEvent({
      mail,
      label: "agent-inbox",
      fallbackId: "fb-1",
      mailbox: "me@corp.example",
      sourceId: "gmail-chip",
    });
    expect(event.source).toBe("gmail");
    expect(event.kind).toBe("email");
    expect(event.deliveryId).toBe("<msg-1@example.com>");
    expect(event.summary).toBe('Email from "Boss" <boss@corp.example>: Deploy tonight');
    expect(event.payload).toMatchObject({
      label: "agent-inbox",
      from: '"Boss" <boss@corp.example>',
      to: "me@corp.example",
      subject: "Deploy tonight",
      body: "@Chip Please deploy after 6pm.",
      authoredBody: "@Chip Please deploy after 6pm.",
      fromEmail: "boss@corp.example",
      rfcMessageId: "<msg-1@example.com>",
      authenticated: true,
    });
    expect(event).toMatchObject({
      sourceId: "gmail-chip",
      principal: {
        provider: "gmail",
        tenantId: "me@corp.example",
        subjectId: "boss@corp.example",
        email: "boss@corp.example",
      },
      conversation: {
        nativeKey: "<msg-1@example.com>",
        rootKey: "<msg-1@example.com>",
        replyTarget: "<msg-1@example.com>",
      },
      targetMentions: [
        { kind: "email", value: "me@corp.example" },
        { kind: "handle", value: "chip" },
      ],
    });
  });

  it("falls back to the synthetic id when Message-ID is missing", async () => {
    const mail = await simpleParser("Subject: no id\r\n\r\nbody");
    const event = emailToWakeEvent({ mail, label: "l", fallbackId: "imap-src-5-42" });
    expect(event.deliveryId).toBe("imap-src-5-42");
    expect(event.payload.subject).toBe("no id");
    expect(event.payload).not.toHaveProperty("rfcMessageId");
    expect(event.conversation).toEqual({
      nativeKey: "imap-src-5-42",
      rootKey: "imap-src-5-42",
      replyTarget: "imap-src-5-42",
    });
  });

  it("does not trust a lower sender-supplied Authentication-Results header", async () => {
    const mail = await simpleParser(
      [
        "From: CJ <cj@snapcorp.com>",
        "To: chip@snapcorp.com",
        "Authentication-Results: mx.google.com; dmarc=fail header.from=snapcorp.com",
        "Authentication-Results: mx.google.com; dmarc=pass header.from=snapcorp.com",
        "Subject: forged result",
        "",
        "@Chip Byte do something",
      ].join("\r\n"),
    );
    const event = emailToWakeEvent({
      mail,
      label: "agent-inbox",
      fallbackId: "forged",
      mailbox: "chip@snapcorp.com",
    });
    expect(event.payload.authenticated).toBe(false);
  });

  it("requires Gmail's passing DMARC domain to match the From domain", async () => {
    const mail = await simpleParser(
      [
        "From: CJ <cj@snapcorp.com>",
        "To: chip@snapcorp.com",
        "Authentication-Results: mx.google.com; dmarc=pass header.from=attacker.example",
        "Subject: mismatched result",
        "",
        "hello",
      ].join("\r\n"),
    );
    const event = emailToWakeEvent({
      mail,
      label: "agent-inbox",
      fallbackId: "mismatch",
      mailbox: "chip@snapcorp.com",
    });
    expect(event.payload.authenticated).toBe(false);
  });

  it("does not turn an old quoted @chip into a current target", async () => {
    const mail = await simpleParser(
      [
        "From: CJ <cj@snapcorp.com>",
        "To: chip@snapcorp.com",
        "Authentication-Results: mx.google.com; dmarc=pass header.from=snapcorp.com",
        "Subject: Re: old request",
        "",
        "Thanks, no action needed.",
        "",
        "On Tue, Jul 28, Chip wrote:",
        "> @Chip do the old thing",
      ].join("\r\n"),
    );
    const event = emailToWakeEvent({
      mail,
      label: "agent-inbox",
      fallbackId: "quoted",
      mailbox: "chip@snapcorp.com",
    });
    expect(event.payload.authoredBody).toBe("Thanks, no action needed.");
    expect(event.targetMentions).toEqual([{ kind: "email", value: "chip@snapcorp.com" }]);
  });
});
