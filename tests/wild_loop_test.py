"""
Wild Loop v4 — Test Suite (Step 7)

Tests:
  1. WildEventQueue: priority ordering, dedup, capacity, clear
  2. State management: get/set wild mode, loop status, configure
  3. Auto-enqueue helpers
  4. Serialization round-trip
  5. Experiment context builder
  6. API endpoint integration (via FastAPI TestClient)
"""

import sys
import os
import time
import json
import pytest

# Ensure the server directory is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import wild_loop as wl
from wild_loop import (
    WildEventQueue,
    WildEvent,
    EnqueueEventRequest,
    WildModeRequest,
    WildLoopConfigRequest,
    enqueue_event,
    dequeue_event,
    get_queue_state,
    get_wild_mode_state,
    set_wild_mode_state,
    get_loop_status,
    update_loop_status,
    configure_loop,
    auto_enqueue_alert,
    auto_enqueue_run_terminal,
    build_experiment_context,
    build_wild_prompt,
    get_serializable_state,
    load_from_saved,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_wild_state():
    """Reset all wild loop module state before each test."""
    wl.wild_mode_enabled = False
    wl.wild_loop_state.update({
        "phase": "idle",
        "iteration": 0,
        "goal": None,
        "session_id": None,
        "started_at": None,
        "is_paused": False,
        "sweep_id": None,
        "termination": {
            "max_iterations": None,
            "max_time_seconds": None,
            "max_tokens": None,
            "custom_condition": None,
        }
    })
    wl.wild_event_queue.clear()
    yield


@pytest.fixture
def queue():
    return WildEventQueue()


# ===========================================================================
# 1. WildEventQueue Tests
# ===========================================================================

class TestWildEventQueue:
    """Unit tests for the heapq-based priority queue."""

    def test_empty_queue(self, queue):
        assert queue.size == 0
        assert queue.dequeue() is None
        assert queue.peek() is None
        assert queue.items() == []

    def test_single_enqueue_dequeue(self, queue):
        event = {"id": "e1", "priority": 50, "created_at": 1.0, "title": "T", "prompt": "P", "type": "run_event"}
        assert queue.enqueue(event) is True
        assert queue.size == 1
        result = queue.dequeue()
        assert result["id"] == "e1"
        assert queue.size == 0

    def test_priority_ordering(self, queue):
        """Lower priority number = higher urgency = dequeued first."""
        events = [
            {"id": "low", "priority": 90, "created_at": 1.0, "title": "L", "prompt": "P", "type": "exploring"},
            {"id": "high", "priority": 10, "created_at": 2.0, "title": "H", "prompt": "P", "type": "steer"},
            {"id": "mid", "priority": 50, "created_at": 3.0, "title": "M", "prompt": "P", "type": "run_event"},
        ]
        for e in events:
            queue.enqueue(e)

        order = []
        while True:
            ev = queue.dequeue()
            if ev is None:
                break
            order.append(ev["id"])
        assert order == ["high", "mid", "low"]

    def test_same_priority_fifo(self, queue):
        """Events with the same priority are dequeued in FIFO order (by created_at)."""
        for i in range(5):
            queue.enqueue({
                "id": f"e{i}", "priority": 50,
                "created_at": float(i), "title": f"T{i}", "prompt": "P", "type": "run_event",
            })
        order = []
        while True:
            ev = queue.dequeue()
            if ev is None:
                break
            order.append(ev["id"])
        assert order == ["e0", "e1", "e2", "e3", "e4"]

    def test_dedup(self, queue):
        """Same id cannot be enqueued twice."""
        event = {"id": "dup1", "priority": 50, "created_at": 1.0, "title": "T", "prompt": "P", "type": "run_event"}
        assert queue.enqueue(event) is True
        assert queue.enqueue(event) is False
        assert queue.size == 1

    def test_dedup_after_dequeue(self, queue):
        """After dequeuing an event, the same id can be enqueued again."""
        event = {"id": "reuse", "priority": 50, "created_at": 1.0, "title": "T", "prompt": "P", "type": "run_event"}
        queue.enqueue(event)
        queue.dequeue()
        # Now re-enqueue with same id
        event2 = {**event, "created_at": 2.0}
        assert queue.enqueue(event2) is True
        assert queue.size == 1

    def test_peek_does_not_remove(self, queue):
        event = {"id": "p1", "priority": 50, "created_at": 1.0, "title": "T", "prompt": "P", "type": "run_event"}
        queue.enqueue(event)
        peeked = queue.peek()
        assert peeked["id"] == "p1"
        assert queue.size == 1
        # Dequeue should still return it
        result = queue.dequeue()
        assert result["id"] == "p1"

    def test_items_returns_sorted_snapshot(self, queue):
        queue.enqueue({"id": "c", "priority": 90, "created_at": 1.0, "title": "C", "prompt": "P", "type": "run_event"})
        queue.enqueue({"id": "a", "priority": 10, "created_at": 2.0, "title": "A", "prompt": "P", "type": "steer"})
        queue.enqueue({"id": "b", "priority": 50, "created_at": 3.0, "title": "B", "prompt": "P", "type": "alert"})
        items = queue.items()
        assert len(items) == 3
        assert [i["id"] for i in items] == ["a", "b", "c"]

    def test_clear(self, queue):
        for i in range(10):
            queue.enqueue({"id": f"e{i}", "priority": 50, "created_at": float(i), "title": "T", "prompt": "P", "type": "run_event"})
        assert queue.size == 10
        queue.clear()
        assert queue.size == 0
        assert queue.dequeue() is None

    def test_stress_ordering(self, queue):
        """100 events with mixed priorities come out in correct order."""
        import random
        random.seed(42)
        priorities = [random.randint(1, 100) for _ in range(100)]
        for i, p in enumerate(priorities):
            queue.enqueue({
                "id": f"s{i}", "priority": p,
                "created_at": float(i), "title": "T", "prompt": "P", "type": "run_event",
            })

        prev_priority = -1
        while True:
            ev = queue.dequeue()
            if ev is None:
                break
            assert ev["priority"] >= prev_priority, f"Out-of-order: {ev['priority']} < {prev_priority}"
            prev_priority = ev["priority"]

    def test_negative_priority(self, queue):
        """Negative priorities (highest urgency) work correctly."""
        queue.enqueue({"id": "neg", "priority": -10, "created_at": 1.0, "title": "Urgent", "prompt": "P", "type": "steer"})
        queue.enqueue({"id": "pos", "priority": 50, "created_at": 2.0, "title": "Normal", "prompt": "P", "type": "run_event"})
        first = queue.dequeue()
        assert first["id"] == "neg"


# ===========================================================================
# 2. State Management Tests
# ===========================================================================

class TestWildModeState:
    """Tests for wild mode enable/disable."""

    def test_default_disabled(self):
        assert get_wild_mode_state() == {"enabled": False}

    def test_enable(self):
        result = set_wild_mode_state(True)
        assert result == {"enabled": True}
        assert wl.wild_mode_enabled is True

    def test_disable(self):
        set_wild_mode_state(True)
        result = set_wild_mode_state(False)
        assert result == {"enabled": False}
        assert wl.wild_mode_enabled is False

    def test_truthy_values(self):
        set_wild_mode_state(1)
        assert wl.wild_mode_enabled is True
        set_wild_mode_state(0)
        assert wl.wild_mode_enabled is False


class TestLoopStatus:
    """Tests for wild loop state transitions."""

    def test_default_idle(self):
        status = get_loop_status()
        assert status["phase"] == "idle"
        assert status["iteration"] == 0

    def test_update_phase(self):
        result = update_loop_status(phase="thinking")
        assert result["phase"] == "thinking"
        # started_at should be set for non-idle phase
        assert result["started_at"] is not None

    def test_update_iteration(self):
        result = update_loop_status(iteration=5)
        assert result["iteration"] == 5

    def test_update_goal(self):
        result = update_loop_status(goal="Train MNIST to 99%")
        assert result["goal"] == "Train MNIST to 99%"

    def test_pause_resume(self):
        update_loop_status(phase="thinking", is_paused=False)
        assert get_loop_status()["is_paused"] is False

        update_loop_status(is_paused=True)
        assert get_loop_status()["is_paused"] is True

        update_loop_status(is_paused=False)
        assert get_loop_status()["is_paused"] is False

    def test_idle_resets_started_at(self):
        update_loop_status(phase="thinking")
        assert get_loop_status()["started_at"] is not None
        update_loop_status(phase="idle")
        assert get_loop_status()["started_at"] is None

    def test_multiple_field_update(self):
        result = update_loop_status(phase="acting", iteration=3, goal="Optimize LR", session_id="abc123")
        assert result["phase"] == "acting"
        assert result["iteration"] == 3
        assert result["goal"] == "Optimize LR"
        assert result["session_id"] == "abc123"

    def test_lifecycle_idle_to_thinking_to_acting_to_complete(self):
        """Full lifecycle: idle → thinking → acting → complete."""
        update_loop_status(phase="thinking", iteration=1, goal="Test")
        s = get_loop_status()
        assert s["phase"] == "thinking"
        assert s["started_at"] is not None

        update_loop_status(phase="acting", iteration=1)
        s = get_loop_status()
        assert s["phase"] == "acting"

        update_loop_status(phase="complete", iteration=1)
        s = get_loop_status()
        assert s["phase"] == "complete"


class TestLoopConfigure:
    """Tests for termination condition configuration."""

    def test_configure_max_iterations(self):
        req = WildLoopConfigRequest(max_iterations=10)
        result = configure_loop(req)
        assert result["termination"]["max_iterations"] == 10

    def test_configure_all_conditions(self):
        req = WildLoopConfigRequest(
            goal="Reach 95% accuracy",
            max_iterations=50,
            max_time_seconds=3600,
            max_tokens=100000,
            custom_condition="loss < 0.01",
        )
        result = configure_loop(req)
        assert result["goal"] == "Reach 95% accuracy"
        assert result["termination"]["max_iterations"] == 50
        assert result["termination"]["max_time_seconds"] == 3600
        assert result["termination"]["max_tokens"] == 100000
        assert result["termination"]["custom_condition"] == "loss < 0.01"

    def test_partial_update_preserves_existing(self):
        configure_loop(WildLoopConfigRequest(max_iterations=10))
        configure_loop(WildLoopConfigRequest(max_time_seconds=600))
        status = get_loop_status()
        assert status["termination"]["max_iterations"] == 10  # preserved
        assert status["termination"]["max_time_seconds"] == 600


# ===========================================================================
# 3. Enqueue/Dequeue via Module API Tests
# ===========================================================================

class TestEnqueueDequeueAPI:
    """Tests for the module-level enqueue/dequeue functions."""

    def test_enqueue_creates_event(self):
        req = EnqueueEventRequest(priority=30, title="Alert", prompt="Fix run", type="alert")
        result = enqueue_event(req)
        assert result["added"] is True
        assert result["queue_size"] == 1
        assert result["event"]["priority"] == 30
        assert result["event"]["type"] == "alert"
        assert "id" in result["event"]

    def test_dequeue_empty(self):
        result = dequeue_event()
        assert result["event"] is None
        assert result["queue_size"] == 0

    def test_enqueue_then_dequeue(self):
        enqueue_event(EnqueueEventRequest(priority=50, title="T1", prompt="P1", type="run_event"))
        enqueue_event(EnqueueEventRequest(priority=20, title="T2", prompt="P2", type="alert"))

        result = dequeue_event()
        assert result["event"]["title"] == "T2"  # priority 20 comes first
        assert result["queue_size"] == 1

        result = dequeue_event()
        assert result["event"]["title"] == "T1"
        assert result["queue_size"] == 0

    def test_get_queue_state(self):
        enqueue_event(EnqueueEventRequest(priority=50, title="T1", prompt="P1", type="run_event"))
        enqueue_event(EnqueueEventRequest(priority=30, title="T2", prompt="P2", type="alert"))

        state = get_queue_state()
        assert state["queue_size"] == 2
        assert len(state["events"]) == 2
        # Should be sorted by priority
        assert state["events"][0]["priority"] == 30
        assert state["events"][1]["priority"] == 50


# ===========================================================================
# 4. Auto-Enqueue Helpers Tests
# ===========================================================================

class TestAutoEnqueue:
    """Tests for auto-enqueue triggered by alerts and run status changes."""

    def test_alert_enqueue_when_wild_disabled(self):
        """No event enqueued when wild mode is off."""
        wl.wild_mode_enabled = False
        auto_enqueue_alert("a1", "r1", "my-run", "critical", "OOM", ["retry", "skip"])
        assert wl.wild_event_queue.size == 0

    def test_alert_enqueue_when_wild_enabled(self):
        wl.wild_mode_enabled = True
        auto_enqueue_alert("a1", "r1", "my-run", "critical", "OOM", ["retry", "skip"])
        assert wl.wild_event_queue.size == 1
        event = wl.wild_event_queue.dequeue()
        assert event["id"] == "alert-a1"
        assert event["priority"] == 20  # critical = 20
        assert event["type"] == "alert"
        assert "OOM" in event["prompt"]

    def test_alert_severity_priorities(self):
        wl.wild_mode_enabled = True
        auto_enqueue_alert("a1", "r1", "run1", "critical", "msg", [])
        auto_enqueue_alert("a2", "r2", "run2", "warning", "msg", [])
        auto_enqueue_alert("a3", "r3", "run3", "info", "msg", [])

        events = wl.wild_event_queue.items()
        assert events[0]["priority"] == 20  # critical
        assert events[1]["priority"] == 30  # warning
        assert events[2]["priority"] == 50  # info

    def test_run_terminal_enqueue_when_disabled(self):
        wl.wild_mode_enabled = False
        auto_enqueue_run_terminal("r1", "my-run", "finished")
        assert wl.wild_event_queue.size == 0

    def test_run_terminal_finished(self):
        wl.wild_mode_enabled = True
        auto_enqueue_run_terminal("r1", "my-run", "finished", exit_code=0)
        assert wl.wild_event_queue.size == 1
        event = wl.wild_event_queue.dequeue()
        assert event["id"] == "run-r1-finished"
        assert event["priority"] == 50  # finished = 50
        assert "✅" in event["title"]

    def test_run_terminal_failed(self):
        wl.wild_mode_enabled = True
        auto_enqueue_run_terminal("r1", "my-run", "failed", exit_code=1, error="segfault")
        event = wl.wild_event_queue.dequeue()
        assert event["priority"] == 40  # failed = 40
        assert "❌" in event["title"]
        assert "segfault" in event["prompt"]

    def test_run_non_terminal_ignored(self):
        """Running/queued status should NOT enqueue."""
        wl.wild_mode_enabled = True
        auto_enqueue_run_terminal("r1", "my-run", "running")
        assert wl.wild_event_queue.size == 0

    def test_multiple_alerts_priority_order(self):
        """Test matrix: Multiple alerts fire simultaneously → processed in priority order."""
        wl.wild_mode_enabled = True
        auto_enqueue_alert("a1", "r1", "run1", "info", "low priority", [])
        auto_enqueue_alert("a2", "r2", "run2", "critical", "high priority", [])
        auto_enqueue_alert("a3", "r3", "run3", "warning", "mid priority", [])

        first = wl.wild_event_queue.dequeue()
        assert first["priority"] == 20  # critical
        second = wl.wild_event_queue.dequeue()
        assert second["priority"] == 30  # warning
        third = wl.wild_event_queue.dequeue()
        assert third["priority"] == 50  # info


# ===========================================================================
# 5. Serialization Round-Trip Tests
# ===========================================================================

class TestSerialization:
    """Tests for state serialization (save/load) — verifying server restart persistence."""

    def test_round_trip(self):
        set_wild_mode_state(True)
        update_loop_status(phase="acting", iteration=7, goal="Beat baseline")
        configure_loop(WildLoopConfigRequest(max_iterations=20, custom_condition="acc > 0.95"))

        saved = get_serializable_state()
        assert saved["wild_mode"] is True
        assert saved["wild_loop"]["phase"] == "acting"
        assert saved["wild_loop"]["iteration"] == 7

        # Simulate a server restart: reset and reload
        wl.wild_mode_enabled = False
        wl.wild_loop_state["phase"] = "idle"
        wl.wild_loop_state["iteration"] = 0
        wl.wild_loop_state["goal"] = None

        load_from_saved(saved)
        assert wl.wild_mode_enabled is True
        assert wl.wild_loop_state["phase"] == "acting"
        assert wl.wild_loop_state["iteration"] == 7
        assert wl.wild_loop_state["goal"] == "Beat baseline"
        assert wl.wild_loop_state["termination"]["max_iterations"] == 20

    def test_load_empty_data(self):
        """Loading empty dict should not crash."""
        load_from_saved({})
        assert wl.wild_mode_enabled is False

    def test_json_serializable(self):
        """State must be JSON-serializable (no datetime, no custom objects)."""
        set_wild_mode_state(True)
        update_loop_status(phase="thinking", iteration=1, goal="Test JSON")
        saved = get_serializable_state()
        json_str = json.dumps(saved)
        restored = json.loads(json_str)
        assert restored["wild_mode"] is True
        assert restored["wild_loop"]["phase"] == "thinking"


# ===========================================================================
# 6. Experiment Context Builder Tests
# ===========================================================================

class TestExperimentContext:
    """Tests for build_experiment_context."""

    def test_empty_state(self):
        def noop_recompute():
            pass
        ctx = build_experiment_context({}, {}, {}, noop_recompute)
        assert "Current Experiment State" in ctx
        assert "Active runs: 0" in ctx
        assert "End State" in ctx

    def test_with_active_runs(self):
        runs = {
            "r1": {"name": "train-v1", "status": "running", "command": "python train.py"},
            "r2": {"name": "eval-v1", "status": "finished", "command": "python eval.py"},
            "r3": {"name": "train-v2", "status": "failed", "error": "OOM", "command": "python train.py --big"},
        }
        ctx = build_experiment_context(runs, {}, {}, lambda: None)
        assert "Active runs: 1" in ctx
        assert "train-v1" in ctx
        assert "Finished runs: 1" in ctx
        assert "Failed runs: 1" in ctx
        assert "FAILED" in ctx
        assert "OOM" in ctx

    def test_with_sweeps(self):
        sweeps = {
            "s1": {"name": "lr-sweep", "progress": {"completed": 3, "total": 10, "failed": 1}},
        }
        ctx = build_experiment_context({}, sweeps, {}, lambda: None)
        assert "Sweeps: 1" in ctx
        assert "lr-sweep" in ctx
        assert "3/10 done" in ctx

    def test_with_pending_alerts(self):
        alerts = {
            "a1": {"id": "a1", "severity": "critical", "status": "pending", "message": "GPU memory full"},
            "a2": {"id": "a2", "severity": "info", "status": "resolved", "message": "Old"},
        }
        ctx = build_experiment_context({}, {}, alerts, lambda: None)
        assert "Pending alerts: 1" in ctx
        assert "GPU memory full" in ctx

    def test_with_goal(self):
        update_loop_status(goal="Beat SOTA")
        ctx = build_experiment_context({}, {}, {}, lambda: None)
        assert "Goal: Beat SOTA" in ctx

    def test_recompute_fn_called(self):
        """recompute_fn should be called exactly once."""
        call_count = [0]
        def counting_recompute():
            call_count[0] += 1
        build_experiment_context({}, {}, {}, counting_recompute)
        assert call_count[0] == 1


# ===========================================================================
# 7. Wild Prompt Builder Tests
# ===========================================================================

class TestWildPromptBuilder:
    """Tests for build_wild_prompt."""

    def test_with_working_skill(self):
        update_loop_status(phase="thinking", iteration=3, goal="Train MNIST")
        configure_loop(WildLoopConfigRequest(max_iterations=10))

        def mock_render(skill_id, variables):
            assert skill_id == "wild_system"
            assert variables["goal"] == "Train MNIST"
            assert "4" in str(variables["iteration"])  # iteration is stored value + 1
            return f"WILD:{variables['goal']}"

        result = build_wild_prompt(mock_render, "experiment context here")
        assert "WILD:Train MNIST" in result
        assert result.endswith("\n\n")  # appends double newline

    def test_with_missing_skill(self):
        """When skill returns None, should return empty string."""
        def mock_render_none(skill_id, variables):
            return None

        result = build_wild_prompt(mock_render_none, "ctx")
        assert result == ""

    def test_sweep_note_included(self):
        wl.wild_loop_state["sweep_id"] = "sweep-abc123"

        variables_captured = {}
        def mock_render(skill_id, variables):
            variables_captured.update(variables)
            return "rendered"

        build_wild_prompt(mock_render, "ctx")
        assert "sweep-abc123" in variables_captured.get("sweep_note", "")

    def test_custom_condition_included(self):
        configure_loop(WildLoopConfigRequest(custom_condition="loss < 0.01"))

        variables_captured = {}
        def mock_render(skill_id, variables):
            variables_captured.update(variables)
            return "rendered"

        build_wild_prompt(mock_render, "ctx")
        assert "loss < 0.01" in variables_captured.get("custom_condition", "")

    def test_unlimited_iterations(self):
        """When no max_iterations, display should say 'unlimited'."""
        update_loop_status(iteration=5)

        variables_captured = {}
        def mock_render(skill_id, variables):
            variables_captured.update(variables)
            return "rendered"

        build_wild_prompt(mock_render, "ctx")
        assert "unlimited" in variables_captured.get("iteration", "")

    def test_setup_state_in_prompt_variables(self):
        """autonomy_level, queue_modify_enabled, away_duration should appear in prompt variables."""
        configure_loop(WildLoopConfigRequest(
            autonomy_level="full",
            queue_modify_enabled=False,
            max_time_seconds=21600,  # 6 hours
        ))

        variables_captured = {}
        def mock_render(skill_id, variables):
            variables_captured.update(variables)
            return "rendered"

        build_wild_prompt(mock_render, "ctx")
        assert variables_captured["autonomy_level"] == "full"
        assert variables_captured["queue_modify_enabled"] == "No"
        assert variables_captured["away_duration"] == "6 hours"


# ===========================================================================
# 8. Integration: Full Lifecycle Tests
# ===========================================================================

class TestLifecycleIntegration:
    """End-to-end lifecycle scenarios from the test matrix."""

    def test_stop_during_iteration(self):
        """User clicks Stop during iteration → loop stops, state reset."""
        set_wild_mode_state(True)
        update_loop_status(phase="thinking", iteration=3, goal="Test")

        # Simulate stop
        update_loop_status(phase="idle", iteration=0)
        set_wild_mode_state(False)

        assert get_loop_status()["phase"] == "idle"
        assert wl.wild_mode_enabled is False

    def test_pause_manual_chat_resume(self):
        """Pause → manual chat → Resume: state preserved across pause."""
        set_wild_mode_state(True)
        update_loop_status(phase="acting", iteration=5, goal="Optimize")

        # Pause
        update_loop_status(is_paused=True)
        status = get_loop_status()
        assert status["is_paused"] is True
        assert status["phase"] == "acting"
        assert status["iteration"] == 5

        # (User does manual chat — doesn't affect loop state)

        # Resume
        update_loop_status(is_paused=False)
        status = get_loop_status()
        assert status["is_paused"] is False
        assert status["iteration"] == 5  # preserved
        assert status["goal"] == "Optimize"

    def test_server_restart_persistence(self):
        """Server restart → loop state persisted and can be resumed."""
        set_wild_mode_state(True)
        update_loop_status(phase="thinking", iteration=7, goal="Find best LR")
        configure_loop(WildLoopConfigRequest(max_iterations=20))

        saved = get_serializable_state()

        # Simulate server restart (hard reset)
        wl.wild_mode_enabled = False
        wl.wild_loop_state.update({
            "phase": "idle", "iteration": 0, "goal": None,
            "session_id": None, "started_at": None, "is_paused": False,
            "sweep_id": None,
            "termination": {"max_iterations": None, "max_time_seconds": None,
                            "max_tokens": None, "custom_condition": None}
        })

        load_from_saved(saved)
        assert wl.wild_mode_enabled is True
        assert get_loop_status()["phase"] == "thinking"
        assert get_loop_status()["iteration"] == 7
        assert get_loop_status()["goal"] == "Find best LR"
        assert get_loop_status()["termination"]["max_iterations"] == 20

    def test_alert_during_exploring(self):
        """Alert fires during exploring phase → event queued, processed in priority order."""
        set_wild_mode_state(True)
        update_loop_status(phase="exploring")

        # Alert fires
        auto_enqueue_alert("a1", "r1", "my-run", "critical", "GPU OOM", ["retry"])

        # Also enqueue a lower-priority exploration event
        enqueue_event(EnqueueEventRequest(priority=90, title="Explore", prompt="Look around", type="exploring"))

        # Alert should come first (priority 20 < 90)
        first = dequeue_event()
        assert first["event"]["type"] == "alert"
        assert first["event"]["priority"] == 20

        second = dequeue_event()
        assert second["event"]["type"] == "exploring"

    def test_termination_condition_max_iterations(self):
        """When max_iterations is reached, the check should indicate stop."""
        configure_loop(WildLoopConfigRequest(max_iterations=5))
        update_loop_status(iteration=5)

        status = get_loop_status()
        max_iter = status["termination"]["max_iterations"]
        assert status["iteration"] >= max_iter

    def test_termination_condition_time(self):
        """When max_time_seconds is reached, started_at + max_time < now should be true."""
        configure_loop(WildLoopConfigRequest(max_time_seconds=60))
        update_loop_status(phase="thinking")

        # Force started_at to be in the past
        wl.wild_loop_state["started_at"] = time.time() - 120  # 2 min ago

        status = get_loop_status()
        elapsed = time.time() - status["started_at"]
        max_time = status["termination"]["max_time_seconds"]
        assert elapsed > max_time  # Should indicate stop


# ===========================================================================
# 9. Edge Case & Robustness Tests
# ===========================================================================

class TestEdgeCases:
    """Edge cases and robustness tests."""

    def test_queue_with_float_priority(self):
        """Float priorities should work correctly (user-adjustable range now -1000 to 1000)."""
        q = WildEventQueue()
        q.enqueue({"id": "f1", "priority": 0.5, "created_at": 1.0, "title": "T", "prompt": "P", "type": "run_event"})
        q.enqueue({"id": "f2", "priority": 0.1, "created_at": 2.0, "title": "T", "prompt": "P", "type": "run_event"})
        first = q.dequeue()
        assert first["id"] == "f2"  # 0.1 < 0.5

    def test_concurrent_state_updates(self):
        """Multiple rapid state updates should not corrupt state."""
        for i in range(100):
            update_loop_status(iteration=i)
        assert get_loop_status()["iteration"] == 99

    def test_configure_with_session_id(self):
        req = WildLoopConfigRequest(session_id="sess-xyz")
        configure_loop(req)
        assert get_loop_status()["session_id"] == "sess-xyz"

    def test_auto_enqueue_dedup(self):
        """Same alert/run event should not be double-enqueued."""
        wl.wild_mode_enabled = True
        auto_enqueue_alert("same-alert", "r1", "run1", "warning", "msg", [])
        auto_enqueue_alert("same-alert", "r1", "run1", "warning", "msg", [])
        assert wl.wild_event_queue.size == 1

    def test_empty_prompt_skill(self):
        """When prompt skill returns empty string, build_wild_prompt should handle it."""
        def mock_render(skill_id, variables):
            return ""  # Empty string is truthy-ish but empty

        result = build_wild_prompt(mock_render, "ctx")
        # Empty string is falsy, so build_wild_prompt logs warning and returns ""
        assert result == ""
