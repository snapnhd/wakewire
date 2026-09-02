import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { hermesTargetFromEvent } from "./hermes-identity.js";
import {
  decideHermesSessionReuse,
  defaultHermesSessionLookup,
  type HermesSessionHit,
  type HermesWorkRef,
  sessionIdsRunningInProcessList,
  sessionTextMatchesRef,
  workRefFromTarget,
} from "./hermes-session-reuse.js";

const PR: HermesWorkRef = {
  githubRepo: "snapnhd/system",
  githubNumber: "1105",
  linearIdentifier: "FRA-2951",
};

function hit(partial: Partial<HermesSessionHit> & Pick<HermesSessionHit, "id">): HermesSessionHit {
  return {
    source: partial.source ?? "cli",
    title: partial.title ?? "Review snapnhd/system#1105 as chipbyte-snap…",
    sessionKey: partial.sessionKey ?? null,
    chatId: partial.chatId ?? null,
    endedAt: partial.endedAt ?? null,
    startedAt: partial.startedAt ?? 1,
    firstUserMatchesRef: partial.firstUserMatchesRef ?? false,
    firstUserRequestsReview: partial.firstUserRequestsReview ?? false,
    id: partial.id,
  };
}

describe("sessionTextMatchesRef", () => {
  it("matches repo#number, pull URL, PR label, and Linear id", () => {
    expect(sessionTextMatchesRef("Review snapnhd/system#1105 as chipbyte-snap", PR)).toBe(true);
    expect(
      sessionTextMatchesRef("https://github.com/snapnhd/system/pull/1105 description", PR),
    ).toBe(true);
    expect(sessionTextMatchesRef("Linear FRA-2951 — Render root-parented checks", PR)).toBe(true);
    expect(sessionTextMatchesRef("PR #1105 review_requested on snapnhd/system", PR)).toBe(true);
  });

  it("does not match a different PR number or ticket", () => {
    expect(sessionTextMatchesRef("Review snapnhd/system#11050 as chipbyte-snap", PR)).toBe(false);
    expect(sessionTextMatchesRef("https://github.com/other/repo/pull/1105", PR)).toBe(false);
    expect(sessionTextMatchesRef("Linear FRA-29510 — nope", PR)).toBe(false);
    expect(sessionTextMatchesRef("random chat", PR)).toBe(false);
  });
});

describe("workRefFromTarget", () => {
  it("extracts github repo/number from a review_requested event", () => {
    const event: WakeEvent = {
      source: "github",
      kind: "pull_request.review_requested",
      deliveryId: "d1",
      occurredAt: "2026-08-20T20:23:04.000Z",
      summary: "review requested",
      payload: { repo: "snapnhd/system", number: 1105, title: "fix(fraud)" },
      principal: {
        provider: "github",
        tenantId: "github.com",
        subjectId: "1",
        handle: "zadams",
      },
    };
    expect(
      workRefFromTarget(hermesTargetFromEvent(event, { linearIdentifier: "FRA-2951" })),
    ).toEqual({
      githubRepo: "snapnhd/system",
      githubNumber: "1105",
      linearIdentifier: "FRA-2951",
    });
  });
});

