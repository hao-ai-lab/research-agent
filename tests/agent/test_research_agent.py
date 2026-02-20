"""Tests for ResearchAgent — the new agent-based wild loop."""

import asyncio
import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server'))

from agent.core.agent import AgentStatus
from agent.core.runtime import AgentRuntime
from agent.research_agent import ResearchAgent, WildV2Engine, ResearchSession


# ── Helpers ───────────────────────────────────────────────────────

def _mock_render(skill_id, variables):
    """Simple render function for tests."""
    return f"[{skill_id}] Goal: {variables.get('goal', '?')}"


def _make_config(tmpdir, render_fn=None, send_chat_message=None):
    """Build config dict for ResearchAgent."""
    return {
        "get_workdir": lambda: tmpdir,
        "server_url": "http://localhost:10000",
        "render_fn": render_fn or _mock_render,
        "send_chat_message": send_chat_message,
        "max_iterations": 5,
    }


# ── Session State Tests ──────────────────────────────────────────

class TestResearchSession:
    def test_defaults(self):
        s = ResearchSession(session_id="test-1", goal="Build a model")
        assert s.status == "running"
        assert s.iteration == 0
        assert s.max_iterations == 25
        assert s.plan == ""
        assert s.history == []

    def test_to_dict(self):
        s = ResearchSession(session_id="s1", goal="Test")
        d = s.to_dict()
        assert d["session_id"] == "s1"
        assert d["goal"] == "Test"
        assert "status" in d


# ── ResearchAgent via Runtime Tests ──────────────────────────────

class TestResearchAgentLoop:
    """Test the research loop using mock OpenCode."""

    @pytest.mark.asyncio
    async def test_done_signal(self):
        """Agent returns DONE after one iteration — reflection stops."""
        tmpdir = tempfile.mkdtemp()
        call_count = 0

        async def mock_send(_chat_id, prompt, display_msg):
            nonlocal call_count
            call_count += 1
            if call_count == 1:  # Planning
                return (
                    "Explored codebase.\n\n"
                    "<plan>\n# Tasks\n- [ ] Do the thing\n</plan>\n"
                    "<summary>Planning done.</summary>"
                )
            if call_count == 2:  # Execution — DONE
                return (
                    "I completed the task.\n\n"
                    "<summary>Finished everything.</summary>\n"
                    "<plan>\n# Done\n- [x] All done\n</plan>\n"
                    "<promise>DONE</promise>"
                )
            # Reflection — STOP
            return (
                "<reflection>All work is complete. Progress is 100%.\n"
                "Lessons: test first.</reflection>\n"
                "<continue>no</continue>"
            )

        config = _make_config(tmpdir, send_chat_message=mock_send)
        config["chat_session_id"] = "test-chat"
        config["max_iterations"] = 5

        runtime = AgentRuntime()
        agent = await runtime.spawn(
            ResearchAgent,
            goal="Quick test",
            config=config,
        )

        # Wait for completion
        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        assert agent._session is not None
        assert agent._session.status == "done"
        assert agent._session.iteration == 1
        assert len(agent._session.history) == 3  # planning + exec + reflection
        assert agent._session.history[1]["promise"] == "DONE"
        assert agent._session.history[2]["promise"] == "REFLECT_STOP"
        assert agent._session.reflection != ""

        # Check files on disk
        tasks_path = os.path.join(tmpdir, ".agents", "wild", agent.id, "tasks.md")
        assert os.path.isfile(tasks_path)
        log_path = os.path.join(tmpdir, ".agents", "wild", agent.id, "iteration_log.md")
        assert os.path.isfile(log_path)

    @pytest.mark.asyncio
    async def test_max_iterations(self):
        """Loop stops after max iterations without DONE."""
        tmpdir = tempfile.mkdtemp()
        call_count = 0

        async def mock_send(_chat_id, prompt, display_msg):
            nonlocal call_count
            call_count += 1
            if call_count == 1:  # Planning
                return "Explored.\n<plan># Tasks\n- [ ] Continue</plan>\n<summary>Planned.</summary>"
            return "Working.\n<summary>More work.</summary>\n<plan># Plan\n- [ ] Continue</plan>"

        config = _make_config(tmpdir, send_chat_message=mock_send)
        config["chat_session_id"] = "test-chat"
        config["max_iterations"] = 3

        runtime = AgentRuntime()
        agent = await runtime.spawn(ResearchAgent, goal="Test", config=config)

        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=15.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        assert agent._session.status == "done"
        assert agent._session.iteration == 3
        assert len(agent._session.history) == 4  # planning + 3 exec

    @pytest.mark.asyncio
    async def test_waiting_signal(self):
        """WAITING signal causes brief sleep then continue."""
        tmpdir = tempfile.mkdtemp()
        call_count = 0

        async def mock_send(_chat_id, prompt, display_msg):
            nonlocal call_count
            call_count += 1
            if call_count == 1:  # Planning
                return "Explored.\n<plan># Tasks\n- [ ] Wait then do</plan>\n<summary>Planned.</summary>"
            if call_count == 2:  # WAITING
                return "Waiting.\n<summary>Waiting for runs.</summary>\n<promise>WAITING</promise>"
            if call_count == 3:  # DONE
                return "Done.\n<summary>Finished.</summary>\n<promise>DONE</promise>"
            # Reflection — STOP
            return "<reflection>Complete.</reflection>\n<continue>no</continue>"

        config = _make_config(tmpdir, send_chat_message=mock_send)
        config["chat_session_id"] = "test-chat"
        config["max_iterations"] = 5
        config["wait_seconds"] = 0.1  # Fast for testing

        runtime = AgentRuntime()
        agent = await runtime.spawn(ResearchAgent, goal="Test", config=config)

        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        assert agent._session.status == "done"
        assert agent._session.iteration == 2
        assert agent._session.history[1]["promise"] == "WAITING"
        assert agent._session.history[2]["promise"] == "DONE"

    @pytest.mark.asyncio
    async def test_reflection_continue(self):
        """DONE → reflection says continue → resumes for one more."""
        tmpdir = tempfile.mkdtemp()
        call_count = 0

        async def mock_send(_chat_id, prompt, display_msg):
            nonlocal call_count
            call_count += 1
            if call_count == 1:  # Planning
                return "Explored.\n<plan># Tasks\n- [ ] Step 1\n- [ ] Step 2</plan>\n<summary>Planned.</summary>"
            if call_count == 2:  # Iter 1 — DONE
                return "Step 1 done.\n<summary>Did step 1.</summary>\n<promise>DONE</promise>"
            if call_count == 3:  # Reflection — CONTINUE
                return (
                    "<reflection>Step 1 complete but Step 2 remains. Progress: 50%.\n"
                    "Should continue.</reflection>\n<continue>yes</continue>"
                )
            if call_count == 4:  # Iter 2 — DONE
                return "Step 2 done.\n<summary>Did step 2.</summary>\n<promise>DONE</promise>"
            # Reflection — STOP
            return "<reflection>All done. 100% progress.</reflection>\n<continue>no</continue>"

        config = _make_config(tmpdir, send_chat_message=mock_send)
        config["chat_session_id"] = "test-chat"
        config["max_iterations"] = 10

        runtime = AgentRuntime()
        agent = await runtime.spawn(ResearchAgent, goal="Two step", config=config)

        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        assert agent._session.status == "done"
        assert agent._session.iteration == 2
        assert len(agent._session.history) == 5  # plan + exec + reflect_continue + exec + reflect_stop
        assert agent._session.history[2]["promise"] == "REFLECT_CONTINUE"
        assert agent._session.history[4]["promise"] == "REFLECT_STOP"


