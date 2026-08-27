#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


RUNNER_PATH = Path(__file__).with_name("hermes_sink_runner.py")


def load_runner():
    spec = importlib.util.spec_from_file_location("hermes_sink_runner_under_test", RUNNER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HermesSinkRunnerMcpTest(unittest.TestCase):
    def test_python_api_discovers_mcp_before_constructing_agent(self):
        runner = load_runner()
        events: list[str] = []

        gateway_package = types.ModuleType("gateway")
        session_context = types.ModuleType("gateway.session_context")
        setattr(session_context, "set_session_vars", lambda **_kwargs: object())
        setattr(session_context, "clear_session_vars", lambda _tokens: None)

        class FakeSessionDB:
            def record_gateway_session_peer(self, *_args, **_kwargs):
                return None

            def set_session_title(self, *_args, **_kwargs):
                return None

        hermes_state = types.ModuleType("hermes_state")
        setattr(hermes_state, "SessionDB", FakeSessionDB)

        class FakeAgent:
            def __init__(self, **_kwargs):
                events.append("agent")
                self.session_id = "session-test"

            def _ensure_db_session(self):
                return None

            def chat(self, _prompt):
                return {"final_response": "ok", "session_id": self.session_id}

        run_agent = types.ModuleType("run_agent")
        setattr(run_agent, "AIAgent", FakeAgent)

        tools_package = types.ModuleType("tools")
        tools_package.__path__ = []
        mcp_tool = types.ModuleType("tools.mcp_tool")

        def discover_mcp_tools():
            events.append("discover")
            return ["mcp__linear__get_issue"]

        setattr(mcp_tool, "discover_mcp_tools", discover_mcp_tools)

        modules = {
            "gateway": gateway_package,
            "gateway.session_context": session_context,
            "hermes_state": hermes_state,
            "run_agent": run_agent,
            "tools": tools_package,
            "tools.mcp_tool": mcp_tool,
        }
        with tempfile.TemporaryDirectory() as home:
            Path(home, "hermes-agent").mkdir()
            with patch.dict(sys.modules, modules, clear=False), patch.dict(
                os.environ, {"HERMES_HOME": home, "HERMES_MODEL": "test-model"}, clear=False
            ):
                session_id, response = runner._run_python_api(
                    {
                        "platform": "github",
                        "userId": "zack",
                        "userName": "Zack",
                        "chatId": "wakewire:github:snapnhd/system#1135",
                        "sessionKey": "wakewire:github:snapnhd/system#1135",
                        "prompt": "Review PR #1135",
                    }
                )

        self.assertEqual((session_id, response), ("session-test", "ok"))
        self.assertEqual(events, ["discover", "agent"])


if __name__ == "__main__":
    unittest.main()
