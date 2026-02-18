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
    parse_analysis,
    parse_plan,
    parse_promise,
    parse_reflection,
    parse_replan,
    parse_summary,
)
from v2_prompts import (
    PromptContext,
    build_analysis_prompt,
    build_iteration_prompt,
    build_planning_prompt,
    build_reflection_prompt,
    parse_continue,
    parse_reflection,
)


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
        """Verify prompts use a render_fn that returns goal-containing text."""
        def mock_render(skill_id, variables):
            return f"[{skill_id}] Goal: {variables.get('goal', '?')} at iteration {variables.get('iteration', 0)}"

        self.engine.start(goal="Fallback test")
        ctx = self.engine._build_context(self.engine.session)
        prompt = build_planning_prompt(ctx, render_fn=mock_render)
        assert "Fallback test" in prompt
        assert "planning" in prompt.lower()
        self.engine.stop()

    def test_api_catalog_in_prompt(self):
        """Verify the API catalog appears in iteration prompts."""
        def mock_render(skill_id, variables):
            return f"[{skill_id}] {variables.get('goal', '')} {variables.get('api_catalog', '')}"

        self.engine.start(goal="API catalog test")
        ctx = self.engine._build_context(self.engine.session)
        ctx.iteration = 1
        prompt = build_iteration_prompt(ctx, render_fn=mock_render)
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

def _mock_render(skill_id, variables):
    """Simple render function for tests — returns a minimal prompt with the goal."""
    return f"[{skill_id}] Goal: {variables.get('goal', '?')}"


