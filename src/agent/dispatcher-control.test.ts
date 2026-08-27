import { describe, expect, it } from "vitest";
import { loadDispatcherDefaultAgent, settingKeys } from "../config.js";
import type { WakeEvent } from "../core/event.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { PeopleStore } from "../people/store.js";
import { ClaudeProxyCoordinator } from "./claude-proxy.js";
import { ClaudeProxyStore } from "./claude-proxy-store.js";
import { AgentCoordinator } from "./coordinator.js";
import { DispatcherControlCoordinator } from "./dispatcher-control.js";
import { OWNER_ROLE_POLICY } from "./policy.js";
import { AgentRequestStore, WorkItemStore } from "./store.js";

const TEAM = "T-SNAP";
const CJ = "UCJ";
const CHIP = "UCHIP";
const SOURCE = "slack-chip";
const CHANNEL = "C-DEV";
const DM = "D-CJ-CHIP";

function slackMessage(
  text: string,
  ts: string,
  options: { user?: string; rootTs?: string; addressed?: boolean } = {},
): WakeEvent {
  const user = options.user ?? CJ;
  const rootTs = options.rootTs ?? ts;
  return {
    source: "slack",
    sourceId: SOURCE,
    kind: "message",
    deliveryId: `Ev-${ts}-${user}`,
    occurredAt: "2026-08-02T12:00:00.000Z",
    summary: `Slack message: ${text}`,
    payload: {
      team: TEAM,
      channel: CHANNEL,
      channelType: "channel",
      user,
      userName: user === CJ ? "CJ" : "CJ",
      recipientUser: CHIP,
      ts,
      ...(rootTs === ts ? {} : { threadTs: rootTs }),
      text,
    },
    principal: { provider: "slack", tenantId: TEAM, subjectId: user, displayName: "CJ" },
    conversation: {
      nativeKey: `${TEAM}:${CHANNEL}:${ts}`,
      rootKey: `${TEAM}:${CHANNEL}:${rootTs}`,
      replyTarget: `${CHANNEL}:${ts}`,
    },
    ...(options.addressed === false
      ? {}
      : { targetMentions: [{ kind: "slack-user" as const, value: CHIP }] }),
  };
}

function slackDm(text: string, ts: string): WakeEvent {
  return {
    source: "slack",
    sourceId: SOURCE,
    kind: "message",
    deliveryId: `Ev-dm-${ts}`,
    occurredAt: "2026-08-02T12:00:00.000Z",
    summary: `Slack PM: ${text}`,
    payload: {
      team: TEAM,
      channel: DM,
      channelType: "im",
      user: CJ,
      recipientUser: CHIP,
      ts,
      text,
    },
    principal: { provider: "slack", tenantId: TEAM, subjectId: CJ },
    conversation: {
      nativeKey: `${TEAM}:${DM}:${ts}`,
      rootKey: `${TEAM}:${DM}:${ts}`,
      replyTarget: `${DM}:${ts}`,
    },
    targetMentions: [{ kind: "direct-message", value: CHIP }],
  };
}

function fixture() {
  const db = openDatabase(":memory:");
  const stores = createStores(db);
  const people = new PeopleStore(db);
  const cj = people.add({ nickname: "CJ", roleName: "owner" });
  people.attachIdentity({
    personId: cj.id,
    provider: "slack",
    tenantId: TEAM,
    externalId: CJ,
  });
  const work = new WorkItemStore(db);
  const requests = new AgentRequestStore(db);
  const agent = new AgentCoordinator(people, work, requests);
  const control = new DispatcherControlCoordinator(db, people, requests, stores.settings, agent);
  const proxy = new ClaudeProxyStore(db);
  const claude = new ClaudeProxyCoordinator(db, people, work, requests, proxy, undefined, {
    defaultAgent: () => loadDispatcherDefaultAgent(stores.settings),
  });
  return { db, stores, people, cj, work, requests, control, proxy, claude };
}

