import type { WakeEvent } from "../../core/event.js";

const COMMIT_MESSAGE_LIMIT = 500;
const MAX_COMMITS = 20;

/**
 * Reduce a raw GitHub webhook payload to the few fields routes and prompts
 * need. Nothing outside this trimmed shape ever reaches the model.
 */
export function trimGithubEvent(args: {
  eventName: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  sourceId?: string | undefined;
}): WakeEvent | null {
  const { eventName, deliveryId, payload, sourceId } = args;
  const repo = repoFullName(payload);
  if (!repo) return null; // ping and other repo-less events are not routable
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const kind = action ? `${eventName}.${action}` : eventName;
  const occurredAt = new Date().toISOString();

  let event: WakeEvent;
  if (eventName === "push") {
    event = trimPush({ repo, deliveryId, occurredAt, payload });
  } else if (eventName === "pull_request") {
    event = trimPullRequest({ repo, kind, action, deliveryId, occurredAt, payload });
  } else if (eventName === "issues") {
    event = trimIssue({ repo, kind, action, deliveryId, occurredAt, payload });
  } else if (eventName === "issue_comment") {
    event = trimIssueComment({ repo, kind, action, deliveryId, occurredAt, payload });
  } else if (eventName === "pull_request_review_comment") {
    event = trimReviewComment({ repo, kind, action, deliveryId, occurredAt, payload });
  } else if (eventName === "pull_request_review") {
    event = trimPullRequestReview({ repo, kind, action, deliveryId, occurredAt, payload });
  } else {
    // Generic fallback: minimal, still routable by repo + event name.
    event = {
      source: "github",
      kind,
      deliveryId,
      occurredAt,
      summary: `${kind} event on ${repo}`,
      payload: { repo, ...(action ? { action } : {}) },
    };
  }
  return addGithubContext(event, payload, sourceId);
}

function trimIssueComment(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const comment = isRecord(payload.comment) ? payload.comment : {};
  const number = numberOf(issue.number);
  const body = truncate(stringOf(comment.body), 4_000);
  const title = truncate(stringOf(issue.title), 200);
  const isPullRequest = isRecord(issue.pull_request);
  const author = isRecord(issue.user) ? stringOf(issue.user.login) : "";
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `Comment ${action ?? ""} on ${repo}#${number ?? "?"}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      title,
      body,
      commentId: numberOf(comment.id) ?? null,
      url: stringOf(comment.html_url),
      issueUrl: stringOf(issue.html_url),
      isPullRequest,
      ...(isPullRequest && author ? { pullRequestAuthorLogin: author } : {}),
    },
  };
}

function trimReviewComment(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const comment = isRecord(payload.comment) ? payload.comment : {};
  const number = numberOf(payload.number) ?? numberOf(pr.number);
  const title = truncate(stringOf(pr.title), 200);
  const author = isRecord(pr.user) ? stringOf(pr.user.login) : "";
  const inReplyToId = numberOf(comment.in_reply_to_id);
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `Review comment ${action ?? ""} on ${repo}#${number ?? "?"}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      title,
      body: truncate(stringOf(comment.body), 4_000),
      commentId: numberOf(comment.id) ?? null,
      ...(inReplyToId !== undefined && inReplyToId > 0 ? { inReplyToId } : {}),
      url: stringOf(comment.html_url),
      pullRequestUrl: stringOf(pr.html_url),
      branch: isRecord(pr.head) && typeof pr.head.ref === "string" ? pr.head.ref : "",
      isPullRequest: true,
      ...(author ? { pullRequestAuthorLogin: author } : {}),
    },
  };
}