describe("decideHermesSessionReuse", () => {
  it("creates when nothing matches", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: null,
        hits: [],
        runningIds: new Set(),
        cmdlineBusy: false,
      }),
    ).toEqual({ action: "create" });
  });

  it("resumes an idle CLI/GitHub session for the same PR", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: null,
        hits: [hit({ id: "20260820_151904_399713" })],
        runningIds: new Set(),
        cmdlineBusy: false,
      }),
    ).toEqual({ action: "resume", sessionId: "20260820_151904_399713" });
  });

  it("ignores a review when that session is already running", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: null,
        hits: [hit({ id: "20260820_151904_399713" })],
        runningIds: new Set(["20260820_151904_399713"]),
        cmdlineBusy: false,
        reviewRequest: true,
      }),
    ).toEqual({
      action: "ignore",
      sessionId: "20260820_151904_399713",
      reason: "running",
    });
  });

  it("supersedes a running review only when the frozen PR head moved", () => {
    const running = {
      ref: PR,
      boundSessionId: "20260820_151904_399713",
      hits: [hit({ id: "20260820_151904_399713" })],
      runningIds: new Set(["20260820_151904_399713"]),
      cmdlineBusy: false,
      reviewRequest: true,
    };

    expect(decideHermesSessionReuse({ ...running, headMoved: false })).toEqual({
      action: "ignore",
      sessionId: "20260820_151904_399713",
      reason: "running",
    });
    expect(decideHermesSessionReuse({ ...running, headMoved: true })).toEqual({
      action: "supersede",
      sessionId: "20260820_151904_399713",
    });
    expect(
      decideHermesSessionReuse({ ...running, reviewRequest: false, headMoved: false }),
    ).toEqual({
      action: "hold",
      sessionId: "20260820_151904_399713",
      reason: "running",
    });
  });

  it("holds non-review turns while the matching session is running", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: null,
        hits: [hit({ id: "20260820_151904_399713" })],
        runningIds: new Set(["20260820_151904_399713"]),
        cmdlineBusy: false,
        reviewRequest: false,
      }),
    ).toEqual({
      action: "hold",
      sessionId: "20260820_151904_399713",
      reason: "running",
    });
  });

  it("ignores a review when a Hermes CLI process already names the PR", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: null,
        hits: [],
        runningIds: new Set(),
        cmdlineBusy: true,
        reviewRequest: true,
      }),
    ).toEqual({ action: "ignore", sessionId: "unbound-running", reason: "running" });
  });

  it("prefers the WorkItem binding when it is idle", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: "bound-session",
        hits: [hit({ id: "other-session" }), hit({ id: "bound-session", source: "github" })],
        runningIds: new Set(),
        cmdlineBusy: false,
      }),
    ).toEqual({ action: "resume", sessionId: "bound-session" });
  });

  it("prefers the dedicated PR session over a stale WorkItem binding from an incidental mention", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: "incidental-report-session",
        hits: [
          hit({
            id: "incidental-report-session",
            source: "github",
            startedAt: 1,
            firstUserMatchesRef: true,
            firstUserRequestsReview: false,
          }),
          hit({
            id: "dedicated-pr-session",
            startedAt: 2,
            endedAt: 3,
            firstUserMatchesRef: true,
            firstUserRequestsReview: true,
          }),
        ],
        runningIds: new Set(),
        cmdlineBusy: false,
      }),
    ).toEqual({ action: "resume", sessionId: "dedicated-pr-session" });
  });

  it("creates instead of resuming a WorkItem binding whose session_key belongs to a different PR", () => {
    expect(
      decideHermesSessionReuse({
        ref: { githubRepo: "snapnhd/system", githubNumber: "1143", linearIdentifier: "FRA-2950" },
        boundSessionId: "20260901_081632_af5dcf13",
        boundSessionKey: "wakewire:github:snapnhd/system#1157",
        boundChatId: "wakewire:github:snapnhd/system#1157",
        hits: [],
        runningIds: new Set(),
        cmdlineBusy: false,
      }),
    ).toEqual({ action: "create" });
  });

  it("does not treat a foreign-keyed bound session as already running", () => {
    expect(
      decideHermesSessionReuse({
        ref: { githubRepo: "snapnhd/system", githubNumber: "1143" },
        boundSessionId: "20260901_081632_af5dcf13",
        boundSessionKey: "wakewire:github:snapnhd/system#1157",
        hits: [],
        runningIds: new Set(["20260901_081632_af5dcf13"]),
        cmdlineBusy: false,
        reviewRequest: true,
      }),
    ).toEqual({ action: "create" });
  });

  it("resumes the oldest open session when a crash minted a newer duplicate", () => {
    expect(
      decideHermesSessionReuse({
        ref: PR,
        boundSessionId: null,
        hits: [
          hit({ id: "20260821_084618_8c68e7", startedAt: 2 }),
          hit({ id: "20260821_082112_e4cac0", startedAt: 1 }),
        ],
        runningIds: new Set(),
        cmdlineBusy: false,
        reviewRequest: true,
      }),
    ).toEqual({ action: "resume", sessionId: "20260821_082112_e4cac0" });
  });
});

describe("sessionIdsRunningInProcessList", () => {
  it("detects a live hermes CLI argv for the session or PR needle", () => {
    const ps = [
      "hermes chat --reasoning high -q Review snapnhd/system#1105 as chipbyte-snap",
      "/usr/bin/python3 scripts/hermes_sink_runner.py",
      "vim README.md",
    ].join("\n");
    const found = sessionIdsRunningInProcessList(
      ps,
      ["20260820_151904_399713"],
      ["snapnhd/system#1105"],
    );
    expect(found.cmdlineBusy).toBe(true);
    expect(found.runningIds.size).toBe(0);

    const withId = sessionIdsRunningInProcessList(
      "python3 hermes_sink_runner.py --resume 20260820_151904_399713\n",
      ["20260820_151904_399713"],
      ["snapnhd/system#1105"],
    );
    expect([...withId.runningIds]).toEqual(["20260820_151904_399713"]);
  });
});

