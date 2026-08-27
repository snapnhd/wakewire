# Hermes sink (Path D)

WakeWire is the GitHub + Linear front door for Chip. Hermes is the agent brain.

```text
GitHub / Linear event
  → WakeWire Chip dispatcher (authZ, correlation, ack)
  → HermesAgentAdapter (stamped session + desktop presentation)
  → finalResponse
  → WakeWire source reply outbox
```

Slack stays on the **native Hermes gateway** (not this sink).

## Enable

```bash
cd /Users/chip/Snap/wakewire
# optional absolute runner path (defaults next to package scripts/)
wakewire config set sink.adapter hermes
# wakewire config set sink.hermesRunnerPath /Users/chip/Snap/wakewire/scripts/hermes_sink_runner.py
# wakewire config set sink.hermesTimeoutSeconds 1500
```

Restart the WakeWire daemon after changing the adapter.

**Warning:** `sink.adapter` is process-global. Setting `hermes` routes **all** Chip dispatcher Codex-path deliveries through Hermes (ordinary non-Chip routes also use this adapter). Claude RC remains a separate dispatcher agent path.

## gateway-role-policy

`$HERMES_HOME/plugins/gateway-role-policy/roles.yaml` (or `$HERMES_HOME/role-policy.yaml`):

```yaml
platforms:
  - slack
  - github
  - linear

users:
  slack:
    UMENQMYBD: admin
  github:
    chipbyte-snap: admin
    # teammate-login: pr_assistant
  linear:
    cj@snapcorp.com: admin
    chip@snapcorp.com: admin
```

Unknown GH/Linear users → `default_role: guest`.

## Files

| Path | Role |
|---|---|
| `src/sinks/hermes.ts` | `AgentAdapter` (+ `setThreadTitle` / `readThreadTitle`) |
| `scripts/hermes_sink_runner.py` | Subprocess protocol |
| `src/agent/hermes-identity.ts` | Principal → stamp + desktop title/key |
| `src/agent/coordinator.ts` | Attaches `hermesSession` when adapter is hermes |

## Protocol (stdin JSON)

Actions: `start` | `resume` | `probe` | `set_title` | `read_title`.

### start / resume body (selected fields)

| Field | Purpose |
|---|---|
| `platform` | `github` \| `linear` — also becomes Hermes session `source` |
| `userId` | github login or linear email (roles.yaml nested id) |
| `userName` | optional display |
| `chatId` | stable WorkItem target, e.g. `wakewire:github:snapnhd/system#997` |
| `sessionKey` | same stable key (session row `session_key`) |
| `sessionTitle` | desktop title, e.g. `snapnhd/system#997 · short` or `FRA-2818 · short` |
| `displayName` | sidebar subtitle (login/email) |
| `sessionId` | resume binding (WorkItem `codexThreadId`) |
| `prompt` | turn text |

On success the runner also writes gateway peer metadata + title onto `~/.hermes/state.db` so Hermes desktop can list the session.

## Desktop session visibility

Path D does **not** use native Hermes GitHub/Linear gateways. Sessions are still real Hermes DB rows:

| Field | Value |
|---|---|
| `source` | `github` or `linear` (desktop messaging sections) |
| `title` | human WorkItem title (repo#n / FRA-id) |
| `session_key` / `chat_id` | stable per open PR/issue |
| `user_id` / `display_name` | login or email |

**Operators** open these in Hermes desktop to inspect/resume context. **End users** keep talking on GitHub/Linear; desktop open does **not** post back to the PR/issue (outbox remains WakeWire’s job). Phase C (desktop composer → PR) is out of scope until explicitly approved.

Hermes desktop lists `github` / `linear` as messaging platforms (same pattern as Slack). If those source ids are missing from desktop’s messaging allow-list, sessions still appear under Recents once titled.

### Ping policy

- Deterministic `pong` without LLM (no Path D preamble).
- No sidebar session stub on ping-only turns.
- First **non-ping** turn creates/resumes the Hermes session and sets title/metadata.

## Session lifecycle (Chip-approved)

PRs can stay open for weeks; people may return to the same conversation.

| Rule | Policy |
|---|---|
| Binding | One Hermes `session_id` per WakeWire WorkItem (PR/issue) while open |
| Duplicate review | `review_requested` while a matching Hermes session is **running** → ignore (no second agent, no extra PR comment). Idle match → resume that session. Never mint a second session for the same repo#N / FRA-id. After a host crash, resume the **oldest** open matching session (a newer empty duplicate is not the review). |
| Crash / reboot | `dispatching` rows reset to `acknowledged` on daemon start and are retried. GitHub reviews **must not** wait on Linear credentials — ticket attach is best-effort. Stamp `session_key` before the Hermes turn so lookup can resume mid-review sessions. |
| Between pings | Session stays in Hermes DB — idle is fine (not a live process) |
| Resume | Always resume the same session when the binding exists **or** a matching GitHub/Linear/CLI session is found |
| Resume miss | Runner looks up `session_key` then starts a fresh session and rebinds (no silent orphan) |
| Context | Bound size via Hermes compression / optional long-idle preamble — **not** by closing after 1h |
| Long gap (e.g. 7+ days) | Still resume; optionally inject “returning after N days; re-check current PR state” |
| Reset | Explicit user reset (`/new` / “start fresh”) → new session |
| Close | Unbind + prune/archive when PR/issue is closed/merged |

Do **not** use a 1-hour “start fresh” default — that breaks multi-week PR dialogue.

## Ops notes

- Live smoke: enrolled `@chipbyte-snap` / Linear `@Chip` after daemon uses `hermes` adapter.
- Do **not** also enable Hermes webhook Chip mention routes (double reply).
- Final user-visible reply is WakeWire outbox text from `finalResponse` (prefer Hermes not double-commenting).
- Daemon: `sink.adapter=hermes` (set + restart WakeWire to apply).
- Verify sessions:  
  `sqlite3 ~/.hermes/state.db "SELECT id,source,title,chat_id,session_key,display_name FROM sessions WHERE source IN ('github','linear') ORDER BY last_activity_at DESC LIMIT 10;"`
