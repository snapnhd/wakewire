# Chip dispatcher

The Snap fork of WakeWire can turn an authenticated mention of Chip in Slack,
GitHub, Gmail, or Linear—or a one-to-one Slack PM, exact Chip mention in a
group PM, or enrolled-engineer feedback on a PR authored by `chipbyte-snap`—into
a Codex Desktop task, or for authenticated Slack, a configured Claude RC proxy.
Gmail requires the current unquoted message body to contain an exact
`@chip`/`@Chip Byte`; delivery to Chip alone is not an invocation. It
correlates related provider conversations to one task and uses a Snap issue
workspace only when it can resolve one exact Linear issue. Visible progress
acknowledgments are delayed for ten seconds and suppressed when the exact bound
request completes sooner.

This path is separate from ordinary WakeWire routes. A message addressed to
Chip is handled by the authorization gate; messages that do not address Chip
continue through the existing route matcher.

## Current identities

The default identity configuration is deliberately explicit:

| Provider | Address Chip as | Acknowledgment after ten seconds |
| --- | --- | --- |
| Slack | mention the existing normal `@chip` / `@Chip Byte` account (including in a group PM), or send a one-to-one PM | `:eyes:` reaction from Chip |
| GitHub | `@chipbyte-snap` or shorthand `@chip` in newly authored issue/PR/comment text; request a review from `chipbyte-snap`; on a PR authored by `chipbyte-snap`, leave a top-level comment, inline review comment, or non-empty review body; or, on a PR Chip already joined, reply in an existing review thread without a mention | eyes reaction on the first exact issue/comment/review comment or PR; maintained-PR feedback and unmentioned review-thread replies are durably debounced for 30 seconds and processed as one full ledger |
| Gmail | send or copy `chip@snapcorp.com` and include exact `@chip` / `@Chip Byte` in the current unquoted body | no progress acknowledgment; final answer replies in the same Gmail thread |
| Linear | type `@chip` and select `@Chip Byte`, or delegate the issue to the Chip agent | ephemeral `👀 I'm on it, <nickname>.` agent activity |

Slack, GitHub, and Linear acknowledgment targets are persisted with the
authorized request but cannot be delivered until ten seconds later. A fast
completion or permanent failure suppresses an unsent acknowledgment. Duplicate
events retain the original deadline and cannot create another reaction.

A target mention only proves that the message was meant for Chip. It does not
authorize the sender.

## Claude proxy mode

Claude routing exists only inside the authenticated Slack Chip dispatcher. It
does not apply to GitHub, Gmail, Linear, ordinary Slack routes, unaddressed
channel messages, or unknown/disabled senders. A one-to-one DM or Slack's exact
resolved Chip mention still has to pass the same immutable-principal and owner
policy checks before either model can run.

`dispatcher.defaultAgent` controls new Slack dispatcher conversations that do
not contain an explicit agent directive:

- `codex` is the backward-compatible default. Generic authenticated Chip DMs
  and addressed messages use the ordinary Codex task path.
- `claude-rc` starts a new persistent Claude Remote Control plus tmux proxy for
  a generic authenticated Chip DM or addressed message.

Configure the default from the local CLI:

```bash
wakewire config set dispatcher.defaultAgent claude-rc
```

The running daemon reads this setting live, so no restart is required. Set the
value back to `codex` to restore the original default.

CJ can also change it directly from Slack with an exact leading Chip mention:

- `<@Chip> set default to Claude RC`
- `<@Chip> make Claude the default`
- `<@Chip> set default to Codex`
- `<@Chip> use GPT by default`

Slack renders `<@Chip>` as the normal `@Chip` mention. This host-owned control
requires the immutable Slack sender to resolve to the unique enrolled CJ person
with WakeWire's exact enabled owner policy. A typed display name, another
enrolled owner, an unmentioned DM, quoted/example text, or a modified replay
cannot change the setting. WakeWire persists the setting and a fixed threaded
confirmation atomically, then sends that confirmation through the durable
source-reply outbox without invoking Claude or Codex.

A configuration change affects only future new conversations; it cannot mutate
an existing Claude session. The Slack control is intercepted before active
proxy follow-ups, so it can change the future default while leaving that active
session untouched.

When Claude RC is the configured default, an anchored Codex/GPT form is a
one-message override back through the ordinary Codex dispatcher:

- `run on Codex: <prompt>`, `run this in Codex: <prompt>`, or the same forms
  with `GPT`
- `use Codex to <prompt>` or `ask GPT to <prompt>`
- `send this to Codex: <prompt>` or `send this to GPT: <prompt>`
- `Codex: <prompt>` or `GPT: <prompt>`

The override prefix is routing metadata only: Codex receives the complete
authenticated request text under its normal safety wrapper. An override can
bypass an active Claude session for that one message, but it does not close,
pause, replace, or change that session's adapter. The next non-override
follow-up still belongs to Claude. Use the exact standalone `back to Chip`
control (or another documented Claude exit control below) before changing the
conversation itself back to normal Chip routing.

For a new Claude conversation, explicit Claude directives continue to win over
the configured default. These narrow, case-insensitive forms select structured
print mode:

- `run on Claude: <prompt>` or `run this on Claude: <prompt>`
- `run in Claude: <prompt>` or `run this in Claude: <prompt>`
- `use Claude to <prompt>` or `ask Claude to <prompt>`
- `send this to Claude: <prompt>`
- `Claude: <prompt>`