describe("defaultHermesSessionLookup", () => {
  it("matches an unstamped crash session via the user-message PR needle", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ww-hermes-lookup-"));
    const dbPath = path.join(dir, "state.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT,
        session_key TEXT,
        chat_id TEXT,
        ended_at REAL,
        started_at REAL,
        archived INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        timestamp REAL,
        active INTEGER DEFAULT 1
      );
    `);
    db.prepare(
      `INSERT INTO sessions (id, source, title, session_key, chat_id, ended_at, started_at)
       VALUES (?, 'github', ?, NULL, NULL, NULL, ?)`,
    ).run("20260821_082112_e4cac0", "Load skill pr-workflow first. Code-review…", 1_000);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp)
       VALUES (?, 'user', ?, 1001)`,
    ).run(
      "20260821_082112_e4cac0",
      "PR #1110 review_requested on snapnhd/system: feat(fraud) (FRA-2872)",
    );
    db.close();

    try {
      const found = defaultHermesSessionLookup(
        { githubRepo: "snapnhd/system", githubNumber: "1110", linearIdentifier: "FRA-2872" },
        { dbPath, nowSeconds: 2_000, psArgs: "" },
      );
      expect(found.hits.map((hit) => hit.id)).toEqual(["20260821_082112_e4cac0"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only sessions whose first user turn identifies the PR as dedicated", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ww-hermes-ranking-"));
    const dbPath = path.join(dir, "state.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT,
        session_key TEXT,
        chat_id TEXT,
        ended_at REAL,
        started_at REAL,
        archived INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        timestamp REAL,
        active INTEGER DEFAULT 1
      );
    `);
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, source, title, session_key, chat_id, ended_at, started_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    );
    insertSession.run(
      "incidental",
      "github",
      "snapnhd/system#1105 · retitled report session",
      "wakewire:github:snapnhd/system#1105",
      null,
      1_000,
    );
    insertSession.run(
      "dedicated",
      "cli",
      "snapnhd/system#1105 · dedicated review",
      null,
      2_000,
      1_500,
    );
    insertSession.run(
      "diagnostic",
      "desktop",
      "What happened on snapnhd/system#1105?",
      null,
      null,
      1_750,
    );
    const insertMessage = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp)
       VALUES (?, ?, 'user', ?, ?)`,
    );
    insertMessage.run(1, "incidental", "Which open PRs still need review?", 1_001);
    insertMessage.run(2, "incidental", "@chipbyte-snap rereview snapnhd/system#1105", 1_002);
    insertMessage.run(
      3,
      "dedicated",
      "Recover the review request for https://github.com/snapnhd/system/pull/1105",
      1_501,
    );
    insertMessage.run(
      4,
      "diagnostic",
      "What happened here https://github.com/snapnhd/system/pull/1105? It missed pr-workflow.",
      1_751,
    );
    db.close();

    try {
      const found = defaultHermesSessionLookup(PR, { dbPath, nowSeconds: 2_000, psArgs: "" });
      expect(
        found.hits.find((candidate) => candidate.id === "incidental")?.firstUserMatchesRef,
      ).toBe(false);
      expect(
        found.hits.find((candidate) => candidate.id === "dedicated")?.firstUserMatchesRef,
      ).toBe(true);
      expect(
        found.hits.find((candidate) => candidate.id === "dedicated")?.firstUserRequestsReview,
      ).toBe(true);
      expect(
        found.hits.find((candidate) => candidate.id === "diagnostic")?.firstUserMatchesRef,
      ).toBe(true);
      expect(
        found.hits.find((candidate) => candidate.id === "diagnostic")?.firstUserRequestsReview,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat another PR's keyed session as a hit because a user message listed this PR", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ww-hermes-foreign-key-"));
    const dbPath = path.join(dir, "state.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT,
        session_key TEXT,
        chat_id TEXT,
        ended_at REAL,
        started_at REAL,
        archived INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        timestamp REAL,
        active INTEGER DEFAULT 1
      );
    `);
    db.prepare(
      `INSERT INTO sessions (id, source, title, session_key, chat_id, ended_at, started_at)
       VALUES (?, 'github', ?, ?, ?, NULL, ?)`,
    ).run(
      "20260901_081632_af5dcf13",
      "snapnhd/system#1157 · feat(fraud): show transfer history on Potential...",
      "wakewire:github:snapnhd/system#1157",
      "wakewire:github:snapnhd/system#1157",
      1_000,
    );
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp)
       VALUES (?, 'user', ?, 1001)`,
    ).run(
      "20260901_081632_af5dcf13",
      [
        "Open Fraud PR Status — 23 open fraud PRs",
        "https://github.com/snapnhd/system/pull/1157 FRA-2803",
        "https://github.com/snapnhd/system/pull/1143 FRA-2950",
        "snapnhd/system#1148 snapnhd/system#1152",
      ].join("\n"),
    );
    db.close();

    try {
      const foreign = defaultHermesSessionLookup(
        { githubRepo: "snapnhd/system", githubNumber: "1143", linearIdentifier: "FRA-2950" },
        { dbPath, nowSeconds: 2_000, psArgs: "" },
      );
      expect(foreign.hits.map((hit) => hit.id)).toEqual([]);

      const owner = defaultHermesSessionLookup(
        { githubRepo: "snapnhd/system", githubNumber: "1157", linearIdentifier: "FRA-2803" },
        { dbPath, nowSeconds: 2_000, psArgs: "" },
      );
      expect(owner.hits.map((hit) => hit.id)).toEqual(["20260901_081632_af5dcf13"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
