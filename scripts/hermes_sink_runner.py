#!/usr/bin/env python3
"""WakeWire ↔ Hermes subprocess protocol (Path D).

Reads one JSON object on stdin, runs a stamped Hermes turn, writes JSON on stdout.

Exit codes:
  0 ok
  1 permanent
  2 unreachable
  3 busy
  124 timeout
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import traceback
import uuid
from pathlib import Path
from typing import Any


def _fail(error_class: str, message: str, code: int) -> int:
    sys.stdout.write(
        json.dumps({"ok": False, "errorClass": error_class, "message": message}) + "\n"
    )
    return code


def _ok(
    session_id: str,
    final_response: str,
    ended_reason: str = "text_response",
    *,
    title: str | None = None,
) -> int:
    payload: dict[str, Any] = {
        "ok": True,
        "sessionId": session_id,
        "finalResponse": final_response,
        "endedReason": ended_reason,
    }
    if title is not None:
        payload["title"] = title
    sys.stdout.write(json.dumps(payload) + "\n")
    return 0


def _which_hermes(explicit: str | None) -> str | None:
    if explicit and Path(explicit).exists():
        return explicit
    for candidate in (
        os.environ.get("HERMES_BIN"),
        str(Path.home() / ".hermes/hermes-agent/venv/bin/hermes"),
        "hermes",
    ):
        if not candidate:
            continue
        if candidate == "hermes":
            from shutil import which

            found = which("hermes")
            if found:
                return found
            continue
        if Path(candidate).exists():
            return candidate
    return None


def _presentation_fields(req: dict[str, Any]) -> dict[str, str]:
    platform = str(req.get("platform") or "").lower()
    user_id = str(req.get("userId") or "")
    user_name = str(req.get("userName") or "")
    chat_id = str(req.get("chatId") or f"wakewire:{platform}:{user_id}")
    session_key = str(req.get("sessionKey") or f"wakewire:{platform}:{chat_id}")
    display_name = str(req.get("displayName") or user_name or user_id)
    session_title = str(req.get("sessionTitle") or "").strip()
    return {
        "platform": platform,
        "user_id": user_id,
        "user_name": user_name,
        "chat_id": chat_id,
        "session_key": session_key,
        "display_name": display_name,
        "session_title": session_title,
    }


def _apply_session_presentation(session_id: str, req: dict[str, Any]) -> str | None:
    """Write gateway peer metadata + desktop title onto the Hermes session row.

    Returns the title actually stored (if any). Best-effort: never fails the turn.
    """
    if not session_id:
        return None
    fields = _presentation_fields(req)
    platform = fields["platform"]
    if platform not in ("github", "linear"):
        return None
    try:
        hermes_root = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "hermes-agent"
        if hermes_root.is_dir() and str(hermes_root) not in sys.path:
            sys.path.insert(0, str(hermes_root))
        from hermes_state import SessionDB  # type: ignore

        db = SessionDB()
        origin = json.dumps(
            {
                "via": "wakewire-hermes-sink",
                "platform": platform,
                "user_id": fields["user_id"],
                "chat_id": fields["chat_id"],
                "session_key": fields["session_key"],
            },
            separators=(",", ":"),
        )
        db.record_gateway_session_peer(
            session_id,
            source=platform,
            user_id=fields["user_id"] or None,
            session_key=fields["session_key"],
            chat_id=fields["chat_id"],
            chat_type="channel",
            thread_id="",
            display_name=fields["display_name"] or None,
            origin_json=origin,
        )
        title = fields["session_title"]
        if not title:
            return None
        try:
            db.set_session_title(session_id, title)
            return title
        except ValueError:
            # Unique title constraint — suffix with short session id.
            alt = f"{title} · {session_id[-6:]}"
            try:
                db.set_session_title(session_id, alt)
                return alt
            except Exception:  # noqa: BLE001
                return None
    except Exception:  # noqa: BLE001
        return None


def _lookup_session_id_by_key(session_key: str) -> str | None:
    """Resume an existing Hermes row keyed to this WorkItem, if any."""
    key = (session_key or "").strip()
    if not key or key.endswith(":unknown"):
        return None
    try:
        hermes_root = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "hermes-agent"
        if hermes_root.is_dir() and str(hermes_root) not in sys.path:
            sys.path.insert(0, str(hermes_root))
        from hermes_state import SessionDB  # type: ignore

        db = SessionDB()
        with db._lock:  # type: ignore[attr-defined]
            cur = db._conn.execute(  # type: ignore[attr-defined]
                """
                SELECT id FROM sessions
                 WHERE session_key = ?
                   AND COALESCE(archived, 0) = 0
                 ORDER BY CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END,
                          started_at ASC
                 LIMIT 1
                """,
                (key,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        sid = row["id"] if hasattr(row, "keys") else row[0]
        return str(sid) if sid else None
    except Exception:  # noqa: BLE001
        return None


def _read_session_title(session_id: str) -> str | None:
    try:
        hermes_root = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "hermes-agent"
        if hermes_root.is_dir() and str(hermes_root) not in sys.path:
            sys.path.insert(0, str(hermes_root))
        from hermes_state import SessionDB  # type: ignore

        db = SessionDB()
        row = db.get_session(session_id) if hasattr(db, "get_session") else None
        if isinstance(row, dict):
            t = row.get("title")
            return str(t) if t else None
        # Fallback SQL via private conn if needed
        with db._lock:  # type: ignore[attr-defined]
            cur = db._conn.execute(  # type: ignore[attr-defined]
                "SELECT title FROM sessions WHERE id = ?", (session_id,)
            )
            r = cur.fetchone()
            if r is None:
                return None
            val = r["title"] if hasattr(r, "keys") else r[0]
            return str(val) if val else None
    except Exception:  # noqa: BLE001
        return None


def github_review_reasoning_config(platform: str) -> dict[str, Any] | None:
    """GitHub Path D is PR review / thread follow-up — always high effort."""
    if str(platform).lower() == "github":
        return {"enabled": True, "effort": "high"}
    return None


def _prefix_github_pr_workflow(platform: str, prompt: str) -> str:
    if str(platform).lower() != "github":
        return prompt
    if "pr-workflow" in prompt.lower():
        return prompt
    return "Load skill pr-workflow first. Code-review reasoning effort is high.\n\n" + prompt


def _run_cli(
    *,
    hermes_bin: str,
    prompt: str,
    session_id: str | None,
    cwd: str | None,
    platform: str,
    user_id: str,
    chat_id: str,
    user_name: str,
    timeout_seconds: int,
    profile: str | None,
    session_key: str,
) -> tuple[str, str]:
    """Return (session_id, final_response)."""
    env = os.environ.copy()
    # gateway-role-policy reads these via get_session_env → os.environ fallback
    env["HERMES_SESSION_PLATFORM"] = platform
    env["HERMES_SESSION_USER_ID"] = user_id
    env["HERMES_SESSION_CHAT_ID"] = chat_id or f"wakewire:{platform}:{user_id}"
    if user_name:
        env["HERMES_SESSION_USER_NAME"] = user_name
    # Session source = platform so desktop can group GitHub / Linear sections.
    env["HERMES_SESSION_SOURCE"] = platform
    env["HERMES_SESSION_KEY"] = session_key
    env["HERMES_PLATFORM"] = platform

    sid = session_id or f"ww-hermes-{uuid.uuid4().hex[:16]}"
    prompt = _prefix_github_pr_workflow(platform, prompt)
    args = [hermes_bin, "chat"]
    if github_review_reasoning_config(platform):
        args.extend(["--reasoning", "high"])
    args.extend(["-q", prompt, "--pass-session-id"])
    if session_id:
        args.extend(["--resume", session_id])
    if profile:
        args = [hermes_bin, "-p", profile, "chat"]
        if github_review_reasoning_config(platform):
            args.extend(["--reasoning", "high"])
        args.extend(["-q", prompt, "--pass-session-id"])
        if session_id:
            args.extend(["--resume", session_id])

    try:
        proc = subprocess.run(
            args,
            input=None,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            cwd=cwd or None,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(str(exc)) from exc
    except FileNotFoundError as exc:
        raise RuntimeError(f"hermes not found: {exc}") from exc

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        combined = (err or out or f"exit {proc.returncode}")[-2000:]
        low = combined.lower()
        if "busy" in low or "in flight" in low:
            raise BusyError(combined)
        if "not found" in low and session_id:
            # Rebind: drop dead session id and start fresh once.
            raise SessionNotFoundError(combined)
        if "unreachable" in low or "connection refused" in low:
            raise UnreachableError(combined)
        if not out:
            raise UnreachableError(combined or "hermes failed with no output")
    if not out:
        raise PermanentError(err[-500:] if err else "hermes returned empty response")
    final = out
    return session_id or sid, final


class BusyError(Exception):
    pass


class PermanentError(Exception):
    pass


class UnreachableError(Exception):
    pass


class SessionNotFoundError(PermanentError):
    pass


def _run_python_api(req: dict[str, Any]) -> tuple[str, str]:
    """Preferred path: in-process AIAgent with set_session_vars."""
    hermes_root = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "hermes-agent"
    if not hermes_root.is_dir():
        raise UnreachableError(f"hermes-agent not found at {hermes_root}")
    sys.path.insert(0, str(hermes_root))

    # Lazy imports after path fix
    from gateway.session_context import clear_session_vars, set_session_vars  # type: ignore
    from hermes_state import SessionDB  # type: ignore
    from run_agent import AIAgent  # type: ignore

    # Direct AIAgent construction bypasses the CLI startup path that discovers
    # configured MCP servers. Without this call, a Path D turn gets only the
    # built-in registry even though Linear is configured and healthy.
    try:
        from tools.mcp_tool import discover_mcp_tools  # type: ignore

        discover_mcp_tools()
    except Exception as exc:  # noqa: BLE001
        # Let _once fall back to the CLI path, which owns its own MCP startup.
        raise UnreachableError(f"MCP tool discovery failed: {exc}") from exc

    fields = _presentation_fields(req)
    platform = fields["platform"]
    user_id = fields["user_id"]
    chat_id = fields["chat_id"]
    user_name = fields["user_name"]
    session_key = fields["session_key"]
    session_title = fields["session_title"]
    prompt = _prefix_github_pr_workflow(platform, str(req["prompt"]))
    session_id = req.get("sessionId") or None
    if session_id is not None:
        session_id = str(session_id).strip() or None
    cwd = req.get("cwd") or None

    # If resume targets a missing row, drop it so AIAgent allocates a real new
    # session id (and WorkItem rebinds). Stale Codex-era ids are common here.
    if session_id:
        try:
            existing = SessionDB().get_session(str(session_id))
        except Exception:  # noqa: BLE001
            existing = None
        if not existing:
            session_id = None

    # source=platform so AIAgent.create_session tags the row as github|linear
    # (desktop messaging sections). gateway-role-policy still uses platform + userId.
    tokens = set_session_vars(
        platform=platform,
        source=platform,
        chat_id=chat_id,
        chat_type="channel",
        chat_name=session_title or f"wakewire:{platform}",
        thread_id="",
        user_id=user_id,
        user_name=user_name,
        session_key=session_key,
        session_id=session_id or "",
        message_id="",
        cwd=cwd or "",
        async_delivery=False,
    )
    try:
        # CRITICAL: AIAgent only persists sessions when session_db is passed.
        # Without it, answers still return but desktop Recents stays empty.
        session_db = SessionDB()
        agent_kwargs: dict[str, Any] = {
            "quiet_mode": True,
            "platform": platform,
            "user_id": user_id or None,
            "user_name": user_name or None,
            "chat_id": chat_id or None,
            "chat_name": session_title or f"wakewire:{platform}",
            "chat_type": "channel",
            "gateway_session_key": session_key or None,
            "session_db": session_db,
            # Never inherit WakeWire/Codex model names (e.g. gpt-5.6-luna).
            "model": _default_hermes_model(),
        }
        rc = github_review_reasoning_config(platform)
        if rc:
            agent_kwargs["reasoning_config"] = rc
        if session_id:
            agent_kwargs["session_id"] = str(session_id)
        agent = AIAgent(**agent_kwargs)
        # Stamp session_key/title before the long turn so a host crash/reboot
        # can resume this WorkItem instead of minting a second PR session.
        try:
            if hasattr(agent, "_ensure_db_session"):
                agent._ensure_db_session()
        except Exception:  # noqa: BLE001
            pass
        sid_early = getattr(agent, "session_id", None) or session_id
        if sid_early:
            _apply_session_presentation(str(sid_early), req)
        # Prefer chat() one-shot if available
        if hasattr(agent, "chat"):
            result = agent.chat(prompt)
        else:
            result = agent.run_conversation(user_message=prompt)
        # Normalize result
        if isinstance(result, dict):
            text = (
                result.get("final_response")
                or result.get("response")
                or result.get("content")
                or ""
            )
            # Surface hard failures that some Hermes versions stash on the dict
            err = result.get("error") or result.get("error_message")
            if err and not str(text).strip():
                raise PermanentError(f"Hermes agent error: {err}")
            sid = result.get("session_id") or getattr(agent, "session_id", None) or session_id
        else:
            text = str(result or "")
            sid = getattr(agent, "session_id", None) or session_id
        if not sid:
            sid = f"ww-hermes-{uuid.uuid4().hex[:16]}"
        if not str(text).strip():
            raise PermanentError("Hermes returned empty final response")
        # Common non-answer failure modes
        lowered = str(text).strip().lower()
        if "the model" in lowered and "does not exist" in lowered:
            raise PermanentError(str(text).strip())
        # Force row create if chat path skipped lazy ensure (belt + suspenders).
        try:
            if hasattr(agent, "_ensure_db_session"):
                agent._ensure_db_session()
        except Exception:  # noqa: BLE001
            pass
        return str(sid), str(text).strip()
    finally:
        clear_session_vars(tokens)


def _default_hermes_model() -> str:
    """Resolve the profile default model so we never send model=\"\" to the API."""
    env = (os.environ.get("HERMES_MODEL") or "").strip()
    if env:
        return env
    try:
        import yaml  # type: ignore

        cfg_path = Path.home() / ".hermes" / "config.yaml"
        if cfg_path.is_file():
            data = yaml.safe_load(cfg_path.read_text()) or {}
            model = data.get("model")
            if isinstance(model, str) and model.strip():
                return model.strip()
            if isinstance(model, dict):
                for key in ("default", "name", "model"):
                    val = model.get(key)
                    if isinstance(val, str) and val.strip():
                        return val.strip()
    except Exception:  # noqa: BLE001
        pass
    return "grok-4.5"


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return _fail("permanent", "empty stdin", 1)
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        return _fail("permanent", f"invalid json: {exc}", 1)

    action = req.get("action") or "start"
    if action == "probe":
        hermes_bin = _which_hermes(req.get("hermesBin"))
        if not hermes_bin:
            return _fail("unreachable", "hermes binary not found", 2)
        try:
            subprocess.run(
                [hermes_bin, "version"],
                capture_output=True,
                timeout=15,
                check=False,
            )
            return _ok("probe", "ok", "probe")
        except Exception as exc:  # noqa: BLE001
            return _fail("unreachable", str(exc), 2)

    if action == "set_title":
        sid = str(req.get("sessionId") or "").strip()
        title = str(req.get("sessionTitle") or req.get("title") or "").strip()
        if not sid:
            return _fail("permanent", "missing sessionId", 1)
        if not title:
            return _fail("permanent", "missing sessionTitle", 1)
        platform = str(req.get("platform") or "").lower()
        user_id = str(req.get("userId") or "").strip()
        # Only rewrite gateway peer metadata when the caller supplies a real
        # stamp. Title-only updates must not invent platform=github userId=wakewire.
        if platform in ("github", "linear") and user_id and user_id not in ("wakewire", "unknown"):
            stored = _apply_session_presentation(
                sid,
                {
                    "platform": platform,
                    "userId": user_id,
                    "sessionTitle": title,
                    "chatId": req.get("chatId"),
                    "sessionKey": req.get("sessionKey"),
                    "displayName": req.get("displayName"),
                    "userName": req.get("userName"),
                },
            )
            if stored is not None:
                return _ok(sid, stored, "set_title", title=stored)
        try:
            hermes_root = (
                Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "hermes-agent"
            )
            if hermes_root.is_dir() and str(hermes_root) not in sys.path:
                sys.path.insert(0, str(hermes_root))
            from hermes_state import SessionDB  # type: ignore

            db = SessionDB()
            try:
                db.set_session_title(sid, title)
                stored = title
            except ValueError:
                alt = f"{title} · {sid[-6:]}"
                db.set_session_title(sid, alt)
                stored = alt
        except Exception as exc:  # noqa: BLE001
            return _fail("permanent", f"set_title failed: {exc}", 1)
        return _ok(sid, stored or title, "set_title", title=stored or title)

    if action == "read_title":
        sid = str(req.get("sessionId") or "").strip()
        if not sid:
            return _fail("permanent", "missing sessionId", 1)
        title = _read_session_title(sid)
        return _ok(sid, title or "", "read_title", title=title)

    if action not in ("start", "resume"):
        return _fail("permanent", f"unknown action {action!r}", 1)

    for key in ("prompt", "platform", "userId"):
        if not req.get(key):
            return _fail("permanent", f"missing {key}", 1)

    timeout_seconds = int(req.get("timeoutSeconds") or 1500)
    platform = str(req["platform"]).lower()
    if platform not in ("github", "linear"):
        return _fail("permanent", f"unsupported platform {platform}", 1)

    fields = _presentation_fields(req)

    def _once(session_id: str | None) -> tuple[str, str]:
        local_req = dict(req)
        if session_id is None:
            local_req.pop("sessionId", None)
        else:
            local_req["sessionId"] = session_id
        try:
            return _run_python_api(local_req)
        except UnreachableError:
            hermes_bin = _which_hermes(req.get("hermesBin"))
            if not hermes_bin:
                raise UnreachableError("hermes binary not found") from None
            return _run_cli(
                hermes_bin=hermes_bin,
                prompt=str(req["prompt"]),
                session_id=session_id,
                cwd=req.get("cwd"),
                platform=platform,
                user_id=fields["user_id"],
                chat_id=fields["chat_id"],
                user_name=fields["user_name"],
                timeout_seconds=timeout_seconds,
                profile=req.get("profile"),
                session_key=fields["session_key"],
            )

    try:
        try:
            session_id = req.get("sessionId") or None
            if session_id is not None:
                session_id = str(session_id).strip() or None
            if session_id is None:
                session_id = _lookup_session_id_by_key(fields["session_key"])
            sid, text = _once(session_id)
        except SessionNotFoundError:
            # Resume miss → create/rebind a fresh session (no silent CLI orphan).
            sid, text = _once(None)
        title = _apply_session_presentation(sid, req)
        return _ok(sid, text, title=title)
    except BusyError as exc:
        return _fail("busy", str(exc), 3)
    except PermanentError as exc:
        return _fail("permanent", str(exc), 1)
    except TimeoutError as exc:
        return _fail("unreachable", f"timeout: {exc}", 124)
    except UnreachableError as exc:
        return _fail("unreachable", str(exc), 2)
    except Exception as exc:  # noqa: BLE001
        return _fail(
            "permanent",
            f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[-1500:]}",
            1,
        )


if __name__ == "__main__":
    raise SystemExit(main())
