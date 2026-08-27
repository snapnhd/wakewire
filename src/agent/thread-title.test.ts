import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import type { ResolvedLinearIssue } from "./correlation.js";
import { buildWorkItemTitle, providerAwareStoredTitle } from "./thread-title.js";

function event(overrides: Partial<WakeEvent>): WakeEvent {
  return {
    source: "slack",
    kind: "message",
    deliveryId: "delivery-1",
    occurredAt: "2026-07-28T00:00:00.000Z",
    summary: "Request for Chip",
    payload: {},
    ...overrides,
  };
}

describe("buildWorkItemTitle", () => {
  it("prefers a resolved Linear identity and issue title", () => {
    const issue: ResolvedLinearIssue = {
      organizationId: "org-1",
      issueId: "issue-123",
      identifier: "ENG-123",
      title: "Repair\tproduction\nreports",
    };

    expect(buildWorkItemTitle(event({}), "CJ", issue)).toBe(
      "Linear ENG-123 — Repair production reports",
    );
  });

  it("uses a native Linear payload title and strips bidi controls", () => {
    expect(
      buildWorkItemTitle(
        event({
          source: "webhook",
          kind: "LinearUserEvent.assignment",
          payload: {
            provider: "linear",
            identifier: "ENG-9",
            title: "Fix \u202edatabase exports",
          },
        }),
        { nickname: "CJ" },
      ),
    ).toBe("Linear ENG-9 — Fix database exports");
  });

  it("labels GitHub pull requests and issues with their repository identity", () => {
    expect(
      buildWorkItemTitle(
        event({
          source: "github",
          kind: "pull_request.review_requested",
          payload: { repo: "snapnhd/system", number: 1001, title: "Review workspace setup" },
        }),
        "CJ",
      ),
    ).toBe("GitHub PR snapnhd/system#1001 — Review workspace setup");

    expect(
      buildWorkItemTitle(
        event({
          source: "github",
          kind: "issue_comment.created",
          payload: {
            repo: "snapnhd/app",
            number: 42,
            title: "Fix billing",
            body: "@chipbyte-snap could you check the failed invoice?",
          },
        }),
        "CJ",
      ),
    ).toBe("GitHub Issue snapnhd/app#42 — check the failed invoice?");
  });

  it("uses the email subject", () => {
    expect(
      buildWorkItemTitle(
        event({
          source: "gmail",
          kind: "email",
          payload: { subject: "  Re:   Q3\nlaunch  " },
        }),
        "CJ",
      ),
    ).toBe("Email — Q3 launch");
  });

  it("uses the service and strips a leading Slack Chip mention and polite request wording", () => {
    expect(
      buildWorkItemTitle(
        event({
          payload: {
            recipientUser: "U-CHIP",
            text: "<@U-CHIP|chip>,   please\nreview the deploy",
          },
          targetMentions: [{ kind: "slack-user", value: "U-CHIP" }],
        }),
        { nickname: "CJ" },
      ),
    ).toBe("Slack — review the deploy");

    expect(buildWorkItemTitle(event({ payload: { text: "@Chip Byte: ship it" } }), "CJ")).toBe(
      "Slack — ship it",
    );
  });

  it("does not strip a different handle that merely starts with Chip", () => {
    expect(buildWorkItemTitle(event({ payload: { text: "@chipmunk check this" } }), "CJ")).toBe(
      "Slack — @chipmunk check this",
    );
  });

  it("normalizes controls and caps titles at 60 Unicode code points", () => {
    const title = buildWorkItemTitle(
      event({ payload: { text: `review\u0000this ${"🛠️".repeat(40)}` } }),
      "CJ",
    );

    expect(title.startsWith("Slack — review this ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect([...title]).toHaveLength(60);
    expect(title).not.toContain("\u0000");
  });

  it("uses the first meaningful email body line when the message has no subject", () => {
    expect(
      buildWorkItemTitle(
        event({
          source: "gmail",
          kind: "email",
          payload: { subject: "", body: "\n\nCould you send me the launch status?\nThanks" },
        }),
        "CJ",
      ),
    ).toBe("Email — launch status?");
  });

  it("uses an authored Linear mention but keeps assignments anchored to the issue title", () => {
    const base = {
      source: "webhook" as const,
      payload: {
        provider: "linear",
        identifier: "ENG-42",
        title: "Repair exports",
      },
    };
    expect(
      buildWorkItemTitle(
        event({
          ...base,
          kind: "LinearUserEvent.mention",
          payload: { ...base.payload, body: "@Chip Byte can you inspect the CSV encoding?" },
        }),
        "CJ",
      ),
    ).toBe("Linear ENG-42 — inspect the CSV encoding?");
    expect(
      buildWorkItemTitle(
        event({
          ...base,
          kind: "LinearUserEvent.assignment",
          payload: { ...base.payload, linearTrigger: "assignment", body: "Work on this issue." },
        }),
        "CJ",
      ),
    ).toBe("Linear ENG-42 — Repair exports");
  });

  it("upgrades legacy persisted titles idempotently and keeps the display limit", () => {
    expect(providerAwareStoredTitle("slack", "CJ — Can you give me the deploy status?")).toBe(
      "Slack — deploy status?",
    );
    expect(providerAwareStoredTitle("gmail", "Email — Q3 launch")).toBe("Email — Q3 launch");
    expect(providerAwareStoredTitle("github", "PR snapnhd/system#1 — Review it")).toBe(
      "GitHub PR snapnhd/system#1 — Review it",
    );
    expect(providerAwareStoredTitle("linear", "ENG-1 — Repair exports")).toBe(
      "Linear ENG-1 — Repair exports",
    );
    expect([...providerAwareStoredTitle("linear", `ENG-1 — ${"x".repeat(100)}`)]).toHaveLength(60);
  });
});
