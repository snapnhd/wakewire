import type { WakeEvent } from "../../core/event.js";

const TEXT_LIMIT = 4_000;
const PRIVILEGED_MESSAGE_KINDS = new Set([
  "message",
  "message.file_share",
  "message.thread_broadcast",
]);
const NEW_HUMAN_MESSAGE_SUBTYPES = new Set(["", "file_share", "thread_broadcast"]);

export interface SlackNames {
  channelName?: string | undefined;
  userName?: string | undefined;
}

/**
 * Reduce a Slack Events API inner event to the fields routes and prompts
 * need. Like every source: nothing outside this trimmed shape reaches the
 * model, and message text is capped.
 */
export function slackToWakeEvent(args: {
  event: Record<string, unknown>;
  eventId: string;
  teamId: string | undefined;
  names: SlackNames;
  sourceId?: string | undefined;
  targetUserId?: string | undefined;
  includeDirectMessages?: boolean | undefined;
  includeChannelMentions?: boolean | undefined;
}): WakeEvent | null {
  const {
    event,
    eventId,
    teamId,
    names,
    sourceId,
    targetUserId,
    includeDirectMessages = true,
    includeChannelMentions = true,
  } = args;
  const type = str(event.type);
  if (!type) return null;
  const subtype = str(event.subtype);
  const kind = subtype ? `${type}.${subtype}` : type;
  const channel = str(event.channel) || str((event.item as Record<string, unknown>)?.channel);
  const channelType = slackConversationType(event);
  const user = str(event.user);
  const occurredAt = tsToIso(str(event.ts) || str(event.event_ts));
  const userLabel = names.userName ?? (user || "unknown");
  const channelLabel = names.channelName ?? (channel || "unknown");

  // userName/channelName are ALWAYS present (falling back to the raw ids):
  // the default prompt template interpolates them, and a missing whitelisted
  // field is a hard template error that would fail every delivery.
  const base = {
    channel,
    channelName: channelLabel,
    user,
    userName: userLabel,
    eventType: kind,
    ...(channelType ? { channelType } : {}),
    ...(teamId ? { team: teamId } : {}),
  };

  if (type === "reaction_added" || type === "reaction_removed") {
    const reaction = str(event.reaction);
    return {
      source: "slack",
      ...(sourceId ? { sourceId } : {}),
      kind,
      deliveryId: eventId,
      occurredAt,
      summary: `@${userLabel} ${type === "reaction_added" ? "reacted" : "unreacted"} :${reaction}: in #${channelLabel}`,
      payload: { ...base, reaction, itemTs: str((event.item as Record<string, unknown>)?.ts) },
    };
  }

  // message / app_mention (and message subtypes)
  const text = truncate(str(event.text), TEXT_LIMIT);
  const snippet = text.replace(/\s+/g, " ").slice(0, 80);
  const ts = str(event.ts);
  const threadTs = str(event.thread_ts);
  const rootTs = threadTs || ts;
  const directMessage =
    includeDirectMessages &&
    Boolean(targetUserId) &&
    isSlackDirectMessageEvent(event, targetUserId) &&
    Boolean(teamId && channel && user && ts);
  const channelMention =
    includeChannelMentions &&
    Boolean(targetUserId) &&
    isSlackUserMentionEvent(event, targetUserId) &&
    Boolean(teamId && channel && user && ts);
  const principal =
    teamId && user
      ? {
          provider: "slack" as const,
          tenantId: teamId,
          subjectId: user,
          ...(names.userName ? { displayName: names.userName } : {}),
        }
      : undefined;
  const conversation =
    teamId && channel && ts
      ? {
          nativeKey: `${teamId}:${channel}:${ts}`,
          rootKey: `${teamId}:${channel}:${rootTs}`,
          replyTarget: `${channel}:${ts}`,
        }
      : undefined;
  const botId = firstMentionedUser(text);
  return {
    source: "slack",
    ...(sourceId ? { sourceId } : {}),
    kind,
    deliveryId: eventId,
    occurredAt,
    summary:
      type === "app_mention"
        ? `@${userLabel} mentioned the bot in #${channelLabel}: ${snippet}`
        : directMessage
          ? `Slack PM from @${userLabel}${snippet ? `: ${snippet}` : ""}`
          : channelMention
            ? channelType === "mpim"
              ? `@${userLabel} mentioned Chip in a group PM: ${snippet}`
              : `@${userLabel} mentioned Chip in #${channelLabel}: ${snippet}`
            : `Slack ${kind} from @${userLabel} in #${channelLabel}${snippet ? `: ${snippet}` : ""}`,
    payload: {
      ...base,
      text,
      ts,
      ...(targetUserId ? { recipientUser: targetUserId } : {}),
      ...(threadTs ? { threadTs } : {}),
    },
    ...(principal ? { principal } : {}),
    ...(conversation ? { conversation } : {}),
    ...(type === "app_mention"
      ? { targetMentions: [{ kind: "app-mention" as const, value: botId ?? "Chip Byte" }] }
      : directMessage
        ? { targetMentions: [{ kind: "direct-message" as const, value: targetUserId as string }] }
        : channelMention
          ? { targetMentions: [{ kind: "slack-user" as const, value: targetUserId as string }] }
          : {}),
  };
}

