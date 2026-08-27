import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import type { SourceRecord, SourceStore } from "../db/repos.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, type SecretStore, secretNames } from "../secrets/store.js";
import { promptHidden } from "./prompt.js";

const SLACK_API = "https://slack.com/api";

export interface SlackAgentIdentity {
  appId: string;
  teamId: string;
  userId: string;
  email: string;
  name: string;
}

export interface SlackCredentialInputs {
  appToken: string;
  userToken: string;
}

export interface SlackCredentialEnvironment {
  SLACK_APP_TOKEN?: string | undefined;
  SLACK_USER_TOKEN?: string | undefined;
}

type HiddenPrompt = (question: string) => Promise<string>;

/**
 * Store Socket Mode's app-level token and Chip's normal Slack user OAuth
 * token. The user token is validated against the source's configured email
 * and then pinned to immutable Slack workspace/user ids before either token is
 * persisted.
 */
export async function authSlack(
  logger: Logger,
  opts: { source?: string; appToken?: string; userToken?: string },
): Promise<void> {
  const db = openDatabase();
  let sourceId: string | null = null;
  let identity: SlackAgentIdentity | null = null;
  let backend: SecretStore["backend"] | null = null;
  try {
    const sources = createStores(db).sources;
    const source = selectSlackSource(sources, opts.source);
    if (!source) return;
    sourceId = source.id;

    const { appToken, userToken } = await resolveSlackCredentialInputs(opts);
    if (!appToken.startsWith("xapp-")) {
      console.error("that does not look like an app-level token (should start with xapp-)");
      process.exitCode = 1;
      return;
    }
    if (!userToken.startsWith("xoxp-")) {
      console.error("that does not look like a user OAuth token (should start with xoxp-)");
      process.exitCode = 1;
      return;
    }

    const secrets = await createSecretStore(logger);
    identity = await configureSlackUserCredentials({
      sourceId: source.id,
      appToken,
      userToken,
      secrets,
      sources,
    });
    backend = secrets.backend;
  } finally {
    db.close();
  }

  if (!sourceId || !identity || !backend) return;
  console.log(`Stored Slack app + Chip user tokens for source ${sourceId} (${backend}).`);
  console.log(
    `Pinned Slack user ${identity.name || identity.email} (${identity.userId}) in workspace ${identity.teamId}.`,
  );
  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the slack source is (re)starting.");
  } catch {
    console.log("Daemon not running; the source will start with the next `wakewire start`.");
  }
}

/**
 * Resolve Slack credentials without putting them in shell argv. Explicit CLI
 * values win, then the project environment loaded by src/cli.ts, with hidden
 * prompts retained as the fallback for ordinary Keychain setup.
 */
export async function resolveSlackCredentialInputs(
  opts: { appToken?: string; userToken?: string },
  environment: SlackCredentialEnvironment = process.env,
  prompt: HiddenPrompt = promptHidden,
): Promise<SlackCredentialInputs> {
  return {
    appToken: await resolveCredential(
      opts.appToken,
      environment.SLACK_APP_TOKEN,
      "App-level token (xapp-…): ",
      prompt,
    ),
    userToken: await resolveCredential(
      opts.userToken,
      environment.SLACK_USER_TOKEN,
      "Chip user OAuth token (xoxp-…): ",
      prompt,
    ),
  };
}

async function resolveCredential(
  explicit: string | undefined,
  environment: string | undefined,
  question: string,
  prompt: HiddenPrompt,
): Promise<string> {
  if (explicit !== undefined) return explicit.trim();
  const mounted = environment?.trim();
  if (mounted) return mounted;
  return (await prompt(question)).trim();
}