def test_loop_done_signal():
    """Agent returns DONE after one iteration — reflection says stop, loop should complete."""

    async def _run():
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000", render_fn=_mock_render)

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
            if call_count == 2:
                # Execution response — DONE
                return (
                    "I completed the task.\n\n"
                    "<summary>Finished everything.</summary>\n"
                    "<plan>\n# Done\n- [x] All done\n</plan>\n"
                    "<promise>DONE</promise>"
                )
            # Reflection response — STOP
            return (
                "<reflection>All work is complete. Progress is 100%.\n"
                "Lessons: test first.</reflection>\n"
                "<continue>no</continue>"
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
        # History should be: planning (iter 0) + execution (iter 1) + reflection
        assert len(engine.session.history) == 3
        assert engine.session.history[0]["iteration"] == 0  # planning
        assert engine.session.history[1]["promise"] == "DONE"
        assert engine.session.history[2]["promise"] == "REFLECT_STOP"
        assert "duration_s" in engine.session.history[1]
        assert "files_modified" in engine.session.history[1]
        assert "error_count" in engine.session.history[1]

        # Reflection should be stored
        assert engine.session.reflection != ""
        assert "100%" in engine.session.reflection

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
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000", render_fn=_mock_render)

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
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000", render_fn=_mock_render)

        call_count = 0

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning response
                return "Explored.\n<plan># Tasks\n- [ ] Wait then do</plan>\n<summary>Planned.</summary>"
            if call_count == 2:
                return "Waiting.\n<summary>Waiting for runs.</summary>\n<promise>WAITING</promise>"
            if call_count == 3:
                return "Done.\n<summary>Finished.</summary>\n<promise>DONE</promise>"
            # Reflection response — STOP
            return "<reflection>Complete.</reflection>\n<continue>no</continue>"

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        engine.start(goal="Test", max_iterations=5, wait_seconds=0.1, auto_analysis=False)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        assert engine.session.iteration == 2
        # History: planning (0) + WAITING (1) + DONE (2) + REFLECT_STOP
        assert len(engine.session.history) == 4
        assert engine.session.history[0]["iteration"] == 0  # planning
        assert engine.session.history[1]["promise"] == "WAITING"
        assert engine.session.history[2]["promise"] == "DONE"
        assert engine.session.history[3]["promise"] == "REFLECT_STOP"

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Reflection Parsers
# ---------------------------------------------------------------------------

class TestParseReflection:
    def test_extracts_reflection(self):
        text = "Before\n<reflection>Learned a lot about the codebase.</reflection>\nAfter"
        assert parse_reflection(text) == "Learned a lot about the codebase."

    def test_multiline(self):
        text = "<reflection>\nLine 1\nLine 2\n</reflection>"
        result = parse_reflection(text)
        assert "Line 1" in result
        assert "Line 2" in result

    def test_none(self):
        assert parse_reflection("no reflection tags") is None


class TestParseContinue:
    def test_yes(self):
        assert parse_continue("<continue>yes</continue>") is True

    def test_no(self):
        assert parse_continue("<continue>no</continue>") is False

    def test_true(self):
        assert parse_continue("<continue>true</continue>") is True

    def test_false(self):
        assert parse_continue("<continue>false</continue>") is False

    def test_default_no_tag(self):
        assert parse_continue("No continue tag here") is False

    def test_case_insensitive(self):
        assert parse_continue("<continue>YES</continue>") is True
        assert parse_continue("<continue>No</continue>") is False


class TestBuildReflectionPrompt:
    def test_with_render_fn(self):
        ctx = PromptContext(
            goal="Build a model",
            iteration=3,
            max_iterations=10,
            workdir="/tmp/test",
            tasks_path="/tmp/test/tasks.md",
            log_path="/tmp/test/log.md",
            server_url="http://localhost:10000",
            session_id="s1",
        )
        def mock_render(skill_id, variables):
            return f"RENDERED:{skill_id}:goal={variables['goal']}"

        prompt = build_reflection_prompt(ctx, render_fn=mock_render, reflection_reason="Periodic check")
        assert prompt == "RENDERED:wild_v2_reflection:goal=Build a model"

    def test_fallback_without_render_fn(self):
        """Verify reflection prompt raises RuntimeError without render_fn."""
        ctx = PromptContext(
            goal="Train a model",
            iteration=2,
            max_iterations=5,
            workdir="/tmp/test",
            tasks_path="/tmp/test/tasks.md",
            log_path="/tmp/test/log.md",
            server_url="http://localhost:10000",
            session_id="s1",
        )
        # HEAD's build_reflection_prompt requires render_fn — no inline fallback
        with pytest.raises((RuntimeError, TypeError)):
            build_reflection_prompt(ctx, render_fn=None, reflection_reason="Test")


# ---------------------------------------------------------------------------
# Async Reflection Tests
# ---------------------------------------------------------------------------

def test_loop_done_with_reflection_continue():
    """Agent says DONE, reflection says continue, resumes for one more iteration."""

    async def _run():
        tmpdir = tempfile.mkdtemp()
        engine = WildV2Engine(get_workdir=lambda: tmpdir, server_url="http://localhost:10000", render_fn=_mock_render)

        call_count = 0

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning
                return "Explored.\n<plan># Tasks\n- [ ] Step 1\n- [ ] Step 2</plan>\n<summary>Planned.</summary>"
            if call_count == 2:
                # Iteration 1 — DONE
                return "Step 1 done.\n<summary>Did step 1.</summary>\n<promise>DONE</promise>"
            if call_count == 3:
                # Reflection — CONTINUE (more work to do)
                return (
                    "<reflection>Step 1 complete but Step 2 remains. Progress: 50%.\n"
                    "Should continue to finish Step 2.</reflection>\n"
                    "<continue>yes</continue>"
                )
            if call_count == 4:
                # Iteration 2 — DONE again
                return "Step 2 done.\n<summary>Did step 2.</summary>\n<promise>DONE</promise>"
            # Second reflection — STOP
            return (
                "<reflection>All done. 100% progress.</reflection>\n"
                "<continue>no</continue>"
            )

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        engine.start(goal="Two step task", max_iterations=10)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        assert engine.session.iteration == 2  # 2 execution iterations
        # History: plan(0) + exec(1) + reflect_continue + exec(2) + reflect_stop
        assert len(engine.session.history) == 5
        assert engine.session.history[1]["promise"] == "DONE"
        assert engine.session.history[2]["promise"] == "REFLECT_CONTINUE"
        assert engine.session.history[3]["promise"] == "DONE"
        assert engine.session.history[4]["promise"] == "REFLECT_STOP"

        # Last reflection is stored
        assert "100%" in engine.session.reflection

    asyncio.run(_run())


def test_planning_display_message_uses_user_goal():
    """Planning display message should show the original user goal."""

    async def _run():
        tmpdir = tempfile.mkdtemp()
        captured_display_messages = []

        async def mock_send_chat(_chat_session_id, _prompt, display_message):
            captured_display_messages.append(display_message)
            if len(captured_display_messages) == 1:
                return (
                    "<plan>\n# Tasks\n- [ ] Execute the plan\n</plan>\n"
                    "<summary>Planning done.</summary>"
                )
            return "<summary>Done.</summary>\n<promise>DONE</promise>"

        def mock_render(_skill_id, variables):
            return f"prompt for {variables['goal']}"

        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            send_chat_message=mock_send_chat,
            render_fn=mock_render,
        )
        engine._git_commit = AsyncMock()

        user_goal = "Find the best model setup for CIFAR-10 with reproducible runs."
        engine.start(goal=user_goal, chat_session_id="chat-test", max_iterations=1)

        # Cancel auto-started task and run manually for deterministic assertions.
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert captured_display_messages
        planning_display = captured_display_messages[0]
        assert "Role: plan" in planning_display
        assert f"Goal: {user_goal}" in planning_display
        assert "Task: Create a concrete step-by-step plan." in planning_display
        assert "Explore the codebase and write a concrete task checklist in tasks.md." not in planning_display

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# New signal parsers
# ---------------------------------------------------------------------------

