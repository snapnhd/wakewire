import { createHash } from "node:crypto";
import {
  isValidLowercaseBranch,
  type LinearReference,
  normalizeEmailSubject,
  uniqueLinearIdentifiers,
} from "./references.js";

const EXACT_LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

export type CorrelationKind = "email-subject" | "github" | "gmail-rfc" | "linear" | "slack";

export interface CanonicalConversation {
  key: string;
  kind: CorrelationKind;
}

export interface ResolvedLinearIssue {
  organizationId: string;
  issueId: string;
  identifier: string;
  title?: string;
  branchName?: string;
}

export interface CorrelationRepository {
  /** Resolve a human Linear identifier to immutable provider IDs and its exact branch name. */
  resolveLinearIdentifier(identifier: string): Promise<ResolvedLinearIssue | null>;
  /** Return the canonical conversation previously bound to an opaque provider alias. */
  findByAlias(aliasKey: string): Promise<CanonicalConversation | null>;
}

export interface CorrelationInput {
  /** Native Linear webhooks should provide this trusted identity directly. */
  linear?: ResolvedLinearIssue;
  /** References extracted from non-Linear messages with extractLinearReferences. */
  linearReferences?: readonly LinearReference[];
  github?: {
    repositoryId: string;
    itemType: "issue" | "pull-request";
    itemId: string | number;
  };
  slack?: {
    teamId: string;
    channelId: string;
    /** The source-normalized root timestamp, not the timestamp of an individual reply. */
    rootTs: string;
  };
  gmail?: {
    mailbox: string;
    /** Root Message-ID inferred from RFC References/In-Reply-To, excluding a new message's ID. */
    rfcThreadId: string;
  };
  email?: {
    mailbox: string;
    /** Stable enrolled person ID or canonical sender address. */
    personId: string;
    subject: string;
  };
}

export interface CorrelationDecision {
  canonical: CanonicalConversation;
  /** Every provider key the caller should bind to canonical after creating/reusing the task. */
  aliases: readonly string[];
  /** True only when findByAlias selected an already-bound canonical conversation. */
  reused: boolean;
  linearIssue?: ResolvedLinearIssue;
}

export class AmbiguousLinearReferenceError extends Error {
  constructor(readonly identifiers: readonly string[]) {
    super(`message refers to multiple Linear issues: ${identifiers.join(", ")}`);
  }
}

export class UnresolvedLinearReferenceError extends Error {
  constructor(readonly identifier: string) {
    super(`Linear issue ${identifier} could not be resolved`);
  }
}

export class ConflictingCorrelationAliasesError extends Error {
  constructor(readonly canonicalKeys: readonly string[]) {
    super(`provider aliases are bound to different conversations: ${canonicalKeys.join(", ")}`);
  }
}

export class InvalidCorrelationInputError extends Error {}

/**
 * Choose one canonical conversation with strict precedence:
 * Linear > any existing alias > GitHub > Slack root > Gmail RFC thread > scoped subject.
 */
export async function correlateConversation(
  input: CorrelationInput,
  repository: CorrelationRepository,
): Promise<CorrelationDecision> {
  const aliases = buildAliases(input);

  if (input.linear) return linearDecision(validateLinearIssue(input.linear), aliases);

  const identifiers = uniqueLinearIdentifiers(input.linearReferences ?? []);
  if (identifiers.length > 1) throw new AmbiguousLinearReferenceError(identifiers);
  const identifier = identifiers[0];
  if (identifier) {
    const resolved = await repository.resolveLinearIdentifier(identifier);
    if (!resolved) throw new UnresolvedLinearReferenceError(identifier);
    return linearDecision(validateLinearIssue(resolved), aliases);
  }

  const existing = await existingConversation(aliases, repository);
  if (existing)
    return { canonical: existing, aliases: aliases.map(({ key }) => key), reused: true };

  const fallback = aliases[0];
  if (!fallback) {
    throw new InvalidCorrelationInputError("no stable conversation identity was provided");
  }
  return {
    canonical: fallback,
    aliases: aliases.map(({ key }) => key),
    reused: false,
  };
}

interface CorrelationAlias extends CanonicalConversation {
  priority: number;
}

