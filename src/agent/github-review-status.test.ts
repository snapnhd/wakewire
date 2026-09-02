import { describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../core/event.js";
import type { SecretStore } from "../secrets/store.js";
import {
  createGithubReviewArtifactLookup,
  createGithubReviewStatusEnsure,
  extractGithubReviewStatus,
  githubReviewHeadMovePickupUpdate,
} from "./github-review-status.js";

describe("githubReviewHeadMovePickupUpdate", () => {
  it("builds pickup status for the exact synchronized HEAD", () => {
    const headSha = "b".repeat(40);
    const event: WakeEvent = {
      source: "github",
      kind: "pull_request.synchronize",
      deliveryId: "sync-1113",
      occurredAt: "2026-09-02T14:00:31.000Z",
      summary: "PR HEAD moved",
      payload: { repo: "snapnhd/system", number: 1113, headSha },
    };

    expect(githubReviewHeadMovePickupUpdate(event, event.occurredAt)).toEqual({
      expectedHeadSha: headSha,
      status: { phase: "pickup", updatedAt: event.occurredAt, headSha },
    });
  });
});

describe("extractGithubReviewStatus", () => {
  it("returns the live stage from Chip's status bar", () => {
    expect(
      extractGithubReviewStatus(`<!-- chip-review-status -->
### 🔎 Chip review

\`[█████░░░░░]\` 📝 reviewing the diff

👀 pickup → 🎫 ticket → 🧵 threads → 📝 **diff** → 💬 comments → 🧪 checks → ✅ done`),
    ).toBe("📝 reviewing the diff");
  });

  it("rejects ordinary Chip comments and malformed status bodies", () => {
    expect(extractGithubReviewStatus("Reviewed against FRA-2889.")).toBeNull();
    expect(extractGithubReviewStatus("<!-- chip-review-status -->\nno progress bar")).toBeNull();
  });
});

const secrets: SecretStore = {
  backend: "file",
  get: () => "token",
  set() {},
  delete() {},
};

const reviewEvent: WakeEvent = {
  source: "github",
  sourceId: "github-snapnhd-system",
  kind: "pull_request.review_requested",
  deliveryId: "review-1113",
  occurredAt: "2026-08-21T18:04:16.000Z",
  summary: "Review requested",
  payload: { repo: "snapnhd/system", number: 1113 },
};

describe("createGithubReviewArtifactLookup", () => {
  it("accepts a Chip review submitted after the request", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      const body = href.includes("/reviews")
        ? [
            {
              user: { login: "chipbyte-snap" },
              submitted_at: "2026-08-21T18:05:00.000Z",
              state: "COMMENTED",
            },
          ]
        : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const lookup = createGithubReviewArtifactLookup({ secrets, fetch, retryDelayMs: 0 });

    await expect(lookup(reviewEvent, reviewEvent.occurredAt)).resolves.toBe(true);
  });

  it("rejects stale reviews and ordinary comments", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      const body = href.includes("/reviews")
        ? [
            {
              user: { login: "chipbyte-snap" },
              submitted_at: "2026-08-21T18:00:00.000Z",
              state: "COMMENTED",
            },
          ]
        : [
            {
              user: { login: "chipbyte-snap" },
              updated_at: "2026-08-21T18:05:00.000Z",
              body: "I could not inspect this PR.",
            },
          ];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const lookup = createGithubReviewArtifactLookup({ secrets, fetch, retryDelayMs: 0 });

    await expect(lookup(reviewEvent, reviewEvent.occurredAt)).resolves.toBe(false);
  });
});

describe("createGithubReviewStatusEnsure", () => {
  it("creates the pickup comment when Chip has none", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(String(url)).toBe("https://api.github.com/repos/snapnhd/system/issues/1113/comments");
        const body = JSON.parse(String(init.body)) as { body: string };
        expect(body.body).toContain("<!-- chip-review-status -->");
        expect(body.body).toContain("👀 picked up — reading the ticket");
        return new Response(
          JSON.stringify({ html_url: "https://github.com/snapnhd/system/pull/1113#issuecomment-9" }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const ensure = createGithubReviewStatusEnsure({ secrets, fetch });

    await expect(ensure(reviewEvent)).resolves.toEqual({
      summary: "👀 picked up — reading the ticket",
      url: "https://github.com/snapnhd/system/pull/1113#issuecomment-9",
    });
    expect(fetch.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true);
  });

  it("does not post when the status comment already exists", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        throw new Error("should not create a second status comment");
      }
      return new Response(
        JSON.stringify([
          {
            user: { login: "chipbyte-snap" },
            html_url: "https://github.com/snapnhd/system/pull/1113#issuecomment-1",
            updated_at: "2026-08-21T18:05:00.000Z",
            body: `<!-- chip-review-status -->\n\`[█████░░░░░]\` 📝 reviewing the diff\n`,
          },
        ]),
        { status: 200 },
      );
    });
    const ensure = createGithubReviewStatusEnsure({ secrets, fetch });

    await expect(ensure(reviewEvent)).resolves.toEqual({
      summary: "📝 reviewing the diff",
      url: "https://github.com/snapnhd/system/pull/1113#issuecomment-1",
    });
  });

  it("does not post when listing comments fails", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        throw new Error("should not create a status comment after a list failure");
      }
      return new Response("nope", { status: 500 });
    });
    const ensure = createGithubReviewStatusEnsure({ secrets, fetch });

    await expect(ensure(reviewEvent)).resolves.toBeNull();
  });
});