Use an explicit `Claude RC` form to start the persistent Remote Control plus
tmux transport instead:

- `run on Claude RC: <prompt>` or `run this on Claude RC: <prompt>`
- `run in Claude RC: <prompt>` or `run this in Claude RC: <prompt>`
- `use Claude RC to <prompt>` or `ask Claude RC to <prompt>`
- `send this to Claude RC: <prompt>`
- `Claude RC: <prompt>`

`Claude tmux` and `Claude RC tmux` are accepted aliases in the same phrase
positions.

The selected adapter is frozen on the proxy session. Plain explicit `Claude`
forms remain on print mode even when `claude-rc` is the configured default;
explicit RC/tmux forms remain on RC mode. Every ordinary Slack follow-up retains
the initial selection. To switch an existing DM or thread, first send `back to
Chip` and wait for the close reply, then send a new print or RC trigger. Merely
changing `dispatcher.defaultAgent`, or sending a one-message Codex/GPT override,
does not switch it.

An optional leading Chip mention, greeting, or `please` is accepted by explicit
Claude and Codex/GPT forms. Quoted examples, negations, questions about the
feature, incidental mid-sentence phrases, and empty prompts do not activate an
override. The initial message still needs the ordinary exact Chip target: a
one-to-one PM or Slack's resolved Chip mention.

WakeWire binds every Slack proxy, including a one-to-one PM, to the exact source,
workspace, Slack thread root, and authenticated tenant/subject pair—not merely
the DM channel or the enrolled person that identity resolves to. Each new
top-level DM message therefore starts an independent conversation and Claude
session; only replies carrying that parent's exact `thread_ts` resume it. Every
later newly-authored human message from that same immutable provider principal
and binding is persisted as a FIFO Claude turn before WakeWire acknowledges the
provider event. Except for an anchored one-message Codex/GPT override, active
proxy follow-ups are claimed before the normal dispatcher and are never
presented to Chip/Codex.

Each turn repeats the same shared `no-destructive-v1` rules, authenticated
principal and role policy, untrusted-provider fencing, and durable-outbox-only
response boundary used by Desktop turns. WakeWire rechecks enrollment and the
exact seeded owner policy immediately before Claude submission. Print mode
invokes Claude with the prompt on stdin, starts with an exact UUID session, and
uses `--resume` for follow-ups. RC mode starts or resumes that exact UUID in a
named session on the ordinary tmux server and enables Claude Remote Control.
WakeWire injects only into the exact validated pane and uses Claude lifecycle
events, not rendered pane text, to bind the final response.

Both transports inherit the full ambient Claude environment: configured MCP
servers, built-in tools including Bash, plugins, skills, hooks, agents, project
instructions, and integrations. WakeWire does not enable safe mode, strict MCP
configuration, or a tool allowlist. Explicit deny rules in Claude's managed,
user, or project settings still take precedence. This intentionally mirrors the
full-capability owner Desktop boundary. The repeated WakeWire no-destructive
policy remains the decision boundary rather than a host tool allowlist.
The captured final result is atomically attached to the request and queued to
the exact thread rooted at the triggering message (or the existing thread root),
including in a one-to-one DM. Every accepted proxy turn uses the same delayed
progress acknowledgment as ordinary Chip work: if its final reply has not been
delivered within ten seconds, WakeWire adds `:eyes:` to the exact triggering
message. Replies are FIFO-fenced per exact provider destination so a transient
failure cannot let a later turn overtake an earlier one.

Use `back to Chip`, `/claude end`, `/claude stop`, or `stop Claude proxy` as an
exact standalone follow-up to close a healthy session without calling either
model. The close barrier is persisted with that message, so anything arriving
after it cannot race into the old proxy. New messages then use the normal Chip
path. If WakeWire cannot prove whether an in-flight Claude CLI process accepted
a turn, it holds that turn and never automatically replays it. The same exact
exit phrase releases conversation routing back to Chip while preserving the
ambiguous turn and its correlation marker for later inspection; a new explicit
Claude trigger—or a generic addressed Slack message when `claude-rc` is the
configured default—starts a fresh session. Any follow-ups already accepted
behind the ambiguous turn are never rerouted to GPT or silently stranded:
WakeWire marks them failed without model submission and queues a fixed notice
to their original Slack target.

Claude's persisted session ID is the conversation protocol in both modes. RC
sessions use names beginning with `wakewire-claude-` on the ordinary tmux
server, so `tmux ls` and a normal `tmux attach -t <name>` can observe them. They
also register with Claude Remote Control for discovery at `claude.ai/code` and
supported Claude mobile surfaces. Native Claude Desktop sidebar visibility is
not a guaranteed part of the RC contract and must be verified against the
installed Desktop release.

Typing directly into the tmux, web, mobile, or Desktop RC surface is not a
WakeWire-ingested Slack turn: it has no authenticated Slack binding, durable
reply target, or newly generated per-turn WakeWire safety wrapper. It still
inherits the private session-level invariant no-destructive policy appended
when WakeWire starts the RC session, but WakeWire does not proxy its response to
Slack. Unexpected manual input while a Slack proxy turn is active is rejected
or holds that turn for reconciliation rather than guessing which response
belongs to Slack. Use the originating Slack thread for proxied follow-ups.

