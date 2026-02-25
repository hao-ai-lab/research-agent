"""Tests for GlobalWatchdogAgent -- server-level L3 executor monitoring.

Tests cover:
  - Dead process detection and cleanup
  - Orphan detection and kill after grace period
  - Hanging detection: warn → grace → kill escalation
  - GPU leak detection and release
  - Alert deduplication
  - Health/actions/status API methods
  - Config hot-update
"""

import asyncio
import time

import pytest

from agentsys.agent import Agent
from agentsys.agents.watchdog import (
    AgentHealthSnapshot,
    GlobalWatchdogAgent,
    WatchdogConfig,
)
from agentsys.runtime import Runtime
from agentsys.types import AgentInfo, AgentStatus, EntryType


# ---------------------------------------------------------------------------
# Helper test agents
# ---------------------------------------------------------------------------

class QuickExecutor(Agent):
    """Executor that finishes quickly."""
    role = "executor"
    allowed_child_roles = frozenset()

    async def run(self):
        self.iteration = 1
        if self.memory:
            self.memory.write(
                {"event": "done"}, type=EntryType.RESULT, tags=["result"],
            )
        await asyncio.sleep(0.05)


class HangingExecutor(Agent):
    """Executor that sleeps forever (simulates a hang)."""
    role = "executor"
    allowed_child_roles = frozenset()

    async def run(self):
        self.iteration = 1
        if self.memory:
            self.memory.write(
                {"event": "started"}, type=EntryType.CONTEXT, tags=["start"],
            )
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            pass


class ActiveExecutor(Agent):
    """Executor that keeps incrementing iteration."""
    role = "executor"
    allowed_child_roles = frozenset()

    async def run(self):
        try:
            for i in range(1000):
                self.iteration = i
                if self.memory:
                    self.memory.write(
                        {"iter": i}, type=EntryType.METRICS, tags=["progress"],
                    )
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            pass


class SimpleOrchestrator(Agent):
    """Orchestrator that finishes quickly (to become dead parent)."""
    role = "orchestrator"
    allowed_child_roles = frozenset({"executor", "sidecar"})

    async def run(self):
        await asyncio.sleep(0.01)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def runtime(tmp_path):
    """Create a fresh Runtime for each test."""
    rt = Runtime(project="test-global-watchdog", store_root=str(tmp_path))
    yield rt
    await rt.shutdown()


@pytest.fixture
def watchdog_agent():
    """Create an unwired GlobalWatchdogAgent for unit testing."""
    return GlobalWatchdogAgent()


@pytest.fixture
async def wired_watchdog(runtime):
    """Create and register a watchdog with fast scanning intervals."""
    wd = GlobalWatchdogAgent()
    runtime.register_local(
        wd,
        goal="Test watchdog",
        config={
            "scan_interval_seconds": 0.1,
            "hang_timeout_seconds": 0.5,
            "memory_stale_threshold_seconds": 0.2,
            "warn_to_kill_grace_seconds": 0.3,
            "orphan_grace_seconds": 0.2,
            "llm_diagnosis_enabled": False,
            "alert_dedup_ttl_seconds": 0.5,
            "gpu_leak_check_enabled": True,
        },
    )
    await wd.start()
    yield wd
    if wd.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
        await wd.stop()


async def _wait_for_status(runtime, agent_id, statuses, timeout=10):
    """Poll until agent reaches one of the expected statuses."""
    for _ in range(int(timeout / 0.05)):
        info = runtime.get_agent(agent_id)
        if info and info.status in statuses:
            return info
        meta = runtime.store.read_agent_info(agent_id)
        if meta and meta.status in statuses:
            return meta
        await asyncio.sleep(0.05)
    return runtime.get_agent(agent_id)


# ===========================================================================
# WatchdogConfig tests
# ===========================================================================

