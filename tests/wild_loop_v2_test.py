"""Tests for wild_loop_v2.py — ralph-style engine."""

import asyncio
import json
import os
import sys
import tempfile
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))

from wild_loop_v2 import (
    WildV2Engine,
    WildV2Session,
    parse_plan,
    parse_promise,
    parse_summary,
)
from v2_prompts import PromptContext, build_planning_prompt, build_iteration_prompt


# ---------------------------------------------------------------------------
# Signal Parsers
# ---------------------------------------------------------------------------

class TestParsePromise:
    def test_done(self):
        assert parse_promise("Some text\n<promise>DONE</promise>\nMore") == "DONE"

    def test_waiting(self):
        assert parse_promise("Waiting for runs\n<promise>WAITING</promise>") == "WAITING"

    def test_case_insensitive_value(self):
        assert parse_promise("<promise>done</promise>") == "DONE"

    def test_none(self):
        assert parse_promise("No promise here") is None

    def test_multiline(self):
        assert parse_promise("<promise>\nDONE\n</promise>") == "DONE"


class TestParsePlan:
    def test_extracts_plan(self):
        text = "work done\n<plan>\n# Plan\n- [x] Step 1\n- [ ] Step 2\n</plan>\nend"
        plan = parse_plan(text)
        assert "Step 1" in plan
        assert "Step 2" in plan

    def test_none(self):
        assert parse_plan("no plan tags") is None


class TestParseSummary:
    def test_extracts_summary(self):
        text = "response\n<summary>Did some work on the project.</summary>\nmore"
        assert parse_summary(text) == "Did some work on the project."

    def test_none(self):
        assert parse_summary("no summary") is None


# ---------------------------------------------------------------------------
# WildV2Session
# ---------------------------------------------------------------------------

class TestWildV2Session:
    def test_defaults(self):
        s = WildV2Session(session_id="test-1", goal="Build a model")
        assert s.status == "running"
        assert s.iteration == 0
        assert s.max_iterations == 25
        assert s.plan == ""
        assert s.history == []

    def test_to_dict(self):
        s = WildV2Session(session_id="s1", goal="Test")
        d = s.to_dict()
        assert d["session_id"] == "s1"
        assert d["goal"] == "Test"
        assert "status" in d


# ---------------------------------------------------------------------------
# WildV2Engine — unit tests (no real OpenCode)
# ---------------------------------------------------------------------------

class TestWildV2Engine:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.engine = WildV2Engine(
            get_workdir=lambda: self.tmpdir,
            server_url="http://localhost:10000",
        )

    def test_start_creates_session(self):
        result = self.engine.start(goal="Train a model", max_iterations=5)
        assert result["goal"] == "Train a model"
        assert result["status"] == "running"
        assert result["max_iterations"] == 5
        assert self.engine.session is not None

        # Check session dir created
        sid = result["session_id"]
        session_dir = os.path.join(self.tmpdir, ".agents", "wild", sid)
        assert os.path.isdir(session_dir)

        # Check tasks.md created (replaces old plan.md)
        tasks_path = os.path.join(session_dir, "tasks.md")
        assert os.path.isfile(tasks_path)
        with open(tasks_path) as f:
            assert "Train a model" in f.read()

        # Check iteration_log.md created
        log_path = os.path.join(session_dir, "iteration_log.md")
        assert os.path.isfile(log_path)
        with open(log_path) as f:
            content = f.read()
            assert "Train a model" in content
            assert "Iteration Log" in content

        self.engine.stop()

    def test_set_server_url_updates_prompt_context(self):
        self.engine.set_server_url("https://preview.example.com/api")
        self.engine.start(goal="Server URL test")
        ctx = self.engine._build_context(self.engine.session)
        assert ctx.server_url == "https://preview.example.com/api"
        self.engine.stop()

    def test_stop(self):
        self.engine.start(goal="Test", max_iterations=3)
        result = self.engine.stop()
        assert result["status"] == "done"
        assert result["finished_at"] is not None

    def test_pause_resume(self):
        self.engine.start(goal="Test", max_iterations=3)
        self.engine.pause()
        assert self.engine.session.status == "paused"

        self.engine.resume()
        assert self.engine.session.status == "running"
        self.engine.stop()

    def test_steer(self):
        self.engine.start(goal="Test", max_iterations=3)
        self.engine.steer("Focus on data preprocessing")
        assert self.engine.session.steer_context == "Focus on data preprocessing"

        ctx_path = os.path.join(
            self.tmpdir, ".agents", "wild",
            self.engine.session.session_id, "context.md"
        )
        assert os.path.isfile(ctx_path)
        with open(ctx_path) as f:
            assert "data preprocessing" in f.read()

        self.engine.stop()

    def test_get_status_inactive(self):
        status = self.engine.get_status()
        assert status["active"] is False

    def test_get_status_active(self):
        self.engine.start(goal="Test")
        status = self.engine.get_status()
        assert status["active"] is True
        assert status["goal"] == "Test"
        self.engine.stop()

    def test_system_health_from_runs_static(self):
        runs = {
            "r1": {"status": "running"},
            "r2": {"status": "finished"},
            "r3": {"status": "queued"},
            "r4": {"status": "failed"},
        }
        health = WildV2Engine.get_system_health_from_runs(runs)
        assert health["running"] == 1
        assert health["completed"] == 1
        assert health["queued"] == 1
        assert health["failed"] == 1
        assert health["total"] == 4

    def test_system_health_empty(self):
        health = WildV2Engine.get_system_health_from_runs({})
        assert health["running"] == 0
        assert health["total"] == 0

    def test_build_prompt_with_render_fn(self):
        """Verify prompts use render_fn when provided."""
        def mock_render(skill_id, variables):
            return f"RENDERED:{skill_id}:{variables['goal']}"

        engine = WildV2Engine(
            get_workdir=lambda: self.tmpdir,
            server_url="http://localhost:10000",
            render_fn=mock_render,
        )
        engine.start(goal="Test render")
        ctx = engine._build_context(engine.session)
        prompt = build_planning_prompt(ctx, render_fn=mock_render)
        assert prompt == "RENDERED:wild_v2_planning:Test render"

        prompt = build_iteration_prompt(ctx, render_fn=mock_render)
        assert prompt == "RENDERED:wild_v2_iteration:Test render"
        engine.stop()

    def test_prompt_fallback_without_render_fn(self):
        """Verify prompts fall back to inline templates without render_fn."""
        self.engine.start(goal="Fallback test")
        ctx = self.engine._build_context(self.engine.session)
        prompt = build_planning_prompt(ctx)  # no render_fn
        assert "Fallback test" in prompt
        assert "iteration 0" in prompt.lower() or "planning" in prompt.lower()
        self.engine.stop()

    def test_api_catalog_in_prompt(self):
        """Verify the API catalog appears in iteration prompts."""
        self.engine.start(goal="API catalog test")
        ctx = self.engine._build_context(self.engine.session)
        ctx.iteration = 1
        prompt = build_iteration_prompt(ctx)  # fallback
        assert "/sweeps/wild" in prompt
        assert "/runs" in prompt
        assert "/wild/v2/events" in prompt
        assert "/wild/v2/system-health" in prompt
        self.engine.stop()

    def test_save_and_load_state(self):
        self.engine.start(goal="Persist test", max_iterations=10)
        sid = self.engine.session.session_id
        self.engine.session.iteration = 5
        self.engine._save_state(sid)

        state_path = os.path.join(self.tmpdir, ".agents", "wild", sid, "state.json")
        assert os.path.isfile(state_path)

        with open(state_path) as f:
            data = json.load(f)
        assert data["iteration"] == 5
        assert data["goal"] == "Persist test"
        self.engine.stop()


