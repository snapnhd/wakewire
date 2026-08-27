import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { migrate } from "./migrations.js";
import { createStores } from "./repos.js";

describe("migrations", () => {
  it("creates the schema and is idempotent", () => {
    const db = openDatabase(":memory:");
    migrate(db); // second run is a no-op
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["routes", "deliveries", "sources", "settings", "schema_migrations"]),
    );
  });
});

describe("migration 3 upgrade (source-kind CHECK removal)", () => {
  it("preserves routes, sources, and deliveries across the table rebuild", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 2); // simulate an installation on the v2 schema
    const stores = createStores(db);
    const route = stores.routes.create({
      name: "old route",
      source: "github",
      match: { repo: "a/b", events: ["push"] },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "read-only",
      rateLimitPerMinute: 3,
      enabled: true,
    });
    stores.sources.upsert({ id: "src-1", kind: "gmail", config: { label: "x" } });
    stores.deliveries.enqueue({
      routeId: route.id,
      event: {
        source: "github",
        kind: "push",
        deliveryId: "d-1",
        occurredAt: "t",
        summary: "s",
        payload: {},
      },
      renderedPrompt: "p",
    });

    migrate(db); // apply v3 rebuild

    const migrated = createStores(db);
    expect(migrated.routes.get(route.id)?.rateLimitPerMinute).toBe(3);
    expect(migrated.sources.get("src-1")?.config.label).toBe("x");
    expect(migrated.deliveries.list({}).length).toBe(1);
    // and the rebuilt table accepts the new source kind
    expect(() =>
      migrated.sources.upsert({ id: "src-2", kind: "slack", config: { team: "default" } }),
    ).not.toThrow();
    expect(() =>
      migrated.routes.create({
        name: "slack route",
        source: "slack",
        match: { events: ["app_mention"] },
        target: { type: "thread", threadId: "t-1" },
        sandbox: "read-only",
        enabled: true,
      }),
    ).not.toThrow();
  });
});

describe("migration 7 upgrade (provider-wide request dedup)", () => {
  it("preserves existing cross-label Gmail duplicates and selects the earliest", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 6);
    const now = "2026-07-27T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, created_at, updated_at)
       VALUES ('work-1', 'email', 'email:one', 'Email', ?, ?)`,
    ).run(now, now);
    const eventJson = JSON.stringify({
      source: "gmail",
      principal: { tenantId: "Chip@SnapCorp.com" },
    });
    const insert = db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         event_json, status, created_at, updated_at)
       VALUES (?, ?, '<same@example.com>', ?, 'work-1', 'do it', ?, 'acknowledged', ?, ?)`,
    );
    insert.run("request-first", "gmail-inbox", personId, eventJson, now, now);
    insert.run("request-second", "gmail-label", personId, eventJson, now, now);

    migrate(db);

    expect(
      db
        .prepare(
          `SELECT request_id FROM agent_request_dedup_keys
           WHERE dedup_scope = 'gmail-mailbox:chip@snapcorp.com'
             AND dedup_delivery_id = '<same@example.com>'`,
        )
        .get(),
    ).toEqual({ request_id: "request-first" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_request_dedup_keys").get()).toEqual({
      count: 3,
    });
  });
});

describe("migration 8 upgrade (owner destructive-action denial)", () => {
  it("tightens the exact seed without overwriting a customized owner", () => {
    const seeded = new DatabaseConstructor(":memory:");
    migrate(seeded, 7);
    expect(
      JSON.parse(
        (
          seeded.prepare("SELECT policy_json FROM roles WHERE name = 'owner'").get() as {
            policy_json: string;
          }
        ).policy_json,
      ).destructiveActions,
    ).toBe("explicit-authenticated-instruction");

    migrate(seeded);
    expect(
      JSON.parse(
        (
          seeded.prepare("SELECT policy_json FROM roles WHERE name = 'owner'").get() as {
            policy_json: string;
          }
        ).policy_json,
      ).destructiveActions,
    ).toBe("deny");

    const customized = new DatabaseConstructor(":memory:");
    migrate(customized, 7);
    const customPolicy = JSON.parse(
      (
        customized.prepare("SELECT policy_json FROM roles WHERE name = 'owner'").get() as {
          policy_json: string;
        }
      ).policy_json,
    );
    customPolicy.secrets.use = false;
    customized
      .prepare("UPDATE roles SET policy_json = ? WHERE name = 'owner'")
      .run(JSON.stringify(customPolicy));

    migrate(customized);
    expect(
      JSON.parse(
        (
          customized.prepare("SELECT policy_json FROM roles WHERE name = 'owner'").get() as {
            policy_json: string;
          }
        ).policy_json,
      ),
    ).toEqual(customPolicy);
  });
});

