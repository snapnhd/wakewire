# Linear

Linear signs webhooks with HMAC-SHA256 (hex) of the raw body in the
`linear-signature` header. The Settings UI generates a signing secret; the
GraphQL `webhookCreate` API can instead receive the secret generated during
WakeWire source setup. Each
delivery also carries a `Linear-Delivery` header, "a UUID (v4) that uniquely
identifies this payload" — the correct dedup key.

## 1. Source

```json
wakewire_source_setup_webhook {
  "name": "linear",
  "verification": { "kind": "hmac-sha256", "header": "linear-signature" },
  "mapping": {
    "deliveryIdHeader": "linear-delivery",
    "kind": "type",
    "occurredAt": "createdAt",
    "summary": "{{action}} {{kind}}: {{title}}",
    "fields": {
      "action": "action",
      "title": "data.title",
      "identifier": "data.identifier",
      "state": "data.state.name",
      "assignee": "data.assignee.name",
      "priority": "data.priorityLabel",
      "url": "url"
    }
  }
}
```

Do NOT map `deliveryId` to the body's `webhookId` — that is the webhook's own
id, identical on every event, and would dedup everything after the first
delivery into `skipped-duplicate`.

## 2. Webhook

Linear → Settings → API → Webhooks → New webhook: paste the `webhookUrl` from
step 1 and pick the resource types (Issues, Comments, …). Then open the
webhook's detail page, copy **Linear's signing secret**, and store it:

```bash
wakewire auth webhook --source webhook-linear
```

(Ignore the secret wakewire generated at setup — Linear issues its own.)

Note: Linear requires an exact HTTP 200 response within 5 seconds; wakewire's
listen-mode ingress returns exactly that.

## 3. Dedicated Chip user

Mount the 1Password Environment `chip agent` as the ignored project file
`.env.local`. It must contain `LINEAR_API_KEY` for exactly
`Chip Byte <chip@snapcorp.com>`. WakeWire reads the 1Password FIFO with Node's
native env-file loader, validates `viewer` and the organization during daemon
startup, and does not copy the key into its database or Keychain.

Subscribe the signed source to `Issue` and `Comment` events. WakeWire accepts a
privileged request only when all of these hold:

- the Linear HMAC is valid and `webhookTimestamp` is within one minute;
- the event organization matches the API-key viewer's immutable organization;
- the immutable actor ID is enrolled for that organization; and
- the current event contains an exact `@chip`/`@Chip Byte` mention, or changes
  the assignee to the pinned Chip user.

Copied old descriptions, lookalikes such as `@chipmunk`, unrelated field
updates, other assignees, and generic mapped events cannot satisfy this gate.
Accepted requests receive `👀 I'm on it, <nickname>.` as an issue comment using
the same dedicated Chip key.

Never mount Snap's controller Environment here. WakeWire fails startup unless
the key's live name and email are exactly the dedicated Chip identity.

## 4. Chip OAuth app and native Agent Sessions

The dedicated-user mode covers normal mentions and assignments. Use a Linear
OAuth app when native delegation, Agent Session UI, ephemeral activities, and
authenticated stop signals are required. WakeWire's native parser accepts
source-pinned `AgentSessionEvent.created` and `AgentSessionEvent.prompted`
webhooks alongside the user mode.

Configure a dedicated Linear OAuth app for Chip:

1. Enable client-credentials authentication.
2. Grant the app `read`, `write`, `app:mentionable`, and `app:assignable`
   scopes.
3. Enable Agent Session webhook events and point them at this source's webhook
   URL.
4. Store the signing secret issued by Linear with `wakewire auth webhook` as in
   step 2 above.
5. Bind the app credentials and immutable app identity:

```bash
wakewire auth linear-agent --source webhook-linear
```

The command prompts for the OAuth app's client ID and hidden client secret. It
mints an access token with the client-credentials grant, queries `viewer`, and
pins that immutable `viewer.id` into the Linear source configuration. Linear
issues these access tokens for 30 days; WakeWire records the returned expiry and
proactively mints a replacement five minutes before expiration. A provider
`401` triggers one retry with a newly minted token. There is no refresh token to
copy or rotate manually.

The app credential is separate from Linear's webhook signing secret. Its scopes
permit the user, organization, issue, `attachmentsForURL`, and
`agentActivityCreate` GraphQL operations used for enrollment, GitHub/Linear
correlation, exact branch lookup, and provider responses.

For a privileged request, WakeWire also requires all of the following:

- a valid Linear HMAC and a `webhookTimestamp` within 60 seconds;
- top-level and nested Agent Session app-user IDs that both equal the source's
  pinned `viewer.id`;
- a current sender-authored mention, a native delegation-through-assignment,
  or an authenticated native `stop` signal in that Agent Session; and
- an immutable human actor ID enrolled for that Linear organization.

An old mention copied into context, a mutable display name, or a declarative
field mapping cannot satisfy this native gate. A delegation is accepted only as
the signed, source-pinned `AgentSessionEvent.created` that Linear creates for
the specific app user. Events that meet neither privileged mode may still match
an ordinary WakeWire route, but they never receive Chip's privileged
acknowledgment or Desktop access.

A normal accepted prompt receives the ephemeral
`👀 I'm on it, <nickname>.` activity. An authenticated `stop` signal on
`AgentSessionEvent.prompted` instead pauses its provider response, prioritizes
the stop request, and interrupts an active Codex Desktop task through the
version-gated private Desktop IPC. Linear receives the non-ephemeral
`Stopped, <nickname>.` response only after WakeWire confirms the task is stopped;
repeated or already-idle stops are idempotent, while unsupported Desktop
versions and untrusted state fail closed.

WakeWire cancels older queued work, cooperatively cancels an active root
`make dev`, and preempts an active Desktop turn. A new-task Accessibility helper
that has already begun UI submission is allowed to settle so WakeWire can
recover the created task ID; the final stop response waits for that task to be
discovered and interrupted.

Codex's final answer for normal work remains in its Desktop task and is not yet
posted back to Linear. The stop confirmation is a lifecycle response, not a
final-answer relay.

## 4. Route examples

Urgent bugs into a thread:

```json
wakewire_route_add {
  "name": "urgent linear issues",
  "source": "webhook",
  "match": {
    "provider": "linear",
    "events": ["Issue"],
    "where": [{ "field": "priority", "equals": "Urgent" }]
  },
  "target": { "type": "thread", "threadId": "<your thread>" }
}
```