class TestWatchdogConfig:

    def test_defaults(self):
        cfg = WatchdogConfig()
        assert cfg.scan_interval_seconds == 15.0
        assert cfg.hang_timeout_seconds == 7200.0
        assert cfg.llm_diagnosis_enabled is True

    def test_from_dict(self):
        cfg = WatchdogConfig.from_dict({
            "scan_interval_seconds": 5.0,
            "hang_timeout_seconds": 100,
            "unknown_key": "ignored",
        })
        assert cfg.scan_interval_seconds == 5.0
        assert cfg.hang_timeout_seconds == 100
        # defaults for unspecified fields
        assert cfg.orphan_grace_seconds == 60.0

    def test_from_empty_dict(self):
        cfg = WatchdogConfig.from_dict({})
        assert cfg.scan_interval_seconds == 15.0


# ===========================================================================
# AgentHealthSnapshot tests
# ===========================================================================

class TestAgentHealthSnapshot:

    def test_defaults(self):
        snap = AgentHealthSnapshot(agent_id="test-123")
        assert snap.agent_id == "test-123"
        assert snap.last_iteration == 0
        assert snap.warned_at == 0.0
        assert snap.orphan_detected_at == 0.0


# ===========================================================================
# Dead process detection
# ===========================================================================

class _DeadProcess:
    """Fake process object that reports as not alive."""
    def is_alive(self):
        return False

    def join(self, timeout=None):
        pass

    def terminate(self):
        pass


class TestDeadProcessDetection:

    @pytest.mark.asyncio
    async def test_dead_process_marked_failed(self, runtime, wired_watchdog):
        """Watchdog detects dead process and marks it FAILED.

        Injects fake metadata + a mock dead process to avoid racing
        with Runtime's event listener loop.
        """
        agent_id = "executor-deadtest1"
        meta = {
            "id": agent_id,
            "role": "executor",
            "status": AgentStatus.RUNNING.value,
            "goal": "will-die",
            "config": {},
            "parent_id": None,
            "children": [],
            "agent_cls_path": "tests.agentsys.test_global_watchdog.QuickExecutor",
            "iteration": 3,
            "scope": {"project": "test-global-watchdog", "role": "executor"},
        }
        runtime._agent_meta[agent_id] = meta
        runtime.store.write_meta(agent_id, meta)
        runtime._processes[agent_id] = _DeadProcess()

        # Trigger a scan
        await wired_watchdog.on_monitor()

        # Watchdog should have marked it FAILED
        updated_meta = runtime._agent_meta.get(agent_id)
        assert updated_meta["status"] == AgentStatus.FAILED.value

        # Should have written an ALERT
        alerts = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["dead_process"],
        )
        assert len(alerts) >= 1
        assert alerts[0].data["agent_id"] == agent_id

    @pytest.mark.asyncio
    async def test_dead_process_alert_dedup(self, runtime, wired_watchdog):
        """Same dead process doesn't generate duplicate alerts."""
        agent_id = "executor-deduptest"
        meta = {
            "id": agent_id,
            "role": "executor",
            "status": AgentStatus.RUNNING.value,
            "goal": "dedup",
            "config": {},
            "parent_id": None,
            "children": [],
            "agent_cls_path": "tests.agentsys.test_global_watchdog.QuickExecutor",
            "iteration": 0,
            "scope": {"project": "test-global-watchdog", "role": "executor"},
        }
        runtime._agent_meta[agent_id] = meta
        runtime.store.write_meta(agent_id, meta)
        runtime._processes[agent_id] = _DeadProcess()

        # Scan twice — first marks FAILED, but we re-inject RUNNING
        await wired_watchdog.on_monitor()

        # Re-inject as RUNNING to test dedup (the alert dedup should block)
        meta["status"] = AgentStatus.RUNNING.value
        runtime._agent_meta[agent_id] = meta

        await wired_watchdog.on_monitor()

        alerts = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["dead_process"],
        )
        # Should only have 1 due to dedup TTL
        assert len(alerts) == 1


# ===========================================================================
# Orphan detection
# ===========================================================================

