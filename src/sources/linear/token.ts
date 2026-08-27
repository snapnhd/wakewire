import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const TOKEN_SKEW_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 7_500;
export const LINEAR_AGENT_SCOPES = "read,write,app:mentionable,app:assignable";
export type LinearAuthKind = "api-key" | "oauth";

export interface LinearViewerIdentity {
  id: string;
  name: string;
  email: string;
  organizationId: string;
}

interface LinearTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

export class LinearAgentTokenProvider {
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(
    private readonly sourceId: string,
    private readonly secrets: SecretStore,
    options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const token = this.secrets.get(secretNames.linearAgentToken(this.sourceId));
    const expiresAt = Number(
      this.secrets.get(secretNames.linearAgentTokenExpiresAt(this.sourceId)) ?? "0",
    );
    const clientId = this.secrets.get(secretNames.linearAgentClientId(this.sourceId));
    const clientSecret = this.secrets.get(secretNames.linearAgentClientSecret(this.sourceId));

    if (token && Number.isFinite(expiresAt) && expiresAt > this.now() + TOKEN_SKEW_MS) {
      return token;
    }
    if (!clientId || !clientSecret) {
      throw new Error(`renewable Linear app credentials are not configured for ${this.sourceId}`);
    }
    if (!this.refreshing) {
      this.refreshing = this.mint(clientId, clientSecret).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  invalidate(): void {
    this.secrets.set(secretNames.linearAgentTokenExpiresAt(this.sourceId), "0");
  }

  private async mint(clientId: string, clientSecret: string): Promise<string> {
    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: LINEAR_AGENT_SCOPES,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    let body: LinearTokenResponse & { error?: unknown; error_description?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new Error(`Linear OAuth token endpoint returned invalid JSON (${response.status})`);
    }
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const detail =
        typeof body.error_description === "string"
          ? body.error_description
          : typeof body.error === "string"
            ? body.error
            : "token mint failed";
      throw new Error(`Linear OAuth token request failed (${response.status}): ${detail}`);
    }
    const expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("Linear OAuth token response did not include a valid expires_in");
    }
    this.secrets.set(secretNames.linearAgentToken(this.sourceId), body.access_token);
    this.secrets.set(
      secretNames.linearAgentTokenExpiresAt(this.sourceId),
      String(this.now() + expiresIn * 1_000),
    );
    return body.access_token;
  }
}

export async function linearViewer(
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  authKind: LinearAuthKind = "oauth",
): Promise<{ id: string; name: string }> {
  const identity = await linearViewerIdentity(token, fetchImpl, authKind);
  return { id: identity.id, name: identity.name };
}

export async function linearViewerIdentity(
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  authKind: LinearAuthKind = "oauth",
): Promise<LinearViewerIdentity> {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      authorization: linearAuthorization(token, authKind),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: "query WakeWireLinearViewer { viewer { id name email } organization { id } }",
    }),
  });
  let body: {
    data?: {
      viewer?: { id?: unknown; name?: unknown; email?: unknown };
      organization?: { id?: unknown };
    };
    errors?: Array<{ message?: unknown }>;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error(`Linear viewer query returned invalid JSON (${response.status})`);
  }
  const id = body.data?.viewer?.id;
  const organizationId = body.data?.organization?.id;
  if (
    !response.ok ||
    body.errors?.length ||
    typeof id !== "string" ||
    !id ||
    typeof organizationId !== "string" ||
    !organizationId
  ) {
    const detail = body.errors
      ?.map((error) => error.message)
      .filter((message): message is string => typeof message === "string")
      .join("; ");
    throw new Error(
      `Linear viewer query failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return {
    id,
    name: typeof body.data?.viewer?.name === "string" ? body.data.viewer.name : "",
    email: typeof body.data?.viewer?.email === "string" ? body.data.viewer.email : "",
    organizationId,
  };
}

export function linearAuthorization(token: string, authKind: LinearAuthKind): string {
  return authKind === "oauth" ? `Bearer ${token}` : token;
}