# ---------------------------------------------------------------------------
# Async loop tests  (mock OpenCode)
# ---------------------------------------------------------------------------

def test_loop_done_signal():
    """Agent returns DONE after one iteration — loop should complete."""

    async def _run():
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000")

        call_count = 0

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning response
                return (
                    "Explored codebase.\n\n"
                    "<plan>\n# Tasks\n- [ ] Do the thing\n</plan>\n"
                    "<summary>Planning done.</summary>"
                )
            # Execution response — DONE
            return (
                "I completed the task.\n\n"
                "<summary>Finished everything.</summary>\n"
                "<plan>\n# Done\n- [x] All done\n</plan>\n"
                "<promise>DONE</promise>"
            )

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        engine.start(goal="Quick test", max_iterations=5)

        # Cancel the auto-started task and run manually
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        assert engine.session.iteration == 1  # 1 execution iteration
        # tasks.md on disk should exist
        tasks_path = os.path.join(
            tmpdir, ".agents", "wild", engine.session.session_id, "tasks.md"
        )
        assert os.path.isfile(tasks_path)
        # History should be: planning (iter 0) + execution (iter 1)
        assert len(engine.session.history) == 2
        assert engine.session.history[0]["iteration"] == 0  # planning
        assert engine.session.history[1]["promise"] == "DONE"
        assert "duration_s" in engine.session.history[1]
        assert "files_modified" in engine.session.history[1]
        assert "error_count" in engine.session.history[1]

        # Iteration log should have been written
        log_path = os.path.join(
            tmpdir, ".agents", "wild", engine.session.session_id, "iteration_log.md"
        )
        assert os.path.isfile(log_path)
        with open(log_path) as f:
            log_content = f.read()
        assert "Iteration 1" in log_content
        assert "DONE" in log_content

    asyncio.run(_run())


def test_loop_max_iterations():
    """Loop stops after max iterations without DONE."""

    async def _run():
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000")

        call_count = 0

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning response
                return "Explored.\n<plan># Tasks\n- [ ] Continue</plan>\n<summary>Planned.</summary>"
            return "Working on it.\n<summary>More work.</summary>\n<plan># Plan\n- [ ] Continue</plan>"

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        engine.start(goal="Test", max_iterations=3)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        assert engine.session.iteration == 3
        # History: planning (0) + 3 execution iterations
        assert len(engine.session.history) == 4

    asyncio.run(_run())


def test_loop_waiting_signal():
    """Agent returns WAITING — engine should sleep briefly (mocked) and continue."""

    async def _run():
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000")

        call_count = 0

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning response
                return "Explored.\n<plan># Tasks\n- [ ] Wait then do</plan>\n<summary>Planned.</summary>"
            if call_count == 2:
                return "Waiting.\n<summary>Waiting for runs.</summary>\n<promise>WAITING</promise>"
            return "Done.\n<summary>Finished.</summary>\n<promise>DONE</promise>"

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        engine.start(goal="Test", max_iterations=5, wait_seconds=0.1)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        assert engine.session.iteration == 2
        # History: planning (0) + WAITING (1) + DONE (2)
        assert len(engine.session.history) == 3
        assert engine.session.history[0]["iteration"] == 0  # planning
        assert engine.session.history[1]["promise"] == "WAITING"
        assert engine.session.history[2]["promise"] == "DONE"

    asyncio.run(_run())
