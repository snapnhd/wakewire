import readline from "node:readline/promises";
import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import type { SourceStore } from "../db/repos.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, type SecretStore, secretNames } from "../secrets/store.js";
import { LinearAgentTokenProvider, linearViewer } from "../sources/linear/token.js";
import { promptHidden } from "./prompt.js";

export async function authGithubApi(
  logger: Logger,
  opts: { source?: string; token?: string },
): Promise<void> {
  const sourceId = selectSource("github", opts.source);
  if (!sourceId) return;
  const token = opts.token ?? (await promptHidden("GitHub App installation/PAT token: "));
  if (!token) throw new Error("no GitHub token provided");
  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.githubApiToken(sourceId), token);
  console.log(`Stored GitHub API token for ${sourceId} (${secrets.backend}).`);
  console.log("Required access: reactions/comments write for the repositories Chip watches.");
}

export async function authLinearAgent(
  logger: Logger,
  opts: { source?: string; clientId?: string; clientSecret?: string },
): Promise<void> {
  const sourceId = selectSource("linear", opts.source);
  if (!sourceId) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const clientId = opts.clientId ?? (await rl.question("Linear OAuth app client ID: ")).trim();
  rl.close();
  const clientSecret =
    opts.clientSecret ?? (await promptHidden("Linear OAuth app client secret: "));
  if (!clientId || !clientSecret) throw new Error("Linear client id and secret are required");
  const secrets = await createSecretStore(logger);

  const db = openDatabase();
  let viewer: { id: string; name: string };
  try {
    const sources = createStores(db).sources;
    viewer = await configureLinearAgentCredentials({
      sourceId,
      clientId,
      clientSecret,
      secrets,
      sources,
    });
  } finally {
    db.close();
  }
  console.log(`Stored renewable Linear app credentials for ${sourceId} (${secrets.backend}).`);
  console.log(`Pinned Linear app user ${viewer.name || "Chip"} (${viewer.id}).`);
  console.log("These credentials are dedicated to Chip, never Snap's controller LINEAR_API_KEY.");
  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the Linear source is restarting with the pinned app user.");
  } catch {
    console.log("Daemon not running; the source will use the pin on the next start.");
  }
}

/**
 * Validate replacement Linear credentials and their immutable app identity in
 * an isolated store, then commit the complete credential set. A failed mint or
 * viewer query never overwrites a working installation.
 */
export async function configureLinearAgentCredentials(args: {
  sourceId: string;
  clientId: string;
  clientSecret: string;
  secrets: SecretStore;
  sources: Pick<SourceStore, "get" | "upsert">;
  fetch?: typeof globalThis.fetch | undefined;
  now?: (() => number) | undefined;
}): Promise<{ id: string; name: string }> {
  const source = args.sources.get(args.sourceId);
  if (source?.kind !== "webhook") {
    throw new Error(`Linear webhook source ${args.sourceId} disappeared`);
  }

  const staged = new MemorySecretStore();
  staged.set(secretNames.linearAgentClientId(args.sourceId), args.clientId);
  staged.set(secretNames.linearAgentClientSecret(args.sourceId), args.clientSecret);
  const provider = new LinearAgentTokenProvider(args.sourceId, staged, {
    ...(args.fetch ? { fetch: args.fetch } : {}),
    ...(args.now ? { now: args.now } : {}),
  });
  const token = await provider.getToken();
  const viewer = await linearViewer(token, args.fetch);

  const credentialNames = [
    secretNames.linearAgentClientId(args.sourceId),
    secretNames.linearAgentClientSecret(args.sourceId),
    secretNames.linearAgentToken(args.sourceId),
    secretNames.linearAgentTokenExpiresAt(args.sourceId),
  ];
  const previous = new Map(credentialNames.map((name) => [name, args.secrets.get(name)] as const));
  try {
    for (const name of credentialNames) {
      const value = staged.get(name);
      if (!value) throw new Error(`validated Linear credential ${name} is missing`);
      args.secrets.set(name, value);
    }
    args.sources.upsert({
      id: source.id,
      kind: source.kind,
      enabled: source.enabled,
      config: { ...source.config, linearAppUserId: viewer.id },
    });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const [name, value] of previous) {
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
        "Linear credential update failed and could not be fully rolled back",
      );
    }
    throw error;
  }
  return viewer;
}

class MemorySecretStore implements SecretStore {
  readonly backend = "file" as const;
  private readonly values = new Map<string, string>();

  get(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }
}

function selectSource(provider: "github" | "linear", requested: string | undefined): string | null {
  const db = openDatabase();
  try {
    const sources = createStores(db).sources;
    const candidates =
      provider === "github"
        ? sources.findByKind("github")
        : sources
            .findByKind("webhook")
            .filter((source) => String(source.config.name).toLowerCase() === "linear");
    if (requested) {
      const source = candidates.find((candidate) => candidate.id === requested);
      if (!source) throw new Error(`${provider} source ${requested} was not found`);
      return source.id;
    }
    if (candidates.length === 1) return candidates[0]?.id ?? null;
    if (candidates.length === 0) {
      console.error(`No ${provider} source is configured.`);
      process.exitCode = 1;
      return null;
    }
    console.error(`Multiple ${provider} sources exist — pass --source <id>:`);
    for (const source of candidates) console.error(`  ${source.id}`);
    process.exitCode = 1;
    return null;
  } finally {
    db.close();
  }
}
