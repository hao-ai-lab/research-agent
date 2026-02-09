import asyncio
import importlib.util
import os
import tempfile
import time
import unittest

import httpx

_SERVER_PATH = os.path.join(os.path.dirname(__file__), "..", "server", "server.py")
_SPEC = importlib.util.spec_from_file_location("research_agent_server", _SERVER_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load server module from {_SERVER_PATH}")
srv = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(srv)


class ChatStreamPersistenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Disable auth middleware for isolated tests.
        srv.USER_AUTH_TOKEN = None

        workdir = tempfile.mkdtemp(prefix="chat-stream-persist-")
        srv.init_paths(workdir)

        # Reset mutable server state.
        srv.chat_sessions.clear()
        srv.chat_streams.clear()
        srv.active_chat_stream_by_session.clear()
        srv.session_stop_flags.clear()
        srv.active_chat_tasks.clear()

        # Keep originals for restore.
        self._orig_get_session = srv.get_opencode_session_for_chat
        self._orig_send_prompt = srv.send_prompt_to_opencode
        self._orig_stream_events = srv.stream_opencode_events

    def tearDown(self):
        srv.get_opencode_session_for_chat = self._orig_get_session
        srv.send_prompt_to_opencode = self._orig_send_prompt
        srv.stream_opencode_events = self._orig_stream_events

    def _patch_fake_opencode(self, *, chunk_count: int, delay_s: float):
        async def fake_get_opencode_session_for_chat(_chat_session_id: str) -> str:
            return "mock-session"

        async def fake_send_prompt_to_opencode(_client, _session_id: str, _content: str):
            return

        async def fake_stream_opencode_events(_client, _session_id: str):
            for i in range(chunk_count):
                await asyncio.sleep(delay_s)
                delta = f"chunk{i} "
                event = {"type": "part_delta", "id": "text-1", "ptype": "text", "delta": delta}
                yield event, delta, "", None
            done = {"type": "session_status", "status": "idle", "_done": True}
            yield done, "", "", None

        srv.get_opencode_session_for_chat = fake_get_opencode_session_for_chat
        srv.send_prompt_to_opencode = fake_send_prompt_to_opencode
        srv.stream_opencode_events = fake_stream_opencode_events

    async def _create_session(self, client: httpx.AsyncClient) -> str:
        response = await client.post("/sessions", json={})
        response.raise_for_status()
        return response.json()["id"]

    async def _wait_for_terminal_stream_status(
        self, client: httpx.AsyncClient, session_id: str, timeout_s: float = 4.0
    ) -> dict:
        deadline = asyncio.get_running_loop().time() + timeout_s
        latest = None
        while asyncio.get_running_loop().time() < deadline:
            response = await client.get(f"/sessions/{session_id}/stream/status")
            response.raise_for_status()
            latest = response.json().get("latest_stream")
            if latest and latest.get("status") in {"completed", "error", "stopped", "interrupted"}:
                return latest
            await asyncio.sleep(0.05)
        self.fail(f"Timed out waiting for terminal stream status (last={latest})")

    async def test_disconnect_does_not_stop_backend_stream(self):
        self._patch_fake_opencode(chunk_count=6, delay_s=0.08)

        transport = httpx.ASGITransport(app=srv.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=None) as client:
            session_id = await self._create_session(client)

            # Start stream and disconnect client after first event.
            async with client.stream(
                "POST",
                "/chat",
                json={"session_id": session_id, "message": "hello", "wild_mode": False},
            ) as response:
                self.assertEqual(response.status_code, 200)
                async for line in response.aiter_lines():
                    if line.strip():
                        break

            latest = await self._wait_for_terminal_stream_status(client, session_id)
            self.assertEqual(latest.get("status"), "completed")

            session_response = await client.get(f"/sessions/{session_id}")
            session_response.raise_for_status()
            messages = session_response.json()["messages"]
            self.assertGreaterEqual(len(messages), 2)
            assistant = messages[-1]
            self.assertEqual(assistant["role"], "assistant")
            self.assertEqual(assistant["content"].strip(), "chunk0 chunk1 chunk2 chunk3 chunk4 chunk5")

    async def test_explicit_stop_stops_stream(self):
        self._patch_fake_opencode(chunk_count=30, delay_s=0.08)

        transport = httpx.ASGITransport(app=srv.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=None) as client:
            session_id = await self._create_session(client)
            srv.chat_sessions[session_id]["messages"].append(
                {"role": "user", "content": "hello", "timestamp": time.time()}
            )
            srv.save_chat_state()

            stream_id = srv._create_chat_stream_task(session_id, "[USER] hello")
            self.assertTrue(stream_id)
            await asyncio.sleep(0.18)
            stop_response = await client.post(f"/sessions/{session_id}/stop")
            stop_response.raise_for_status()

            latest = await self._wait_for_terminal_stream_status(client, session_id)
            self.assertEqual(latest.get("status"), "stopped")

            session_response = await client.get(f"/sessions/{session_id}")
            session_response.raise_for_status()
            messages = session_response.json()["messages"]
            self.assertGreaterEqual(len(messages), 2)
            assistant = messages[-1]
            self.assertEqual(assistant["role"], "assistant")
            self.assertIn("chunk0", assistant["content"])
            self.assertNotIn("chunk29", assistant["content"])


if __name__ == "__main__":
    unittest.main()