function buildAliases(input: CorrelationInput): CorrelationAlias[] {
  const aliases: CorrelationAlias[] = [];

  if (input.github) {
    const repositoryId = required(input.github.repositoryId, "GitHub repository ID");
    const itemId = required(String(input.github.itemId), "GitHub item ID");
    aliases.push({
      key: `github:${component(repositoryId)}:${input.github.itemType}:${component(itemId)}`,
      kind: "github",
      priority: 10,
    });
  }

  if (input.slack) {
    const teamId = required(input.slack.teamId, "Slack team ID");
    const channelId = required(input.slack.channelId, "Slack channel ID");
    const rootTs = required(input.slack.rootTs, "Slack root timestamp");
    aliases.push({
      key: `slack:${component(teamId)}:${component(channelId)}:${component(rootTs)}`,
      kind: "slack",
      priority: 20,
    });
  }

  if (input.gmail) {
    const mailbox = normalizeScope(input.gmail.mailbox, "Gmail mailbox");
    const rfcThreadId = normalizeRfcMessageId(input.gmail.rfcThreadId);
    aliases.push({
      key: `gmail-rfc:${digest(`${mailbox}\u0000${rfcThreadId}`)}`,
      kind: "gmail-rfc",
      priority: 30,
    });
  }

  if (input.email) {
    const mailbox = normalizeScope(input.email.mailbox, "email mailbox");
    const personId = normalizeScope(input.email.personId, "email person");
    const subject = normalizeEmailSubject(input.email.subject);
    if (subject) {
      aliases.push({
        key: `email-subject:${digest(`${mailbox}\u0000${personId}\u0000${subject}`)}`,
        kind: "email-subject",
        priority: 40,
      });
    }
  }

  return deduplicateAliases(aliases).sort((left, right) => left.priority - right.priority);
}

async function existingConversation(
  aliases: readonly CorrelationAlias[],
  repository: CorrelationRepository,
): Promise<CanonicalConversation | null> {
  const matches = await Promise.all(aliases.map(({ key }) => repository.findByAlias(key)));
  const unique = new Map<string, CanonicalConversation>();
  for (const match of matches) {
    if (match) unique.set(`${match.kind}\u0000${match.key}`, match);
  }
  if (unique.size > 1) {
    throw new ConflictingCorrelationAliasesError(
      [...unique.values()].map((conversation) => conversation.key),
    );
  }
  return unique.values().next().value ?? null;
}

function linearDecision(
  issue: ResolvedLinearIssue,
  aliases: readonly CorrelationAlias[],
): CorrelationDecision {
  return {
    canonical: {
      key: `linear:${component(issue.organizationId)}:${component(issue.issueId)}`,
      kind: "linear",
    },
    aliases: aliases.map(({ key }) => key),
    reused: false,
    linearIssue: issue,
  };
}

function validateLinearIssue(issue: ResolvedLinearIssue): ResolvedLinearIssue {
  required(issue.organizationId, "Linear organization ID");
  required(issue.issueId, "Linear issue ID");
  const identifier = required(issue.identifier, "Linear identifier");
  if (!EXACT_LINEAR_IDENTIFIER.test(identifier)) {
    throw new InvalidCorrelationInputError("Linear identifier must use exact uppercase syntax");
  }
  // Linear often returns gitBranchName values that are not Snap controller
  // branches (underscores, slashes, >63 chars). Keep the Linear identity for
  // correlation/title, but drop unusable branch names so Chip can still reply
  // (cwd falls back to SNAP_ROOT) instead of holding forever after 👀.
  if (issue.branchName !== undefined && !isValidLowercaseBranch(issue.branchName)) {
    const { branchName: _ignored, ...rest } = issue;
    return { ...rest, identifier };
  }
  return { ...issue, identifier };
}

function normalizeRfcMessageId(value: string): string {
  let normalized = required(value, "RFC thread Message-ID").normalize("NFKC").trim();
  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return required(normalized, "RFC thread Message-ID").toLowerCase();
}

function normalizeScope(value: string, label: string): string {
  return required(value, label).normalize("NFKC").trim().toLowerCase();
}

function required(value: string, label: string): string {
  if (!value || value !== value.trim()) {
    throw new InvalidCorrelationInputError(
      `${label} must be non-empty and have no outer whitespace`,
    );
  }
  return value;
}

function component(value: string): string {
  return encodeURIComponent(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deduplicateAliases(aliases: readonly CorrelationAlias[]): CorrelationAlias[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    if (seen.has(alias.key)) return false;
    seen.add(alias.key);
    return true;
  });
}
