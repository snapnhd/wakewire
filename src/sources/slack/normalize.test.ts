import { describe, expect, it } from "vitest";
import {
  isAuthenticatedSlackHumanMessage,
  isBotEvent,
  isPrivilegedSlackUserEvent,
  slackToWakeEvent,
} from "./normalize.js";
import { SlackSourceConfigSchema } from "./source.js";

describe("slackToWakeEvent", () => {
  it("trims an app_mention with names resolved", () => {
    const event = slackToWakeEvent({
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C456",
        text: "<@UBOT> please look at the failing deploy",
        ts: "1751551200.000100",
        client_msg_id: "should-not-leak",
        blocks: [{ type: "rich_text" }],
      },
      eventId: "Ev123",
      teamId: "T789",
      names: { channelName: "dev", userName: "glenn" },
    });
    expect(event).toMatchObject({
      source: "slack",
      kind: "app_mention",
      deliveryId: "Ev123",
      occurredAt: "2025-07-03T14:00:00.000Z",
    });
    expect(event?.summary).toContain("@glenn mentioned the bot in #dev");
    expect(event?.payload).toMatchObject({
      channel: "C456",
      channelName: "dev",
      user: "U123",
      userName: "glenn",
      team: "T789",
      eventType: "app_mention",
    });
    expect(event).toMatchObject({
      principal: { provider: "slack", tenantId: "T789", subjectId: "U123" },
      conversation: {
        nativeKey: "T789:C456:1751551200.000100",
        rootKey: "T789:C456:1751551200.000100",
        replyTarget: "C456:1751551200.000100",
      },
      targetMentions: [{ kind: "app-mention", value: "UBOT" }],
    });
    expect(JSON.stringify(event?.payload)).not.toContain("should-not-leak");
    expect(JSON.stringify(event?.payload)).not.toContain("rich_text");
  });

  it("handles plain messages, subtypes, and missing names", () => {
    const plain = slackToWakeEvent({
      event: { type: "message", user: "U1", channel: "C1", text: "hi", ts: "1.0" },
      eventId: "Ev1",
      teamId: undefined,
      names: {},
    });
    expect(plain?.kind).toBe("message");
    expect(plain?.summary).toContain("@U1");
    // unresolved names fall back to raw ids so the default template always renders
    expect(plain?.payload.channelName).toBe("C1");
    expect(plain?.payload.userName).toBe("U1");

    const subtype = slackToWakeEvent({
      event: { type: "message", subtype: "channel_topic", channel: "C1", ts: "1.0" },
      eventId: "Ev2",
      teamId: "T1",
      names: {},
    });
    expect(subtype?.kind).toBe("message.channel_topic");
  });

  it("marks only a complete new human message.im event as a Chip PM", () => {
    const direct = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "im",
        user: "U-CJ",
        channel: "D-CJ-CHIP",
        text: "please take a look",
        ts: "1751551200.000100",
      },
      eventId: "Ev-DM",
      teamId: "T-SNAP",
      names: { userName: "CJ" },
      targetUserId: "UCHIP",
    });

    expect(direct).toMatchObject({
      kind: "message",
      summary: "Slack PM from @CJ: please take a look",
      payload: {
        channelType: "im",
        team: "T-SNAP",
        channel: "D-CJ-CHIP",
        user: "U-CJ",
        recipientUser: "UCHIP",
      },
      principal: { provider: "slack", tenantId: "T-SNAP", subjectId: "U-CJ" },
      conversation: {
        nativeKey: "T-SNAP:D-CJ-CHIP:1751551200.000100",
        replyTarget: "D-CJ-CHIP:1751551200.000100",
      },
      targetMentions: [{ kind: "direct-message", value: "UCHIP" }],
    });

    const disabled = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "im",
        user: "U-CJ",
        channel: "D-CJ-CHIP",
        text: "please take a look",
        ts: "1751551200.000100",
      },
      eventId: "Ev-DM-DISABLED",
      teamId: "T-SNAP",
      names: {},
      targetUserId: "UCHIP",
      includeDirectMessages: false,
    });
    expect(disabled?.targetMentions).toBeUndefined();

    const fileShare = slackToWakeEvent({
      event: {
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        user: "U-CJ",
        channel: "D-CJ-CHIP",
        text: "please inspect this file",
        ts: "1751551200.000102",
      },
      eventId: "Ev-DM-FILE",
      teamId: "T-SNAP",
      names: {},
      targetUserId: "UCHIP",
    });
    expect(fileShare?.kind).toBe("message.file_share");
    expect(isPrivilegedSlackUserEvent(fileShare as NonNullable<typeof fileShare>)).toBe(true);

    for (const event of [
      { type: "message", channel_type: "channel" },
      { type: "message", channel_type: "mpim" },
      { type: "message", channel_type: "im", subtype: "message_changed" },
      { type: "message", channel_type: "im", subtype: "channel_join" },
      { type: "message", channel_type: "im", bot_id: "B1" },
      { type: "message", channel_type: "im", edited: { user: "U-CJ" } },
    ]) {
      const normalized = slackToWakeEvent({
        event: {
          ...event,
          user: "U-CJ",
          channel: "D-CJ-CHIP",
          text: "not a new human PM",
          ts: "1751551200.000101",
        },
        eventId: `Ev-${String(event.channel_type)}-${String(event.subtype ?? event.bot_id ?? "plain")}`,
        teamId: "T-SNAP",
        names: {},
        targetUserId: "UCHIP",
      });
      expect(normalized?.targetMentions).toBeUndefined();
    }
  });

  it("recognizes only Slack's exact immutable mention of the normal Chip user", () => {
    const mention = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "channel",
        user: "U-CJ",
        channel: "C-DEV",
        text: "<@UCHIP> please take a look",
        ts: "1751551200.000200",
      },
      eventId: "Ev-MENTION",
      teamId: "T-SNAP",
      names: { channelName: "dev", userName: "CJ" },
      targetUserId: "UCHIP",
    });
    expect(mention).toMatchObject({
      kind: "message",
      summary: "@CJ mentioned Chip in #dev: <@UCHIP> please take a look",
      payload: { recipientUser: "UCHIP", channelType: "channel" },
      targetMentions: [{ kind: "slack-user", value: "UCHIP" }],
    });

    const disabled = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "channel",
        user: "U-CJ",
        channel: "C-DEV",
        text: "<@UCHIP> please take a look",
        ts: "1751551200.000200",
      },
      eventId: "Ev-MENTION-DISABLED",
      teamId: "T-SNAP",
      names: {},
      targetUserId: "UCHIP",
      includeChannelMentions: false,
    });
    expect(disabled?.targetMentions).toBeUndefined();

    const broadcast = slackToWakeEvent({
      event: {
        type: "message",
        subtype: "thread_broadcast",
        channel_type: "channel",
        user: "U-CJ",
        channel: "C-DEV",
        text: "<@UCHIP> please take a look",
        ts: "1751551200.000202",
        thread_ts: "1751551200.000199",
      },
      eventId: "Ev-MENTION-BROADCAST",
      teamId: "T-SNAP",
      names: {},
      targetUserId: "UCHIP",
    });
    expect(broadcast).toMatchObject({
      kind: "message.thread_broadcast",
      conversation: { rootKey: "T-SNAP:C-DEV:1751551200.000199" },
      targetMentions: [{ kind: "slack-user", value: "UCHIP" }],
    });
    expect(isPrivilegedSlackUserEvent(broadcast as NonNullable<typeof broadcast>)).toBe(true);

    for (const event of [
      { user: "U-CJ", text: "@chip plain text is not a resolved mention" },
      { user: "U-CJ", text: "<@UCHIPPER> is someone else" },
      { user: "UCHIP", text: "<@UCHIP> self-authored" },
      { user: "U-CJ", text: "<@UCHIP> edited", edited: { user: "U-CJ" } },
      { user: "U-CJ", text: "<@UCHIP> bot", bot_id: "B1" },
    ]) {
      const normalized = slackToWakeEvent({
        event: {
          type: "message",
          channel_type: "channel",
          channel: "C-DEV",
          ts: "1751551200.000201",
          ...event,
        },
        eventId: `Ev-${event.user}-${event.text}`,
        teamId: "T-SNAP",
        names: {},
        targetUserId: "UCHIP",
      });
      expect(normalized?.targetMentions).toBeUndefined();
    }
  });

  it("requires an exact Chip mention in a multi-party direct message", () => {
    const mention = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "mpim",
        user: "U-CJ",
        channel: "C0BM7CVCW8Y",
        text: "<@UCHIP> hello?",
        ts: "1751551200.000300",
      },
      eventId: "Ev-MPIM-MENTION",
      teamId: "T-SNAP",
      names: { userName: "CJ" },
      targetUserId: "UCHIP",
    });
    expect(mention).toMatchObject({
      kind: "message",
      summary: "@CJ mentioned Chip in a group PM: <@UCHIP> hello?",
      payload: {
        channelType: "mpim",
        team: "T-SNAP",
        channel: "C0BM7CVCW8Y",
        user: "U-CJ",
        recipientUser: "UCHIP",
      },
      targetMentions: [{ kind: "slack-user", value: "UCHIP" }],
    });
    expect(isPrivilegedSlackUserEvent(mention as NonNullable<typeof mention>)).toBe(true);

    for (const text of ["hello Chip", "@chip hello", "<@U-OTHER> hello"]) {
      const unaddressed = slackToWakeEvent({
        event: {
          type: "message",
          channel_type: "mpim",
          user: "U-CJ",
          channel: "C0BM7CVCW8Y",
          text,
          ts: "1751551200.000301",
        },
        eventId: `Ev-MPIM-${text}`,
        teamId: "T-SNAP",
        names: {},
        targetUserId: "UCHIP",
      });
      expect(unaddressed?.targetMentions).toBeUndefined();
      expect(isAuthenticatedSlackHumanMessage(unaddressed as NonNullable<typeof unaddressed>)).toBe(
        true,
      );
      expect(isPrivilegedSlackUserEvent(unaddressed as NonNullable<typeof unaddressed>)).toBe(
        false,
      );
    }
  });

  it("revalidates an unmentioned human thread reply without addressing Chip", () => {
    const followup = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "private_channel",
        user: "U-CJ",
        channel: "C-PRIVATE",
        text: "one more constraint",
        ts: "1751551200.000451",
        thread_ts: "1751551200.000402",
      },
      eventId: "Ev-PRIVATE-FOLLOWUP",
      teamId: "T-SNAP",
      names: { userName: "CJ" },
      targetUserId: "UCHIP",
    });

    expect(followup?.targetMentions).toBeUndefined();
    expect(isAuthenticatedSlackHumanMessage(followup as NonNullable<typeof followup>)).toBe(true);
    expect(isPrivilegedSlackUserEvent(followup as NonNullable<typeof followup>)).toBe(false);

    if (!followup?.conversation) throw new Error("fixture conversation missing");
    followup.conversation.rootKey = "T-SNAP:C-PRIVATE:different";
    expect(isAuthenticatedSlackHumanMessage(followup)).toBe(false);
  });

  it("accepts Slack channel type aliases and events without channel_type", () => {
    for (const event of [
      {
        type: "message",
        channel_type: "public_channel",
        channel: "C-DEV",
        user: "U-CJ",
        text: "<@UCHIP|Chip Byte> please look",
        ts: "1751551200.000400",
      },
      {
        type: "message",
        channel: "C-DEV",
        user: "U-CJ",
        text: "<@UCHIP|Chip Byte> please look",
        ts: "1751551200.000401",
      },
    ]) {
      const normalized = slackToWakeEvent({
        event,
        eventId: `Ev-${event.ts}`,
        teamId: "T-SNAP",
        names: {},
        targetUserId: "UCHIP",
      });
      expect(normalized).toMatchObject({
        payload: { channelType: "channel", recipientUser: "UCHIP" },
        targetMentions: [{ kind: "slack-user", value: "UCHIP" }],
      });
    }
  });

  it("normalizes private_channel events even when the conversation id starts with C", () => {
    const normalized = slackToWakeEvent({
      event: {
        type: "message",
        channel_type: "private_channel",
        channel: "C-PRIVATE",
        user: "U-CJ",
        text: "<@UCHIP|Chip Byte> please look",
        ts: "1751551200.000402",
      },
      eventId: "Ev-PRIVATE-CHANNEL",
      teamId: "T-SNAP",
      names: { channelName: "private-team" },
      targetUserId: "UCHIP",
    });

    expect(normalized).toMatchObject({
      summary: "@U-CJ mentioned Chip in #private-team: <@UCHIP|Chip Byte> please look",
      payload: { channelType: "group", recipientUser: "UCHIP" },
      targetMentions: [{ kind: "slack-user", value: "UCHIP" }],
    });
    expect(isPrivilegedSlackUserEvent(normalized as NonNullable<typeof normalized>)).toBe(true);
  });

  it("truncates long text at 4000 chars", () => {
    const event = slackToWakeEvent({
      event: { type: "message", user: "U1", channel: "C1", text: "y".repeat(9000), ts: "1.0" },
      eventId: "Ev3",
      teamId: undefined,
      names: {},
    });
    const text = event?.payload.text as string;
    expect(text.length).toBeLessThanOrEqual(4000 + "… [truncated]".length);
    expect(text).toContain("[truncated]");
  });

  it("normalizes reactions", () => {
    const event = slackToWakeEvent({
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "rocket",
        item: { type: "message", channel: "C9", ts: "2.0" },
        event_ts: "1751551200.0",
      },
      eventId: "Ev4",
      teamId: undefined,
      names: { userName: "sam" },
    });
    expect(event?.kind).toBe("reaction_added");
    expect(event?.summary).toBe("@sam reacted :rocket: in #C9");
    expect(event?.payload).toMatchObject({ channel: "C9", reaction: "rocket", itemTs: "2.0" });
  });

  it("returns null for typeless events", () => {
    expect(
      slackToWakeEvent({ event: {}, eventId: "Ev5", teamId: undefined, names: {} }),
    ).toBeNull();
  });
});

describe("isBotEvent", () => {
  it("flags bot messages by bot_id or subtype", () => {
    expect(isBotEvent({ type: "message", bot_id: "B1" })).toBe(true);
    expect(isBotEvent({ type: "message", subtype: "bot_message" })).toBe(true);
    expect(isBotEvent({ type: "message", user: "U1" })).toBe(false);
  });
});

describe("SlackSourceConfigSchema", () => {
  it("defaults to Chip's normal account and requires pinned ids as a pair", () => {
    expect(SlackSourceConfigSchema.parse({})).toMatchObject({
      agentEmail: "chip@snapcorp.com",
      includeDirectMessages: true,
      includeChannelMentions: true,
    });
    expect(
      SlackSourceConfigSchema.parse({ includeDirectMessages: false }).includeDirectMessages,
    ).toBe(false);
    expect(SlackSourceConfigSchema.safeParse({ agentUserId: "U1" }).success).toBe(false);
    expect(
      SlackSourceConfigSchema.safeParse({
        agentAppId: "A1",
        agentUserId: "U1",
        agentTeamId: "T1",
      }).success,
    ).toBe(true);
  });
});