class TestParseReflection:
    def test_extracts_reflection(self):
        text = "reviewing\n<reflection>\n## Progress: 5/10\n## Trend: IMPROVING\n</reflection>\nend"
        result = parse_reflection(text)
        assert "## Progress: 5/10" in result
        assert "IMPROVING" in result

    def test_none(self):
        assert parse_reflection("no reflection here") is None


class TestParseReplan:
    def test_extracts_replan(self):
        text = "<replan>\n# New Tasks\n- [ ] New task 1\n- [ ] New task 2\n</replan>"
        result = parse_replan(text)
        assert "New task 1" in result
        assert "New task 2" in result

    def test_none(self):
        assert parse_replan("no replan") is None


class TestParseAnalysis:
    def test_extracts_analysis(self):
        text = "analyzing results\n<analysis>\n## Run Summary\n| Run | Speedup |\n| 1 | 1.2x |\n</analysis>\nfin"
        result = parse_analysis(text)
        assert "Run Summary" in result
        assert "1.2x" in result

    def test_none(self):
        assert parse_analysis("no analysis") is None


# ---------------------------------------------------------------------------
# Session reflection & analysis fields
# ---------------------------------------------------------------------------

class TestSessionReflectionFields:
    def test_defaults(self):
        s = WildV2Session(session_id="test-r", goal="Test")
        assert s.reflections == []
        assert s.reflection_interval == 5
        assert s.analyses == []
        assert s.auto_analysis is True

    def test_custom_interval(self):
        s = WildV2Session(session_id="test-r2", goal="Test", reflection_interval=3)
        assert s.reflection_interval == 3

    def test_to_dict_includes_fields(self):
        s = WildV2Session(session_id="s1", goal="Test")
        s.reflections.append({"content": "looks good"})
        s.analyses.append({"content": "metrics summary"})
        d = s.to_dict()
        assert "reflections" in d
        assert len(d["reflections"]) == 1
        assert "analyses" in d
        assert len(d["analyses"]) == 1
        assert d["reflection_interval"] == 5
        assert d["auto_analysis"] is True

    def test_serialization_roundtrip(self):
        s = WildV2Session(session_id="s1", goal="Test", reflection_interval=3, auto_analysis=False)
        d = s.to_dict()
        j = json.dumps(d)
        loaded = json.loads(j)
        assert loaded["reflection_interval"] == 3
        assert loaded["auto_analysis"] is False