/** Validate and pin the normal Slack account before committing either token. */
export async function configureSlackUserCredentials(args: {
  sourceId: string;
  appToken: string;
  userToken: string;
  secrets: SecretStore;
  sources: Pick<SourceStore, "get" | "upsert">;
  fetch?: typeof globalThis.fetch | undefined;
}): Promise<SlackAgentIdentity> {
  if (!args.appToken.startsWith("xapp-")) {
    throw new Error("Slack app token must start with xapp-");
  }
  if (!args.userToken.startsWith("xoxp-")) {
    throw new Error("Slack user OAuth token must start with xoxp-");
  }
  const source = args.sources.get(args.sourceId);
  if (source?.kind !== "slack") {
    throw new Error(`Slack source ${args.sourceId} disappeared`);
  }
  const agentEmail = stringConfig(source, "agentEmail");
  if (!agentEmail) {
    throw new Error(`Slack source ${args.sourceId} has no agentEmail configured`);
  }

  const fetchImpl = args.fetch ?? globalThis.fetch;
  const connection = await slackCall<SlackConnectionsOpenResponse>(
    "apps.connections.open",
    args.appToken,
    {},
    fetchImpl,
  );
  requireSlackSocketUrl(connection.url);
  const appTokenAppId = resolveSlackAppId(args.appToken);
  const auth = await slackCall<SlackAuthTestResponse>("auth.test", args.userToken, {}, fetchImpl, {
    requiredScopes: ["chat:write", "reactions:write", "mpim:history"],
  });
  // Slack's documented standard user-token response does not include app_id.
  // Some token types still return it; when present it remains a hard mismatch
  // check. Event ingestion independently requires this xapp app id plus the
  // pinned normal user/workspace authorization on every envelope.
  const userTokenAppId = auth.app_id?.trim();
  if (userTokenAppId && appTokenAppId !== userTokenAppId) {
    throw new Error(
      `Slack app/user token mismatch: app token belongs to ${appTokenAppId}, user token belongs to ${userTokenAppId}`,
    );
  }
  const teamId = requiredSlackId(auth.team_id, "team_id", "auth.test");
  const userId = requiredSlackId(auth.user_id, "user_id", "auth.test");

  const info = await slackCall<SlackUsersInfoResponse>(
    "users.info",
    args.userToken,
    { user: userId },
    fetchImpl,
  );
  const user = info.user;
  if (!user || user.id !== userId) {
    throw new Error("Slack users.info did not return the authenticated user");
  }
  if (auth.bot_id || user.is_bot || user.is_app_user) {
    throw new Error("Slack credential resolved to a bot/app identity, not Chip's normal account");
  }
  const email = user.profile?.email?.trim() ?? "";
  if (!email || email.toLowerCase() !== agentEmail.trim().toLowerCase()) {
    throw new Error(`Slack account email does not match configured agentEmail ${agentEmail}`);
  }

  requireMatchingPin(source, "agentAppId", appTokenAppId);
  requireMatchingPin(source, "agentTeamId", teamId);
  requireMatchingPin(source, "agentUserId", userId);
  const identity: SlackAgentIdentity = {
    appId: appTokenAppId,
    teamId,
    userId,
    email,
    name: user.profile?.display_name || user.profile?.real_name || user.name || email,
  };

  const appTokenName = secretNames.slackAppToken(source.id);
  const userTokenName = secretNames.slackUserToken(source.id);
  const legacyBotTokenName = secretNames.slackBotToken(source.id);
  const previousAppToken = args.secrets.get(appTokenName);
  const previousUserToken = args.secrets.get(userTokenName);
  const previousLegacyBotToken = args.secrets.get(legacyBotTokenName);
  try {
    args.sources.upsert({
      id: source.id,
      kind: source.kind,
      enabled: source.enabled,
      config: {
        ...source.config,
        agentAppId: appTokenAppId,
        agentTeamId: teamId,
        agentUserId: userId,
      },
    });
    args.secrets.set(appTokenName, args.appToken);
    args.secrets.set(userTokenName, args.userToken);
    // Retire the old bot credential only after the complete user-token
    // replacement has been persisted. Any failure here rolls everything back.
    if (previousLegacyBotToken !== null) args.secrets.delete(legacyBotTokenName);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      args.sources.upsert(source);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    for (const [name, value] of [
      [appTokenName, previousAppToken],
      [userTokenName, previousUserToken],
      [legacyBotTokenName, previousLegacyBotToken],
    ] as const) {
      try {
        if (value === null) args.secrets.delete(name);
        else args.secrets.set(name, value);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Slack credential update failed and could not be fully rolled back",
      );
    }
    throw error;
  }
  return identity;
}