describe("DispatcherControlCoordinator", () => {
  it("changes the live default for CJ and queues one fixed thread reply without a model", () => {
    const context = fixture();
    const event = slackMessage(`<@${CHIP}> set default to Claude RC`, "1.0");
    const accepted = context.control.accept(event);

    expect(accepted).toMatchObject({
      claimed: true,
      accepted: true,
      duplicate: false,
      replyQueued: true,
      defaultAgent: "claude-rc",
    });
    expect(loadDispatcherDefaultAgent(context.stores.settings)).toBe("claude-rc");
    const request = context.requests.get(accepted.requestId ?? "");
    expect(request).toMatchObject({
      status: "submitted",
      requestText: `<@${CHIP}> set default to Claude RC`,
    });
    expect(request?.correlationMarker).toContain(
      "wakewire:host-control:v1:dispatcher-default-agent:",
    );
    expect(context.requests.listReady()).toEqual([]);
    expect(context.requests.sourceReplyForRequest(request?.id ?? "")).toMatchObject({
      provider: "slack",
      replyKind: "thread-reply",
      destination: `${TEAM}:${CHANNEL}:1.0`,
      payload: {
        channel: CHANNEL,
        threadTs: "1.0",
        text: "Default agent changed to Claude RC for new Slack conversations. Active sessions are unchanged.",
      },
    });

    const generic = slackMessage(`<@${CHIP}> inspect the retry path`, "1.1");
    expect(context.claude.accept(generic)).toMatchObject({ claimed: true, accepted: true });
    expect(
      context.proxy.findActiveSession(SOURCE, "slack", `${TEAM}:${CHANNEL}:1.1`),
    ).toMatchObject({
      adapterMode: "rc-tmux",
    });
  });

  it("requires but accepts a real Chip mention inside a one-to-one DM", () => {
    const context = fixture();

    expect(context.control.accept(slackDm("set default to Claude RC", "1.2"))).toEqual({
      claimed: false,
      accepted: false,
    });
    const accepted = context.control.accept(slackDm(`<@${CHIP}> set default to Claude RC`, "1.3"));
    expect(accepted).toMatchObject({ accepted: true, defaultAgent: "claude-rc" });
    expect(context.requests.sourceReplyForRequest(accepted.requestId ?? "")).toMatchObject({
      destination: `${TEAM}:${DM}:1.3`,
      payload: { channel: DM, threadTs: "1.3" },
    });
  });

  it("intercepts a control before an active Claude session without changing that session", () => {
    const context = fixture();
    context.stores.settings.set(settingKeys.dispatcherDefaultAgent, "claude-rc");
    const initial = context.claude.accept(
      slackMessage(`<@${CHIP}> start in Claude`, "2.0", { rootTs: "2.0" }),
    );
    expect(context.proxy.getSession(initial.sessionId ?? "")?.adapterMode).toBe("rc-tmux");

    const control = context.control.accept(
      slackMessage(`<@${CHIP}> make GPT the default`, "2.1", { rootTs: "2.0" }),
    );
    expect(control).toMatchObject({ accepted: true, defaultAgent: "codex" });
    expect(context.proxy.listTurns(initial.sessionId ?? "")).toHaveLength(1);
    expect(context.proxy.getSession(initial.sessionId ?? "")).toMatchObject({
      adapterMode: "rc-tmux",
      status: "ready",
    });

    const followup = context.claude.accept(
      slackMessage("continue in Claude", "2.2", { rootTs: "2.0", addressed: false }),
    );
    expect(followup).toMatchObject({ accepted: true, sessionId: initial.sessionId });
    expect(context.proxy.listTurns(initial.sessionId ?? "")).toHaveLength(2);

    expect(
      context.claude.accept(slackMessage(`<@${CHIP}> start a separate new conversation`, "2.3")),
    ).toEqual({ claimed: false, accepted: false });
  });

  it("deduplicates exact control replays and never reapplies an old value", () => {
    const context = fixture();
    const event = slackMessage(`<@${CHIP}> set default to Codex`, "3.0");
    const first = context.control.accept(event);
    context.stores.settings.set(settingKeys.dispatcherDefaultAgent, "claude-rc");

    expect(context.control.accept(event)).toMatchObject({
      claimed: true,
      accepted: true,
      duplicate: true,
      requestId: first.requestId,
    });
    expect(loadDispatcherDefaultAgent(context.stores.settings)).toBe("claude-rc");
    expect(context.db.prepare("SELECT count(*) AS count FROM source_reply_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("claims a mutated control replay before it can fall through", () => {
    const context = fixture();
    const event = slackMessage(`<@${CHIP}> set default to Codex`, "4.0");
    context.control.accept(event);
    if (!event.conversation) throw new Error("fixture conversation missing");
    const altered = {
      ...event,
      conversation: { ...event.conversation, rootKey: `${TEAM}:${CHANNEL}:wrong` },
    };

    expect(context.control.accept(altered)).toEqual({
      claimed: true,
      accepted: false,
      reason: "dispatcher control delivery id was replayed with different event content",
    });
    expect(context.control.accept({ ...event, source: "webhook" })).toEqual({
      claimed: true,
      accepted: false,
      reason: "dispatcher control delivery id was replayed with different event content",
    });
  });

  it("rejects display-name spoofing and another enrolled owner", () => {
    const context = fixture();
    const other = context.people.add({ nickname: "Other", roleName: "owner" });
    context.people.attachIdentity({
      personId: other.id,
      provider: "slack",
      tenantId: TEAM,
      externalId: "UOTHER",
      displayName: "CJ",
    });

    expect(
      context.control.accept(
        slackMessage(`<@${CHIP}> set default to Claude RC`, "5.0", { user: "UOTHER" }),
      ),
    ).toMatchObject({
      claimed: true,
      accepted: false,
      reason: "dispatcher control is restricted to the enrolled CJ principal",
    });
    expect(loadDispatcherDefaultAgent(context.stores.settings)).toBe("codex");
    expect(context.db.prepare("SELECT count(*) AS count FROM agent_requests").get()).toEqual({
      count: 0,
    });
  });

  it("requires CJ to remain enabled with the exact owner policy", () => {
    const disabled = fixture();
    disabled.people.disable(disabled.cj.id);
    expect(
      disabled.control.accept(slackMessage(`<@${CHIP}> set default to Claude RC`, "6.0")),
    ).toMatchObject({ claimed: true, accepted: false });

    const customized = fixture();
    customized.people.setRole("owner", {
      ...OWNER_ROLE_POLICY,
      capabilities: { ...OWNER_ROLE_POLICY.capabilities, deployments: "read" },
    });
    expect(
      customized.control.accept(slackMessage(`<@${CHIP}> set default to Claude RC`, "6.1")),
    ).toMatchObject({
      claimed: true,
      accepted: false,
      reason: "dispatcher control requires the exact enabled owner policy",
    });
  });

  it("requires a real leading Slack mention and valid normalized metadata", () => {
    const context = fixture();
    expect(context.control.accept(slackMessage("set default to Claude RC", "7.0"))).toEqual({
      claimed: false,
      accepted: false,
    });
    expect(context.control.accept(slackMessage("@Chip set default to Claude RC", "7.1"))).toEqual({
      claimed: false,
      accepted: false,
    });

    const malformed = slackMessage(`<@${CHIP}> set default to Claude RC`, "7.2");
    if (!malformed.conversation) throw new Error("fixture conversation missing");
    malformed.conversation.rootKey = `${TEAM}:${CHANNEL}:wrong`;
    expect(context.control.accept(malformed)).toMatchObject({
      claimed: true,
      accepted: false,
      reason: "dispatcher control requires an authenticated exact Chip mention",
    });
    expect(loadDispatcherDefaultAgent(context.stores.settings)).toBe("codex");
  });
});