# ---------------------------------------------------------------------------
# Reflection & Analysis prompt building
# ---------------------------------------------------------------------------

class TestReflectionPrompt:
    def test_build_with_render_fn(self):
        def mock_render(skill_id, variables):
            return f"RENDERED:{skill_id}:iter={variables['iteration']}"

        ctx = PromptContext(
            goal="Optimize kernel",
            iteration=5,
            max_iterations=25,
            workdir="/tmp/test",
            tasks_path="/tmp/test/tasks.md",
            log_path="/tmp/test/log.md",
            server_url="http://localhost:10000",
            session_id="test-1",
            auth_token="tok",
            history=[{"iteration": 1, "duration_s": 60, "promise": None, "files_modified": ["a.py"], "error_count": 0, "summary": "Did stuff"}],
        )
        prompt = build_reflection_prompt(ctx, render_fn=mock_render, reflection_reason="periodic")
        assert prompt == "RENDERED:wild_v2_reflection:iter=5"


class TestAnalysisPrompt:
    def test_build_with_render_fn(self):
        def mock_render(skill_id, variables):
            return f"RENDERED:{skill_id}:metrics={variables['metrics_data'][:20]}"

        ctx = PromptContext(
            goal="Optimize kernel",
            iteration=5,
            max_iterations=25,
            workdir="/tmp/test",
            tasks_path="/tmp/test/tasks.md",
            log_path="/tmp/test/log.md",
            server_url="http://localhost:10000",
            session_id="test-1",
            auth_token="tok",
        )
        metrics = {"results/metrics.json": {"speedup": 1.2}}
        prompt = build_analysis_prompt(ctx, metrics_data=metrics, render_fn=mock_render)
        assert "RENDERED:wild_v2_analysis" in prompt


# ---------------------------------------------------------------------------
# Async loop tests — reflection integration
# ---------------------------------------------------------------------------

def test_loop_with_reflection():
    """Reflection fires at configured interval (every 3 iterations) and at end."""

    async def _run():
        tmpdir = tempfile.mkdtemp()

        def render_fn(skill_id, variables):
            # Include skill_id so tests can detect reflection/analysis prompts
            return f"RENDERED:{skill_id}:{variables.get('goal', '')}"

        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=render_fn,
        )

        call_count = 0
        reflection_prompts = []

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning
                return "Explored.\n<plan># Tasks\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3\n</plan>\n<summary>Planned.</summary>"

            # Check if this is a reflection prompt
            if "wild_v2_reflection" in prompt or "reflect" in prompt.lower():
                reflection_prompts.append(call_count)
                return (
                    "Reflecting...\n"
                    "<reflection>\n## Progress: 3/3 tasks\n## Trend: IMPROVING\n## Recommendation: CONTINUE\n</reflection>\n"
                    "<summary>Reflected on progress.</summary>"
                )

            # Regular execution — never says DONE so we hit max_iterations
            return "Working.\n<summary>Made progress.</summary>\n<plan># Tasks\n- [ ] Continue</plan>"

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        # reflection_interval=3 with max_iterations=4
        engine.start(goal="Test reflection", max_iterations=4, reflection_interval=3)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        # Should have reflections: at iter 3 (periodic) + final
        assert len(engine.session.reflections) >= 1
        # Check reflections.md file exists
        ref_path = os.path.join(
            tmpdir, ".agents", "wild", engine.session.session_id, "reflections.md"
        )
        assert os.path.isfile(ref_path)
        with open(ref_path) as f:
            content = f.read()
        assert "IMPROVING" in content

    asyncio.run(_run())


