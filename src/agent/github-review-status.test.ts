import { describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../core/event.js";
import type { SecretStore } from "../secrets/store.js";
import {
  createGithubReviewArtifactLookup,
  createGithubReviewStatusEnsure,
  createGithubReviewStatusLookup,
  createGithubReviewStatusUpdate,
  extractGithubReviewStatus,
  type GithubReviewBodyUpdate,
  githubReviewHeadMovePickupUpdate,
  renderGithubReviewBody,
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

describe("renderGithubReviewBody", () => {
  it("prepends the owned pickup status and preserves an unmarked body exactly", () => {
    const original = "Human summary\n\n- Keep this spacing\n";
    const rendered = renderGithubReviewBody(original, {
      status: { phase: "pickup", updatedAt: "2026-08-27T18:00:00.000Z" },
    });

    expect(rendered).toContain("<!-- chip-review-status -->");
    expect(rendered).toContain("### 🔎 PR Status");
    expect(rendered).toContain("👀 picked up");
    expect(rendered.endsWith(original)).toBe(true);
  });

  it("reorders and replaces valid owned blocks while retaining surrounding human bytes", () => {
    const original = [
      "human-before\n",
      "<!-- chip-review-status -->\nold status\n<!-- /chip-review-status -->",
      "\nhuman-between\n",
      "<!-- chip-workspace-links -->\nold links\n<!-- /chip-workspace-links -->",
      "\nhuman-after",
    ].join("");
    const rendered = renderGithubReviewBody(original, {
      links: {
        app: "https://fra-2967.ws.chipbyte.dev",
        data: "https://data-fra-2967.ws.chipbyte.dev",
        snapcorp: "https://snapcorp-fra-2967.ws.chipbyte.dev",
      },
      status: {
        phase: "tests-running",
        updatedAt: "2026-08-27T18:01:00.000Z",
        tests: { app: "running", data: "pending", snapcorp: "pending", windmill: "pending" },
      },
    });

    expect(rendered.indexOf("<!-- chip-workspace-links -->")).toBeLessThan(
      rendered.indexOf("<!-- chip-review-status -->"),
    );
    expect(rendered).toContain("### Workspace");
    expect(rendered).toContain("🧪 local tests running");
    expect(rendered).not.toContain("old status");
    expect(rendered).not.toContain("old links");
    expect(rendered.indexOf("human-before")).toBeLessThan(rendered.indexOf("human-between"));
    expect(rendered.indexOf("human-between")).toBeLessThan(rendered.indexOf("human-after"));
  });

  it("is idempotent and does not accumulate separator newlines", () => {
    const update: GithubReviewBodyUpdate = {
      links: {
        app: "https://fra-2967.ws.chipbyte.dev",
        data: "https://data-fra-2967.ws.chipbyte.dev",
        snapcorp: "https://snapcorp-fra-2967.ws.chipbyte.dev",
      },
      status: {
        phase: "tests-running" as const,
        updatedAt: "2026-08-27T18:01:00.000Z",
        tests: { app: "running", data: "pending", snapcorp: "pending", windmill: "pending" },
      },
    };
    const once = renderGithubReviewBody("Human summary\n", update);
    const twice = renderGithubReviewBody(once, update);

    expect(twice).toBe(once);
  });

  it.each([
    "<!-- chip-review-status -->\nmissing close",
    "<!-- /chip-review-status -->",
    "<!-- chip-review-status -->\none\n<!-- chip-review-status -->\ntwo\n<!-- /chip-review-status -->",
    "<!-- chip-workspace-links -->\n<!-- chip-review-status -->\n<!-- /chip-workspace-links -->\n<!-- /chip-review-status -->",
  ])("fails closed on malformed ownership boundaries", (body) => {
    expect(() =>
      renderGithubReviewBody(body, {
        status: { phase: "pickup", updatedAt: "2026-08-27T18:00:00.000Z" },
      }),
    ).toThrow(/marker|overlap/u);
  });

  it("removes stale links explicitly when a workspace is not running", () => {
    const body = [
      "<!-- chip-workspace-links -->",
      "### Workspace",
      "<!-- /chip-workspace-links -->",
      "",
      "human",
    ].join("\n");
    const rendered = renderGithubReviewBody(body, {
      links: null,
      status: { phase: "workspace-failed", updatedAt: "2026-08-27T18:02:00.000Z" },
    });
    expect(rendered).not.toContain("chip-workspace-links");
    expect(rendered).toContain("human");
  });

  it("renders only applicable blocks for an empty author body", () => {
    const rendered = renderGithubReviewBody("", {
      status: { phase: "pickup", updatedAt: "2026-08-27T18:00:00.000Z" },
    });
    expect(rendered.match(/^<!-- chip-review-status -->$/gmu)).toHaveLength(1);
    expect(rendered).not.toContain("chip-workspace-links");
  });

  it.each([
    ["specialists-incomplete" as const, "specialist verification incomplete"],
    ["specialists-waiting" as const, "specialist verdict needs follow-up"],
    ["review-incomplete" as const, "GitHub review artifact missing"],
  ])("keeps %s visibly non-terminal", (phase, headline) => {
    const rendered = renderGithubReviewBody("Human summary", {
      status: { phase, updatedAt: "2026-08-27T18:00:00.000Z" },
    });

    expect(rendered).toContain(headline);
    expect(rendered).not.toContain("[██████████]");
    expect(rendered).not.toContain("**🏁 done**");
  });
});

describe("extractGithubReviewStatus", () => {
  it("returns the live stage from Chip's status bar", () => {
    expect(
      extractGithubReviewStatus(`<!-- chip-review-status -->
### 🔎 Chip review

\`[█████░░░░░]\` 📝 reviewing the diff

👀 pickup → 🎫 ticket → 🧵 threads → 📝 **diff** → 💬 comments → 🧪 checks → ✅ done
<!-- /chip-review-status -->`),
    ).toBe("📝 reviewing the diff");
  });

  it("rejects ordinary Chip comments and malformed status bodies", () => {
    expect(extractGithubReviewStatus("Reviewed against FRA-2889.")).toBeNull();
    expect(extractGithubReviewStatus("<!-- chip-review-status -->\nno progress bar")).toBeNull();
    expect(
      extractGithubReviewStatus("<!-- chip-review-status -->\n`[█░░░░░░░░░]` forged headline"),
    ).toBeNull();
    expect(
      extractGithubReviewStatus(
        "<!-- chip-review-status -->\n`[█░░░░░░░░░]` forged headline\n<!-- /chip-review-status -->",
      ),
    ).toBeNull();
  });
});

const secrets: SecretStore = {
  backend: "file",
  get: () => "token",
  set() {},
  delete() {},
};

const LEGACY_STATUS_COMMENT = `<!-- chip-review-status -->
### 🔎 Chip review

\`[█░░░░░░░░░]\` 👀 picked up — reading the ticket

👀 pickup → 🎫 ticket → 🧵 threads → 📝 diff → 💬 comments → 🧪 checks → ✅ done
`;

const reviewEvent: WakeEvent = {
  source: "github",
  sourceId: "github-snapnhd-system",
  kind: "pull_request.review_requested",
  deliveryId: "review-1113",
  occurredAt: "2026-08-21T18:04:16.000Z",
  summary: "Review requested",
  payload: { repo: "snapnhd/system", number: 1113 },
};
const reviewExpectation = {
  since: reviewEvent.occurredAt,
  expectedHeadSha: "a".repeat(40),
  allowedStates: ["COMMENTED"] as const,
};

describe("GitHub review context validation", () => {
  it.each([
    { repo: "snapnhd/system?other=repo", number: 1113 },
    { repo: "snapnhd/system", number: 1113.5 },
    { repo: "snapnhd/system", number: "01113" },
  ])("rejects a noncanonical REST target %#", async (payload) => {
    const fetch = vi.fn(async () => {
      throw new Error("malformed targets must not reach GitHub");
    });
    const lookup = createGithubReviewStatusLookup({ secrets, fetch });

    await expect(
      lookup({ ...reviewEvent, payload: { ...reviewEvent.payload, ...payload } }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not mutate a non-system pull request body", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("non-system status writes must not reach GitHub");
    });
    const update = createGithubReviewStatusUpdate({ secrets, fetch });
    const event = {
      ...reviewEvent,
      payload: { ...reviewEvent.payload, repo: "other/repository" },
    };

    await expect(
      update(event, {
        status: { phase: "pickup", updatedAt: "2026-08-27T18:00:00.000Z" },
      }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the canonical validated PR URL instead of response metadata", async () => {
    const body = renderGithubReviewBody("", {
      status: { phase: "pickup", updatedAt: "2026-08-27T18:00:00.000Z" },
    });
    const fetch = vi.fn(async () =>
      Response.json({ body, html_url: "https://attacker.invalid/redirect" }),
    );
    const lookup = createGithubReviewStatusLookup({ secrets, fetch });

    await expect(lookup(reviewEvent)).resolves.toMatchObject({
      url: "https://github.com/snapnhd/system/pull/1113",
    });
  });
});

describe("createGithubReviewArtifactLookup", () => {
  it("accepts a Chip review submitted after the request", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      const body = href.includes("/reviews")
        ? [
            {
              user: { login: "chipbyte-snap" },
              submitted_at: "2026-08-21T18:05:00.000Z",
              commit_id: reviewExpectation.expectedHeadSha,
              state: "COMMENTED",
            },
          ]
        : { body: null, head: { sha: reviewExpectation.expectedHeadSha } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const lookup = createGithubReviewArtifactLookup({ secrets, fetch, retryDelayMs: 0 });

    await expect(lookup(reviewEvent, reviewExpectation)).resolves.toBe(true);
  });

  it("rejects a PR-body status update as a substitute for a submitted review", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/reviews")) return new Response(JSON.stringify([]), { status: 200 });
      if (href.endsWith("/pulls/1113")) {
        return new Response(
          JSON.stringify({
            body: "<!-- chip-review-status -->\n<!-- chip-review-status-updated: 2026-08-21T18:05:00.000Z -->\n<!-- /chip-review-status -->",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const lookup = createGithubReviewArtifactLookup({ secrets, fetch, retryDelayMs: 0 });

    await expect(lookup(reviewEvent, reviewExpectation)).resolves.toBe(false);
  });

  it("rejects an ordinary unrelated PR-body edit", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/reviews")) return new Response(JSON.stringify([]), { status: 200 });
      if (href.endsWith("/pulls/1113")) {
        return new Response(
          JSON.stringify({
            body: "Human edited this body",
            updated_at: "2026-08-21T18:05:00.000Z",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const lookup = createGithubReviewArtifactLookup({ secrets, fetch, retryDelayMs: 0 });
    await expect(lookup(reviewEvent, reviewExpectation)).resolves.toBe(false);
  });
});

describe("createGithubReviewStatusEnsure", () => {
  it("writes pickup status to the PR body and verifies the read-back", async () => {
    let currentBody = "Human description\n";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (init?.method === "POST") throw new Error("status comments are forbidden");
      if (href.endsWith("/pulls/1113") && init?.method === "PATCH") {
        currentBody = (JSON.parse(String(init.body)) as { body: string }).body;
        return new Response(JSON.stringify({ body: currentBody }), { status: 200 });
      }
      if (href.endsWith("/pulls/1113")) {
        return new Response(
          JSON.stringify({
            body: currentBody,
            html_url: "https://github.com/snapnhd/system/pull/1113",
          }),
          { status: 200 },
        );
      }
      if (href.includes("/issues/1113/comments")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const ensure = createGithubReviewStatusEnsure({
      secrets,
      fetch,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    } as never);

    await expect(ensure(reviewEvent)).resolves.toEqual({
      summary: "👀 picked up",
      url: "https://github.com/snapnhd/system/pull/1113",
    });
    expect(currentBody).toContain("<!-- chip-review-status -->");
    expect(currentBody.endsWith("Human description\n")).toBe(true);
    expect(fetch.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true);
    expect(fetch.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it.each(["initial", "read-back"])(
    "rejects a %s PR HEAD mismatch for an exact-head status update",
    async (mismatch) => {
      const expectedHeadSha = "a".repeat(40);
      let currentBody = "Human description";
      let pullReads = 0;
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href.endsWith("/pulls/1113") && init?.method === "PATCH") {
          currentBody = (JSON.parse(String(init.body)) as { body: string }).body;
          return Response.json({ body: currentBody });
        }
        if (href.endsWith("/pulls/1113")) {
          pullReads++;
          const mismatched = mismatch === "initial" || pullReads > 1;
          return Response.json({
            body: currentBody,
            head: { sha: mismatched ? "b".repeat(40) : expectedHeadSha },
          });
        }
        if (href.includes("/issues/1113/comments")) return Response.json([]);
        throw new Error(`unexpected URL ${href}`);
      });
      const update = createGithubReviewStatusUpdate({ secrets, fetch });

      await expect(
        update(reviewEvent, {
          expectedHeadSha,
          status: {
            phase: "workspace-ready",
            updatedAt: "2026-08-27T18:00:00.000Z",
            headSha: expectedHeadSha,
          },
        }),
      ).resolves.toBeNull();
      expect(fetch.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(
        mismatch === "initial" ? 0 : 1,
      );
    },
  );

  it("deletes only legacy Chip status comments after verified migration", async () => {
    let currentBody = "Human description";
    let legacyDeleted = false;
    const deleted: number[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/pulls/1113") && init?.method === "PATCH") {
        currentBody = (JSON.parse(String(init.body)) as { body: string }).body;
        return new Response(JSON.stringify({ body: currentBody }), { status: 200 });
      }
      if (href.endsWith("/pulls/1113")) {
        return new Response(
          JSON.stringify({
            body: currentBody,
            html_url: "https://github.com/snapnhd/system/pull/1113",
          }),
          { status: 200 },
        );
      }
      if (href.includes("/issues/1113/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: "chipbyte-snap" },
              updated_at: "2026-08-21T18:05:00.000Z",
              body: LEGACY_STATUS_COMMENT,
            },
            { id: 2, user: { login: "chipbyte-snap" }, body: "Ordinary Chip comment" },
            { id: 3, user: { login: "human" }, body: "<!-- chip-review-status -->" },
            {
              id: 4,
              user: { login: "chipbyte-snap" },
              body: `${LEGACY_STATUS_COMMENT}Human-authored follow-up prose`,
            },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === "DELETE") {
        deleted.push(Number(href.split("/").at(-1)));
        legacyDeleted = true;
        return new Response(null, { status: 204 });
      }
      if (href.endsWith("/issues/comments/1")) {
        return legacyDeleted
          ? new Response(null, { status: 404 })
          : Response.json({
              id: 1,
              user: { login: "chipbyte-snap" },
              body: LEGACY_STATUS_COMMENT,
            });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const ensure = createGithubReviewStatusEnsure({
      secrets,
      fetch,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    });

    await expect(ensure(reviewEvent)).resolves.toMatchObject({
      url: "https://github.com/snapnhd/system/pull/1113",
    });
    expect(currentBody).toContain("<!-- chip-review-status -->");
    expect(deleted).toEqual([1]);
  });

  it("does not delete a legacy comment that changed after the list read", async () => {
    let currentBody = "Human description";
    const deleted: number[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/pulls/1113") && init?.method === "PATCH") {
        currentBody = (JSON.parse(String(init.body)) as { body: string }).body;
        return Response.json({ body: currentBody });
      }
      if (href.endsWith("/pulls/1113")) {
        return Response.json({ body: currentBody });
      }
      if (href.includes("/issues/1113/comments")) {
        return Response.json([
          {
            id: 1,
            user: { login: "chipbyte-snap" },
            body: LEGACY_STATUS_COMMENT,
          },
        ]);
      }
      if (href.endsWith("/issues/comments/1") && init?.method === "DELETE") {
        deleted.push(1);
        return new Response(null, { status: 204 });
      }
      if (href.endsWith("/issues/comments/1")) {
        return Response.json({
          id: 1,
          user: { login: "chipbyte-snap" },
          body: `${LEGACY_STATUS_COMMENT}changed`,
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const ensure = createGithubReviewStatusEnsure({ secrets, fetch });

    await expect(ensure(reviewEvent)).resolves.toBeNull();
    expect(deleted).toEqual([]);
  });

  it("fails closed when a legacy comment deletion cannot be read back as absent", async () => {
    let currentBody = "Human description";
    let legacyDeleted = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/pulls/1113") && init?.method === "PATCH") {
        currentBody = (JSON.parse(String(init.body)) as { body: string }).body;
        return new Response(JSON.stringify({ body: currentBody }), { status: 200 });
      }
      if (href.endsWith("/pulls/1113")) {
        return new Response(
          JSON.stringify({
            body: currentBody,
            html_url: "https://github.com/snapnhd/system/pull/1113",
          }),
          { status: 200 },
        );
      }
      if (href.includes("/issues/1113/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: "chipbyte-snap" },
              updated_at: "2026-08-21T18:05:00.000Z",
              body: LEGACY_STATUS_COMMENT,
            },
          ]),
          { status: 200 },
        );
      }
      if (href.endsWith("/issues/comments/1") && init?.method === "DELETE") {
        legacyDeleted = true;
        return new Response(null, { status: 204 });
      }
      if (href.endsWith("/issues/comments/1")) {
        return Response.json({
          id: 1,
          user: { login: "chipbyte-snap" },
          body: LEGACY_STATUS_COMMENT,
          deleted: legacyDeleted,
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const ensure = createGithubReviewStatusEnsure({
      secrets,
      fetch,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    });

    await expect(ensure(reviewEvent)).resolves.toBeNull();
    expect(
      fetch.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/issues/comments/1") && init?.method === undefined,
      ),
    ).toHaveLength(2);
  });

  it.each(["patch", "read-back"])("retains legacy comments after failed %s", async (failure) => {
    let pullReads = 0;
    const deleted: number[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/pulls/1113") && init?.method === "PATCH") {
        return failure === "patch"
          ? new Response("nope", { status: 500 })
          : new Response(JSON.stringify({ body: "ignored" }), { status: 200 });
      }
      if (href.endsWith("/pulls/1113")) {
        pullReads++;
        return new Response(
          JSON.stringify({
            body: pullReads > 1 && failure === "read-back" ? "concurrent human edit" : "Human",
            html_url: "https://github.com/snapnhd/system/pull/1113",
          }),
          { status: 200 },
        );
      }
      if (href.includes("/issues/1113/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: "chipbyte-snap" },
              updated_at: "2026-08-21T18:05:00.000Z",
              body: LEGACY_STATUS_COMMENT,
            },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === "DELETE") {
        deleted.push(1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const ensure = createGithubReviewStatusEnsure({
      secrets,
      fetch,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    });

    await expect(ensure(reviewEvent)).resolves.toBeNull();
    expect(deleted).toEqual([]);
  });
});
