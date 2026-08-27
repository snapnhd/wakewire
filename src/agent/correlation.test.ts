import { describe, expect, it, vi } from "vitest";
import {
  AmbiguousLinearReferenceError,
  type CanonicalConversation,
  ConflictingCorrelationAliasesError,
  type CorrelationRepository,
  correlateConversation,
  UnresolvedLinearReferenceError,
} from "./correlation.js";
import { extractLinearReferences } from "./references.js";

function repository(
  aliases: ReadonlyMap<string, CanonicalConversation> = new Map(),
): CorrelationRepository & {
  findByAlias: ReturnType<typeof vi.fn<CorrelationRepository["findByAlias"]>>;
  resolveLinearIdentifier: ReturnType<
    typeof vi.fn<CorrelationRepository["resolveLinearIdentifier"]>
  >;
} {
  return {
    findByAlias: vi.fn(async (key: string) => aliases.get(key) ?? null),
    resolveLinearIdentifier: vi.fn(async (identifier: string) =>
      identifier === "ENG-42"
        ? {
            organizationId: "linear-org",
            issueId: "issue-uuid",
            identifier,
            branchName: "fix-correlation-eng-42",
          }
        : null,
    ),
  };
}

const github = {
  repositoryId: "repo-1",
  itemType: "pull-request" as const,
  itemId: 88,
};
const slack = { teamId: "T1", channelId: "C1", rootTs: "123.456" };
const gmail = { mailbox: "CJ@SnapCorp.com", rfcThreadId: "<root@example.com>" };
const email = { mailbox: "CJ@SnapCorp.com", personId: "person-cj", subject: "Re: Build it" };

describe("correlateConversation", () => {
  it("gives a native Linear issue absolute precedence without repository lookups", async () => {
    const repo = repository();
    const result = await correlateConversation(
      {
        linear: {
          organizationId: "org",
          issueId: "issue",
          identifier: "ENG-1",
          branchName: "ship-it-eng-1",
        },
        github,
      },
      repo,
    );

    expect(result.canonical).toEqual({ key: "linear:org:issue", kind: "linear" });
    expect(result.linearIssue?.branchName).toBe("ship-it-eng-1");
    expect(result.aliases).toEqual(["github:repo-1:pull-request:88"]);
    expect(repo.resolveLinearIdentifier).not.toHaveBeenCalled();
    expect(repo.findByAlias).not.toHaveBeenCalled();
  });

  it("resolves one referenced Linear issue ahead of existing provider aliases", async () => {
    const repo = repository(
      new Map([["github:repo-1:pull-request:88", { key: "github:old", kind: "github" }]]),
    );
    const result = await correlateConversation(
      {
        linearReferences: extractLinearReferences({ text: "Please handle ENG-42" }),
        github,
      },
      repo,
    );

    expect(result.canonical).toEqual({
      key: "linear:linear-org:issue-uuid",
      kind: "linear",
    });
    expect(repo.resolveLinearIdentifier).toHaveBeenCalledWith("ENG-42");
    expect(repo.findByAlias).not.toHaveBeenCalled();
  });

  it("rejects multiple distinct Linear references before looking anything up", async () => {
    const repo = repository();
    const attempt = correlateConversation(
      {
        linearReferences: extractLinearReferences({ text: "ENG-42 is blocked by OPS-9" }),
        github,
      },
      repo,
    );

    await expect(attempt).rejects.toBeInstanceOf(AmbiguousLinearReferenceError);
    expect(repo.resolveLinearIdentifier).not.toHaveBeenCalled();
    expect(repo.findByAlias).not.toHaveBeenCalled();
  });

  it("fails closed when an explicit Linear reference cannot be resolved", async () => {
    const repo = repository();
    const attempt = correlateConversation(
      {
        linearReferences: extractLinearReferences({ text: "Use OPS-404" }),
        github,
      },
      repo,
    );

    await expect(attempt).rejects.toBeInstanceOf(UnresolvedLinearReferenceError);
    expect(repo.findByAlias).not.toHaveBeenCalled();
  });

  it("reuses any existing alias before creating a provider fallback", async () => {
    const discovery = repository();
    const fresh = await correlateConversation({ github, slack }, discovery);
    const slackAlias = fresh.aliases.find((alias) => alias.startsWith("slack:"));
    expect(slackAlias).toBeDefined();

    const existing = { key: "linear:org:linked-issue", kind: "linear" } as const;
    const repo = repository(new Map([[slackAlias ?? "", existing]]));
    const result = await correlateConversation({ github, slack }, repo);

    expect(result.canonical).toEqual(existing);
    expect(result.reused).toBe(true);
  });

  it("rejects aliases already bound to different conversations", async () => {
    const discovery = repository();
    const fresh = await correlateConversation({ github, slack }, discovery);
    const [githubAlias, slackAlias] = fresh.aliases;
    const repo = repository(
      new Map([
        [githubAlias ?? "", { key: "github:a", kind: "github" }],
        [slackAlias ?? "", { key: "slack:b", kind: "slack" }],
      ]),
    );

    await expect(correlateConversation({ github, slack }, repo)).rejects.toBeInstanceOf(
      ConflictingCorrelationAliasesError,
    );
  });

  it("uses provider fallback precedence in the specified order", async () => {
    const repo = repository();
    const githubResult = await correlateConversation({ github, slack, gmail, email }, repo);
    const slackResult = await correlateConversation({ slack, gmail, email }, repo);
    const gmailResult = await correlateConversation({ gmail, email }, repo);
    const emailResult = await correlateConversation({ email }, repo);

    expect(githubResult.canonical.kind).toBe("github");
    expect(slackResult.canonical.kind).toBe("slack");
    expect(gmailResult.canonical.kind).toBe("gmail-rfc");
    expect(emailResult.canonical.kind).toBe("email-subject");
  });

  it("scopes normalized subject fallback by mailbox and person", async () => {
    const repo = repository();
    const first = await correlateConversation({ email }, repo);
    const repeated = await correlateConversation(
      {
        email: {
          mailbox: "cj@snapcorp.com",
          personId: "PERSON-CJ",
          subject: "Fwd: RE: build   IT",
        },
      },
      repo,
    );
    const otherPerson = await correlateConversation(
      { email: { ...email, personId: "person-someone-else" } },
      repo,
    );
    const otherMailbox = await correlateConversation(
      { email: { ...email, mailbox: "other@snapcorp.com" } },
      repo,
    );

    expect(repeated.canonical.key).toBe(first.canonical.key);
    expect(otherPerson.canonical.key).not.toBe(first.canonical.key);
    expect(otherMailbox.canonical.key).not.toBe(first.canonical.key);
  });
});
