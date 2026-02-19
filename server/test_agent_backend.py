"""Tests for agent_backend.py — AgentBackend protocol and OpenCodeBackend."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from agent_backend import (
    AgentBackend,
    OpenCodeBackend,
    parse_opencode_event,
    _extract_tool_name,
    _coerce_tool_text,
    _extract_tool_data,
)


# ---------------------------------------------------------------------------
# parse_opencode_event tests
# ---------------------------------------------------------------------------

class TestParseOpenCodeEvent(unittest.TestCase):
    """Tests for the SSE event parser."""

    def test_text_delta(self):
        event = {
            "payload": {
                "type": "message.part.delta",
                "properties": {
                    "sessionID": "s1",
                    "delta": "Hello ",
                    "field": "text",
                    "partID": "p1",
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNotNone(result)
        self.assertEqual(result["type"], "part_delta")
        self.assertEqual(result["ptype"], "text")
        self.assertEqual(result["delta"], "Hello ")

    def test_reasoning_delta(self):
        event = {
            "payload": {
                "type": "message.part.delta",
                "properties": {
                    "sessionID": "s1",
                    "delta": "thinking...",
                    "field": "reasoning",
                    "partID": "p2",
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNotNone(result)
        self.assertEqual(result["ptype"], "reasoning")
        self.assertEqual(result["delta"], "thinking...")

    def test_wrong_session_returns_none(self):
        event = {
            "payload": {
                "type": "message.part.delta",
                "properties": {
                    "sessionID": "other-session",
                    "delta": "nope",
                    "field": "text",
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNone(result)

    def test_session_idle_done(self):
        event = {
            "payload": {
                "type": "session.status",
                "properties": {
                    "sessionID": "s1",
                    "status": {"type": "idle"},
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNotNone(result)
        self.assertEqual(result["type"], "session_status")
        self.assertTrue(result.get("_done"))

    def test_empty_delta_returns_none(self):
        event = {
            "payload": {
                "type": "message.part.delta",
                "properties": {
                    "sessionID": "s1",
                    "delta": "",
                    "field": "text",
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNone(result)

    def test_non_dict_payload_returns_none(self):
        result = parse_opencode_event({"payload": "not-a-dict"}, "s1")
        self.assertIsNone(result)

    def test_tool_part_updated(self):
        event = {
            "payload": {
                "type": "message.part.updated",
                "properties": {
                    "sessionID": "s1",
                    "part": {
                        "type": "tool",
                        "id": "t1",
                        "name": "read_file",
                        "state": {"status": "running"},
                    },
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNotNone(result)
        self.assertEqual(result["type"], "part_update")
        self.assertEqual(result["ptype"], "tool")
        self.assertEqual(result["name"], "read_file")

    def test_text_part_updated(self):
        event = {
            "payload": {
                "type": "message.part.updated",
                "properties": {
                    "sessionID": "s1",
                    "delta": "world",
                    "part": {"type": "text", "id": "p1"},
                },
            }
        }
        result = parse_opencode_event(event, "s1")
        self.assertIsNotNone(result)
        self.assertEqual(result["ptype"], "text")
        self.assertEqual(result["delta"], "world")


# ---------------------------------------------------------------------------
# Helper function tests
# ---------------------------------------------------------------------------

class TestExtractToolName(unittest.TestCase):

    def test_name_field(self):
        self.assertEqual(_extract_tool_name({"name": "read_file"}), "read_file")

    def test_tool_field(self):
        self.assertEqual(_extract_tool_name({"tool": "write_file"}), "write_file")

    def test_state_title(self):
        self.assertEqual(
            _extract_tool_name({"state": {"title": "Execute Command"}}),
            "Execute Command",
        )

    def test_none_for_empty(self):
        self.assertIsNone(_extract_tool_name({}))
        self.assertIsNone(_extract_tool_name({"name": ""}))


class TestCoerceToolText(unittest.TestCase):

    def test_string_passthrough(self):
        self.assertEqual(_coerce_tool_text("hello"), "hello")

    def test_none_passthrough(self):
        self.assertIsNone(_coerce_tool_text(None))

    def test_dict_to_json(self):
        result = _coerce_tool_text({"key": "val"})
        parsed = json.loads(result)
        self.assertEqual(parsed["key"], "val")


class TestExtractToolData(unittest.TestCase):

    def test_basic_extraction(self):
        part = {
            "state": {
                "status": "completed",
                "input": {"path": "/tmp/file.txt"},
                "output": "file contents",
                "time": {"start": 1000, "end": 1500},
            }
        }
        data = _extract_tool_data(part)
        self.assertEqual(data["tool_status"], "completed")
        self.assertIn("/tmp/file.txt", data["tool_input"])
        self.assertEqual(data["tool_output"], "file contents")
        self.assertEqual(data["tool_duration_ms"], 500)

    def test_missing_state(self):
        data = _extract_tool_data({})
        self.assertIsNone(data["tool_status"])
        self.assertIsNone(data["tool_input"])


# ---------------------------------------------------------------------------
# OpenCodeBackend tests
# ---------------------------------------------------------------------------

class TestOpenCodeBackend(unittest.TestCase):

    def test_protocol_compliance(self):
        """OpenCodeBackend should satisfy the AgentBackend protocol."""
        backend = OpenCodeBackend()
        self.assertIsInstance(backend, AgentBackend)

    def test_properties(self):
        backend = OpenCodeBackend(
            url="http://localhost:9999",
            model_provider="test-provider",
            model_id="test-model",
        )
        self.assertEqual(backend.url, "http://localhost:9999")
        self.assertEqual(backend.model_provider, "test-provider")
        self.assertEqual(backend.model_id, "test-model")
        self.assertEqual(backend.events_url, "http://localhost:9999/global/event")

    def test_create_session_success(self):
        """create_session should POST to /session and return the ID."""
        backend = OpenCodeBackend(url="http://mock:4096")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "sess-123"}
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock()

        with patch("agent_backend.httpx.AsyncClient", return_value=mock_client):
            result = asyncio.get_event_loop().run_until_complete(
                backend.create_session("/tmp/workdir")
            )

        self.assertEqual(result, "sess-123")
        mock_client.post.assert_called_once()

    def test_create_session_failure(self):
        """create_session should return None on failure."""
        backend = OpenCodeBackend(url="http://mock:4096")

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=Exception("connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock()

        with patch("agent_backend.httpx.AsyncClient", return_value=mock_client):
            result = asyncio.get_event_loop().run_until_complete(
                backend.create_session("/tmp/workdir")
            )

        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