WakeWire never treats rendered tmux pane text as a completion protocol. tmux is
an observable host for RC mode, while the durable session, turn marker, Claude
lifecycle events, and source-reply outbox remain the authorization and replay
boundaries. The launchd service PATH already includes `~/.homebrew/bin`;
override binaries explicitly when needed:

```bash
wakewire config set sink.claudePath /absolute/path/to/claude
wakewire config set sink.tmuxPath /absolute/path/to/tmux
wakewire stop
wakewire start --detach
```

## Model, effort, and separate-task directives

Every accepted request carries a frozen execution profile. WakeWire resolves it
only from the authenticated sender's current request text, persists it with the
request, and passes explicit settings on every resumed turn so an earlier
override cannot leak into later work. The default is `gpt-5.6-luna` with `low`
effort ("light" is an accepted alias for `low`).

Use an explicit directive such as `model: Terra`, `use GPT-5.6 Sol`,
`effort: high`, or `with xhigh effort`. Bare project words such as "Luna" and
ordinary phrases such as "high priority" do not alter execution. The allowed
models are the current local catalog: GPT-5.6 Luna, Terra, and Sol; GPT-5.5;
GPT-5.4 and GPT-5.4 Mini; and GPT-5.3 Codex Spark. WakeWire validates that the
requested effort is supported by that model. Conflicting, unknown, or
incompatible keyed directives produce a clarification-only task rather than an
arbitrary choice.

The case-insensitive standalone word `Ultracode` is the shortcut for the best
current profile: `gpt-5.6-sol` with `ultra` effort. Its mapping is
operator-controlled and wins over other model/effort text in the same request.

An explicit phrase such as `in a separate chat`, `create a new task`, or
`use another thread` enables a host-owned parent/child state machine. WakeWire
prepares one empty same-directory child with a deterministic app-server
`threadSource`, so a retry recovers that task instead of creating another. It
persists the parent and child IDs, stage, exact child turn marker, and completed
child result. The result is then appended exactly once as a parent report turn;
only that parent turn keeps the original provider completion/reply binding. The
child repeats the full safety and no-direct-provider-reply envelope. A Linear
stop supersedes the state machine and interrupts both persisted tasks. Negated
phrases such as `do not use a separate chat` do not trigger delegation.

Codex Desktop's new-task deep link cannot select model or effort before its
first turn. Therefore, when the first request for a new work item asks for a
non-default profile, WakeWire also uses the parent/child flow automatically;
existing tasks receive the requested profile directly through Desktop IPC.

Slack uses Chip's existing full user account, not a bot or a second identity.
Slack renders a selected mention as `<@CHIP_USER_ID>`; WakeWire accepts only
that immutable encoding, not raw lookalike text. A one-to-one PM arrives as a
user-scoped `message.im` with `channel_type: "im"`; it needs no mention. A
multi-party PM arrives as `message.mpim` with `channel_type: "mpim"` and triggers
only when it contains Slack's exact resolved Chip mention. In both cases the
sender is authorized by the same immutable app/workspace/user tuple. Linear still
uses the installed agent identity. GitHub has no alias facility: WakeWire
recognizes literal `@chip` in new sender-authored text, but that username belongs
to an unrelated GitHub account and GitHub may notify that person. Prefer
`@chipbyte-snap` or request a review from `chipbyte-snap` on GitHub.

Linear's authenticated `stop` signal is different from a normal prompt: its
outbox response is held until WakeWire confirms the Desktop task is stopped,
interrupting an active turn through private IPC when necessary. Linear then
receives `Stopped, <nickname>.`.

## Sender enrollment and authorization

People are enrolled once, using all email addresses that may identify them on
the configured services. WakeWire then resolves those email aliases to stable
provider identities and pins the tuple `(provider, tenant ID, external ID)`.
Mutable handles, display names, and email addresses are retained as metadata;
they are not the authorization key for Slack, GitHub, or Linear. Gmail is the
explicit exception described below: the aligned From address remains its
sender key because email exposes no immutable per-person account ID.

For example, enroll CJ with both known addresses:

```bash
wakewire people add \
  --nickname CJ \
  --email cj@snapcorp.com \
  --email cjlazell@gmail.com \
  --role owner
```

Run account resolution after the provider sources and outbound credentials
described below are configured:

```bash
wakewire people resolve CJ
wakewire people show CJ
wakewire policy explain --person CJ
```

GitHub often hides profile email. Bind an explicit login when automatic lookup
cannot produce one unique account:

```bash
wakewire people resolve CJ --github-login YOUR_GITHUB_LOGIN
```

If a provider has no email lookup, pin an ID obtained from that authenticated
provider or its administration console:

```bash
wakewire people identity-add CJ \
  --provider slack \
  --tenant YOUR_SLACK_TEAM_ID \
  --external-id YOUR_SLACK_USER_ID \
  --handle cj
```

Use the equivalent immutable organization/user IDs for Linear and the numeric
user ID with tenant `github.com` for GitHub. Never infer an ID from a display
name. GitHub's automatic email search binds only when it finds one unique
account; otherwise use the explicit login or immutable-ID command.

