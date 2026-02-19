"""Tests for wild_loop_v2.py — WildV2Engine with mock backend."""
import asyncio
import json
import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from wild_loop_v2 import WildV2Engine, WildV2Session


# ---------------------------------------------------------------------------
# Mock AgentBackend
# ---------------------------------------------------------------------------

class MockBackend:
    """Mock agent backend that returns pre-configured responses."""

    def __init__(self, responses: list[str]):
        self.responses = responses
        self.prompt_log: list[tuple[str, str]] = []
        self._idx = 0
        self._session_counter = 0

    async def create_session(self, workdir: str) -> str:
        self._session_counter += 1
        return f"mock-session-{self._session_counter}"

    async def send_prompt(self, session_id: str, prompt: str) -> str:
        self.prompt_log.append((session_id, prompt))
        text = self.responses[self._idx % len(self.responses)]
        self._idx += 1
        return text

    async def abort_session(self, session_id: str) -> None:
        pass


def _mock_render_fn(template_name: str, variables: dict) -> str:
    """Simple mock render_fn that returns a basic prompt string."""
    goal = variables.get("goal", "unknown")
    iteration = variables.get("iteration", "?")
    return f"[{template_name}] Goal: {goal}, Iteration: {iteration}"


# ---------------------------------------------------------------------------
# WildV2Session tests
# ---------------------------------------------------------------------------

class TestWildV2Session(unittest.TestCase):
    """Tests for the session dataclass."""

    def test_default_values(self):
        s = WildV2Session(session_id="test-1", goal="Do something")
        self.assertEqual(s.status, "running")
        self.assertEqual(s.iteration, 0)
        self.assertEqual(s.max_iterations, 25)
        self.assertEqual(s.plan, "")
        self.assertEqual(s.history, [])
        self.assertEqual(s.autonomy_level, "balanced")

    def test_to_dict(self):
        s = WildV2Session(session_id="test-1", goal="Test goal")
        d = s.to_dict()
        self.assertEqual(d["session_id"], "test-1")
        self.assertEqual(d["goal"], "Test goal")
        self.assertEqual(d["status"], "running")
        self.assertIn("history", d)
        self.assertIn("evo_sweep_enabled", d)


# ---------------------------------------------------------------------------
# Engine lifecycle tests
# ---------------------------------------------------------------------------

class TestEngineLifecycle(unittest.TestCase):
    """Tests for start/stop/pause/resume state transitions."""

    def _make_engine(self, backend=None, workdir=None):
        if workdir is None:
            workdir = tempfile.mkdtemp()
        backend = backend or MockBackend(["<plan>test plan</plan>"])
        engine = WildV2Engine(
            backend=backend,
            get_workdir=lambda: workdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render_fn,
        )
        return engine, workdir

    def test_start_creates_session(self):
        engine, workdir = self._make_engine()
        # Patch _run_loop to avoid actually running the async loop
        with patch.object(engine, '_run_loop', new_callable=AsyncMock):
            result = engine.start("Test goal", max_iterations=3)

        self.assertIn("session_id", result)
        self.assertEqual(result["goal"], "Test goal")
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["max_iterations"], 3)

    def test_stop_sets_done(self):
        engine, workdir = self._make_engine()
        with patch.object(engine, '_run_loop', new_callable=AsyncMock):
            engine.start("Test goal")

        result = engine.stop()
        self.assertEqual(result["status"], "done")
        self.assertIsNotNone(result.get("finished_at"))

    def test_stop_without_session(self):
        engine, _ = self._make_engine()
        result = engine.stop()
        self.assertEqual(result, {"stopped": False})

    def test_pause_resume(self):
        engine, _ = self._make_engine()
        with patch.object(engine, '_run_loop', new_callable=AsyncMock):
            engine.start("Test goal")

        engine.pause()
        self.assertEqual(engine.session.status, "paused")

        with patch.object(engine, '_run_loop', new_callable=AsyncMock):
            engine.resume()
        self.assertEqual(engine.session.status, "running")

    def test_steer_sets_context(self):
        engine, _ = self._make_engine()
        with patch.object(engine, '_run_loop', new_callable=AsyncMock):
            engine.start("Test goal")

        engine.steer("Focus on tests")
        self.assertEqual(engine.session.steer_context, "Focus on tests")

    def test_is_active(self):
        engine, _ = self._make_engine()
        self.assertFalse(engine.is_active)

        with patch.object(engine, '_run_loop', new_callable=AsyncMock):
            engine.start("Test")
        self.assertTrue(engine.is_active)

        engine.stop()
        self.assertFalse(engine.is_active)


# ---------------------------------------------------------------------------
# Run loop phase tests
# ---------------------------------------------------------------------------