# ── ResearchAgent API Helper Tests ───────────────────────────────

class TestResearchAgentAPI:
    @pytest.mark.asyncio
    async def test_get_status_inactive(self):
        """No agent = inactive."""
        agent = ResearchAgent(goal="test", config={"get_workdir": lambda: "/tmp"})
        status = agent.get_status()
        assert status["active"] is False

    @pytest.mark.asyncio
    async def test_system_health(self):
        runs = {
            "r1": {"status": "running"},
            "r2": {"status": "finished"},
            "r3": {"status": "queued"},
            "r4": {"status": "failed"},
        }
        health = ResearchAgent.get_system_health_from_runs(runs)
        assert health["running"] == 1
        assert health["completed"] == 1
        assert health["queued"] == 1
        assert health["failed"] == 1


# ── WildV2Engine Facade Tests ────────────────────────────────────

class TestWildV2EngineFacade:
    """Ensure the backward-compatible facade still works."""

    def test_start_creates_session(self):
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render,
        )
        result = engine.start(goal="Train a model", max_iterations=5)
        assert result["goal"] == "Train a model"
        assert result["max_iterations"] == 5
        assert engine.session is not None

        session_dir = os.path.join(tmpdir, ".agents", "wild", engine.session.session_id)
        assert os.path.isdir(session_dir)
        assert os.path.isfile(os.path.join(session_dir, "tasks.md"))
        assert os.path.isfile(os.path.join(session_dir, "iteration_log.md"))

        engine.stop()

    def test_stop(self):
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render,
        )
        engine.start(goal="Test", max_iterations=3)
        result = engine.stop()
        assert result["status"] == "done"
        assert result["finished_at"] is not None

    def test_pause_resume(self):
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render,
        )
        engine.start(goal="Test", max_iterations=3)
        engine.pause()
        assert engine.session.status == "paused"

        engine.resume()
        assert engine.session.status == "running"
        engine.stop()

    def test_steer(self):
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render,
        )
        engine.start(goal="Test", max_iterations=3)
        engine.steer("Focus on data preprocessing")
        assert engine.session.steer_context == "Focus on data preprocessing"

        ctx_path = os.path.join(
            tmpdir, ".agents", "wild",
            engine.session.session_id, "context.md"
        )
        assert os.path.isfile(ctx_path)
        engine.stop()

    def test_get_status_inactive(self):
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
        )
        status = engine.get_status()
        assert status["active"] is False

    def test_system_health_static(self):
        runs = {
            "r1": {"status": "running"},
            "r2": {"status": "finished"},
        }
        health = WildV2Engine.get_system_health_from_runs(runs)
        assert health["running"] == 1
        assert health["completed"] == 1
        assert health["total"] == 2

    def test_save_state(self):
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=_mock_render,
        )
        engine.start(goal="Persist test", max_iterations=10)
        sid = engine.session.session_id
        engine.session.iteration = 5
        engine._agent._save_state(sid)

        state_path = os.path.join(tmpdir, ".agents", "wild", sid, "state.json")
        assert os.path.isfile(state_path)

        with open(state_path) as f:
            data = json.load(f)
        assert data["iteration"] == 5
        assert data["goal"] == "Persist test"
        engine.stop()