function trimPullRequestReview(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const review = isRecord(payload.review) ? payload.review : {};
  const number = numberOf(payload.number) ?? numberOf(pr.number);
  const title = truncate(stringOf(pr.title), 200);
  const author = isRecord(pr.user) ? stringOf(pr.user.login) : "";
  const reviewState = stringOf(review.state).trim();
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `Review ${action ?? ""} on ${repo}#${number ?? "?"}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      title,
      body: truncate(stringOf(review.body), 4_000),
      reviewId: numberOf(review.id) ?? null,
      ...(reviewState ? { reviewState } : {}),
      url: stringOf(review.html_url),
      pullRequestUrl: stringOf(pr.html_url),
      branch: isRecord(pr.head) && typeof pr.head.ref === "string" ? pr.head.ref : "",
      isPullRequest: true,
      ...(author ? { pullRequestAuthorLogin: author } : {}),
    },
  };
}

function addGithubContext(
  event: WakeEvent,
  raw: Record<string, unknown>,
  sourceId: string | undefined,
): WakeEvent {
  const repository = isRecord(raw.repository) ? raw.repository : {};
  const sender = isRecord(raw.sender) ? raw.sender : {};
  const repoId = numberOf(repository.id);
  const senderId = numberOf(sender.id);
  const senderLogin = stringOf(sender.login);
  const senderType = stringOf(sender.type);
  const senderIsUser = senderType === "User";
  const number = numberOf(event.payload.number);
  const commentId = numberOf(event.payload.commentId);
  const relevantText = senderIsUser ? githubSenderAuthoredText(event, raw, senderId) : "";
  const mentions = extractGithubMentions(relevantText);
  const senderAuthoredFeedback = isGithubFeedbackEvent(event) && relevantText.trim().length > 0;
  const requestedReviewer = senderIsUser ? githubRequestedReviewerTarget(event, raw) : undefined;
  if (requestedReviewer && !mentions.some(({ value }) => value === requestedReviewer)) {
    mentions.push({ kind: "handle", value: requestedReviewer });
  }
  const repoScope = repoId === undefined ? String(event.payload.repo) : String(repoId);
  const rootKey = number === undefined ? undefined : `${repoScope}:${number}`;
  const nativeKey =
    commentId === undefined ? rootKey : `${rootKey ?? repoScope}:comment:${commentId}`;
  return {
    ...event,
    ...(sourceId ? { sourceId } : {}),
    payload: {
      ...event.payload,
      ...(repoId === undefined ? {} : { repositoryId: repoId }),
      ...(senderId === undefined ? {} : { senderId }),
      ...(senderLogin ? { senderLogin } : {}),
      ...(senderType ? { senderType } : {}),
      ...(senderAuthoredFeedback ? { senderAuthoredFeedback: true } : {}),
    },
    ...(senderId === undefined
      ? {}
      : {
          principal: {
            provider: "github" as const,
            tenantId: "github.com",
            subjectId: String(senderId),
            ...(senderLogin ? { handle: senderLogin, displayName: senderLogin } : {}),
          },
        }),
    ...(nativeKey
      ? {
          conversation: {
            nativeKey,
            ...(rootKey ? { rootKey } : {}),
            replyTarget:
              commentId === undefined
                ? `${repoScope}:${number ?? "repo"}`
                : `${repoScope}:comment:${commentId}`,
          },
        }
      : {}),
    ...(mentions.length > 0 ? { targetMentions: mentions } : {}),
  };
}

/**
 * GitHub's top-level sender is the actor for the webhook action, not
 * necessarily the author of the issue/comment text included in that payload.
 * Only newly-created text whose immutable author id equals sender may address
 * Chip. This prevents CJ closing/labeling another person's issue from turning
 * that person's old @chip text into a CJ-authenticated command.
 */
function githubSenderAuthoredText(
  event: WakeEvent,
  raw: Record<string, unknown>,
  senderId: number | undefined,
): string {
  if (senderId === undefined) return "";
  let authored: Record<string, unknown> = {};
  if (event.kind === "issue_comment.created") {
    authored = isRecord(raw.comment) ? raw.comment : {};
  } else if (event.kind === "pull_request_review_comment.created") {
    authored = isRecord(raw.comment) ? raw.comment : {};
  } else if (event.kind === "pull_request_review.submitted") {
    authored = isRecord(raw.review) ? raw.review : {};
  } else if (event.kind === "issues.opened") {
    authored = isRecord(raw.issue) ? raw.issue : {};
  } else if (event.kind === "pull_request.opened") {
    authored = isRecord(raw.pull_request) ? raw.pull_request : {};
  } else {
    return "";
  }
  const author = isRecord(authored.user) ? authored.user : {};
  if (numberOf(author.id) !== senderId || stringOf(author.type) !== "User") return "";
  return [authored.title, authored.body]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isGithubFeedbackEvent(event: WakeEvent): boolean {
  return (
    event.kind === "issue_comment.created" ||
    event.kind === "pull_request_review_comment.created" ||
    event.kind === "pull_request_review.submitted"
  );
}

function extractGithubMentions(text: string): Array<{ kind: "handle"; value: string }> {
  const values = new Set<string>();
  for (const match of text.matchAll(/(^|[^@\w])@([a-z\d](?:[a-z\d-]{0,38}))(?![\w-])/gi)) {
    const value = match[2];
    if (value) values.add(value.toLowerCase());
  }
  return [...values].map((value) => ({ kind: "handle", value }));
}

/**
 * A review request is newly-authored structured intent in the signed webhook.
 * Use only the action's singular user field. The PR body/reviewer arrays are
 * older state, and requested_team is excluded because this is a user identity.
 * Whether the normalized reviewer is Chip is decided centrally by targeting.
 */
function githubRequestedReviewerTarget(
  event: WakeEvent,
  raw: Record<string, unknown>,
): string | undefined {
  if (event.kind !== "pull_request.review_requested") return undefined;
  const reviewer = isRecord(raw.requested_reviewer) ? raw.requested_reviewer : {};
  const login = stringOf(reviewer.login).trim().toLowerCase();
  return login || undefined;
}

function trimPush(args: {
  repo: string;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, deliveryId, occurredAt, payload } = args;
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const branch = ref.replace(/^refs\/(heads|tags)\//, "");
  const pusher =
    isRecord(payload.pusher) && typeof payload.pusher.name === "string"
      ? payload.pusher.name
      : "unknown";
  const compareUrl = typeof payload.compare === "string" ? payload.compare : "";
  const rawCommits = Array.isArray(payload.commits) ? payload.commits : [];
  const commits = rawCommits.slice(0, MAX_COMMITS).map((c) => trimCommit(c));
  const commitCount = rawCommits.length;
  const plural = commitCount === 1 ? "commit" : "commits";
  return {
    source: "github",
    kind: "push",
    deliveryId,
    occurredAt,
    summary: `${commitCount} ${plural} pushed to ${repo}:${branch} by ${pusher}`,
    payload: {
      repo,
      branch,
      pusher,
      compareUrl,
      commitCount,
      ...(commitCount > MAX_COMMITS ? { commitsTruncatedTo: MAX_COMMITS } : {}),
      commits,
    },
  };
}

function trimCommit(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const message = typeof raw.message === "string" ? raw.message : "";
  const author =
    isRecord(raw.author) && typeof raw.author.name === "string" ? raw.author.name : "unknown";
  const filesChanged =
    arrayLength(raw.added) + arrayLength(raw.removed) + arrayLength(raw.modified);
  return {
    sha: typeof raw.id === "string" ? raw.id : "",
    author,
    message: truncate(message, COMMIT_MESSAGE_LIMIT),
    filesChanged,
  };
}

function trimPullRequest(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const number =
    typeof payload.number === "number" ? payload.number : (pr.number as number | undefined);
  const title = typeof pr.title === "string" ? truncate(pr.title, 200) : "";
  const author = isRecord(pr.user) && typeof pr.user.login === "string" ? pr.user.login : "unknown";
  const url = typeof pr.html_url === "string" ? pr.html_url : "";
  const headBranch = isRecord(pr.head) && typeof pr.head.ref === "string" ? pr.head.ref : "";
  const headSha =
    isRecord(pr.head) && typeof pr.head.sha === "string"
      ? pr.head.sha
      : typeof payload.after === "string"
        ? payload.after
        : "";
  const beforeSha = typeof payload.before === "string" ? payload.before : "";
  const requestedReviewerLogins = (
    Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : []
  )
    .map((reviewer) => (isRecord(reviewer) ? stringOf(reviewer.login).trim().toLowerCase() : ""))
    .filter(Boolean);
  const baseBranch = isRecord(pr.base) && typeof pr.base.ref === "string" ? pr.base.ref : "";
  const body = truncate(typeof pr.body === "string" ? pr.body : "", 1000);
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `PR #${number ?? "?"} ${action ?? ""} on ${repo}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      title,
      author,
      url,
      branch: headBranch,
      isPullRequest: true,
      ...(headSha ? { headSha } : {}),
      ...(beforeSha ? { beforeSha } : {}),
      ...(requestedReviewerLogins.length > 0 ? { requestedReviewerLogins } : {}),
      baseBranch,
      // A review_requested action is the command. Keep the older PR body only
      // as provider context so requestText cannot promote it to the command.
      ...(action === "review_requested" ? { pullRequestBody: body } : { body }),
    },
  };
}

function trimIssue(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const number = typeof issue.number === "number" ? issue.number : undefined;
  const title = typeof issue.title === "string" ? truncate(issue.title, 200) : "";
  const author =
    isRecord(issue.user) && typeof issue.user.login === "string" ? issue.user.login : "unknown";
  const url = typeof issue.html_url === "string" ? issue.html_url : "";
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `Issue #${number ?? "?"} ${action ?? ""} on ${repo}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      title,
      author,
      url,
      body: truncate(typeof issue.body === "string" ? issue.body : "", 1000),
    },
  };
}

function repoFullName(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (isRecord(repository) && typeof repository.full_name === "string") {
    return repository.full_name;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}