/** A newly authored, human, one-to-one Slack message visible to Chip's account. */
export function isSlackDirectMessageEvent(
  event: Record<string, unknown>,
  targetUserId?: string,
): boolean {
  return (
    isNewHumanSlackMessage(event) &&
    str(event.channel_type) === "im" &&
    (!targetUserId || str(event.user) !== targetUserId)
  );
}

/** A new human channel or group-PM message containing Slack's immutable mention encoding. */
export function isSlackUserMentionEvent(
  event: Record<string, unknown>,
  targetUserId?: string,
): boolean {
  const channelType = slackConversationType(event);
  const user = str(event.user);
  return (
    isNewHumanSlackMessage(event) &&
    isMentionableSlackConversation(channelType) &&
    Boolean(targetUserId) &&
    user !== targetUserId &&
    mentionedUsers(str(event.text)).includes(targetUserId as string)
  );
}

/** Slack has emitted both Events API names and Web API names for conversation types. */
function slackConversationType(event: Record<string, unknown>): string {
  const explicit = str(event.channel_type);
  if (explicit) {
    if (explicit === "public_channel") return "channel";
    if (explicit === "private_channel") return "group";
    return explicit;
  }
  const channel = str(event.channel);
  if (channel.startsWith("C")) return "channel";
  if (channel.startsWith("G")) return "group";
  if (channel.startsWith("D")) return "im";
  return "";
}

function isMentionableSlackConversation(channelType: string): boolean {
  return channelType === "channel" || channelType === "group" || channelType === "mpim";
}

/**
 * Revalidate every normalized field used by the privileged Chip dispatcher.
 * The marker is emitted only by the authenticated Socket Mode source, and the
 * immutable Slack principal must agree with the event payload.
 */
export function isPrivilegedSlackUserEvent(event: WakeEvent): boolean {
  if (!isAuthenticatedSlackHumanMessage(event)) return false;
  const recipientUser = str(event.payload.recipientUser);
  const channelType = str(event.payload.channelType);
  if (channelType === "im") return true;
  return (
    mentionedUsers(str(event.payload.text)).includes(recipientUser) &&
    (event.targetMentions ?? []).some(
      (mention) => mention.kind === "slack-user" && mention.value === recipientUser,
    )
  );
}

/**
 * Revalidate a newly-authored human message delivered through the pinned Slack
 * user installation without treating that visibility as a fresh Chip mention.
 * Active host-owned proxy sessions use this narrower primitive for exact-bound
 * follow-ups; ordinary requests must continue through isPrivilegedSlackUserEvent.
 */
export function isAuthenticatedSlackHumanMessage(event: WakeEvent): boolean {
  if (event.source !== "slack" || !PRIVILEGED_MESSAGE_KINDS.has(event.kind)) return false;
  const team = str(event.payload.team);
  const channel = str(event.payload.channel);
  const user = str(event.payload.user);
  const ts = str(event.payload.ts);
  const threadTs = str(event.payload.threadTs);
  const rootTs = threadTs || ts;
  const recipientUser = str(event.payload.recipientUser);
  const channelType = str(event.payload.channelType);
  const principal = event.principal;
  if (
    !team ||
    !channel ||
    !user ||
    !ts ||
    !recipientUser ||
    user === recipientUser ||
    principal?.provider !== "slack" ||
    principal.tenantId !== team ||
    principal.subjectId !== user ||
    event.conversation?.nativeKey !== `${team}:${channel}:${ts}` ||
    event.conversation.rootKey !== `${team}:${channel}:${rootTs}` ||
    event.conversation.replyTarget !== `${channel}:${ts}`
  ) {
    return false;
  }
  if (channelType === "im") {
    return (event.targetMentions ?? []).some(
      (mention) => mention.kind === "direct-message" && mention.value === recipientUser,
    );
  }
  return channelType === "channel" || channelType === "group" || channelType === "mpim";
}

/** Bot chatter is skipped by default so integrations can't flood routes. */
export function isBotEvent(event: Record<string, unknown>): boolean {
  return Boolean(event.bot_id) || str(event.subtype) === "bot_message";
}

/** Slack's documented newly-authored message shapes, excluding system/history mutations. */
function isNewHumanSlackMessage(event: Record<string, unknown>): boolean {
  return (
    str(event.type) === "message" &&
    NEW_HUMAN_MESSAGE_SUBTYPES.has(str(event.subtype)) &&
    event.hidden !== true &&
    !event.edited &&
    !isBotEvent(event)
  );
}

function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}

function firstMentionedUser(text: string): string | null {
  return /<@([A-Z0-9]+)>/i.exec(text)?.[1] ?? null;
}

function mentionedUsers(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/gi)].map((match) => match[1] as string);
}