The initial database migration seeds only the `owner` role. It grants full
machine, Desktop, filesystem, shell, network, browser, connected-app, Git, and
deployment capabilities. Its policy text instructs Codex not to disclose
secrets or change authorization policy, and unconditionally denies destructive
work. WakeWire repeats a versioned, operator-controlled no-destructive-actions
block at the start of every new or resumed Desktop turn and JSON-encodes the
authenticated request beneath it. These remain model-level trusted instructions,
not an OS-enforced capability boundary: a Desktop task with full machine and
shell reach is technically capable of bypassing them. Treat CJ's `owner` role as
full machine authority, and do not give it to anyone who is not trusted at that
level.

The dispatch pipeline has an injectable local safety-screening seam before Snap
workspace provisioning and Desktop submission. Until a local model is configured,
the daemon reports `local-model-placeholder`, `enforcing: false`, and allows the
request through to the repeated Codex safety envelope. The placeholder is never a
silent fallback for a configured model. A later enforcing screener must return
`allow`, `deny`, or retryable `hold`; only `allow` reaches Desktop.

The Codex Desktop private turn API does not expose an enforceable per-tool
capability boundary. Consequently, **only the exact seeded `owner` role and
policy are dispatchable in this build**. Policy is checked both when a request
arrives and again immediately before Desktop submission. Changing the seeded
owner policy, assigning a custom role, or assigning a narrower role causes the
request to fail closed with `desktop-policy-not-enforceable`, before any
provider acknowledgment or Desktop work.

Additional roles can still be stored, assigned, and inspected with
`wakewire people show` and `wakewire policy explain`; they are configuration for
a future enforceable Desktop boundary, not active partial-access grants. Do not
enroll another person on the assumption that trusted instructions alone will
constrain browser, connected-app, shell, or filesystem access.

Slack connector calls have an additional execution-time boundary. WakeWire's
Codex configuration sets the Slack app to `default_tools_enabled = false` and
then enables an exact checked-in method allowlist. Approved reads, searches,
messages, reactions, reminders, conversation creation/join/invite, and the
file-upload flow remain available. Message delete, message edit, channel leave,
canvas update, profile update, and any future unclassified Slack method are not
exposed to the model. This native Codex app boundary applies globally because
Slack's OAuth scopes bundle upload with delete-capable credentials; it is
intentionally not limited to one WakeWire thread. The `PreToolUse` hook remains
installed as defense in depth for MCP paths that emit hooks, but it is not the
primary boundary for the bundled Slack app connector.

Disable a person immediately with:

```bash
wakewire people disable CJ
```

For email, To/Cc routing to `chip@snapcorp.com` and an exact `@chip` in the
newly authored, unquoted body are both required. WakeWire also trusts only the
topmost Authentication-Results header when
it begins with `mx.google.com`, reports `dmarc=pass`, and its `header.from`
domain exactly matches the visible From domain. An enrolled address and aligned
Gmail verdict are both required. This authenticates control of authorized mail
infrastructure for the From domain, **not the individual local-part**. Another
system allowed to send aligned mail as `cj@snapcorp.com` could impersonate CJ.
Because CJ's owner role is full-machine authority, enabling email dispatch is an
explicit trust in Google/Snap's mail-account and outbound-domain controls; use a
separate cryptographic signer or approval challenge before extending this model
to less-controlled domains. Addressed requests from unknown, disabled,
unauthenticated, or policy-denied principals receive no provider reply; the
daemon stays silent so it does not become an account-discovery oracle. Chip's
own outbound events are also ignored to prevent loops.

An addressed Gmail request must carry a real RFC 5322 `Message-ID`. WakeWire
still assigns an IMAP-derived synthetic delivery ID when the header is missing
so ingestion and deduplication remain durable, but it rejects that request
before dispatch. Synthetic IDs are never used as Gmail API reply targets.

The Gmail app available inside ChatGPT/Codex is useful for reading and searching
a mailbox, but it is not an identity oracle. Seeing the received message through
that app only proves that the message reached the connected mailbox; it does not
bind the visible From local-part to one person. The Desktop app connection is
also not a reusable daemon credential. OpenAI's API Gmail connector still
requires WakeWire to conduct OAuth and supply an access token, so putting a GPT
decision in this gate would add latency and prompt-injection risk without adding
cryptographic evidence.

The stronger mail-account proof is deterministic sender-mailbox attestation:
OAuth-connect each enrolled sender mailbox and require the exact RFC Message-ID
to exist under that same account's `SENT` label before granting owner access.
That would prove control of the enrolled Gmail account, subject to delegates or
account compromise, and should be implemented directly with Gmail's API rather
than by asking a model. It is not enabled in the current build; until then the
aligned-DMARC trust boundary above remains in force.

## Install the Codex Desktop bridge

The `codex-desktop` adapter is the default for this fork. Existing tasks receive
turns through a same-user, private Codex Desktop Unix socket. WakeWire verifies
the OpenAI signature, required follower-turn routes, live initialization, and
the realized rollout/model/effort; stop/interrupt remains exact-build pinned.
A new task is created by opening a marked `codex://threads/new` URL and asking a
small Swift Accessibility helper to activate Desktop, verify the exact marked
composer and its unique Send control, and submit it. The helper reads the focused
application directly through Accessibility rather than relying on AppKit's
potentially stale frontmost cache. Its append-only intent is retryable until an
exclusive sidecar is durably written immediately before mouseDown;
after that barrier, all recovery is read-only. It never types Return and refuses
locked sessions, modals, marker changes, and ambiguous controls.

