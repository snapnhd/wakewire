import { WebClient } from "@slack/web-api";
import type { SourceStore } from "../db/repos.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import { linearApiKeyFromEnvironment } from "../sources/linear/environment.js";
import {
  LinearAgentTokenProvider,
  type LinearAuthKind,
  linearAuthorization,
} from "../sources/linear/token.js";
import type { Person } from "./schema.js";
import type { PeopleStore } from "./store.js";

export interface ResolvedAccount {
  provider: "github" | "linear" | "slack";
  tenantId: string;
  externalId: string;
  handle?: string;
  displayName?: string;
  matchedEmail?: string;
}

export interface AccountResolutionReport {
  attached: ResolvedAccount[];
  unresolved: Array<{ provider: string; reason: string }>;
}

export interface SlackDirectoryClient {
  auth: { test(): Promise<{ team_id?: string }> };
  users: {
    lookupByEmail(args: { email: string }): Promise<{
      user?: {
        id?: string;
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
    }>;
  };
}

export interface AccountDirectoryDependencies {
  fetch?: typeof globalThis.fetch;
  slackClient?: (token: string) => SlackDirectoryClient;
  linearApiKey?: string | null;
}

/** Resolve enrollment emails to immutable ids, then pin them in PeopleStore. */
export async function resolvePersonAccounts(args: {
  person: Person;
  people: PeopleStore;
  sources: SourceStore;
  secrets: SecretStore;
  githubLogin?: string | undefined;
  dependencies?: AccountDirectoryDependencies;
}): Promise<AccountResolutionReport> {
  const fetchImpl = args.dependencies?.fetch ?? globalThis.fetch;
  const slackClient = args.dependencies?.slackClient ?? ((token: string) => new WebClient(token));
  const attached: ResolvedAccount[] = [];
  const unresolved: Array<{ provider: string; reason: string }> = [];

  const slackSources = args.sources.findByKind("slack");
  if (slackSources.length === 0) {
    unresolved.push({ provider: "slack", reason: "no Slack source is configured" });
  }
  for (const source of slackSources) {
    const token = args.secrets.get(secretNames.slackUserToken(source.id));
    if (!token) {
      unresolved.push({
        provider: "slack",
        reason: `user token is not configured for ${source.id}`,
      });
      continue;
    }
    try {
      const client = slackClient(token);
      const auth = await client.auth.test();
      if (!auth.team_id) throw new Error("Slack auth.test returned no team id");
      const candidates: ResolvedAccount[] = [];
      for (const email of args.person.emails) {
        try {
          const result = await client.users.lookupByEmail({ email });
          if (result.user?.id) {
            candidates.push({
              provider: "slack",
              tenantId: auth.team_id,
              externalId: result.user.id,
              ...(result.user.name ? { handle: result.user.name } : {}),
              ...(slackDisplayName(result.user)
                ? { displayName: slackDisplayName(result.user) }
                : {}),
              matchedEmail: email,
            });
          }
        } catch {
          // Try every enrolled email; report only when none resolve.
        }
      }
      attachUnique(args.people, args.person.id, candidates, attached);
      if (candidates.length === 0) {
        unresolved.push({ provider: "slack", reason: `no account matched in ${auth.team_id}` });
      }
    } catch (error) {
      unresolved.push({ provider: "slack", reason: safeMessage(error) });
    }
  }

  const githubSource = args.sources.findByKind("github")[0];
  const githubToken = githubSource
    ? args.secrets.get(secretNames.githubApiToken(githubSource.id))
    : null;
  try {
    const github = args.githubLogin
      ? await githubUserByLogin(fetchImpl, args.githubLogin, githubToken)
      : await githubUserByEmails(fetchImpl, args.person.emails, githubToken);
    if (github) {
      attachUnique(
        args.people,
        args.person.id,
        [
          {
            provider: "github",
            tenantId: "github.com",
            externalId: String(github.id),
            handle: github.login,
            ...(github.name ? { displayName: github.name } : {}),
            ...(github.email ? { matchedEmail: github.email.toLowerCase() } : {}),
          },
        ],
        attached,
      );
    } else {
      unresolved.push({
        provider: "github",
        reason: args.githubLogin
          ? `GitHub login ${args.githubLogin} was not found`
          : "no unique public-email match; pass --github-login to bind an explicit account",
      });
    }
  } catch (error) {
    unresolved.push({ provider: "github", reason: safeMessage(error) });
  }

  const linearSource = args.sources
    .findByKind("webhook")
    .find((source) => String(source.config.name).toLowerCase() === "linear");
  const linearApiKey =
    args.dependencies && Object.hasOwn(args.dependencies, "linearApiKey")
      ? (args.dependencies.linearApiKey ?? null)
      : linearApiKeyFromEnvironment();
  if (!linearSource && !linearApiKey) {
    unresolved.push({
      provider: "linear",
      reason: "no Linear source or dedicated LINEAR_API_KEY is configured",
    });
  } else {
    try {
      const authKind: LinearAuthKind = linearApiKey ? "api-key" : "oauth";
      const linearToken = linearApiKey
        ? linearApiKey
        : await new LinearAgentTokenProvider(linearSource?.id ?? "", args.secrets, {
            fetch: fetchImpl,
          }).getToken();
      const candidates = await linearUsersByEmails(
        fetchImpl,
        linearToken,
        authKind,
        args.person.emails,
      );
      attachUnique(args.people, args.person.id, candidates, attached);
      if (candidates.length === 0) {
        unresolved.push({ provider: "linear", reason: "no user matched an enrolled email" });
      }
    } catch (error) {
      unresolved.push({ provider: "linear", reason: safeMessage(error) });
    }
  }

  return { attached, unresolved };
}

function attachUnique(
  people: PeopleStore,
  personId: string,
  candidates: ResolvedAccount[],
  attached: ResolvedAccount[],
): void {
  const unique = new Map<string, ResolvedAccount>();
  for (const candidate of candidates) {
    unique.set(`${candidate.provider}\0${candidate.tenantId}\0${candidate.externalId}`, candidate);
  }
  for (const candidate of unique.values()) {
    people.attachIdentity({
      personId,
      provider: candidate.provider,
      tenantId: candidate.tenantId,
      externalId: candidate.externalId,
      handle: candidate.handle,
      displayName: candidate.displayName,
    });
    attached.push(candidate);
  }
}

async function githubUserByEmails(
  fetchImpl: typeof globalThis.fetch,
  emails: string[],
  token: string | null,
): Promise<GithubUser | null> {
  const matches = new Map<number, GithubUser>();
  for (const email of emails) {
    const url = new URL("https://api.github.com/search/users");
    url.searchParams.set("q", `${email} in:email`);
    const result = await githubJson<{ items?: Array<{ login?: string; id?: number }> }>(
      fetchImpl,
      url,
      token,
    );
    for (const item of result.items ?? []) {
      if (item.login && item.id) {
        const profile = await githubUserByLogin(fetchImpl, item.login, token);
        if (profile?.email?.toLowerCase() === email.toLowerCase()) matches.set(profile.id, profile);
      }
    }
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}

async function githubUserByLogin(
  fetchImpl: typeof globalThis.fetch,
  login: string,
  token: string | null,
): Promise<GithubUser | null> {
  const response = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: githubHeaders(token),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub directory failed with HTTP ${response.status}`);
  const profile = (await response.json()) as Record<string, unknown>;
  return typeof profile.id === "number" && typeof profile.login === "string"
    ? {
        id: profile.id,
        login: profile.login,
        ...(typeof profile.name === "string" ? { name: profile.name } : {}),
        ...(typeof profile.email === "string" ? { email: profile.email } : {}),
      }
    : null;
}

async function githubJson<T>(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  token: string | null,
): Promise<T> {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub directory failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

function githubHeaders(token: string | null): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function linearUsersByEmails(
  fetchImpl: typeof globalThis.fetch,
  token: string,
  authKind: LinearAuthKind,
  emails: string[],
): Promise<ResolvedAccount[]> {
  const candidates: ResolvedAccount[] = [];
  for (const email of emails) {
    const response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: linearAuthorization(token, authKind),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `query WakeWireUser($email: String!) {
          organization { id }
          users(first: 2, filter: { email: { eq: $email } }) {
            nodes { id name displayName email }
          }
        }`,
        variables: { email },
      }),
    });
    const body = (await response.json()) as {
      data?: {
        organization?: { id?: string };
        users?: { nodes?: Array<Record<string, unknown>> };
      };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || body.errors?.length) {
      throw new Error(`Linear directory failed with HTTP ${response.status}`);
    }
    const organizationId = body.data?.organization?.id;
    const nodes = body.data?.users?.nodes ?? [];
    if (!organizationId || nodes.length > 1) continue;
    const user = nodes[0];
    if (typeof user?.id !== "string") continue;
    candidates.push({
      provider: "linear",
      tenantId: organizationId,
      externalId: user.id,
      ...(typeof user.displayName === "string" ? { handle: user.displayName } : {}),
      ...(typeof user.name === "string" ? { displayName: user.name } : {}),
      matchedEmail: email,
    });
  }
  return candidates;
}

function slackDisplayName(user: {
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}): string {
  return user.profile?.display_name || user.profile?.real_name || user.real_name || "";
}

interface GithubUser {
  id: number;
  login: string;
  name?: string;
  email?: string;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