class TestRunLoopPhases(unittest.TestCase):
    """Tests for the decomposed loop phases using mock backend."""

    def _make_engine_and_session(self, responses, iteration=0):
        workdir = tempfile.mkdtemp()
        backend = MockBackend(responses)
        engine = WildV2Engine(
            backend=backend,
            get_workdir=lambda: workdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render_fn,
        )
        session = WildV2Session(
            session_id="test-session",
            goal="Test goal",
            started_at=time.time(),
            iteration=iteration,
        )
        engine._session = session

        # Create session dir
        session_dir = engine._session_dir(session.session_id)
        os.makedirs(session_dir, exist_ok=True)

        return engine, session, backend, workdir

    def test_planning_phase_with_plan_tag(self):
        """Planning phase should parse <plan> tag and write tasks.md."""
        plan_content = "# Tasks\n- [ ] Step 1\n- [ ] Step 2"
        response = f"<plan>{plan_content}</plan>\n<summary>Created a plan</summary>"
        engine, session, backend, workdir = self._make_engine_and_session([response])

        engine._git_commit = AsyncMock()

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine._run_planning_phase(session))
        finally:
            loop.close()

        # Verify plan was written
        tasks_path = os.path.join(engine._session_dir(session.session_id), "tasks.md")
        self.assertTrue(os.path.exists(tasks_path))
        with open(tasks_path) as f:
            content = f.read()
        self.assertEqual(content, plan_content)
        self.assertEqual(session.plan, plan_content)

        # History should have one entry
        self.assertEqual(len(session.history), 1)
        self.assertEqual(session.history[0]["iteration"], 0)

    def test_planning_phase_failure_sets_failed(self):
        """Planning phase should set status to 'failed' if send_prompt raises."""
        engine, session, _backend, _workdir = self._make_engine_and_session([""])

        engine._send_prompt = AsyncMock(side_effect=RuntimeError("Connection refused"))
        engine._git_commit = AsyncMock()

        loop = asyncio.new_event_loop()
        try:
            with self.assertRaises(RuntimeError):
                loop.run_until_complete(engine._run_planning_phase(session))
        finally:
            loop.close()

        self.assertEqual(session.status, "failed")

    def test_execution_iteration_done_promise(self):
        """Execution iteration should parse DONE promise."""
        response = "<summary>Fixed the bug</summary>\n<promise>DONE</promise>"
        engine, session, backend, workdir = self._make_engine_and_session([response])

        engine._git_commit = AsyncMock()
        engine._snapshot_files = MagicMock(return_value={})

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(engine._run_execution_iteration(session))
        finally:
            loop.close()

        self.assertIsNotNone(result)
        self.assertEqual(result["promise"], "DONE")
        self.assertEqual(session.iteration, 1)

    def test_execution_iteration_waiting_promise(self):
        """Execution iteration should parse WAITING promise."""
        response = "<summary>Waiting for data</summary>\n<promise>WAITING</promise>"
        engine, session, backend, workdir = self._make_engine_and_session([response])

        engine._git_commit = AsyncMock()
        engine._snapshot_files = MagicMock(return_value={})

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(engine._run_execution_iteration(session))
        finally:
            loop.close()

        self.assertIsNotNone(result)
        self.assertEqual(result["promise"], "WAITING")

    def test_handle_promise_done_reflection_stop(self):
        """handle_promise with DONE should run reflection and return 'break' if reflection says stop."""
        engine, session, _backend, _workdir = self._make_engine_and_session([""])
        engine._run_reflection = AsyncMock(return_value=False)

        iter_record = {"promise": "DONE", "summary": "All done"}

        loop = asyncio.new_event_loop()
        try:
            action = loop.run_until_complete(engine._handle_promise(session, iter_record))
        finally:
            loop.close()

        self.assertEqual(action, "break")
        self.assertEqual(session.status, "done")
        engine._run_reflection.assert_called_once_with(session, "All done")

    def test_handle_promise_done_reflection_continue(self):
        """handle_promise with DONE + reflection continue should return 'continue'."""
        engine, session, _backend, _workdir = self._make_engine_and_session([""])
        engine._run_reflection = AsyncMock(return_value=True)

        iter_record = {"promise": "DONE", "summary": "Partly done"}

        loop = asyncio.new_event_loop()
        try:
            action = loop.run_until_complete(engine._handle_promise(session, iter_record))
        finally:
            loop.close()

        self.assertEqual(action, "continue")
        self.assertEqual(session.status, "running")  # NOT done

    def test_handle_promise_waiting(self):
        """handle_promise with WAITING should sleep and return 'continue'."""
        engine, session, _backend, _workdir = self._make_engine_and_session([""])
        session.wait_seconds = 0.01  # Don't actually wait

        iter_record = {"promise": "WAITING", "summary": ""}

        loop = asyncio.new_event_loop()
        try:
            action = loop.run_until_complete(engine._handle_promise(session, iter_record))
        finally:
            loop.close()

        self.assertEqual(action, "continue")

    def test_handle_promise_none(self):
        """handle_promise with no promise should return 'continue'."""
        engine, session, _backend, _workdir = self._make_engine_and_session([""])

        iter_record = {"promise": None, "summary": ""}

        loop = asyncio.new_event_loop()
        try:
            action = loop.run_until_complete(engine._handle_promise(session, iter_record))
        finally:
            loop.close()

        self.assertEqual(action, "continue")