describe("migration 9 upgrade (durable source replies)", () => {
  it("preserves acknowledgments and adds independent completion/reply state", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 8);
    const now = "2026-07-28T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'Slack', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         event_json, status, created_at, updated_at)
       VALUES ('request-1', 'slack-snap', 'Ev1', ?, 'work-1', 'do it', '{}',
         'submitted', ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO ack_outbox
        (id, request_id, source_id, provider, provider_delivery_id, ack_kind,
         destination, payload_json, status, created_at, updated_at)
       VALUES ('ack-1', 'request-1', 'slack-snap', 'slack', 'Ev1', 'eyes-reaction',
         'C:1', '{}', 'sent', ?, ?)`,
    ).run(now, now);

    migrate(db);

    expect(db.prepare("SELECT id, status FROM ack_outbox").get()).toEqual({
      id: "ack-1",
      status: "sent",
    });
    expect(
      db
        .prepare(
          `SELECT codex_thread_id, codex_turn_id, correlation_marker
           FROM agent_requests WHERE id = 'request-1'`,
        )
        .get(),
    ).toEqual({ codex_thread_id: null, codex_turn_id: null, correlation_marker: null });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("source_reply_outbox"),
    ).toEqual({ name: "source_reply_outbox" });
    expect(
      (db.prepare("PRAGMA table_info(source_reply_outbox)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toEqual(expect.arrayContaining(["lease_owner", "lease_expires_at"]));
    expect(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("source_reply_outbox_ready"),
    ).toMatchObject({ sql: expect.stringContaining("lease_expires_at") });
    const insertReply = db.prepare(
      `INSERT INTO source_reply_outbox
        (id, request_id, source_id, provider, reply_kind, destination, payload_json,
         status, lease_owner, lease_expires_at, created_at, updated_at)
       VALUES (?, 'request-1', 'slack-snap', 'slack', 'thread-reply', 'T:C:1', '{}',
         ?, ?, ?, ?, ?)`,
    );
    expect(() => insertReply.run("reply-sending", "sending", null, null, now, now)).toThrow();
    expect(() =>
      insertReply.run("reply-pending", "pending", "worker-a", "2026-07-28T00:01:00.000Z", now, now),
    ).toThrow();
  });
});

describe("migration 10 upgrade (durable Codex task titles)", () => {
  it("marks existing work items unsynchronized without changing their desired title", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 9);
    const now = "2026-07-28T00:00:00.000Z";
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, codex_thread_id, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'CJ — Check this', 'thread-1', ?, ?)`,
    ).run(now, now);

    migrate(db);

    expect(
      db.prepare("SELECT title, codex_thread_title FROM work_items WHERE id = 'work-1'").get(),
    ).toEqual({ title: "CJ — Check this", codex_thread_title: null });
  });
});

describe("migration 11 upgrade (frozen request execution profiles)", () => {
  it("gives existing requests the Luna low current-task default", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 10);
    const now = "2026-07-30T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'Slack', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         event_json, status, created_at, updated_at)
       VALUES ('request-1', 'slack-snap', 'Ev1', ?, 'work-1', 'do it', '{}',
         'acknowledged', ?, ?)`,
    ).run(personId, now, now);

    migrate(db);

    const row = db
      .prepare("SELECT execution_profile_json FROM agent_requests WHERE id = 'request-1'")
      .get() as { execution_profile_json: string };
    expect(JSON.parse(row.execution_profile_json)).toEqual({
      version: 1,
      mode: "current",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      source: "default",
      clarification: null,
    });
  });
});

describe("migration 13 upgrade (host-owned child orchestration)", () => {
  it("requires durable task identities as orchestration advances", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 12);
    const now = "2026-07-30T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'Slack', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         execution_profile_json, event_json, status, created_at, updated_at)
       VALUES ('request-1', 'slack-snap', 'Ev1', ?, 'work-1', 'do it',
         '{"version":1,"mode":"separate","model":"gpt-5.6-sol","reasoningEffort":"ultra","source":"ultracode","clarification":null}',
         '{}', 'dispatching', ?, ?)`,
    ).run(personId, now, now);

    migrate(db, 13);

    db.prepare(
      `INSERT INTO agent_request_orchestrations
        (request_id, stage, cwd, sandbox_policy, child_prompt, child_title,
         report_prompt_prefix, report_prompt_suffix, created_at, updated_at)
       VALUES ('request-1', 'planned', '/Users/chip/Snap', 'workspace-write',
         'child prompt', 'child title', 'prefix', 'suffix', ?, ?)`,
    ).run(now, now);
    expect(() =>
      db
        .prepare(
          `UPDATE agent_request_orchestrations SET child_turn_id = 'stale-turn'
           WHERE request_id = 'request-1'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE agent_request_orchestrations
           SET stage = 'child_submitted', parent_thread_id = 'parent',
             child_thread_id = 'child' WHERE request_id = 'request-1'`,
        )
        .run(),
    ).toThrow();
    db.prepare(
      `UPDATE agent_request_orchestrations
       SET stage = 'child_submitted', parent_thread_id = 'parent', child_thread_id = 'child',
         child_correlation_marker = 'marker' WHERE request_id = 'request-1'`,
    ).run();
    expect(
      db
        .prepare(
          "SELECT stage, parent_thread_id, child_thread_id FROM agent_request_orchestrations",
        )
        .get(),
    ).toEqual({
      stage: "child_submitted",
      parent_thread_id: "parent",
      child_thread_id: "child",
    });
  });
});