New-task creation does not require the private IPC socket or an IPC build pin;
the deep link launches Desktop when necessary. Existing-task delivery creates a
fresh IPC connection for every operation and performs a bounded hidden relaunch
when the socket is missing or stale after an app restart.

An empty task created by a separate `codex app-server` process is transient and
is not owned by Desktop's renderer, so it cannot be background-loaded and used
as a follower-IPC substitute for this first submission. WakeWire therefore does
not claim that Desktop new-task creation works while the Mac is locked. Requests
remain durably queued until the interactive session is available; the CLI/SDK
and app-server adapters are the background-capable alternatives.

As soon as the exact correlation marker appears in Desktop's early persisted
preview, WakeWire gives the task an explicit, sanitized title through Codex's
`thread/name/set` protocol. Titles identify the service and summarize the
question: `Slack — …`, `Email — …`, `GitHub PR … — …`, or
`Linear ENG-123 — …`. Leading Chip mentions and routine request wording are
removed, mail reply/forward prefixes are collapsed, and titles are capped at 60
characters. This metadata lane is cosmetic and independent from turn delivery:
it retries failures without resending the request, confirms the persisted title
with a read-only check, and reasserts it after the first turn finishes so
Desktop's automatic safety-wrapper title cannot win a late race. Startup also
upgrades and reconciles legacy WakeWire-owned task titles.

Build and install the helper from this checkout:

```bash
swift run --package-path desktop-bridge wakewire-codex-desktop-helper-tests
swift build --package-path desktop-bridge -c release
/usr/bin/install -d -m 700 "$HOME/.local/bin"
/usr/bin/install -m 755 \
  "$(swift build --package-path desktop-bridge -c release --show-bin-path)/wakewire-codex-desktop-helper" \
  "$HOME/.local/bin/wakewire-codex-desktop-helper"
```

Then grant Accessibility permission to the installed helper:

1. Open **System Settings → Privacy & Security → Accessibility**.
2. Click `+`, authenticate, and select
   `~/.local/bin/wakewire-codex-desktop-helper`. Use `Command-Shift-G` in the
   file picker to enter the full path if the hidden directory is not visible.
3. Keep the Mac unlocked on the console, start Codex Desktop, and close any
   modal dialogs.
4. Run `~/.local/bin/wakewire-codex-desktop-helper probe`. It must print exactly
   `{"ok":true}` and exit successfully.
5. Run `wakewire desktop doctor`.

The doctor is read-only. It checks signed Desktop turn compatibility, private
socket ownership and mode, separately pinned interrupt support, helper
executability and Accessibility readiness, and readability of Codex's task-state
database. A healthy result has top-level
`"ok": true`. It never requests Accessibility permission itself.

SwiftPM ad-hoc signs the helper, and installation preserves that signature.
Grant Accessibility only after copying it to its stable final path. Rebuilding
or replacing it changes its code identity, so remove and re-add its System
Settings entry (or toggle and regrant it) after updates. If it is installed
elsewhere, set `sink.desktopHelperPath` to that absolute path. Run the doctor
after helper changes or when compatibility health is degraded. The IPC protocol
is private and unsupported by OpenAI, so missing signed protocol routes fail
closed automatically. Do not set `sink.desktopAllowUnsupportedVersion=true`
until that exact build has been tested manually; it also widens interrupt support.

Confirm the adapter and restart the daemon after configuration changes:

```bash
wakewire config set sink.adapter codex-desktop
wakewire desktop doctor
wakewire stop
wakewire start --detach
```

WakeWire reads Codex's state database and the task's recorded rollout only for
correlation and replay prevention; it does not write either one. The helper uses
that state to discover its newly persisted task ID. The `codex-sdk`,
`codex-app-server`, and `codex-exec` adapters remain background-capable
fallbacks, but they do not provide the same first-task Desktop bridge.

## Provider credentials and scopes

Configure inbound sources using [the normal setup guide](setup.md), then add the
narrow outbound/directory credentials needed by the dispatcher. Secrets are
stored in the macOS Keychain when available, with WakeWire's existing mode-0600
file fallback.

### Slack

- App-level token: `connections:write` for Socket Mode.
- Chip user token (`xoxp-…`): `channels:history`, `channels:read`, `chat:write`,
  `im:history`, `mpim:history`, `users:read`, `users:read.email`, and
  `reactions:write` as **User Token Scopes**.
- Add `groups:history` and `groups:read` only if Chip is intentionally allowed
  in private channels.
- Under **Subscribe to events on behalf of users**, add `message.im` for
  one-to-one PMs, `message.mpim` for group-PM mentions, and `message.channels`
  for public-channel mentions; add `message.groups` only for private-channel
  mentions. Do not create a bot user or use `app_mention`.
- Install/authorize the app while signed in as the existing Chip account, and
  keep Chip as its only authorizing user. WakeWire validates and pins the token's
  app ID, non-bot workspace/user IDs, and profile email before accepting events.
- WakeWire dispatches new human `message.im` events with `channel_type: "im"`
  without requiring a mention. Channel and `message.mpim` group-PM requests
  require Slack's exact resolved `<@CHIP_USER_ID>` mention. Edits, deletions,
  bot messages, and ordinary unmentioned group-PM chatter do not trigger.

Store the app and Chip user tokens with:

```bash
wakewire auth slack --source slack-WORKSPACE
```