# ---------------------------------------------------------------------------
# Reflection tests
# ---------------------------------------------------------------------------

class TestReflection(unittest.TestCase):
    """Tests for the extracted reflection logic."""

    def _make_engine_and_session(self, responses):
        workdir = tempfile.mkdtemp()
        backend = MockBackend(responses)
        engine = WildV2Engine(
            backend=backend,
            get_workdir=lambda: workdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render_fn,
        )
        session = WildV2Session(
            session_id="test-session",
            goal="Test goal",
            started_at=time.time(),
            iteration=3,
        )
        engine._session = session
        os.makedirs(engine._session_dir(session.session_id), exist_ok=True)
        return engine, session

    def test_reflection_continue(self):
        """Reflection returning <continue>yes</continue> should return True."""
        response = "<reflection>Work is good</reflection>\n<continue>yes</continue>"
        engine, session = self._make_engine_and_session([response])

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(engine._run_reflection(session, "summary"))
        finally:
            loop.close()

        self.assertTrue(result)
        self.assertEqual(session.reflection, "Work is good")

    def test_reflection_stop(self):
        """Reflection returning <continue>no</continue> should return False."""
        response = "<reflection>All done here</reflection>\n<continue>no</continue>"
        engine, session = self._make_engine_and_session([response])

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(engine._run_reflection(session, "summary"))
        finally:
            loop.close()

        self.assertFalse(result)

    def test_reflection_failure_returns_false(self):
        """If reflection fails, should return False (stop)."""
        engine, session = self._make_engine_and_session([""])
        engine._send_prompt = AsyncMock(side_effect=RuntimeError("Connection lost"))

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(engine._run_reflection(session, "summary"))
        finally:
            loop.close()

        self.assertFalse(result)

    def test_memory_extraction(self):
        """Memories should be extracted and stored from reflection output."""
        response = (
            "<reflection>Learned a lot</reflection>\n"
            "<continue>no</continue>\n"
            "<memories>\n"
            "- [lesson] Always validate inputs\n"
            "- [gotcha] The API returns 500 for empty bodies\n"
            "</memories>"
        )
        engine, session = self._make_engine_and_session([response])

        mock_store = MagicMock()
        engine.memory_store = mock_store

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine._run_reflection(session, "summary"))
        finally:
            loop.close()

        # memory_store.add should have been called for each memory
        self.assertEqual(mock_store.add.call_count, 2)

    def test_reflection_records_history(self):
        """Reflection should add a record to session history."""
        response = "<reflection>Progress</reflection>\n<continue>no</continue>"
        engine, session = self._make_engine_and_session([response])

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine._run_reflection(session, "summary"))
        finally:
            loop.close()

        self.assertEqual(len(session.history), 1)
        self.assertEqual(session.history[0]["promise"], "REFLECT_STOP")


# ---------------------------------------------------------------------------
# Struggle detection tests
# ---------------------------------------------------------------------------

class TestStruggleDetection(unittest.TestCase):

    def test_no_progress_streak(self):
        workdir = tempfile.mkdtemp()
        backend = MockBackend(["<summary>Did nothing useful</summary>"])
        engine = WildV2Engine(
            backend=backend,
            get_workdir=lambda: workdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render_fn,
        )
        session = WildV2Session(
            session_id="test",
            goal="Test",
            started_at=time.time(),
        )
        engine._session = session
        os.makedirs(engine._session_dir(session.session_id), exist_ok=True)

        engine._git_commit = AsyncMock()
        # Both snapshots return the same thing → no changes
        engine._snapshot_files = MagicMock(return_value={"file.py": "abc123"})

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine._run_execution_iteration(session))
        finally:
            loop.close()

        self.assertEqual(session.no_progress_streak, 1)

        # Run again
        backend._idx = 0  # Reset response index
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine._run_execution_iteration(session))
        finally:
            loop.close()

        self.assertEqual(session.no_progress_streak, 2)


# ---------------------------------------------------------------------------
# Steer context tests
# ---------------------------------------------------------------------------

class TestSteerContext(unittest.TestCase):

    def test_steer_context_cleared_after_iteration(self):
        workdir = tempfile.mkdtemp()
        backend = MockBackend(["<summary>Done</summary>"])
        engine = WildV2Engine(
            backend=backend,
            get_workdir=lambda: workdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render_fn,
        )
        session = WildV2Session(
            session_id="test",
            goal="Test",
            started_at=time.time(),
            steer_context="Focus on performance",
        )
        engine._session = session
        os.makedirs(engine._session_dir(session.session_id), exist_ok=True)

        engine._git_commit = AsyncMock()
        engine._snapshot_files = MagicMock(return_value={})

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine._run_execution_iteration(session))
        finally:
            loop.close()

        self.assertEqual(session.steer_context, "")


if __name__ == "__main__":
    unittest.main()
