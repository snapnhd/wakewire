import { describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../core/event.js";
import type { SecretStore } from "../secrets/store.js";
import { chipReviewCoversHead, createGithubReviewCommitLookup } from "./github-review-head.js";

const HEAD = "1234567890abcdef1234567890abcdef12345678";
const OTHER_HEAD = "abcdef1234567890abcdef1234567890abcdef12";

describe("chipReviewCoversHead", () => {
  it.each(["APPROVED", "CHANGES_REQUESTED"])("treats %s on the exact head as covering", (state) => {
    expect(
      chipReviewCoversHead({
        lastChipReviewSha: HEAD,
        lastChipReviewState: state,
        lastChipReviewBody: "",
        headSha: HEAD,
      }),
    ).toBe(true);
  });

  it.each([
    "blocking: the changed authorization path accepts an untrusted actor",
    "Product findings: the changed retry path can duplicate a review",
    "No blocking findings on the diff.",
  ])("treats a diff-judging COMMENTED review as covering: %s", (body) => {
    expect(
      chipReviewCoversHead({
        lastChipReviewSha: HEAD,
        lastChipReviewState: "COMMENTED",
        lastChipReviewBody: body,
        headSha: HEAD,
      }),
    ).toBe(true);
  });

  it.each([
    "Exact-head local verification did not produce a retrievable aggregate result.",
    "The host gate is unavailable and cannot be prepared under this review role.",
    "The workspace could not be prepared. No agent task was started.",
    "The review clone has tracked changes in app/yarn.lock.",
    "Local tests are running, but there is no live make test process.",
  ])("does not treat a process-miss COMMENTED review as covering: %s", (body) => {
    expect(
      chipReviewCoversHead({
        lastChipReviewSha: HEAD,
        lastChipReviewState: "COMMENTED",
        lastChipReviewBody: body,
        headSha: HEAD,
      }),
    ).toBe(false);
  });

  it("does not cover a different head", () => {
    expect(
      chipReviewCoversHead({
        lastChipReviewSha: OTHER_HEAD,
        lastChipReviewState: "APPROVED",
        lastChipReviewBody: "",
        headSha: HEAD,
      }),
    ).toBe(false);
  });

  it("does not cover a head without a prior Chip review", () => {
    expect(
      chipReviewCoversHead({
        lastChipReviewSha: null,
        lastChipReviewState: null,
        lastChipReviewBody: null,
        headSha: HEAD,
      }),
    ).toBe(false);
  });
});

describe("createGithubReviewCommitLookup", () => {
  it("returns the latest submitted Chip review with its commit, state, and body", async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        {
          user: { login: "chipbyte-snap" },
          submitted_at: "2026-08-21T18:05:00.000Z",
          commit_id: "a".repeat(40),
          state: "APPROVED",
          body: "No blocking findings.",
        },
        {
          user: { login: "someone-else" },
          submitted_at: "2026-08-21T18:07:00.000Z",
          commit_id: "b".repeat(40),
          state: "CHANGES_REQUESTED",
          body: "blocking: unrelated reviewer",
        },
        {
          user: { login: "chipbyte-snap" },
          submitted_at: "2026-08-21T18:06:00.000Z",
          commit_id: "c".repeat(40),
          state: "COMMENTED",
          body: "Exact-head local verification did not produce a retrievable aggregate result.",
        },
      ]),
    );
    const secrets: SecretStore = {
      backend: "file",
      get: () => "token",
      set() {},
      delete() {},
    };
    const event: WakeEvent = {
      source: "github",
      sourceId: "github-snapnhd-system",
      kind: "pull_request.synchronize",
      deliveryId: "sync-1",
      occurredAt: "2026-09-02T14:00:00.000Z",
      summary: "PR synchronized",
      payload: { repo: "snapnhd/system", number: 1143 },
    };
    const lookup = createGithubReviewCommitLookup({ secrets, fetch });

    await expect(lookup(event)).resolves.toEqual({
      lastChipReviewSha: "c".repeat(40),
      lastChipReviewState: "COMMENTED",
      lastChipReviewBody:
        "Exact-head local verification did not produce a retrievable aggregate result.",
    });
  });
});
