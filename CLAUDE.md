# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WakeWire is a local-only daemon that pushes external events — GitHub webhooks, Gmail over IMAP IDLE, Slack Socket Mode, and generic signed webhooks (Linear, Sentry, ClickUp, CI) — into Codex threads as new turns. There is no cloud component and no web UI: you configure it conversationally from inside Codex through a bundled plugin that talks to an MCP server (`wakewire mcp`), which calls the daemon's loopback HTTP API.

**This checkout is Snap's fork.** On top of upstream's route-based delivery it adds a second, higher-authority ingress path — the *Chip dispatcher* (`src/agent/`, `src/people/`) — that turns authenticated Slack DMs/mentions, `@chip` email, Linear delegations, and GitHub review requests into correlated Codex Desktop tasks and replies back on the originating provider. Read `docs/chip-dispatcher.md` and `SECURITY.md` before changing anything under `src/agent/`, `src/people/`, or `src/sinks/codex-desktop*.ts`.

## Commands

```bash
npm install
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run
npm test -- src/core/queue.test.ts      # a single file
npx vitest run -t "coalesces"           # a single test by name
npm run test:watch
npm run test:coverage                   # thresholds are enforced (see below)
npm run lint                            # biome ci .
npm run lint:fix                        # biome check --write .
npm run build                           # tsc -p tsconfig.build.json → dist/
npm run dev -- status                   # run the CLI from source via tsx
```

CI (`.github/workflows/ci.yml`) runs typecheck → `biome ci .` → `vitest run --coverage` → build on Node 20 and 22, Ubuntu and macOS. Coverage is scoped to `src/core/**`, `src/db/**`, and four source helpers (`github/verify.ts`, `github/trim.ts`, `gmail/extract.ts`, `slack/normalize.ts`) at 80% lines/functions/statements and 75% branches — changes there need tests or CI fails, and coverage on the rest of the tree is deliberately unmeasured.

The macOS Codex Desktop helper is a separate SwiftPM package with its own toolchain (Swift 6.2, macOS 13+):

```bash
swift run   --package-path desktop-bridge wakewire-codex-desktop-helper-tests   # test harness, not XCTest
swift build --package-path desktop-bridge -c release
```

No end-to-end Codex tests run in CI — the sink is mocked. The real path is covered by the manual smoke test in `CONTRIBUTING.md` (M1 injection → M2 webhook → M3 plugin → M4 gmail → resilience), which uses `WAKEWIRE_HOME=$(mktemp -d)` to isolate state. Run it before a release.

## Architecture

### The delivery pipeline (ordinary routes)

```
Source.start() → WakeEvent → daemon emit callback → AgentCoordinator.accept()
                                                  ↓ (not addressed to Chip)
                                    matchRoutes() → DeliveryQueue.enqueueEvent()
                                                  → buildPrompt() → AgentAdapter
```

`src/daemon/daemon.ts` wires everything and is the best single file to read first. The emit callback there is the fork's fork-in-the-road: `AgentCoordinator.accept()` gets every event first, and if the event is *addressed to Chip* it is consumed by the dispatcher and never reaches route matching.