With a 1Password-mounted project `.env.local`, set `SLACK_APP_TOKEN` and
`SLACK_USER_TOKEN` and run that same command without token flags. WakeWire uses
the mounted values only as candidates for its normal validation and immutable
identity-pinning flow, then stores the source-scoped credentials in its existing
Keychain backend. Missing values fall back to hidden prompts.

Reinstall the Slack app after changing scopes or event subscriptions.

### GitHub

The inbound webhook still uses its independent HMAC secret. For account lookup
and acknowledgments, use a repository-limited GitHub App installation token or
fine-grained PAT that can read user/repository metadata and write reactions on
the watched Issues and Pull requests. Subscribe the webhook to the issue,
pull-request, issue-comment, and pull-request-review-comment events on which
people may mention Chip. The pull-request subscription is also what delivers
`review_requested`; WakeWire accepts it only when the requested reviewer is the
canonical `chipbyte-snap` account.

```bash
wakewire auth github-api --source github-OWNER-REPO
```

Do not use a broad classic PAT when a repository-limited credential is
available.

### Gmail

Gmail does not receive the delayed 👀 acknowledgment. WakeWire's Desktop OAuth
flow requests `https://mail.google.com/` for IMAP XOAUTH2 and durable
same-thread final replies; an IMAP app password supports inbound mail only and
cannot return Chip's completed answer.

```bash
wakewire auth gmail --source gmail-YOU-snapcorp.com-LABEL
```

Keep the required label filter narrow. The email must be addressed or copied to
`chip@snapcorp.com` and the current unquoted body must contain exact `@chip` or
`@Chip Byte`; inherited subjects and quoted old mentions do not count. The
DMARC-aligned visible From address must be one of the enrolled aliases.
Non-Gmail IMAP can still feed ordinary routes, but it cannot
satisfy the dispatcher's current `mx.google.com` authentication gate or its
Gmail API final-reply path.

### Linear

Use separate inbound and outbound credentials:

- Linear's webhook signing secret authenticates inbound payloads.
- A dedicated `Chip Byte <chip@snapcorp.com>` user API key may be mounted from
  the 1Password Environment `chip agent` at the ignored project path
  `.env.local`. WakeWire validates the live viewer identity at every daemon
  start, uses the key for user/issue lookup and comments, and never persists it.
- An optional dedicated Linear OAuth app remains supported for native Agent
  Sessions, delegation, ephemeral activities, and authenticated stop signals.

The 1Password local environment file is a private FIFO, not a plaintext secret
checked into the repository. The project loads it with Node's native env-file
loader and never overwrites an explicitly supplied process variable. Startup
fails if `LINEAR_API_KEY` resolves to anyone other than exactly
`Chip Byte <chip@snapcorp.com>`. Never point this mount at Snap's controller
environment, even though that older credential uses the same variable name.

For the dedicated-user mode, configure a signed webhook for `Issue` and
`Comment` events. WakeWire pins the API-key viewer's immutable user and
organization IDs onto the source. A signed, fresh event becomes privileged only
when its immutable actor is enrolled and it contains either a current exact
`@chip`/`@Chip Byte` mention or a new assignment to the pinned Chip user. If the
bound Codex request remains incomplete after ten seconds, the progress
acknowledgment is a normal issue comment.

For native Agent mode, enable client-credentials authentication and Agent
Session webhook events, then grant exactly `read`, `write`, `app:mentionable`,
and `app:assignable`. After creating the signed Linear webhook source, run:

```bash
wakewire auth webhook --source webhook-linear
wakewire auth linear-agent --source webhook-linear
```

The command prompts for the app client ID and a hidden client secret, mints an
access token immediately, queries `viewer`, and pins that immutable `viewer.id`
to the webhook source. Linear client-credentials tokens are issued for 30 days;
WakeWire records the returned expiry and proactively mints a replacement five
minutes before it expires. A `401` also invalidates the cached expiry and causes
one fresh-token retry. Client credentials do not use a refresh token.

For native Agent events, the signed, fresh event must bind both its top-level
and nested session app-user IDs to the pinned `viewer.id`, and its immutable
human actor must match an enrolled Linear principal. A created session may come
from a structured mention or Linear's native delegation flow. A generic Linear
field mapping remains an ordinary WakeWire route and cannot manufacture either
kind of privileged Chip target. See [the Linear recipe](../recipes/linear.md).

An authenticated `stop` signal on a prompted Agent Session is prioritized ahead
of ordinary requests. WakeWire interrupts the correlated Codex Desktop task via
the separately exact-build-pinned private IPC used by Desktop's Stop UI. The
Linear response is deferred until that interruption succeeds; a permanent failure
produces an error activity instead. Because this protocol is private, stop support
fails closed on unapproved interrupt builds and must be compatibility-tested after
a Desktop update that changes that capability.

The stop lane cancels older queued requests and preempts active Desktop turns.
An active root `make prepare` receives cooperative process cancellation. Once the
new-task Accessibility helper has begun its UI submission, WakeWire deliberately
lets it settle so it can recover the durable task ID; it then interrupts that
task before releasing `Stopped`. UI submission may therefore continue briefly
after the signal, but no later Codex work is allowed or falsely confirmed
stopped.

## Correlation and task reuse

The dispatcher chooses one canonical work item in this exact order:

1. One resolved Linear issue.
2. Any provider alias already attached to an existing work item.
3. GitHub repository plus issue/pull-request identity.
4. Slack team, channel, and root thread timestamp.
5. Gmail's RFC `References`/`In-Reply-To` root.
6. A normalized email subject, scoped by receiving mailbox and enrolled person.