function selectSlackSource(
  sources: Pick<SourceStore, "findByKind" | "get">,
  requested: string | undefined,
): SourceRecord | null {
  const candidates = sources.findByKind("slack");
  if (requested) {
    const source = sources.get(requested);
    if (source?.kind === "slack") return source;
    console.error(`slack source ${requested} not found`);
    process.exitCode = 1;
    return null;
  }
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length === 0) {
    console.error(
      "No slack source configured yet. Create one first (from Codex: wakewire_source_setup_slack).",
    );
    process.exitCode = 1;
    return null;
  }
  console.error("Multiple slack sources exist — pass --source <id>:");
  for (const source of candidates) {
    console.error(`  ${source.id}  team=${String(source.config.team)}`);
  }
  process.exitCode = 1;
  return null;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
}

interface SlackAuthTestResponse extends SlackApiResponse {
  app_id?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
}

interface SlackConnectionsOpenResponse extends SlackApiResponse {
  url?: string;
}

interface SlackUsersInfoResponse extends SlackApiResponse {
  user?: {
    id?: string;
    name?: string;
    is_bot?: boolean;
    is_app_user?: boolean;
    profile?: { email?: string; display_name?: string; real_name?: string };
  };
}

async function slackCall<T extends SlackApiResponse>(
  method: string,
  token: string,
  params: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
  options: { requiredScopes?: readonly string[] } = {},
): Promise<T> {
  const response = await fetchImpl(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`Slack ${method} request failed with HTTP ${response.status}`);
  const payload = (await response.json()) as T;
  if (!payload.ok) throw new Error(`Slack ${method} failed: ${payload.error ?? "unknown error"}`);
  if (options.requiredScopes?.length) {
    const granted = new Set(
      (response.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    );
    const missing = options.requiredScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new Error(
        `Slack ${method} token is missing required OAuth scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    }
  }
  return payload;
}

function requiredSlackId(value: string | undefined, field: string, method: string): string {
  if (!value) throw new Error(`Slack ${method} did not return ${field}`);
  return value;
}

/**
 * Bind an app-level token to an immutable Slack app id. Current xapp tokens
 * embed it as their third dash-separated field. The `app_id` query parameter
 * in Slack's temporary Socket Mode URL is an opaque connection identifier, not
 * the public app id returned by `auth.test`, so it must not be compared to the
 * user token's identity.
 */
function resolveSlackAppId(appToken: string): string {
  const fromToken = /^xapp-\d+-(A[A-Z0-9]+)-/i.exec(appToken)?.[1];
  if (!fromToken) {
    throw new Error("Slack app token does not encode a verifiable app_id");
  }
  return fromToken;
}

function requireSlackSocketUrl(connectionUrl: string | undefined): void {
  if (!connectionUrl) {
    throw new Error("Slack apps.connections.open did not provide a WebSocket URL");
  }
  try {
    if (new URL(connectionUrl).protocol !== "wss:") throw new Error("not wss");
  } catch {
    throw new Error("Slack apps.connections.open returned an invalid WebSocket URL");
  }
}

function stringConfig(source: SourceRecord, key: string): string | null {
  const value = source.config[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function requireMatchingPin(
  source: SourceRecord,
  key: "agentAppId" | "agentTeamId" | "agentUserId",
  id: string,
) {
  const pinned = stringConfig(source, key);
  if (pinned && pinned !== id) {
    throw new Error(`Slack ${key} pin mismatch: expected ${pinned}, received ${id}`);
  }
}