describe("migration 14 upgrade (scheduled follow-up terminal outbox)", () => {
  it("upgrades a live version-12 binding and enforces one complete terminal record", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 13);
    const now = "2026-07-30T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'Slack', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         execution_profile_json, event_json, codex_thread_id, codex_turn_id,
         correlation_marker, status, created_at, updated_at)
       VALUES ('request-1', 'slack-snap', 'Ev1', ?, 'work-1', 'do it',
         '{"version":1,"mode":"current","model":"gpt-5.6-luna","reasoningEffort":"low","source":"default","clarification":null}',
         '{}', 'thread-1', 'turn-1', 'marker-1', 'completed', ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         execution_profile_json, event_json, codex_thread_id, correlation_marker,
         status, created_at, updated_at)
       VALUES ('terminal-1', 'slack-snap', 'Ev2', ?, 'work-1', 'done',
         '{"version":1,"mode":"current","model":"gpt-5.6-luna","reasoningEffort":"low","source":"default","clarification":null}',
         '{}', 'thread-1', 'terminal-marker', 'submitted', ?, ?)`,
    ).run(personId, now, now);

    const insert = db.prepare(
      `INSERT INTO scheduled_followup_bindings
        (id, automation_id, origin_request_id, origin_codex_thread_id,
         origin_codex_turn_id, origin_correlation_marker, created_at, updated_at)
       VALUES (?, ?, 'request-1', 'thread-1', 'turn-1', 'marker-1', ?, ?)`,
    );
    insert.run("binding-1", "monitor-access", now, now);

    migrate(db);

    db.prepare(
      `UPDATE scheduled_followup_bindings
       SET terminal_request_id = 'terminal-1', terminal_message_sha256 = ?, completed_at = ?
       WHERE id = 'binding-1'`,
    ).run("a".repeat(64), now);
    expect(
      db
        .prepare(
          `SELECT terminal_request_id, terminal_message_sha256, completed_at
           FROM scheduled_followup_bindings WHERE id = 'binding-1'`,
        )
        .get(),
    ).toEqual({
      terminal_request_id: "terminal-1",
      terminal_message_sha256: "a".repeat(64),
      completed_at: now,
    });

    insert.run("binding-2", "other-monitor", now, now);
    expect(() =>
      db
        .prepare(
          `UPDATE scheduled_followup_bindings
           SET terminal_request_id = 'terminal-1', terminal_message_sha256 = ?, completed_at = ?
           WHERE id = 'binding-2'`,
        )
        .run("b".repeat(64), now),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE scheduled_followup_bindings SET terminal_message_sha256 = ?
           WHERE id = 'binding-2'`,
        )
        .run("c".repeat(64)),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE scheduled_followup_bindings
           SET terminal_request_id = NULL, terminal_message_sha256 = NULL, completed_at = NULL
           WHERE id = 'binding-1'`,
        )
        .run(),
    ).toThrow("scheduled follow-up terminal fields are immutable");
    expect(() =>
      db
        .prepare(
          `UPDATE scheduled_followup_bindings
           SET terminal_message_sha256 = ?, completed_at = ?
           WHERE id = 'binding-1'`,
        )
        .run("d".repeat(64), "2026-07-30T00:01:00.000Z"),
    ).toThrow("scheduled follow-up terminal fields are immutable");
    expect(() => insert.run("binding-3", "monitor-access", now, now)).toThrow();
  });

  it("applies a missing migration 13 when 14 was already recorded", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 14);
    db.exec(`
      DROP TABLE agent_request_orchestrations;
      DELETE FROM schema_migrations WHERE version = 13;
    `);

    migrate(db);

    const versions = db
      .prepare("SELECT version FROM schema_migrations WHERE version >= 12 ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(versions.map(({ version }) => version)).toEqual([
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_request_orchestrations'",
        )
        .get(),
    ).toEqual({ name: "agent_request_orchestrations" });
  });
});

describe("migration 18 upgrade (source reply request outcomes)", () => {
  it("preserves existing replies as completions and constrains terminal outcomes", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 17);
    const now = "2026-07-31T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'Slack', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id, request_text,
         event_json, status, created_at, updated_at)
       VALUES ('request-1', 'slack-snap', 'Ev1', ?, 'work-1', 'do it', '{}',
         'submitted', ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO source_reply_outbox
        (id, request_id, source_id, provider, reply_kind, destination, payload_json,
         status, created_at, updated_at)
       VALUES ('reply-1', 'request-1', 'slack-snap', 'slack', 'thread-reply',
         'T:C:1', '{}', 'pending', ?, ?)`,
    ).run(now, now);

    migrate(db);

    expect(
      db.prepare("SELECT request_outcome FROM source_reply_outbox WHERE id = 'reply-1'").get(),
    ).toEqual({ request_outcome: "completed" });
    expect(() =>
      db
        .prepare("UPDATE source_reply_outbox SET request_outcome = 'invalid' WHERE id = 'reply-1'")
        .run(),
    ).toThrow();
    expect(
      db
        .prepare("UPDATE source_reply_outbox SET request_outcome = 'failed' WHERE id = 'reply-1'")
        .run().changes,
    ).toBe(1);
  });
});