class TestOrphanDetection:

    @pytest.mark.asyncio
    async def test_orphan_detected_and_killed(self, runtime, wired_watchdog):
        """Orphaned L3 (parent DONE) is killed after grace period."""
        # Spawn an orchestrator that finishes quickly
        parent_info = await runtime.spawn(SimpleOrchestrator, goal="parent")
        await _wait_for_status(
            runtime, parent_info.id, [AgentStatus.DONE], timeout=5,
        )

        # Spawn an executor manually with that parent
        child_info = await runtime.spawn(
            HangingExecutor, goal="orphan-child",
            parent_id=parent_info.id,
        )
        await asyncio.sleep(0.1)  # let it start

        # Scan — should detect orphan and start grace
        await wired_watchdog.on_monitor()

        # Check warning alert
        warnings = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["orphan_detected"],
        )
        assert len(warnings) >= 1

        # Wait for grace period to expire
        await asyncio.sleep(wired_watchdog._cfg.orphan_grace_seconds + 0.1)

        # Scan again — should kill
        await wired_watchdog.on_monitor()

        kill_alerts = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["orphan_killed"],
        )
        assert len(kill_alerts) >= 1

        # Verify child is stopped
        await asyncio.sleep(0.2)
        child = runtime.get_agent(child_info.id)
        assert child is None or child.status in (AgentStatus.DONE, AgentStatus.FAILED)


# ===========================================================================
# Hanging detection
# ===========================================================================

class TestHangingDetection:

    @pytest.mark.asyncio
    async def test_hanging_warn_then_kill(self, runtime, wired_watchdog):
        """Hanging agent gets warning, then killed after grace."""
        info = await runtime.spawn(HangingExecutor, goal="hang-test")
        await asyncio.sleep(0.1)  # let it start

        # Wait for memory_stale_threshold to pass
        await asyncio.sleep(wired_watchdog._cfg.memory_stale_threshold_seconds + 0.1)

        # Scan — should detect suspicious and warn
        await wired_watchdog.on_monitor()

        warnings = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["hang_warning"],
        )
        assert len(warnings) >= 1

        # Wait for grace period
        await asyncio.sleep(wired_watchdog._cfg.warn_to_kill_grace_seconds + 0.1)

        # Wait for hang_timeout to pass (from first iteration stale detection)
        # In our test config hang_timeout=0.5s, so it should already be expired
        await asyncio.sleep(0.3)

        # Scan again — should kill
        await wired_watchdog.on_monitor()

        kill_alerts = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["hang_killed"],
        )
        assert len(kill_alerts) >= 1

    @pytest.mark.asyncio
    async def test_active_agent_not_killed(self, runtime, wired_watchdog):
        """An actively writing agent should not be flagged as hanging."""
        info = await runtime.spawn(ActiveExecutor, goal="active-test")
        await asyncio.sleep(0.3)

        # Multiple scans — should find no warnings
        for _ in range(3):
            await wired_watchdog.on_monitor()
            await asyncio.sleep(0.1)

        warnings = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["hang_warning"],
        )
        assert len(warnings) == 0

        # Cleanup
        await runtime.stop(info.id)


# ===========================================================================
# GPU leak detection
# ===========================================================================

class TestGPULeakDetection:

    @pytest.mark.asyncio
    async def test_gpu_leak_released(self, runtime, wired_watchdog):
        """Stale scheduler request with no process gets released."""
        from agentsys.scheduler import Scheduler, RequestStatus, ScheduleRequest
        from pathlib import Path

        # Set up a scheduler
        sched_dir = Path(runtime._store_root) / "_scheduler"
        scheduler = Scheduler(runtime, sched_dir)
        runtime._scheduler = scheduler
        scheduler.start()

        # Inject a fake RUNNING request with a dead agent_id
        req = ScheduleRequest(
            request_id="sched-fake1234",
            agent_cls_path="agentsys.agents.executor.ExecutorAgent",
            goal="fake",
            parent_id=None,
            config=None,
            gpu_required=1,
            status=RequestStatus.RUNNING,
            agent_id="executor-deadbeef",
        )
        scheduler._requests[req.request_id] = req
        scheduler._gpu.allocate(req.request_id, 1)

        assert scheduler._gpu.allocated == 1

        # Scan
        await wired_watchdog.on_monitor()

        # GPU should have been released
        assert scheduler._gpu.allocated == 0

        # Alert should have been written
        alerts = runtime.store.query(
            agent_id=wired_watchdog.id, type=EntryType.ALERT, tags=["gpu_leak_released"],
        )
        assert len(alerts) >= 1

        await scheduler.shutdown()


