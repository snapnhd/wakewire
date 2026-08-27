import type { ResolvedLinearIssue } from "./correlation.js";

const REQUEST_TIMEOUT_MS = 7_500;

export interface LinearIssueDirectory {
  resolveIdentifier(identifier: string): Promise<ResolvedLinearIssue | null>;
  issuesForUrl(url: string): Promise<ResolvedLinearIssue[]>;
}

export class UnconfiguredLinearDirectory implements LinearIssueDirectory {
  async resolveIdentifier(_identifier: string): Promise<ResolvedLinearIssue | null> {
    return null;
  }

  async issuesForUrl(_url: string): Promise<ResolvedLinearIssue[]> {
    return [];
  }
}

export interface LinearGraphqlDirectoryOptions {
  token?: string;
  getToken?: () => Promise<string>;
  invalidateToken?: () => void;
  authKind?: "api-key" | "oauth";
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

/** Narrow read-only Linear directory used for correlation; tokens are never persisted here. */
export class LinearGraphqlDirectory implements LinearIssueDirectory {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: LinearGraphqlDirectoryOptions) {
    if (!options.token && !options.getToken) {
      throw new Error("Linear directory token provider is empty");
    }
    this.endpoint = options.endpoint ?? "https://api.linear.app/graphql";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async resolveIdentifier(identifier: string): Promise<ResolvedLinearIssue | null> {
    const data = await this.query<{
      organization: { id: string };
      issue: null | {
        id: string;
        identifier: string;
        title?: string | null;
        branchName?: string | null;
      };
    }>(
      `query WakeWireIssue($identifier: String!) {
        organization { id }
        issue(id: $identifier) { id identifier title branchName }
      }`,
      { identifier },
    );
    return data.issue ? toIssue(data.organization.id, data.issue) : null;
  }

  async issuesForUrl(url: string): Promise<ResolvedLinearIssue[]> {
    const data = await this.query<{
      organization: { id: string };
      attachmentsForURL: {
        nodes: Array<{
          issue: null | {
            id: string;
            identifier: string;
            title?: string | null;
            branchName?: string | null;
          };
        }>;
      };
    }>(
      `query WakeWireAttachments($url: String!) {
        organization { id }
        attachmentsForURL(url: $url) {
          nodes { issue { id identifier title branchName } }
        }
      }`,
      { url },
    );
    const unique = new Map<string, ResolvedLinearIssue>();
    for (const node of data.attachmentsForURL.nodes) {
      if (node.issue) {
        const issue = toIssue(data.organization.id, node.issue);
        unique.set(issue.issueId, issue);
      }
    }
    return [...unique.values()];
  }

  private async query<T>(query: string, variables: Record<string, string>): Promise<T> {
    let token = this.options.getToken ? await this.options.getToken() : (this.options.token ?? "");
    let response = await this.request(token, query, variables);
    if (response.status === 401 && this.options.getToken && this.options.invalidateToken) {
      this.options.invalidateToken();
      token = await this.options.getToken();
      response = await this.request(token, query, variables);
    }
    let body: { data?: T; errors?: Array<{ message?: string }> };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new Error(`Linear directory returned invalid JSON (${response.status})`);
    }
    if (!response.ok || body.errors?.length) {
      const detail = body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `Linear directory query failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!body.data) throw new Error("Linear directory response had no data");
    return body.data;
  }

  private request(
    token: string,
    query: string,
    variables: Record<string, string>,
  ): Promise<Response> {
    const authorization = this.options.authKind === "oauth" ? `Bearer ${token}` : token;
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  }
}

function toIssue(
  organizationId: string,
  issue: {
    id: string;
    identifier: string;
    title?: string | null;
    branchName?: string | null;
  },
): ResolvedLinearIssue {
  return {
    organizationId,
    issueId: issue.id,
    identifier: issue.identifier.toUpperCase(),
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.branchName ? { branchName: issue.branchName } : {}),
  };
}
