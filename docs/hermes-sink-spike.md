# Hermes sink spike (Path D)

## Goal

Stamp `HERMES_SESSION_PLATFORM` + `HERMES_SESSION_USER_ID` so `gateway-role-policy` applies when WakeWire runs Hermes (not bare ungated CLI).

## Finding

`gateway.session_context.get_session_env` falls back to `os.environ` when ContextVars are unset.

Verified:

```bash
HERMES_SESSION_PLATFORM=linear HERMES_SESSION_USER_ID=cj@snapcorp.com \
  python -c 'from gateway.session_context import get_session_env; ...'
# → linear / cj@snapcorp.com
```

In-process preferred path (runner):

1. `set_session_vars(platform=..., user_id=..., chat_id=..., ...)`
2. Construct `AIAgent(quiet_mode=True, platform=...)`
3. `agent.chat(prompt)` or `run_conversation`
4. `clear_session_vars(tokens)`

CLI fallback:

```bash
HERMES_SESSION_PLATFORM=github \
HERMES_SESSION_USER_ID=alice \
HERMES_SESSION_CHAT_ID=workitem:… \
hermes chat -q "…"
```

## Identity stamp (nested roles.yaml)

| Platform | `HERMES_SESSION_PLATFORM` | `HERMES_SESSION_USER_ID` |
|---|---|---|
| GitHub | `github` | login lowercased (`chipbyte-snap`) |
| Linear | `linear` | email lowercased (`cj@snapcorp.com`) |

Prefer `@snapcorp.com` when multiple Linear emails are enrolled.

## Not acceptable

`hermes chat -q` with **no** session env — CLI is ungated by role-policy.