def test_loop_with_auto_analysis():
    """Auto analysis fires after WAITING transition."""

    async def _run():
        tmpdir = tempfile.mkdtemp()

        def render_fn(skill_id, variables):
            return f"RENDERED:{skill_id}:{variables.get('goal', '')}"

        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=render_fn,
        )

        call_count = 0
        analysis_prompts = []

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Planning
                return "Explored.\n<plan># Tasks\n- [ ] Run benchmark\n</plan>\n<summary>Planned.</summary>"

            # Check if this is an analysis prompt
            if "wild_v2_analysis" in prompt or "analyze" in prompt.lower():
                analysis_prompts.append(call_count)
                return (
                    "Analyzing...\n"
                    "<analysis>\n## Run Summary\n| Run | Speedup |\n| 1 | 1.2x |\n## Best: 1.2x\n</analysis>\n"
                    "<summary>Analyzed results.</summary>"
                )

            # Check if this is a reflection prompt
            if "wild_v2_reflection" in prompt or "reflect" in prompt.lower():
                return (
                    "<reflection>\n## Progress: ok\n## Trend: IMPROVING\n</reflection>\n"
                    "<summary>Reflected.</summary>"
                )

            if call_count == 2:
                # Execution iter 1: WAITING
                return "Started runs.\n<summary>Waiting for benchmark.</summary>\n<promise>WAITING</promise>"
            # Execution iter 2: DONE
            return "Done.\n<summary>Finished.</summary>\n<promise>DONE</promise>"

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        # auto_analysis=True, wait_seconds=0.1 to speed up test
        engine.start(goal="Test analysis", max_iterations=5, wait_seconds=0.1, auto_analysis=True, reflection_interval=0)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        assert engine.session.status == "done"
        # Auto analysis should have fired (after WAITING)
        assert len(analysis_prompts) >= 1
        assert len(engine.session.analyses) >= 1

    asyncio.run(_run())


def test_reflection_replan():
    """Reflection with <replan> tag updates tasks.md."""

    async def _run():
        tmpdir = tempfile.mkdtemp()

        def render_fn(skill_id, variables):
            return f"RENDERED:{skill_id}:{variables.get('goal', '')}"

        engine = WildV2Engine(
            get_workdir=lambda: tmpdir,
            server_url="http://localhost:10000",
            render_fn=render_fn,
        )

        call_count = 0

        async def mock_run(session_id, prompt):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return "Explored.\n<plan># Tasks\n- [ ] Original task\n</plan>\n<summary>Planned.</summary>"

            # Reflection prompt
            if "wild_v2_reflection" in prompt or "reflect" in prompt.lower():
                return (
                    "Need to replan.\n"
                    "<reflection>\n## Progress: 1/3\n## Trend: STAGNATING\n## Recommendation: REPLAN\n</reflection>\n"
                    "<replan>\n# Revised Tasks\n- [ ] New approach task 1\n- [ ] New approach task 2\n</replan>\n"
                    "<summary>Replanned.</summary>"
                )

            # Regular execution — keep going
            return "Working.\n<summary>Made progress.</summary>"

        engine._create_opencode_session = AsyncMock(return_value="oc-test-1")
        engine._run_opencode = mock_run
        engine._git_commit = AsyncMock()

        # reflection_interval=1 so it fires immediately
        engine.start(goal="Test replan", max_iterations=2, reflection_interval=1)
        if engine._task:
            engine._task.cancel()
            try:
                await engine._task
            except asyncio.CancelledError:
                pass

        await engine._run_loop()

        # tasks.md should have been rewritten with the new plan
        tasks_path = os.path.join(
            tmpdir, ".agents", "wild", engine.session.session_id, "tasks.md"
        )
        with open(tasks_path) as f:
            content = f.read()
        assert "New approach task 1" in content
        assert "New approach task 2" in content
        # Original task should be gone (overwritten)
        assert "Original task" not in content

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# SSE Parsing Tests (_stream_opencode_sse / _run_opencode)
# ---------------------------------------------------------------------------

