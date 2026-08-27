import { describe, expect, it, vi } from "vitest";
import { LinearGraphqlDirectory } from "./linear-directory.js";

describe("LinearGraphqlDirectory", () => {
  it("resolves an identifier to immutable ids and exact branch", async () => {
    let requestInit: RequestInit | undefined;
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      requestInit = init;
      return Response.json({
        data: {
          organization: { id: "org-1" },
          issue: {
            id: "issue-1",
            identifier: "ENG-4610",
            title: "Fix local workspace naming",
            branchName: "cj/eng-4610-fix-it",
          },
        },
      });
    });
    const directory = new LinearGraphqlDirectory({ token: "not-logged", fetch });
    await expect(directory.resolveIdentifier("ENG-4610")).resolves.toEqual({
      organizationId: "org-1",
      issueId: "issue-1",
      identifier: "ENG-4610",
      title: "Fix local workspace naming",
      branchName: "cj/eng-4610-fix-it",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requestInit?.headers).toMatchObject({ authorization: "not-logged" });
  });

  it("deduplicates attachment matches and surfaces GraphQL errors", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: {
          organization: { id: "org" },
          attachmentsForURL: {
            nodes: [
              { issue: { id: "i", identifier: "ENG-1" } },
              { issue: { id: "i", identifier: "ENG-1" } },
            ],
          },
        },
      }),
    );
    const directory = new LinearGraphqlDirectory({ token: "token", fetch });
    await expect(directory.issuesForUrl("https://github.com/a/b/pull/1")).resolves.toHaveLength(1);

    const failing = new LinearGraphqlDirectory({
      token: "token",
      fetch: vi.fn(async () => Response.json({ errors: [{ message: "denied" }] })),
    });
    await expect(failing.resolveIdentifier("ENG-1")).rejects.toThrow("denied");
  });

  it("invalidates and retries once after an OAuth 401", async () => {
    const tokens = ["expired-token", "fresh-token"];
    const getToken = vi.fn(async () => tokens.shift() ?? "fresh-token");
    const invalidateToken = vi.fn();
    const authorizations: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push((init?.headers as Record<string, string>).authorization ?? "");
      if (authorizations.length === 1) return new Response("unauthorized", { status: 401 });
      return Response.json({
        data: {
          organization: { id: "org-1" },
          issue: { id: "issue-1", identifier: "ENG-1", branchName: "eng-1-fix" },
        },
      });
    });
    const directory = new LinearGraphqlDirectory({
      getToken,
      invalidateToken,
      authKind: "oauth",
      fetch,
    });

    await expect(directory.resolveIdentifier("ENG-1")).resolves.toMatchObject({
      issueId: "issue-1",
      branchName: "eng-1-fix",
    });
    expect(invalidateToken).toHaveBeenCalledOnce();
    expect(authorizations).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
  });
});