# ===========================================================================
# API methods
# ===========================================================================

class TestWatchdogAPI:

    @pytest.mark.asyncio
    async def test_get_health_summary(self, runtime, wired_watchdog):
        """get_health_summary returns monitored agents."""
        info = await runtime.spawn(HangingExecutor, goal="summary-test")
        await asyncio.sleep(0.1)

        await wired_watchdog.on_monitor()

        summary = wired_watchdog.get_health_summary()
        assert summary["monitored_count"] >= 1
        assert summary["scan_count"] >= 1
        agent_ids = [a["agent_id"] for a in summary["agents"]]
        assert info.id in agent_ids

        await runtime.stop(info.id)

    @pytest.mark.asyncio
    async def test_get_recent_actions(self, runtime, wired_watchdog):
        """get_recent_actions returns action audit log."""
        result = wired_watchdog.get_recent_actions()
        assert "actions" in result
        assert "total" in result
        assert isinstance(result["actions"], list)

    @pytest.mark.asyncio
    async def test_get_status(self, runtime, wired_watchdog):
        """get_status returns operational info."""
        status = wired_watchdog.get_status()
        assert status["status"] == "running"
        assert "config" in status
        assert status["config"]["llm_diagnosis_enabled"] is False

    @pytest.mark.asyncio
    async def test_update_config(self, runtime, wired_watchdog):
        """update_config changes thresholds at runtime."""
        old_timeout = wired_watchdog._cfg.hang_timeout_seconds

        result = wired_watchdog.update_config({"hang_timeout_seconds": 9999})
        assert wired_watchdog._cfg.hang_timeout_seconds == 9999
        assert result["config"]["hang_timeout_seconds"] == 9999

    @pytest.mark.asyncio
    async def test_update_scan_interval_updates_monitor_interval(self, runtime, wired_watchdog):
        """Changing scan_interval_seconds also updates monitor_interval."""
        wired_watchdog.update_config({"scan_interval_seconds": 42.0})
        assert wired_watchdog.monitor_interval == 42.0


# ===========================================================================
# Snapshot lifecycle
# ===========================================================================

class TestSnapshotLifecycle:

    @pytest.mark.asyncio
    async def test_snapshots_pruned_for_completed_agents(self, runtime, wired_watchdog):
        """Snapshots for completed agents are cleaned up."""
        # Use HangingExecutor so it stays alive long enough for the scan
        info = await runtime.spawn(HangingExecutor, goal="prune-test")
        await asyncio.sleep(0.2)  # let it start

        # Scan while running — should add to snapshots
        await wired_watchdog.on_monitor()
        assert info.id in wired_watchdog._snapshots

        # Stop it
        await runtime.stop(info.id)
        await asyncio.sleep(0.2)

        # Scan again — snapshot should be pruned (agent no longer active)
        await wired_watchdog.on_monitor()
        assert info.id not in wired_watchdog._snapshots


# ===========================================================================
# Integration: watchdog lifecycle
# ===========================================================================

class TestWatchdogLifecycle:

    @pytest.mark.asyncio
    async def test_watchdog_starts_and_stops(self, runtime):
        """Watchdog can be started and stopped cleanly."""
        wd = GlobalWatchdogAgent()
        runtime.register_local(
            wd, goal="lifecycle-test",
            config={"scan_interval_seconds": 0.1},
        )

        await wd.start()
        assert wd.status == AgentStatus.RUNNING

        await wd.stop()
        assert wd.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_watchdog_is_leaf_node(self, runtime):
        """Watchdog cannot spawn children."""
        wd = GlobalWatchdogAgent()
        assert wd.allowed_child_roles == frozenset()
        assert wd.role == "watchdog"

    @pytest.mark.asyncio
    async def test_on_monitor_without_runtime(self):
        """on_monitor is a no-op when runtime is None."""
        wd = GlobalWatchdogAgent()
        wd._cfg = WatchdogConfig()
        # Should not raise
        await wd.on_monitor()
        assert wd._scan_count == 1  # count increments, but no work done
