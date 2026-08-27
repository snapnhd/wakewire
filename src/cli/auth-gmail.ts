import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline/promises";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, secretNames } from "../secrets/store.js";
import { promptHidden } from "./prompt.js";

const GMAIL_SCOPE = "https://mail.google.com/"; // required for IMAP XOAUTH2
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface GmailCredentialPromptDependencies {
  promptVisible?: ((question: string) => Promise<string>) | undefined;
  promptSecret?: ((question: string) => Promise<string>) | undefined;
}

export interface GmailOAuthCallbackOptions {
  timeoutMs?: number | undefined;
  randomBytes?: ((size: number) => Buffer) | undefined;
  onAuthorizationUrl?: ((url: string) => void) | undefined;
}

export interface GmailOAuthAuthorization {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/**
 * Interactive OAuth consent for a gmail source. The user supplies their own
 * OAuth client (Desktop type): wakewire is self-hosted, so shipping a shared
 * client id would put every user behind Google's restricted-scope app
 * verification. A personal client in test mode works immediately.
 */
export async function authGmail(
  logger: Logger,
  opts: { source?: string; clientId?: string; clientSecret?: string },
): Promise<void> {
  const db = openDatabase();
  const stores = createStores(db);
  const gmailSources = stores.sources.findByKind("gmail");
  let sourceId = opts.source;
  if (!sourceId) {
    if (gmailSources.length === 1) {
      sourceId = gmailSources[0]?.id;
    } else if (gmailSources.length === 0) {
      console.error(
        "No gmail source configured yet. Create one first (from Codex: wakewire_source_setup_gmail, or POST /api/sources/gmail/setup).",
      );
      process.exitCode = 1;
      return;
    } else {
      console.error("Multiple gmail sources exist — pass --source <id>:");
      for (const s of gmailSources) {
        console.error(`  ${s.id}  label=${String(s.config.label)}`);
      }
      process.exitCode = 1;
      return;
    }
  }
  if (!sourceId || !stores.sources.get(sourceId)) {
    console.error(`gmail source ${sourceId} not found`);
    process.exitCode = 1;
    return;
  }

  const { clientId, clientSecret } = await readGmailOAuthClientCredentials(opts);
  if (!clientId || !clientSecret) {
    console.error("client id and secret are required");
    process.exitCode = 1;
    return;
  }

  const { code, redirectUri, codeVerifier } = await receiveAuthCode(clientId, clientSecret);
  const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    console.error(
      "Google did not return a refresh token. Remove the app's prior grant at " +
        "https://myaccount.google.com/permissions and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.gmailClientId(sourceId), clientId);
  secrets.set(secretNames.gmailClientSecret(sourceId), clientSecret);
  secrets.set(secretNames.gmailRefreshToken(sourceId), tokens.refresh_token);
  console.log(`Stored Gmail OAuth credentials for source ${sourceId} (${secrets.backend}).`);

  db.close();
  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the gmail source is (re)starting.");
  } catch {
    console.log("Daemon not running; the source will start with the next `wakewire start`.");
  }
}

export async function readGmailOAuthClientCredentials(
  opts: { clientId?: string; clientSecret?: string },
  dependencies: GmailCredentialPromptDependencies = {},
): Promise<{ clientId: string; clientSecret: string }> {
  const promptVisible = dependencies.promptVisible ?? visiblePrompt;
  const promptSecret = dependencies.promptSecret ?? promptHidden;
  const clientId = (opts.clientId ?? (await promptVisible("Google OAuth client ID: "))).trim();
  const clientSecret = (
    opts.clientSecret ?? (await promptSecret("Google OAuth client secret: "))
  ).trim();
  return { clientId, clientSecret };
}

async function visiblePrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function receiveAuthCode(
  clientId: string,
  clientSecret: string,
  options: GmailOAuthCallbackOptions = {},
): Promise<GmailOAuthAuthorization> {
  const timeoutMs = options.timeoutMs ?? OAUTH_CALLBACK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("OAuth callback timeout must be a positive number"));
  }
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;
    let redirectUri = "";

    const finish = (error?: Error, result?: GmailOAuthAuthorization) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (server.listening) server.close();
      if (error) reject(error);
      else if (result) resolve(result);
    };

    server.on("request", (req, res) => {
      const reqUrl = new URL(req.url ?? "/", redirectUri);
      if (req.method !== "GET" || reqUrl.pathname !== "/oauth2callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      const returnedState = reqUrl.searchParams.get("state");
      if (!returnedState || !timingSafeEqual(returnedState, state)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("wakewire: authorization failed: invalid OAuth state");
        finish(new Error("authorization failed: invalid OAuth state"));
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`wakewire: authorization failed: ${error ?? "no code"}`);
        finish(new Error(`authorization failed: ${error ?? "no code returned"}`));
        return;
      }

      res.writeHead(200, { "content-type": "text/plain" });
      res.end("wakewire: Gmail authorization received. You can close this tab.");
      finish(undefined, { code, redirectUri, codeVerifier });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish(new Error("could not open loopback listener"));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const url = oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [GMAIL_SCOPE],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
      timeout = setTimeout(
        () => finish(new Error(`authorization timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      try {
        if (options.onAuthorizationUrl) {
          options.onAuthorizationUrl(url);
        } else {
          console.log("\nOpen this URL in your browser and approve access:\n");
          console.log(`  ${url}\n`);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    server.on("error", (error) => finish(error));
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}
