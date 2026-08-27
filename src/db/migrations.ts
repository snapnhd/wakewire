import type { Database } from "better-sqlite3";

/**
 * Append-only list of migrations. Each entry runs once, inside a transaction,
 * tracked in schema_migrations. Never edit a shipped migration — add a new one.
 * disableForeignKeys is for table rebuilds (SQLite cannot alter constraints).
 */
const MIGRATIONS: ReadonlyArray<{
  version: number;
  name: string;
  sql: string;
  disableForeignKeys?: boolean;
}> = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('github', 'gmail')),
        match_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        prompt_template TEXT,
        sandbox_policy TEXT NOT NULL DEFAULT 'read-only'
          CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES routes(id),
        source_delivery_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'received', 'queued', 'delivering', 'delivered',
          'failed', 'skipped-duplicate', 'held', 'coalesced'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        event_json TEXT NOT NULL,
        rendered_prompt TEXT,
        thread_id TEXT,
        turn_id TEXT,
        error TEXT,
        coalesced_into TEXT REFERENCES deliveries(id),
        is_replay INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Dedup: one live delivery per (route, source delivery id). Rows that only
      -- record a skipped duplicate or a replay are excluded from the constraint.
      CREATE UNIQUE INDEX deliveries_dedup
        ON deliveries (route_id, source_delivery_id)
        WHERE status NOT IN ('skipped-duplicate') AND is_replay = 0;

      CREATE INDEX deliveries_status ON deliveries (status, next_attempt_at);
      CREATE INDEX deliveries_route ON deliveries (route_id, received_at);

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('github', 'gmail')),
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "route-rate-limit",
    sql: `
      ALTER TABLE routes ADD COLUMN rate_limit_per_minute INTEGER;
    `,
  },
  {
    // Source kinds are an extensible enum (slack joined github/gmail) and are
    // validated by zod at the boundaries; baking them into CHECK constraints
    // was a mistake. Rebuild routes and sources without the kind CHECKs.
    version: 3,
    name: "drop-source-kind-checks",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE routes_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        match_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        prompt_template TEXT,
        sandbox_policy TEXT NOT NULL DEFAULT 'read-only'
          CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        rate_limit_per_minute INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO routes_new (id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at)
        SELECT id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at FROM routes;
      DROP TABLE routes;
      ALTER TABLE routes_new RENAME TO routes;

      CREATE TABLE sources_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sources_new (id, kind, config_json, enabled)
        SELECT id, kind, config_json, enabled FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;
    `,
  },
  {
    // Capture mode for generic webhook sources: the first few raw payloads are
    // stored so the model can inspect a real event and author the field mapping.
    version: 4,
    name: "webhook-captures",
    sql: `
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX captures_source ON captures (source_id, received_at);
    `,
  },
  {
    // People are the authorization principal. Provider identities use stable,
    // provider-issued ids; email addresses are enrollment aliases only and live
    // in their own table so they are never confused with immutable identities.
    version: 5,
    name: "people-and-role-policies",
    sql: `
      CREATE TABLE roles (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO roles (name, policy_json, created_at, updated_at)
      VALUES (
        'owner',
        '{"version":1,"capabilities":{"machine":"full","desktop":"full","filesystem":"full","shell":"full","network":"full","browser":"full","computerUse":"full","connectedApps":"full","sourceReplies":"full","git":"full","deployments":"full"},"secrets":{"use":true,"disclose":false},"policyAdmin":false,"destructiveActions":"explicit-authenticated-instruction"}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      CREATE TABLE people (
        id TEXT PRIMARY KEY CHECK (
          length(id) = 36 AND
          substr(id, 9, 1) = '-' AND
          substr(id, 14, 1) = '-' AND
          substr(id, 19, 1) = '-' AND
          substr(id, 24, 1) = '-'
        ),
        nickname TEXT NOT NULL COLLATE NOCASE,
        role_name TEXT NOT NULL COLLATE NOCASE REFERENCES roles(name),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX people_nickname_nocase
        ON people (nickname COLLATE NOCASE);

      CREATE TABLE person_emails (
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        email TEXT NOT NULL COLLATE NOCASE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (person_id, email)
      );
      CREATE UNIQUE INDEX person_emails_email_nocase
        ON person_emails (email COLLATE NOCASE);

      CREATE TABLE person_identities (
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        handle TEXT,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, tenant_id, external_id)
      );
      CREATE INDEX person_identities_person ON person_identities (person_id);
    `,
  },
  {
    // One canonical work item may have Slack, email, GitHub, and Linear aliases.
    // Authorized requests are persisted before Codex Desktop dispatch. The
    // optional outbox stores required lifecycle replies or later-classified
    // progress acknowledgments.
    version: 6,
    name: "agent-work-items-and-ack-outbox",
    sql: `
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        canonical_kind TEXT NOT NULL CHECK (canonical_kind IN ('linear', 'github', 'slack', 'email')),
        canonical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (canonical_kind, canonical_key)
      );

      CREATE TABLE work_item_aliases (
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        native_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, scope, native_key)
      );
      CREATE INDEX work_item_aliases_work_item ON work_item_aliases (work_item_id);

      CREATE TABLE agent_requests (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_delivery_id TEXT NOT NULL,
        person_id TEXT NOT NULL REFERENCES people(id),
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        request_text TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        status TEXT NOT NULL CHECK (status IN (
          'acknowledged', 'dispatching', 'submitted', 'completed', 'held', 'failed'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source_id, source_delivery_id)
      );
      CREATE INDEX agent_requests_status ON agent_requests (status, created_at);
      CREATE INDEX agent_requests_work_item ON agent_requests (work_item_id, created_at);

      CREATE TABLE ack_outbox (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES agent_requests(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_delivery_id TEXT NOT NULL,
        ack_kind TEXT NOT NULL,
        destination TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'held', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        provider_result_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source_id, provider_delivery_id, ack_kind, destination)
      );
      CREATE INDEX ack_outbox_ready ON ack_outbox (status, next_attempt_at, created_at);
    `,
  },
  {
    // A mailbox can be watched through overlapping Gmail labels. Keep the
    // concrete source id on the request/outbox for reply credentials, while a
    // separate provider-wide key prevents the same RFC Message-ID from being
    // accepted twice. Existing duplicates are preserved; the earliest one is
    // the canonical target for future provider-wide replays.
    version: 7,
    name: "agent-request-provider-dedup",
    sql: `
      CREATE TABLE agent_request_dedup_keys (
        dedup_scope TEXT NOT NULL,
        dedup_delivery_id TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (dedup_scope, dedup_delivery_id)
      );
      CREATE INDEX agent_request_dedup_request
        ON agent_request_dedup_keys (request_id);

      INSERT INTO agent_request_dedup_keys
        (dedup_scope, dedup_delivery_id, request_id, created_at)
      SELECT 'source:' || source_id, source_delivery_id, id, created_at
      FROM agent_requests;

      INSERT INTO agent_request_dedup_keys
        (dedup_scope, dedup_delivery_id, request_id, created_at)
      SELECT
        'gmail-mailbox:' || lower(trim(json_extract(current.event_json, '$.principal.tenantId'))),
        current.source_delivery_id,
        current.id,
        current.created_at
      FROM agent_requests AS current
      WHERE json_extract(current.event_json, '$.source') = 'gmail'
        AND trim(COALESCE(json_extract(current.event_json, '$.principal.tenantId'), '')) <> ''
        AND current.rowid = (
          SELECT MIN(candidate.rowid)
          FROM agent_requests AS candidate
          WHERE json_extract(candidate.event_json, '$.source') = 'gmail'
            AND lower(trim(json_extract(candidate.event_json, '$.principal.tenantId'))) =
              lower(trim(json_extract(current.event_json, '$.principal.tenantId')))
            AND candidate.source_delivery_id = current.source_delivery_id
        );
    `,
  },
  {
    // Tighten only the byte-for-byte seeded owner policy. A deliberately
    // customized owner remains untouched and therefore continues to fail the
    // exact Desktop policy gate rather than being silently rewritten.
    version: 8,
    name: "owner-deny-destructive-actions",
    sql: `
      UPDATE roles
      SET
        policy_json = '{"version":1,"capabilities":{"machine":"full","desktop":"full","filesystem":"full","shell":"full","network":"full","browser":"full","computerUse":"full","connectedApps":"full","sourceReplies":"full","git":"full","deployments":"full"},"secrets":{"use":true,"disclose":false},"policyAdmin":false,"destructiveActions":"deny"}',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE name = 'owner' COLLATE NOCASE
        AND policy_json = '{"version":1,"capabilities":{"machine":"full","desktop":"full","filesystem":"full","shell":"full","network":"full","browser":"full","computerUse":"full","connectedApps":"full","sourceReplies":"full","git":"full","deployments":"full"},"secrets":{"use":true,"disclose":false},"policyAdmin":false,"destructiveActions":"explicit-authenticated-instruction"}';
    `,
  },
  {
    // A Desktop submission and its provider response are separate durable
    // effects. Bind every request to the exact Codex task/turn/marker, then use
    // a second outbox so a progress acknowledgment and final reply can coexist.
    version: 9,
    name: "agent-source-reply-outbox",
    sql: `
      ALTER TABLE agent_requests ADD COLUMN codex_thread_id TEXT
        CHECK (codex_thread_id IS NULL OR length(trim(codex_thread_id)) > 0);
      ALTER TABLE agent_requests ADD COLUMN codex_turn_id TEXT
        CHECK (codex_turn_id IS NULL OR length(trim(codex_turn_id)) > 0);
      ALTER TABLE agent_requests ADD COLUMN correlation_marker TEXT
        CHECK (correlation_marker IS NULL OR length(trim(correlation_marker)) > 0);

      CREATE TABLE source_reply_outbox (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES agent_requests(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        reply_kind TEXT NOT NULL,
        destination TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'held', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        provider_result_id TEXT,
        error TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'sending'
            AND lease_owner IS NOT NULL
            AND length(trim(lease_owner)) > 0
            AND lease_expires_at IS NOT NULL
            AND length(trim(lease_expires_at)) > 0)
          OR
          (status <> 'sending' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        )
      );
      CREATE INDEX source_reply_outbox_ready
        ON source_reply_outbox (status, next_attempt_at, lease_expires_at, created_at);
    `,
  },
  {
    // Keep cosmetic Codex naming idempotent and independent from turn
    // delivery. NULL means the desired work-item title still needs syncing;
    // a changed canonical title (for example a Linear promotion) naturally
    // differs from this last-applied value and is reconciled once.
    version: 10,
    name: "work-item-codex-thread-title",
    sql: `
      ALTER TABLE work_items ADD COLUMN codex_thread_title TEXT
        CHECK (codex_thread_title IS NULL OR length(trim(codex_thread_title)) > 0);
    `,
  },
  {
    // Resolve authenticated model/effort directives once at ingress. Persisting
    // the typed result prevents a parser update from changing an already queued
    // request when it is retried after a crash or transient Desktop failure.
    version: 11,
    name: "agent-request-execution-profile",
    sql: `
      ALTER TABLE agent_requests ADD COLUMN execution_profile_json TEXT NOT NULL
        DEFAULT '{"version":1,"mode":"current","model":"gpt-5.6-luna","reasoningEffort":"low","source":"default","clarification":null}'
        CHECK (json_valid(execution_profile_json));
    `,
  },
  {
    // A thread-bound Codex heartbeat reports in the originating task, but its
    // later turn is not a new authenticated provider request. Persist an opaque
    // bridge to the exact request before activation so a terminal callback can
    // queue one provider-only child through the normal durable reply outbox.
    version: 12,
    name: "scheduled-followup-bindings",
    sql: `
      CREATE TABLE scheduled_followup_bindings (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL UNIQUE,
        origin_request_id TEXT NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
        origin_codex_thread_id TEXT NOT NULL CHECK (length(trim(origin_codex_thread_id)) > 0),
        origin_codex_turn_id TEXT NOT NULL CHECK (length(trim(origin_codex_turn_id)) > 0),
        origin_correlation_marker TEXT NOT NULL
          CHECK (length(trim(origin_correlation_marker)) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX scheduled_followup_bindings_automation
        ON scheduled_followup_bindings (automation_id, created_at);
    `,
  },
  {
    // Separate-task execution is a host-owned state machine. Keep the child
    // identity and exact completion binding outside agent_requests: only the
    // later parent report turn is allowed to own the provider reply binding.
    version: 13,
    name: "agent-request-child-orchestration",
    sql: `
      CREATE TABLE agent_request_orchestrations (
        request_id TEXT PRIMARY KEY REFERENCES agent_requests(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN (
          'planned', 'parent_ready', 'child_ready', 'child_submitted',
          'child_completed', 'report_submitted'
        )),
        cwd TEXT NOT NULL CHECK (length(trim(cwd)) > 0),
        sandbox_policy TEXT NOT NULL CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        child_prompt TEXT NOT NULL CHECK (length(trim(child_prompt)) > 0),
        child_title TEXT NOT NULL CHECK (length(trim(child_title)) > 0),
        report_prompt_prefix TEXT NOT NULL CHECK (length(report_prompt_prefix) > 0),
        report_prompt_suffix TEXT NOT NULL CHECK (length(report_prompt_suffix) > 0),
        parent_thread_id TEXT CHECK (
          parent_thread_id IS NULL OR length(trim(parent_thread_id)) > 0
        ),
        child_thread_id TEXT CHECK (
          child_thread_id IS NULL OR length(trim(child_thread_id)) > 0
        ),
        child_turn_id TEXT CHECK (
          child_turn_id IS NULL OR length(trim(child_turn_id)) > 0
        ),
        child_correlation_marker TEXT CHECK (
          child_correlation_marker IS NULL OR length(trim(child_correlation_marker)) > 0
        ),
        child_final_response TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (stage = 'planned' AND parent_thread_id IS NULL
            AND child_thread_id IS NULL AND child_turn_id IS NULL
            AND child_correlation_marker IS NULL AND child_final_response IS NULL)
          OR
          (stage = 'parent_ready' AND parent_thread_id IS NOT NULL
            AND child_thread_id IS NULL AND child_turn_id IS NULL
            AND child_correlation_marker IS NULL AND child_final_response IS NULL)
          OR
          (stage = 'child_ready' AND parent_thread_id IS NOT NULL
            AND child_thread_id IS NOT NULL AND child_turn_id IS NULL
            AND child_correlation_marker IS NULL AND child_final_response IS NULL)
          OR
          (stage = 'child_submitted' AND parent_thread_id IS NOT NULL
            AND child_thread_id IS NOT NULL AND child_correlation_marker IS NOT NULL
            AND child_final_response IS NULL)
          OR
          (stage = 'child_completed' AND parent_thread_id IS NOT NULL
            AND child_thread_id IS NOT NULL AND child_correlation_marker IS NOT NULL
            AND child_final_response IS NOT NULL)
          OR
          (stage = 'report_submitted' AND parent_thread_id IS NOT NULL
            AND child_thread_id IS NOT NULL AND child_correlation_marker IS NOT NULL
            AND child_final_response IS NOT NULL)
        )
      );
      CREATE INDEX agent_request_orchestrations_stage
        ON agent_request_orchestrations (stage, updated_at);
    `,
  },
  {
    // Migration 12 reached a live daemon before terminal first-write-wins was
    // added. Evolve it separately so existing opaque bindings remain valid.
    version: 14,
    name: "scheduled-followup-terminal-outbox",
    sql: `
      ALTER TABLE scheduled_followup_bindings ADD COLUMN terminal_request_id TEXT
        REFERENCES agent_requests(id);
      ALTER TABLE scheduled_followup_bindings ADD COLUMN terminal_message_sha256 TEXT
        CHECK (terminal_message_sha256 IS NULL OR length(terminal_message_sha256) = 64);
      ALTER TABLE scheduled_followup_bindings ADD COLUMN completed_at TEXT;

      CREATE UNIQUE INDEX scheduled_followup_terminal_request
        ON scheduled_followup_bindings (terminal_request_id)
        WHERE terminal_request_id IS NOT NULL;

      CREATE TRIGGER scheduled_followup_terminal_fields_insert
      BEFORE INSERT ON scheduled_followup_bindings
      WHEN NOT (
        (NEW.terminal_request_id IS NULL AND NEW.terminal_message_sha256 IS NULL
          AND NEW.completed_at IS NULL)
        OR
        (NEW.terminal_request_id IS NOT NULL AND NEW.terminal_message_sha256 IS NOT NULL
          AND NEW.completed_at IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'scheduled follow-up terminal fields must be all null or all set');
      END;

      CREATE TRIGGER scheduled_followup_terminal_fields_update
      BEFORE UPDATE OF terminal_request_id, terminal_message_sha256, completed_at
      ON scheduled_followup_bindings
      WHEN NOT (
        (NEW.terminal_request_id IS NULL AND NEW.terminal_message_sha256 IS NULL
          AND NEW.completed_at IS NULL)
        OR
        (NEW.terminal_request_id IS NOT NULL AND NEW.terminal_message_sha256 IS NOT NULL
          AND NEW.completed_at IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'scheduled follow-up terminal fields must be all null or all set');
      END;
    `,
  },
  {
    // Keep terminal completion first-write-wins even for direct database
    // callers. Migration 14 enforced field completeness but still allowed all
    // three values to be replaced or cleared together.
    version: 15,
    name: "scheduled-followup-terminal-immutable",
    sql: `
      CREATE TRIGGER scheduled_followup_terminal_fields_immutable
      BEFORE UPDATE OF terminal_request_id, terminal_message_sha256, completed_at
      ON scheduled_followup_bindings
      WHEN OLD.terminal_request_id IS NOT NULL AND (
        NEW.terminal_request_id IS NOT OLD.terminal_request_id
        OR NEW.terminal_message_sha256 IS NOT OLD.terminal_message_sha256
        OR NEW.completed_at IS NOT OLD.completed_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'scheduled follow-up terminal fields are immutable');
      END;
    `,
  },
  {
    // Recurring proactive Slack deliveries are bound once to an authenticated
    // origin and may emit one provider-only message per stable occurrence key.
    // The frozen team/channel never comes from a later automation callback.
    version: 16,
    name: "scheduled-channel-deliveries",
    sql: `
      CREATE TABLE scheduled_channel_delivery_bindings (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL UNIQUE,
        origin_request_id TEXT NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
        origin_codex_thread_id TEXT NOT NULL CHECK (length(trim(origin_codex_thread_id)) > 0),
        origin_codex_turn_id TEXT NOT NULL CHECK (length(trim(origin_codex_turn_id)) > 0),
        origin_correlation_marker TEXT NOT NULL
          CHECK (length(trim(origin_correlation_marker)) > 0),
        origin_source_id TEXT NOT NULL CHECK (length(trim(origin_source_id)) > 0),
        slack_team_id TEXT NOT NULL CHECK (length(trim(slack_team_id)) > 0),
        slack_channel_id TEXT NOT NULL CHECK (length(trim(slack_channel_id)) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX scheduled_channel_delivery_bindings_automation
        ON scheduled_channel_delivery_bindings (automation_id, created_at);

      CREATE TABLE scheduled_channel_delivery_occurrences (
        binding_id TEXT NOT NULL
          REFERENCES scheduled_channel_delivery_bindings(id) ON DELETE CASCADE,
        occurrence_key TEXT NOT NULL CHECK (length(trim(occurrence_key)) > 0),
        request_id TEXT NOT NULL UNIQUE REFERENCES agent_requests(id),
        message_sha256 TEXT NOT NULL CHECK (length(message_sha256) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (binding_id, occurrence_key)
      );
      CREATE INDEX scheduled_channel_delivery_occurrences_created
        ON scheduled_channel_delivery_occurrences (binding_id, created_at DESC);

      CREATE TRIGGER scheduled_channel_delivery_bindings_immutable
      BEFORE UPDATE OF
        automation_id,
        origin_request_id,
        origin_codex_thread_id,
        origin_codex_turn_id,
        origin_correlation_marker,
        origin_source_id,
        slack_team_id,
        slack_channel_id
      ON scheduled_channel_delivery_bindings
      BEGIN
        SELECT RAISE(ABORT, 'scheduled channel delivery binding is immutable');
      END;

      CREATE TRIGGER scheduled_channel_delivery_occurrences_immutable
      BEFORE UPDATE ON scheduled_channel_delivery_occurrences
      BEGIN
        SELECT RAISE(ABORT, 'scheduled channel delivery occurrence is immutable');
      END;
    `,
  },
  {
    // Child task titles are cosmetic, but their reconciliation must survive a
    // daemon restart without ever resubmitting the child turn.
    version: 17,
    name: "child-task-title-reconciliation",
    sql: `
      ALTER TABLE agent_request_orchestrations ADD COLUMN child_title_synced_at TEXT;
      CREATE INDEX agent_request_orchestrations_child_title_sync
        ON agent_request_orchestrations (child_title_synced_at, updated_at)
        WHERE child_thread_id IS NOT NULL;
    `,
  },
  {
    // A final source reply may report either successful Codex completion or a
    // terminal failure that happened before dispatch. Existing rows represent
    // successful completions and retain that behavior through the default.
    version: 18,
    name: "source-reply-request-outcome",
    sql: `
      ALTER TABLE source_reply_outbox ADD COLUMN request_outcome TEXT NOT NULL
        DEFAULT 'completed' CHECK (request_outcome IN ('completed', 'failed'));
    `,
  },
  {
    // A direct Claude proxy is bound to one authenticated provider conversation,
    // while every provider message remains an ordinary durable agent_request.
    // Session/turn state is separate from Codex completion state so follow-up
    // messages can bypass Codex without weakening request dedup or source replies.
    version: 19,
    name: "claude-proxy-sessions-and-turns",
    sql: `
      CREATE TABLE claude_proxy_sessions (
        id TEXT PRIMARY KEY CHECK (
          length(id) = 36 AND
          substr(id, 9, 1) = '-' AND
          substr(id, 14, 1) = '-' AND
          substr(id, 19, 1) = '-' AND
          substr(id, 24, 1) = '-'
        ),
        source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
        provider TEXT NOT NULL CHECK (
          length(trim(provider)) > 0 AND provider = lower(provider)
        ),
        conversation_key TEXT NOT NULL CHECK (
          length(trim(conversation_key)) > 0 AND conversation_key = trim(conversation_key)
        ),
        principal_provider TEXT NOT NULL CHECK (
          length(trim(principal_provider)) > 0 AND principal_provider = lower(principal_provider)
        ),
        principal_tenant_id TEXT NOT NULL CHECK (length(trim(principal_tenant_id)) > 0),
        principal_subject_id TEXT NOT NULL CHECK (length(trim(principal_subject_id)) > 0),
        person_id TEXT NOT NULL REFERENCES people(id),
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        cwd TEXT NOT NULL CHECK (length(trim(cwd)) > 0),
        claude_session_id TEXT NOT NULL UNIQUE CHECK (
          length(claude_session_id) = 36 AND
          substr(claude_session_id, 9, 1) = '-' AND
          substr(claude_session_id, 14, 1) = '-' AND
          substr(claude_session_id, 19, 1) = '-' AND
          substr(claude_session_id, 24, 1) = '-'
        ),
        status TEXT NOT NULL CHECK (
          status IN ('ready', 'busy', 'held', 'paused', 'closed', 'failed')
        ),
        close_after_ordinal INTEGER CHECK (close_after_ordinal IS NULL OR close_after_ordinal > 0),
        error TEXT,
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status IN ('ready', 'busy') AND error IS NULL AND closed_at IS NULL)
          OR
          (status IN ('held', 'paused') AND length(trim(error)) > 0 AND closed_at IS NULL)
          OR
          (status = 'closed' AND error IS NULL AND closed_at IS NOT NULL)
          OR
          (status = 'failed' AND length(trim(error)) > 0 AND closed_at IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX claude_proxy_sessions_active_conversation
        ON claude_proxy_sessions (source_id, provider, conversation_key)
        WHERE status IN ('ready', 'busy', 'held');
      CREATE INDEX claude_proxy_sessions_status
        ON claude_proxy_sessions (status, updated_at);

      CREATE TABLE claude_proxy_turns (
        agent_request_id TEXT PRIMARY KEY REFERENCES agent_requests(id),
        session_id TEXT NOT NULL REFERENCES claude_proxy_sessions(id),
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        stage TEXT NOT NULL CHECK (
          stage IN ('queued', 'dispatching', 'submitted', 'completed', 'held', 'failed')
        ),
        correlation_marker TEXT NOT NULL UNIQUE CHECK (length(trim(correlation_marker)) > 0),
        final_response TEXT,
        error TEXT,
        submitted_at TEXT,
        terminal_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, ordinal),
        CHECK (
          (stage IN ('queued', 'dispatching')
            AND final_response IS NULL AND error IS NULL
            AND submitted_at IS NULL AND terminal_at IS NULL)
          OR
          (stage = 'submitted'
            AND final_response IS NULL AND error IS NULL
            AND submitted_at IS NOT NULL AND terminal_at IS NULL)
          OR
          (stage = 'completed'
            AND length(trim(final_response)) > 0 AND error IS NULL
            AND submitted_at IS NOT NULL AND terminal_at IS NOT NULL)
          OR
          (stage = 'held'
            AND final_response IS NULL AND length(trim(error)) > 0
            AND terminal_at IS NULL)
          OR
          (stage = 'failed'
            AND final_response IS NULL AND length(trim(error)) > 0
            AND terminal_at IS NOT NULL)
        )
      );

      CREATE INDEX claude_proxy_turns_session_stage
        ON claude_proxy_turns (session_id, stage, ordinal);

      CREATE TRIGGER claude_proxy_sessions_binding_immutable
      BEFORE UPDATE OF
        source_id, provider, conversation_key,
        principal_provider, principal_tenant_id, principal_subject_id,
        person_id, work_item_id, cwd, claude_session_id
      ON claude_proxy_sessions
      BEGIN
        SELECT RAISE(ABORT, 'Claude proxy session binding is immutable');
      END;

      CREATE TRIGGER claude_proxy_turns_binding_immutable
      BEFORE UPDATE OF agent_request_id, session_id, ordinal, correlation_marker, created_at
      ON claude_proxy_turns
      BEGIN
        SELECT RAISE(ABORT, 'Claude proxy turn binding is immutable');
      END;

      CREATE TRIGGER claude_proxy_turn_request_binding_insert
      BEFORE INSERT ON claude_proxy_turns
      WHEN NOT EXISTS (
        SELECT 1
          FROM claude_proxy_sessions session
          JOIN agent_requests request ON request.id = NEW.agent_request_id
         WHERE session.id = NEW.session_id
           AND request.source_id = session.source_id
           AND request.person_id = session.person_id
           AND request.work_item_id = session.work_item_id
           AND json_extract(request.event_json, '$.principal.provider') = session.principal_provider
           AND json_extract(request.event_json, '$.principal.tenantId') = session.principal_tenant_id
           AND json_extract(request.event_json, '$.principal.subjectId') = session.principal_subject_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Claude proxy turn request does not match its session binding');
      END;

      CREATE TRIGGER claude_proxy_session_close_barrier_monotonic
      BEFORE UPDATE OF close_after_ordinal ON claude_proxy_sessions
      WHEN OLD.close_after_ordinal IS NOT NULL
        OR NEW.close_after_ordinal IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'Claude proxy close barrier is immutable once requested');
      END;

      CREATE TRIGGER claude_proxy_turn_request_binding_update
      BEFORE UPDATE OF source_id, person_id, work_item_id, request_text, event_json ON agent_requests
      WHEN EXISTS (
        SELECT 1
          FROM claude_proxy_turns turn
          JOIN claude_proxy_sessions session ON session.id = turn.session_id
         WHERE turn.agent_request_id = OLD.id
           AND (
             NEW.source_id <> session.source_id OR
             NEW.person_id <> session.person_id OR
             NEW.work_item_id <> session.work_item_id OR
             NEW.request_text <> OLD.request_text OR
             NEW.event_json <> OLD.event_json
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Claude proxy request binding is immutable');
      END;
    `,
  },
  {
    // Freeze the transport selected by the authenticated initial directive.
    // Existing proxy sessions predate transport selection and remain on the
    // original non-interactive print adapter.
    version: 20,
    name: "claude-proxy-adapter-mode",
    sql: `
      ALTER TABLE claude_proxy_sessions ADD COLUMN adapter_mode TEXT NOT NULL
        DEFAULT 'print' CHECK (adapter_mode IN ('print', 'rc-tmux'));

      CREATE TRIGGER claude_proxy_session_adapter_mode_immutable
      BEFORE UPDATE OF adapter_mode ON claude_proxy_sessions
      BEGIN
        SELECT RAISE(ABORT, 'Claude proxy adapter mode is immutable');
      END;
    `,
  },
  {
    // Versions before exact Slack thread-root binding reused one session for
    // an entire one-to-one DM. Retire only idle legacy sessions. In-flight or
    // held sessions remain intact so their evidence can drain or be released
    // explicitly without discarding any provider outcome.
    version: 21,
    name: "retire-legacy-dm-wide-claude-proxies",
    sql: `
      UPDATE claude_proxy_sessions
         SET status = 'paused',
             error = 'Legacy DM-wide Claude proxy retired; new messages use exact Slack thread roots.',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE provider = 'slack'
         AND conversation_key LIKE 'slack-dm:%'
         AND status = 'ready'
         AND NOT EXISTS (
           SELECT 1
             FROM claude_proxy_turns turn
            WHERE turn.session_id = claude_proxy_sessions.id
              AND turn.stage IN ('queued', 'dispatching', 'submitted', 'held')
         );
    `,
  },
  {
    // Review tools can emit one webhook per inline comment. Keep one durable
    // pending request per Chip-authored PR while preserving every provider
    // delivery id for replay protection.
    version: 22,
    name: "agent-request-feedback-coalescing",
    sql: `
      ALTER TABLE agent_requests ADD COLUMN coalesce_key TEXT
        CHECK (coalesce_key IS NULL OR length(trim(coalesce_key)) > 0);
      CREATE INDEX agent_requests_pending_coalesce
        ON agent_requests (coalesce_key, status, created_at);
    `,
  },
];

/** targetVersion is for tests that need to exercise upgrade paths from older schemas. */
export function migrate(db: Database, targetVersion = Number.POSITIVE_INFINITY): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > targetVersion) break;
    if (applied.has(migration.version)) continue;
    if (migration.disableForeignKeys) db.pragma("foreign_keys = OFF");
    try {
      const run = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, new Date().toISOString());
      });
      run();
    } finally {
      if (migration.disableForeignKeys) db.pragma("foreign_keys = ON");
    }
    if (migration.disableForeignKeys) {
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`migration ${migration.version} left foreign key violations`);
      }
    }
  }
}