Repeated `Re:`, `Fw:`, and `Fwd:` variants are removed before subject fallback.
Subject keys are hashed and never used across mailboxes or people.

A Linear URL, identifier such as `ENG-4610`, or exact lowercase Linear branch
in Slack, email, or GitHub content promotes the work item to Linear. If a
GitHub issue or pull request is referenced, the dispatcher also asks Linear
whether that exact GitHub URL is attached to an issue, even when direct ticket
text is present. All direct and attachment evidence must resolve to the same
immutable issue. Provider
aliases are retained when promotion happens, so later Slack, GitHub, Linear,
and email messages can all reuse the same Codex Desktop task.

Two different Linear references in one request fail permanently before Desktop
dispatch. Likewise, aliases already bound to different tasks fail closed; the
dispatcher never guesses which history to abandon.

## Snap workspace boundary

A work item with one resolved Linear issue uses the normalized lowercase ticket
as its managed folder identity. For an authenticated `snapnhd/system` review,
WakeWire prefers that authoritative ticket and falls back only to the exact PR
URL when Linear identity is unavailable. It never derives identity from an
arbitrary title, branch name, or comment.

WakeWire delegates provisioning and lifecycle authority to the `workspaces`
dispatcher, launched without a shell:

```bash
make -C "$SNAP_ROOT/workspaces" dev fra-2967
make -C "$SNAP_ROOT/workspaces" status fra-2967
```

The first `dev` argument may instead be the exact
`https://github.com/snapnhd/system/pull/N` URL. After `dev`, WakeWire parses the
resolved ticket and status, then verifies one real `workspaces/<ticket>` path,
managed metadata, `overmind=running`, exact Git HEAD, and the exact App, Data,
and Snapcorp hosts. Missing, redirected, duplicate, stopped, or conflicting
state fails closed. No ad hoc scratch clone is created under `workspaces/`.

Non-system requests with no Linear identity continue from the Snap root. A
persisted old branch-named cwd is never silently trusted; it must rebind through
the ticket dispatcher or fail closed.

## System PR review preflight and provider authority

The first GitHub write is the pickup state in the PR description. WakeWire owns
only two unique paired blocks: workspace links first, review status second.
Every update fetches the latest full body, replaces only marker-owned ranges,
PATCHes the merged body, and immediately reads it back. Duplicate, missing,
overlapping, or malformed boundaries fail closed. Human content outside the
blocks is preserved.

GitHub exposes only a whole-body PATCH, so a concurrent author edit can still
race between fetch and write. The mitigation is latest-body fetch per update,
pure block replacement, immediate exact verification, and no retry from a stale
body. Legacy Chip status comments are deleted only after successful body
read-back proves the migration; each DELETE is then verified by fetching the
exact comment and requiring it to be absent. Ordinary Chip and human comments
are retained.

Once the workspace is verified, WakeWire invokes exactly:

```bash
make -C "$SNAP_ROOT/workspaces" test fra-2967
```

The subprocess uses bounded diagnostics and process-tree cancellation. WakeWire
requires explicit App, Data, Snapcorp, Windmill, and aggregate summaries, a zero
exit, and the same exact HEAD before and after the run. Any drift, red suite, or
malformed footer blocks the full review. A failure dispatches only one limited
COMMENTED triage turn; a focused rerun cannot unlock the normal review.

After a full-review turn, WakeWire accepts completion only when GitHub exposes a
formal Chip review submitted after the request and the final response includes
one exact specialist proof. The proof must match a private coordinator state
event and a separate mode-0600 invocation attestation bound to the stable PR
key, exact HEAD, per-attempt invocation ID, digest, and trusted verdict. PR-body progress alone cannot
satisfy either gate. Missing or `INCOMPLETE` evidence updates the body to a
non-terminal hold and retries the same request/session; a recovery turn that
already has a formal review is explicitly forbidden from posting another one.

One canonical parent PR session owns every provider write. Read-only children
may inspect independent slices after the relevant gate, but cannot post, edit
the PR body, resolve threads, approve, merge, or start another PR session. The
parent rechecks child evidence at the exact HEAD and posts once.

## Progress acknowledgments and final source responses

Normal acceptance atomically commits the deduplicated request and its exact
provider acknowledgment with a ten-second not-before deadline. Unauthorized,
self-authored, Gmail, and untargeted events create no delayed acknowledgment.
Before delivery, an atomic claim rechecks the parent request; a completion,
permanent failure, or authenticated stop suppresses an unsent progress reaction.

Once present, the dedicated acknowledgment worker sends the visible response
independently of workspace creation and model work, retries delivery failures
with capped backoff, and treats an already-present eyes reaction as success. A
Linear stop request remains the exception: its required outbox row is committed
in a held state at ingress and released only after Desktop interruption succeeds,
or as an error activity after a permanent failure.

A progress acknowledgment is not a final response, and the deferred Linear stop
confirmation is only a lifecycle response. A separate completion worker reads
only the rollout bound to the submitted Desktop task and exact WakeWire marker.
It ignores partial assistant output. Slack and Gmail queue the user-visible
`task_complete` message for a durable reply worker, which posts it once to the
original Slack thread root or Gmail RFC thread. GitHub and Linear are marked complete while
their final answer remains in Desktop until provider-specific final responders
are added. The stored provider target controls routing; model output cannot
retarget, broadcast, or create mentions.