describe("migration 20 upgrade (immutable Claude proxy adapter mode)", () => {
  it("defaults existing sessions to print and constrains new immutable selections", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 19);
    const now = "2026-08-01T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, cwd, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:C:1', 'Slack Claude proxy',
         '/Users/chip/Snap', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO claude_proxy_sessions
        (id, source_id, provider, conversation_key,
         principal_provider, principal_tenant_id, principal_subject_id,
         person_id, work_item_id, cwd, claude_session_id, status, created_at, updated_at)
       VALUES (
         '22222222-2222-4222-8222-222222222222', 'slack-snap', 'slack', 'T:C:1',
         'slack', 'T', 'U', ?, 'work-1', '/Users/chip/Snap',
         '33333333-3333-4333-8333-333333333333', 'ready', ?, ?
       )`,
    ).run(personId, now, now);

    migrate(db);

    expect(
      db
        .prepare(
          `SELECT adapter_mode FROM claude_proxy_sessions
           WHERE id = '22222222-2222-4222-8222-222222222222'`,
        )
        .get(),
    ).toEqual({ adapter_mode: "print" });
    expect(() =>
      db
        .prepare(
          `UPDATE claude_proxy_sessions SET adapter_mode = 'rc-tmux'
           WHERE id = '22222222-2222-4222-8222-222222222222'`,
        )
        .run(),
    ).toThrow("Claude proxy adapter mode is immutable");

    const insert = db.prepare(
      `INSERT INTO claude_proxy_sessions
        (id, source_id, provider, conversation_key,
         principal_provider, principal_tenant_id, principal_subject_id,
         person_id, work_item_id, cwd, claude_session_id, adapter_mode,
         status, created_at, updated_at)
       VALUES (?, 'slack-snap', 'slack', ?, 'slack', 'T', 'U', ?, 'work-1',
         '/Users/chip/Snap', ?, ?, 'ready', ?, ?)`,
    );
    expect(
      insert.run(
        "44444444-4444-4444-8444-444444444444",
        "T:C:2",
        personId,
        "55555555-5555-4555-8555-555555555555",
        "rc-tmux",
        now,
        now,
      ).changes,
    ).toBe(1);
    expect(() =>
      insert.run(
        "66666666-6666-4666-8666-666666666666",
        "T:C:3",
        personId,
        "77777777-7777-4777-8777-777777777777",
        "unsupported",
        now,
        now,
      ),
    ).toThrow();
  });
});

describe("migration 21 upgrade (exact Slack thread-root Claude proxies)", () => {
  it("pauses only idle legacy DM-wide sessions and preserves every session row", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 20);
    const now = "2026-08-02T00:00:00.000Z";
    const personId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, 'CJ', 'owner', 1, ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO work_items
        (id, canonical_kind, canonical_key, title, cwd, created_at, updated_at)
       VALUES ('work-1', 'slack', 'slack:T:D:1', 'Slack Claude proxy',
         '/Users/chip/Snap', ?, ?)`,
    ).run(now, now);
    const insert = db.prepare(
      `INSERT INTO claude_proxy_sessions
        (id, source_id, provider, conversation_key,
         principal_provider, principal_tenant_id, principal_subject_id,
         person_id, work_item_id, cwd, claude_session_id, adapter_mode,
         status, error, created_at, updated_at)
       VALUES (?, 'slack-snap', 'slack', ?, 'slack', 'T', 'U', ?, 'work-1',
         '/Users/chip/Snap', ?, 'print', ?, ?, ?, ?)`,
    );
    insert.run(
      "22222222-2222-4222-8222-222222222222",
      "slack-dm:T:D",
      personId,
      "33333333-3333-4333-8333-333333333333",
      "ready",
      null,
      now,
      now,
    );
    insert.run(
      "44444444-4444-4444-8444-444444444444",
      "slack-dm:T:E",
      personId,
      "55555555-5555-4555-8555-555555555555",
      "busy",
      null,
      now,
      now,
    );
    insert.run(
      "66666666-6666-4666-8666-666666666666",
      "T:D:2.0",
      personId,
      "77777777-7777-4777-8777-777777777777",
      "ready",
      null,
      now,
      now,
    );
    insert.run(
      "88888888-8888-4888-8888-888888888888",
      "slack-dm:T:F",
      personId,
      "99999999-9999-4999-8999-999999999999",
      "ready",
      null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO agent_requests
        (id, source_id, source_delivery_id, person_id, work_item_id,
         request_text, event_json, status, created_at, updated_at)
       VALUES ('request-queued', 'slack-snap', 'delivery-queued', ?, 'work-1',
         'queued before upgrade',
         '{"source":"slack","principal":{"provider":"slack","tenantId":"T","subjectId":"U"}}',
         'acknowledged', ?, ?)`,
    ).run(personId, now, now);
    db.prepare(
      `INSERT INTO claude_proxy_turns
        (agent_request_id, session_id, ordinal, stage, correlation_marker, created_at, updated_at)
       VALUES ('request-queued', '88888888-8888-4888-8888-888888888888', 1,
         'queued', 'legacy-queued-marker', ?, ?)`,
    ).run(now, now);

    migrate(db);

    expect(
      db
        .prepare(
          `SELECT id, conversation_key, status, error
             FROM claude_proxy_sessions
            ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "22222222-2222-4222-8222-222222222222",
        conversation_key: "slack-dm:T:D",
        status: "paused",
        error: "Legacy DM-wide Claude proxy retired; new messages use exact Slack thread roots.",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        conversation_key: "slack-dm:T:E",
        status: "busy",
        error: null,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        conversation_key: "T:D:2.0",
        status: "ready",
        error: null,
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        conversation_key: "slack-dm:T:F",
        status: "ready",
        error: null,
      },
    ]);
    expect(
      db
        .prepare("SELECT stage FROM claude_proxy_turns WHERE agent_request_id = 'request-queued'")
        .get(),
    ).toEqual({ stage: "queued" });
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 21").get()).toEqual({
      name: "retire-legacy-dm-wide-claude-proxies",
    });
  });
});