class TestStreamOpencodeSSE:
    """Tests for the rewritten _run_opencode / _stream_opencode_sse logic.

    These verify that the SSE event parsing matches the actual OpenCode format
    (same as server.py:parse_opencode_event).
    """

    def _make_engine(self, tmpdir):
        return WildV2Engine(
            opencode_url="http://127.0.0.1:4097",
            model_provider="opencode",
            model_id="test-model",
            get_workdir=lambda: tmpdir,
            server_url="http://127.0.0.1:10099",
            render_fn=_mock_render,
        )

    def _sse_line(self, payload: dict) -> str:
        """Build an SSE data line from a payload dict."""
        return f"data: {json.dumps({'payload': payload})}"

    @staticmethod
    def _async_line_iter(lines):
        """Create an async iterator factory from a list of SSE lines."""
        async def _iter():
            for line in lines:
                yield line
        return _iter

    def test_text_accumulation(self):
        """Text deltas from message.part.updated are accumulated correctly."""
        async def _run():
            with tempfile.TemporaryDirectory() as tmpdir:
                engine = self._make_engine(tmpdir)

                lines = [
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_123",
                            "delta": "Hello ",
                            "part": {"type": "text", "sessionID": "ses_123"},
                        },
                    }),
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_123",
                            "delta": "world!",
                            "part": {"type": "text", "sessionID": "ses_123"},
                        },
                    }),
                    self._sse_line({
                        "type": "session.status",
                        "properties": {
                            "sessionID": "ses_123",
                            "status": {"type": "idle"},
                        },
                    }),
                ]

                mock_response = AsyncMock()
                mock_response.aiter_lines = self._async_line_iter(lines)
                mock_response.__aenter__ = AsyncMock(return_value=mock_response)
                mock_response.__aexit__ = AsyncMock(return_value=False)

                mock_client = AsyncMock()
                mock_client.stream = MagicMock(return_value=mock_response)

                result = await engine._stream_opencode_sse(mock_client, "ses_123")
                assert result == "Hello world!"

        asyncio.run(_run())

    def test_session_status_idle_completes(self):
        """session.status with type=idle breaks the SSE loop."""
        async def _run():
            with tempfile.TemporaryDirectory() as tmpdir:
                engine = self._make_engine(tmpdir)

                lines = [
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_abc",
                            "delta": "Response text",
                            "part": {"type": "text", "sessionID": "ses_abc"},
                        },
                    }),
                    self._sse_line({
                        "type": "session.status",
                        "properties": {
                            "sessionID": "ses_abc",
                            "status": {"type": "idle"},
                        },
                    }),
                    # This line should never be reached
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_abc",
                            "delta": " SHOULD NOT APPEAR",
                            "part": {"type": "text", "sessionID": "ses_abc"},
                        },
                    }),
                ]

                mock_response = AsyncMock()
                mock_response.aiter_lines = self._async_line_iter(lines)
                mock_response.__aenter__ = AsyncMock(return_value=mock_response)
                mock_response.__aexit__ = AsyncMock(return_value=False)

                mock_client = AsyncMock()
                mock_client.stream = MagicMock(return_value=mock_response)

                result = await engine._stream_opencode_sse(mock_client, "ses_abc")
                assert result == "Response text"
                assert "SHOULD NOT APPEAR" not in result

        asyncio.run(_run())

    def test_filters_other_sessions(self):
        """Events for other sessions are ignored."""
        async def _run():
            with tempfile.TemporaryDirectory() as tmpdir:
                engine = self._make_engine(tmpdir)

                lines = [
                    # Event for a different session — should be ignored
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_OTHER",
                            "delta": "wrong session",
                            "part": {"type": "text", "sessionID": "ses_OTHER"},
                        },
                    }),
                    # Event for our session
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_mine",
                            "delta": "correct",
                            "part": {"type": "text", "sessionID": "ses_mine"},
                        },
                    }),
                    self._sse_line({
                        "type": "session.status",
                        "properties": {
                            "sessionID": "ses_mine",
                            "status": {"type": "idle"},
                        },
                    }),
                ]

                mock_response = AsyncMock()
                mock_response.aiter_lines = self._async_line_iter(lines)
                mock_response.__aenter__ = AsyncMock(return_value=mock_response)
                mock_response.__aexit__ = AsyncMock(return_value=False)

                mock_client = AsyncMock()
                mock_client.stream = MagicMock(return_value=mock_response)

                result = await engine._stream_opencode_sse(mock_client, "ses_mine")
                assert result == "correct"

        asyncio.run(_run())

    def test_message_part_delta_accumulation(self):
        """Text deltas from message.part.delta (bus format) are accumulated."""
        async def _run():
            with tempfile.TemporaryDirectory() as tmpdir:
                engine = self._make_engine(tmpdir)

                lines = [
                    # message.part.delta events (OpenCode bus format)
                    self._sse_line({
                        "type": "message.part.delta",
                        "properties": {
                            "sessionID": "ses_delta",
                            "delta": "Hello ",
                        },
                    }),
                    self._sse_line({
                        "type": "message.part.delta",
                        "properties": {
                            "sessionID": "ses_delta",
                            "delta": "from delta!",
                        },
                    }),
                    self._sse_line({
                        "type": "session.status",
                        "properties": {
                            "sessionID": "ses_delta",
                            "status": {"type": "idle"},
                        },
                    }),
                ]

                mock_response = AsyncMock()
                mock_response.aiter_lines = self._async_line_iter(lines)
                mock_response.__aenter__ = AsyncMock(return_value=mock_response)
                mock_response.__aexit__ = AsyncMock(return_value=False)

                mock_client = AsyncMock()
                mock_client.stream = MagicMock(return_value=mock_response)

                result = await engine._stream_opencode_sse(mock_client, "ses_delta")
                assert result == "Hello from delta!"

        asyncio.run(_run())

    def test_mixed_updated_and_delta_events(self):
        """Both message.part.updated and message.part.delta events are accumulated."""
        async def _run():
            with tempfile.TemporaryDirectory() as tmpdir:
                engine = self._make_engine(tmpdir)

                lines = [
                    self._sse_line({
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_mix",
                            "delta": "A",
                            "part": {"type": "text", "sessionID": "ses_mix"},
                        },
                    }),
                    self._sse_line({
                        "type": "message.part.delta",
                        "properties": {
                            "sessionID": "ses_mix",
                            "delta": "B",
                        },
                    }),
                    self._sse_line({
                        "type": "message.part.delta",
                        "properties": {
                            "sessionID": "ses_mix",
                            "delta": "C",
                        },
                    }),
                    self._sse_line({
                        "type": "session.status",
                        "properties": {
                            "sessionID": "ses_mix",
                            "status": {"type": "idle"},
                        },
                    }),
                ]

                mock_response = AsyncMock()
                mock_response.aiter_lines = self._async_line_iter(lines)
                mock_response.__aenter__ = AsyncMock(return_value=mock_response)
                mock_response.__aexit__ = AsyncMock(return_value=False)

                mock_client = AsyncMock()
                mock_client.stream = MagicMock(return_value=mock_response)

                result = await engine._stream_opencode_sse(mock_client, "ses_mix")
                assert result == "ABC"

        asyncio.run(_run())

    def test_run_opencode_timeout(self):
        """_run_opencode returns partial text on timeout."""
        async def _run():
            with tempfile.TemporaryDirectory() as tmpdir:
                engine = self._make_engine(tmpdir)

                # Mock _stream_opencode_sse to hang forever
                async def _hang_forever(client, sid):
                    await asyncio.sleep(999)
                    return ""

                engine._stream_opencode_sse = _hang_forever

                # Mock the prompt POST
                mock_resp = AsyncMock()
                mock_resp.raise_for_status = MagicMock()

                mock_client = AsyncMock()
                mock_client.post = AsyncMock(return_value=mock_resp)
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)

                with patch("httpx.AsyncClient", return_value=mock_client):
                    result = await engine._run_opencode("ses_timeout", "test prompt", timeout_s=0.1)

                # Should return empty (timed out before any text)
                assert result == ""

        asyncio.run(_run())