If the workspace dispatcher exits unsuccessfully or the resulting Snap workspace fails
identity validation before submission, WakeWire does not keep retrying an
untyped controller failure forever. It marks the authenticated request failed
and, for Slack or Gmail, atomically queues a fixed host-generated notice to the
same frozen origin. That notice says no agent task was started and names the
WakeWire request ID; raw controller output is retained only as private in-memory
diagnostic context and is never copied into the database or provider reply.
Sending the notice does not turn the failed request into a completed agent task.

The operator-controlled task envelope also makes WakeWire the sole delivery
path for conversational replies. Codex returns its answer in the task and must
not send the same answer through a Slack, Gmail, Linear, GitHub, email, browser,
or other connector. This prevents duplicate replies and connector-added product
attribution. An explicitly requested provider side effect is still allowed when
its target is distinct from the originating conversation; its result is reported
through the normal WakeWire final reply where supported, or remains in Codex
Desktop where a provider responder has not been added yet.

GitHub comments and Linear activities are not final-response targets yet. Their
completed answers remain available in the Codex Desktop task
until a provider-specific final responder is added. Cross-provider correlation
never causes a Slack-originated answer to be posted anywhere except its original
Slack thread.

## Scheduled follow-ups

### One-shot terminal follow-ups

A monitor or reminder created from an authenticated WakeWire request uses a
Codex heartbeat targeted to the exact originating task. The automation is
created paused, then registered against the persisted WakeWire request before
activation. Registration snapshots the original Codex task, turn, correlation
marker, and provider request; the caller receives only an opaque follow-up ID.

Terminal completion is first-write-wins for the entire binding. In one SQLite
transaction WakeWire creates a provider-only synthetic request already in the
submitted state, queues its source-reply outbox row, and records the terminal
request on the binding. That child is never dispatched to Desktop and cannot
create a second model turn. Identical retries return the same request and
outbox; a different terminal body conflicts. The callback must present the
same automation ID and Codex task ID, and WakeWire rechecks that the originating
person remains enabled with source-reply permission.

The task ID supplied by the authenticated local client is a consistency guard,
not a provider-derived authorization claim. Delivery authority comes from the
opaque binding and local agent API authentication; the destination is always
loaded from the frozen origin request and cannot be selected by the callback.

The heartbeat renders the terminal body in the originating Codex task. The
source-reply worker independently posts the normalized body to the frozen Slack
or Gmail target. Provider destinations never enter the automation prompt or
callback. After durable completion is accepted, the heartbeat pauses the
automation rather than deleting it.

The local management surface is:

```bash
wakewire scheduled-followup register \
  --automation-id <id> \
  --origin-request-id <request-id> \
  --current-codex-thread-id "$CODEX_THREAD_ID"
wakewire scheduled-followup complete \
  --followup-id <opaque-id> \
  --automation-id <id> \
  --current-codex-thread-id "$CODEX_THREAD_ID" \
  --message <terminal-body>
wakewire scheduled-followup status --followup-id <opaque-id>
```

### Recurring top-level Slack reports

A periodic report requested through authenticated Slack uses a separate
recurring channel-delivery binding. Create the task-targeted heartbeat paused,
then register it once with the automation ID, the operator-controlled origin
request ID, and the current Codex task ID. WakeWire freezes the origin source,
workspace, channel, task, turn, and correlation marker and returns an opaque
delivery ID. The callback cannot supply or retarget the Slack destination, and
the provider target never belongs in the automation prompt.

Each run derives a deterministic occurrence key from the logical report window,
including its timezone when relevant. Sending creates one provider-only request
and one durable source-reply outbox row for that binding and occurrence. An
identical retry returns the same request and outbox; reusing the key with a
different normalized body conflicts. Authorization and the frozen Slack origin
are rechecked before every enqueue.

The scheduled task must call `wakewire_scheduled_channel_send`, not the bundled
Slack connector's `slack_send_message` or scheduling methods. WakeWire posts the
body as a new top-level message through Chip's pinned Slack user-token source,
which avoids connector-added product attribution and keeps destination authority
outside model-generated content. A successful occurrence does not pause or
delete the recurring automation.

The local management surface is:

```bash
wakewire scheduled-channel-delivery register \
  --automation-id <id> \
  --origin-request-id <request-id> \
  --current-codex-thread-id "$CODEX_THREAD_ID"
wakewire scheduled-channel-delivery send \
  --delivery-id <opaque-id> \
  --automation-id <id> \
  --current-codex-thread-id "$CODEX_THREAD_ID" \
  --occurrence-key <stable-logical-window> \
  --message-stdin
wakewire scheduled-channel-delivery status --delivery-id <opaque-id>
```

## Operational checks

```bash
wakewire desktop doctor
wakewire status
wakewire people show CJ
wakewire policy explain --person CJ
wakewire logs --lines 200
```

If an acknowledgment or Desktop submission is held, keep the daemon running;
both workers retry the same durable request. Fix the missing provider token,
Accessibility grant, unlocked console, Desktop version, or Linear resolution
problem shown in the logs. A root-controller exit or workspace identity failure
is terminal: fix the local environment, then send the request again. Do not
bypass identity, branch, metadata, socket-ownership, or version checks to force
a request through.