- **`src/sources/<kind>/source.ts`** — one per ingress kind. Sources own **payload trimming**: they turn raw provider payloads into a normalized `WakeEvent` (`src/core/event.ts`) with capped fields (commit messages 500 chars, email bodies 4,000, HTML→text). Nothing downstream may ever see a raw provider payload. `SourceContext.emit` is contractually **synchronous** through route matching and the SQLite enqueue — the Slack source acks its Socket Mode envelope only after `emit` returns, treating "returned" as "durably queued". Don't make it async.
- **`src/core/route.ts` / `router.ts`** — a route is match + target + prompt template + sandbox. Matching is pure and table-driven.
- **`src/core/envelope.ts`** — builds the two-part turn: trusted route instructions, then the payload inside an `<event>` fence. `fenceSafeJson`/`fenceSafeText` escape `</` → `<\/` so a payload can never emit a literal `</event>` and break out. This is the prompt-injection boundary; changes here need a matching test in `envelope.test.ts`.
- **`src/core/queue.ts`** — persistent per-thread FIFO. Crash-only: all state is SQLite, `delivering` rows are reset to `queued` on boot, and the in-memory `inFlight` set only guards against concurrency inside one process. Dedup is by the source's native delivery id. Over the per-route rate limit (default 10/min) waiting deliveries are **coalesced into one digest turn** rather than dropped. `BusyError`/`UnreachableError` retry forever with capped backoff; `PermanentError` fails immediately.
- **`src/sinks/`** — the `AgentAdapter` seam (`types.ts`). **Nothing outside `src/sinks/` may know how turns reach Codex.** Four implementations selected by the `sink.adapter` setting via `factory.ts`: `codex-desktop` (this fork's default, macOS Accessibility helper + private Desktop IPC, version-gated and fail-closed), `codex-app-server` (JSON-RPC v2; supports shared-ws mode so a `codex --remote` TUI streams injected turns live), `codex-sdk` (vendored binary, the stability fallback), `codex-exec` (last resort). Only the Desktop adapter returns a `correlationMarker`, which is what binds a submitted turn to a completion.
- **`src/daemon/api.ts`** — loopback-only Hono API on `127.0.0.1`, bearer-token auth. `/api/*` is the management plane consumed by the CLI and MCP server through `src/client.ts`; `/ingress/*` receives webhooks. `src/mcp/server.ts` is a thin stdio MCP wrapper over the same API.

### The Chip dispatcher (`src/agent/`)

A separate, higher-authority path with its own store, workers, and reply channels. Key pieces:

- **`coordinator.ts`** — `AgentCoordinator.accept()` is a *synchronous* ingress gate doing only local checks and durable SQLite writes before the provider transport is acked. `AgentDispatchWorker` then correlates, provisions a workspace, safety-screens, and submits.
- **Authorization is never a mention.** Slack/GitHub/Linear senders must match an enrolled immutable `(provider, tenantId, externalId)` tuple in `src/people/`. Gmail is the documented exception (aligned DMARC + enrolled alias + exact unquoted `@chip`) and carries a mail-infrastructure trust caveat. Unknown, disabled, ambiguous, and policy-denied senders are ignored **silently** — no provider response — so the daemon can't be used as an account-discovery oracle.
- **`policy.ts`** — structured role capability matrix. Because the Codex Desktop turn API cannot enforce per-tool capabilities, `isEnforceableDesktopOwner` dispatches **only** a person whose role equals the seeded `owner` policy byte-for-byte; anything else fails closed with `desktop-policy-not-enforceable`. Checked at ingress *and* again immediately before Desktop submission.
- **`safety.ts`** — the local-model screening seam currently ships `PlaceholderLocalSafetyScreener`, which reports `enforcing: false` and allows dispatch. A configured local model must never silently fall back to it.
- **`correlation.ts` / `references.ts` / `store.ts`** — many provider conversations collapse onto one `WorkItem` via aliases (Linear issue, GitHub repo+number, Slack thread root, Gmail RFC thread, normalized email subject). Conflicting aliases raise `WorkItemConflictError` rather than guessing.
- **`snap-workspace.ts`** — the Snap boundary. Workspaces are created *only* by shelling out to `make -C /Users/chip/Snap dev <branch>` with `shell: false`, then validating that the realpath matches exactly and `.snap/workspace.env`'s `BRANCH_NAME` equals the branch. Branch names are never repaired or slugified. Related skills: `snap-workspace-lifecycle`, `snap-branch-operations`.
- **Outbound** — `ack-dispatcher.ts` (delayed 10s progress reactions), `reply-dispatcher.ts` + `responders/` (final replies to the exact source thread), `completion-worker.ts`, `title-sync-worker.ts`. Cosmetic work (titles) is deliberately outside turn delivery: a failed title update must never cause a prompt to be resubmitted.

### State

Everything lives under `WAKEWIRE_HOME` (default `~/.wakewire`, mode 0700, ownership- and symlink-checked by `ensurePrivateWakewireHome`): `state.db` (SQLite, forward-only numbered migrations in `src/db/migrations.ts`), `daemon.json` (pid/port/token, mode 0600), `logs/`, `secrets.json` (fallback when no OS keychain), `worktrees/`. Secrets prefer the OS keychain via `@napi-rs/keyring` (`src/secrets/store.ts`).

Tests open in-memory databases with `openDatabase(":memory:")`, which runs migrations and skips all the path-safety checks — that's the standard fixture pattern across `src/**/*.test.ts`.

## Conventions

- Strict TypeScript, ESM with `.js` import specifiers (NodeNext). `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on, which is why you'll see `...(x ? { x } : {})` spreads instead of `x: x ?? undefined`.
- Biome-formatted: 2-space indent, 100-column lines, double quotes, semicolons. `biome ci .` is CI-blocking.
- Zod schemas define the wire contracts (`core/event.ts`, `people/schema.ts`, `agent/policy.ts`); parse at the boundary, trust the type after.
- Comments in this codebase explain *why a rule exists* (usually a security or crash-recovery invariant), not what the line does. Match that density — the existing comments are load-bearing documentation of decisions recorded in `DECISIONS.md`.
- New migrations append to the `MIGRATIONS` array in `src/db/migrations.ts`; never edit an applied one.
- The app-server protocol surface is marked experimental by OpenAI and drifts. When a codex release breaks it, re-run `codex app-server generate-ts` and diff against `src/sinks/`.

## Reference docs

`README.md` (overview, adapter tradeoffs) · `docs/setup.md` (per-source setup with exact commands) · `docs/chip-dispatcher.md` (bridge install, enrollment, provider scopes, correlation precedence) · `SECURITY.md` (prompt injection, ingress verification, dispatcher authorization, blast-radius defaults) · `DECISIONS.md` (verified Codex protocol facts, deviations from the plan, deferred work) · `CONTRIBUTING.md` (smoke test, release checklist).