describe("stores", () => {
  it("round-trips routes with JSON columns", () => {
    const stores = createStores(openDatabase(":memory:"));
    const route = stores.routes.create({
      name: "r",
      source: "github",
      match: { repo: "a/b", events: ["push"] },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "read-only",
      enabled: true,
    });
    const loaded = stores.routes.get(route.id);
    expect(loaded?.match).toEqual({ repo: "a/b", events: ["push"] });
    expect(loaded?.target).toEqual({ type: "thread", threadId: "t-1" });
    expect(stores.routes.list()).toHaveLength(1);
    expect(stores.routes.remove(route.id)).toBe(true);
    expect(stores.routes.list()).toHaveLength(0);
  });

  it("settings getOrCreate only creates once", () => {
    const stores = createStores(openDatabase(":memory:"));
    let calls = 0;
    const make = () => {
      calls++;
      return "token-value";
    };
    expect(stores.settings.getOrCreate("k", make)).toBe("token-value");
    expect(stores.settings.getOrCreate("k", make)).toBe("token-value");
    expect(calls).toBe(1);
  });

  it("sources upsert preserves ids and updates configs", () => {
    const stores = createStores(openDatabase(":memory:"));
    const created = stores.sources.upsert({ kind: "gmail", config: { label: "a" } });
    const updated = stores.sources.upsert({
      id: created.id,
      kind: "gmail",
      config: { label: "b" },
    });
    expect(updated.id).toBe(created.id);
    expect(stores.sources.list()).toHaveLength(1);
    expect(stores.sources.get(created.id)?.config.label).toBe("b");
  });
});
