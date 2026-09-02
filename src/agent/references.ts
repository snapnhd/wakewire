const LINEAR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const LINEAR_BRANCH = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_LINEAR_BRANCH_LENGTH = 63;

export type LinearReferenceKind = "branch" | "identifier" | "url";

/** Evidence that a message refers to a Linear issue. Identifiers are canonical uppercase. */
export interface LinearReference {
  identifier: string;
  kind: LinearReferenceKind;
  raw: string;
}

export interface LinearReferenceInput {
  /** Untrusted message text, title, or body. */
  text?: string;
  /** Provider-extracted URLs, when available separately from text. */
  urls?: readonly string[];
  /** Exact provider branch names. Branches are never slugified or repaired. */
  branches?: readonly string[];
}

/**
 * Extract exact Linear issue identifiers from text, Linear URLs, and complete branch names.
 * Duplicate evidence is retained; callers can use uniqueLinearIdentifiers for ambiguity checks.
 */
export function extractLinearReferences(input: LinearReferenceInput): LinearReference[] {
  const references: LinearReference[] = [];

  if (input.text) {
    for (const url of urlsInText(input.text)) {
      const identifier = linearIdentifierFromUrl(url);
      if (identifier) references.push({ identifier, kind: "url", raw: url });
    }

    for (const identifier of linearIdentifiersInText(input.text)) {
      references.push({ identifier, kind: "identifier", raw: identifier });
    }
  }

  for (const url of input.urls ?? []) {
    const identifier = linearIdentifierFromUrl(url);
    if (identifier) references.push({ identifier, kind: "url", raw: url });
  }

  for (const branch of input.branches ?? []) {
    const identifier = linearIdentifierFromBranch(branch);
    if (identifier) references.push({ identifier, kind: "branch", raw: branch });
  }

  return deduplicateReferences(references);
}

/** Canonical GitHub issue/PR URLs that Linear attachmentsForURL can resolve. */
export function githubItemUrlsInText(text: string): string[] {
  const urls = new Set<string>();
  for (const raw of urlsInText(text)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.hostname.toLowerCase() !== "github.com" || url.protocol !== "https:") continue;
    if (url.username || url.password || (url.port && url.port !== "443")) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      segments.length < 4 ||
      !segments[0] ||
      !segments[1] ||
      !["pull", "issues"].includes(segments[2] ?? "") ||
      !/^\d+$/.test(segments[3] ?? "")
    ) {
      continue;
    }
    urls.add(`https://github.com/${segments[0]}/${segments[1]}/${segments[2]}/${segments[3]}`);
  }
  return [...urls];
}

/** Parse only canonical linear.app issue URLs, with or without a workspace path segment. */
export function linearIdentifierFromUrl(value: string): string | null {
  const candidate = stripUrlPunctuation(value.trim());
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.hostname !== "linear.app" && url.hostname !== "www.linear.app") return null;
  if (url.username || url.password || (url.port && url.port !== "443")) return null;

  let pathSegments: string[];
  try {
    pathSegments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  const issueIndex = pathSegments.indexOf("issue");
  if (issueIndex !== 0 && issueIndex !== 1) return null;
  const identifier = pathSegments[issueIndex + 1];
  return identifier && LINEAR_IDENTIFIER.test(identifier) ? identifier.toUpperCase() : null;
}

/**
 * Return the single issue identifier embedded in a complete, valid lowercase Linear branch.
 * A branch containing zero or multiple identifier-shaped segments is not an exact match.
 */
export function linearIdentifierFromBranch(branch: string): string | null {
  if (!isValidLowercaseBranch(branch)) return null;

  const identifiers = new Set<string>();
  const matches = branch.matchAll(/(?:^|-)([a-z][a-z0-9]*)-(\d+)(?=-|$)/g);
  for (const match of matches) {
    const team = match[1];
    const number = match[2];
    if (team && number) identifiers.add(`${team}-${number}`.toUpperCase());
  }

  return identifiers.size === 1 ? (identifiers.values().next().value ?? null) : null;
}

/** Exact branch syntax accepted by the Snap root Makefile. */
export function isValidLowercaseBranch(branch: string): boolean {
  return (
    branch.length > 0 && branch.length <= MAX_LINEAR_BRANCH_LENGTH && LINEAR_BRANCH.test(branch)
  );
}

/** Preserve first-seen order while collapsing repeated URL/text/branch evidence. */
export function uniqueLinearIdentifiers(references: readonly LinearReference[]): string[] {
  return [...new Set(references.map((reference) => reference.identifier.toUpperCase()))];
}

/**
 * GitHub PR ↔ Linear is 1:1. The PR title/branch is the ticket; extra ENG/FRA
 * ids in comments (or Linear linkback “also references”) are not more work items.
 * Linear-origin events similarly keep the native issue; title/body citations
 * of other tickets are references, not extra work items.
 */
export function primaryLinearIdentifierForGithubPr(input: {
  title?: string | undefined;
  branch?: string | undefined;
}): string | undefined {
  const fromBranch = uniqueLinearIdentifiers(
    extractLinearReferences({ branches: input.branch ? [input.branch] : [] }),
  );
  if (fromBranch.length === 1) return fromBranch[0];
  const fromTitle = uniqueLinearIdentifiers(extractLinearReferences({ text: input.title ?? "" }));
  if (fromTitle.length === 1) return fromTitle[0];
  return fromBranch[0] ?? fromTitle[0];
}

/**
 * Normalize a subject for fallback correlation. Repeated reply/forward prefixes are removed,
 * Unicode and whitespace are normalized, and casing is folded.
 */
export function normalizeEmailSubject(subject: string): string {
  let normalized = normalizeWhitespace(subject.normalize("NFKC"));
  const prefix = /^(?:(?:re|fw|fwd)(?:\s*(?:\[\d+\]|\(\d+\)))?\s*:|\[(?:re|fw|fwd)\]\s*:?)\s*/iu;

  while (prefix.test(normalized)) normalized = normalized.replace(prefix, "");
  return normalizeWhitespace(normalized).toLowerCase();
}

function linearIdentifiersInText(text: string): string[] {
  const identifiers: string[] = [];
  const matches = text.matchAll(/(^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9])/g);
  for (const match of matches) {
    const identifier = match[2];
    if (identifier) identifiers.push(identifier.toUpperCase());
  }
  return identifiers;
}

function urlsInText(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>"'|]+/giu)].map((match) =>
    stripUrlPunctuation(match[0]),
  );
}

function stripUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?\])}]+$/gu, "");
}

function deduplicateReferences(references: readonly LinearReference[]): LinearReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}\u0000${reference.identifier}\u0000${reference.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
