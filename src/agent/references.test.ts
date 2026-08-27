import { describe, expect, it } from "vitest";
import {
  extractLinearReferences,
  githubItemUrlsInText,
  isValidLowercaseBranch,
  linearIdentifierFromBranch,
  linearIdentifierFromUrl,
  normalizeEmailSubject,
  primaryLinearIdentifierForGithubPr,
  uniqueLinearIdentifiers,
} from "./references.js";

describe("Linear reference extraction", () => {
  it("extracts exact identifiers without accepting embedded lookalikes", () => {
    const references = extractLinearReferences({
      text: "Please handle ENG-42, eng-43 and XENG-44A; ignore ENG-nope.",
    });

    expect(uniqueLinearIdentifiers(references)).toEqual(["ENG-42", "ENG-43"]);
  });

  it("extracts issue URLs with and without a Linear workspace segment", () => {
    expect(linearIdentifierFromUrl("https://linear.app/snap/issue/ENG-4610/a-title")).toBe(
      "ENG-4610",
    );
    expect(linearIdentifierFromUrl("https://linear.app/issue/eng-9?pane=activity")).toBe("ENG-9");
    expect(linearIdentifierFromUrl("https://linear.app/too/many/issue/ENG-9/a-title")).toBeNull();
    expect(linearIdentifierFromUrl("https://linear.app.evil.test/snap/issue/ENG-9")).toBeNull();
    expect(linearIdentifierFromUrl("https://evil@linear.app/snap/issue/ENG-9")).toBeNull();
    expect(linearIdentifierFromUrl("http://linear.app/snap/issue/ENG-9")).toBeNull();
  });

  it("handles Slack-formatted URLs and deduplicates repeated evidence", () => {
    const references = extractLinearReferences({
      text: "See <https://linear.app/snap/issue/ENG-7/fix|ENG-7> and ENG-7.",
      urls: ["https://linear.app/snap/issue/ENG-7/fix"],
    });

    expect(uniqueLinearIdentifiers(references)).toEqual(["ENG-7"]);
    expect(references.some((reference) => reference.kind === "url")).toBe(true);
    expect(references.some((reference) => reference.kind === "identifier")).toBe(true);
  });

  it("extracts an identifier from exact prefix and suffix branch formats", () => {
    expect(linearIdentifierFromBranch("eng-4610-local-issue-workspaces")).toBe("ENG-4610");
    expect(linearIdentifierFromBranch("local-issue-workspaces-eng-4610")).toBe("ENG-4610");
  });

  it("rejects malformed or ambiguous branch references", () => {
    expect(linearIdentifierFromBranch("ENG-4610-title")).toBeNull();
    expect(linearIdentifierFromBranch("eng-1-related-to-ops-2")).toBeNull();
    expect(linearIdentifierFromBranch("eng-4610/title")).toBeNull();
    expect(linearIdentifierFromBranch(`eng-1-${"a".repeat(58)}`)).toBeNull();
    expect(isValidLowercaseBranch("eng-4610-title")).toBe(true);
    expect(isValidLowercaseBranch("eng--4610")).toBe(true);
    expect(isValidLowercaseBranch("eng-4610-")).toBe(false);
  });
});

describe("GitHub item URL extraction", () => {
  it("canonicalizes PR and issue URLs for Linear attachment lookup", () => {
    expect(
      githubItemUrlsInText(
        "See <https://github.com/snapnhd/system/pull/1001|PR> and https://github.com/snapnhd/system/issues/42#note.",
      ),
    ).toEqual([
      "https://github.com/snapnhd/system/pull/1001",
      "https://github.com/snapnhd/system/issues/42",
    ]);
  });

  it("rejects lookalike hosts and non-item URLs", () => {
    expect(
      githubItemUrlsInText(
        "https://github.com.evil.test/snapnhd/system/pull/1 https://github.com/snapnhd/system/actions/1",
      ),
    ).toEqual([]);
  });
});

describe("primaryLinearIdentifierForGithubPr", () => {
  it("uses the PR title/branch ticket and ignores extra ids that would appear in comments", () => {
    expect(
      primaryLinearIdentifierForGithubPr({
        title: "feat(orders): route system communications to EPC contact types (ENG-4663)",
        branch: "routing-of-system-communications-when-loan-processor-eng-4663",
      }),
    ).toBe("ENG-4663");
  });
});

describe("normalizeEmailSubject", () => {
  it("strips repeated reply and forward variants", () => {
    expect(normalizeEmailSubject(" RE: Fwd: fw[2]: [Re]  Project Update ")).toBe("project update");
    expect(normalizeEmailSubject("Re(3): RE : Quarterly   Plan")).toBe("quarterly plan");
  });

  it("normalizes Unicode, whitespace, and case", () => {
    expect(normalizeEmailSubject("ＲＥ：  Launch\n\tREADY")).toBe("launch ready");
  });

  it("does not remove prefix-like words without a delimiter", () => {
    expect(normalizeEmailSubject("Regarding: launch")).toBe("regarding: launch");
    expect(normalizeEmailSubject("Frework needed")).toBe("frework needed");
  });
});
