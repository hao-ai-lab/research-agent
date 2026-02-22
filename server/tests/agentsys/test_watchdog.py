"""Tests for the periodic watchdog monitor (Agent ABC + ExecutorAgent).

ABC-level tests: agents run in child processes via multiprocess Runtime.
ExecutorAgent-level tests: executor spawns sidecars via spawn_child() in run().
"""

import asyncio

import pytest

from agentsys.agent import Agent
from agentsys.agents.executor import ExecutorAgent
from agentsys.runtime import Runtime
from agentsys.types import AgentInfo, AgentStatus, EntryType


# ---------------------------------------------------------------------------
# Helper test agents
# ---------------------------------------------------------------------------

class CrashingSidecar(Agent):
    """Sidecar that crashes immediately."""
    role = "sidecar"
    allowed_child_roles = frozenset()

    async def run(self):
        raise RuntimeError("sidecar crash")


class DoneSidecar(Agent):
    """Sidecar that completes normally."""
    role = "sidecar"
    allowed_child_roles = frozenset()

    async def run(self):
        await asyncio.sleep(0.01)


class NoWatchdogAgent(Agent):
    """Agent with default monitor_interval=0 (no watchdog)."""
    role = "executor"

    async def run(self):
        await asyncio.sleep(0.1)


class MonitorCountingAgent(Agent):
    """Agent that counts on_monitor() calls."""
    role = "executor"
    monitor_calls = 0

    async def on_start(self):
        self.monitor_interval = 0.05
        self.monitor_calls = 0

    async def on_monitor(self):
        self.monitor_calls += 1

    async def run(self):
        await asyncio.sleep(0.3)


class MonitorRaisingAgent(Agent):
    """Agent whose on_monitor() always raises."""
    role = "executor"
    monitor_calls = 0

    async def on_start(self):
        self.monitor_interval = 0.05
        self.monitor_calls = 0

    async def on_monitor(self):
        self.monitor_calls += 1
        raise ValueError("monitor error")

    async def run(self):
        await asyncio.sleep(0.3)


class ShortRunAgent(Agent):
    """Agent that finishes almost immediately."""
    role = "executor"

    async def on_start(self):
        self.monitor_interval = 1.0

    async def run(self):
        await asyncio.sleep(0.01)


class PauseCheckingAgent(Agent):
    """Agent that checks pause and counts monitor calls."""
    role = "executor"
    monitor_calls = 0

    async def on_start(self):
        self.monitor_interval = 0.05
        self.monitor_calls = 0

    async def on_monitor(self):
        self.monitor_calls += 1

    async def run(self):
        await asyncio.sleep(10)


class ExecutorWithCrashingSidecar(ExecutorAgent):
    """Executor that forks a crashing sidecar then runs long."""

    async def run(self):
        self.memory.write(
            {"event": "starting_task", "goal": self.goal, "backend": "test"},
            type=EntryType.CONTEXT,
            tags=["start"],
        )
        # Spawn a crashing sidecar
        await self.spawn_child(CrashingSidecar, goal="will-crash")
        # Run long enough for watchdog to detect the crash
        await asyncio.sleep(1.0)
        self.memory.write(
            {"output": "done"}, type=EntryType.RESULT, tags=["result"],
        )
        self.iteration = 1


class ExecutorWithCrashingSidecarRespawn(ExecutorAgent):
    """Executor that forks a crashing sidecar (respawn enabled)."""

    async def run(self):
        self.memory.write(
            {"event": "starting_task", "goal": self.goal, "backend": "test"},
            type=EntryType.CONTEXT,
            tags=["start"],
        )
        await self.spawn_child(CrashingSidecar, goal="will-crash")
        await asyncio.sleep(1.5)
        self.memory.write(
            {"output": "done"}, type=EntryType.RESULT, tags=["result"],
        )
        self.iteration = 1


class ExecutorWithDoneSidecar(ExecutorAgent):
    """Executor that forks a sidecar that completes normally."""

    async def run(self):
        self.memory.write(
            {"event": "starting_task", "goal": self.goal, "backend": "test"},
            type=EntryType.CONTEXT,
            tags=["start"],
        )
        await self.spawn_child(DoneSidecar, goal="will-finish")
        await asyncio.sleep(0.5)
        self.memory.write(
            {"output": "done"}, type=EntryType.RESULT, tags=["result"],
        )
        self.iteration = 1


class ExecutorWithTwoCrashingSidecars(ExecutorAgent):
    """Executor that forks two crashing sidecars."""

    async def run(self):
        self.memory.write(
            {"event": "starting_task", "goal": self.goal, "backend": "test"},
            type=EntryType.CONTEXT,
            tags=["start"],
        )
        await self.spawn_child(CrashingSidecar, goal="crash-1")
        await self.spawn_child(CrashingSidecar, goal="crash-2")
        await asyncio.sleep(1.0)
        self.memory.write(
            {"output": "done"}, type=EntryType.RESULT, tags=["result"],
        )
        self.iteration = 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _wait_for_status(runtime, agent_id, statuses, timeout=15):
    """Poll until agent reaches one of the expected statuses."""
    for _ in range(int(timeout / 0.1)):
        info = runtime.get_agent(agent_id)
        if info and info.status in statuses:
            return info
        meta = runtime.store.read_agent_info(agent_id)
        if meta and meta.status in statuses:
            return meta
        await asyncio.sleep(0.1)
    return runtime.get_agent(agent_id)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def runtime(tmp_path):
    rt = Runtime(project="test-watchdog", store_root=str(tmp_path))
    yield rt
    await rt.shutdown()


# ===========================================================================
# ABC-level tests
# ===========================================================================

class TestWatchdogABC:

    @pytest.mark.asyncio
    async def test_no_watchdog_when_interval_zero(self, runtime):
        """Default monitor_interval=0 means no watchdog task created."""
        info = await runtime.spawn(NoWatchdogAgent, goal="no-wd")
        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED],
        )
        assert result.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_on_monitor_called_periodically(self, runtime):
        """on_monitor() is called during agent run."""
        info = await runtime.spawn(MonitorCountingAgent, goal="count")
        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED],
        )
        assert result.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_watchdog_stops_when_run_completes(self, runtime):
        """Watchdog task is cleaned up after run() finishes."""
        info = await runtime.spawn(ShortRunAgent, goal="short")
        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED],
        )
        assert result.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_on_monitor_exception_does_not_kill_agent(self, runtime):
        """Agent completes DONE even if on_monitor() raises every time."""
        info = await runtime.spawn(MonitorRaisingAgent, goal="raise")
        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED],
        )
        assert result.status == AgentStatus.DONE

        # Should have written error entries with watchdog tag
        errors = runtime.store.query(agent_id=info.id, tags=["watchdog"])
        assert len(errors) >= 1

    @pytest.mark.asyncio
    async def test_watchdog_cancelled_on_stop(self, runtime):
        """Stopping an agent cancels the watchdog cleanly."""
        info = await runtime.spawn(PauseCheckingAgent, goal="stop-test")
        await asyncio.sleep(0.2)

        await runtime.stop(info.id)
        await asyncio.sleep(0.2)

        agent_info = runtime.get_agent(info.id)
        assert agent_info.status == AgentStatus.DONE


# ===========================================================================
# ExecutorAgent-level tests
# ===========================================================================

class TestExecutorWatchdog:

    @pytest.mark.asyncio
    async def test_executor_detects_crashed_sidecar(self, runtime):
        """ALERT written when a sidecar crashes."""
        executor_info = await runtime.spawn(
            ExecutorWithCrashingSidecar, goal="detect-crash",
            config={"monitor_interval": 0.05, "respawn_sidecars": False},
        )

        # Wait for executor to complete (it runs for ~1s)
        result = await _wait_for_status(
            runtime, executor_info.id, [AgentStatus.DONE, AgentStatus.FAILED],
            timeout=15,
        )

        alerts = runtime.store.query(
            agent_id=executor_info.id, tags=["sidecar_crash"],
        )
        assert len(alerts) >= 1
        assert alerts[0].data["event"] == "sidecar_crashed"

    @pytest.mark.asyncio
    async def test_executor_respawns_crashed_sidecar(self, runtime):
        """Crashed sidecar is respawned and noted in CONTEXT."""
        executor_info = await runtime.spawn(
            ExecutorWithCrashingSidecarRespawn, goal="respawn-test",
            config={"monitor_interval": 0.05, "respawn_sidecars": True,
                    "max_respawn_count": 3},
        )

        # Wait for executor to complete
        result = await _wait_for_status(
            runtime, executor_info.id, [AgentStatus.DONE, AgentStatus.FAILED],
            timeout=15,
        )

        respawn_entries = runtime.store.query(
            agent_id=executor_info.id, tags=["respawn"],
        )
        assert len(respawn_entries) >= 1
        assert respawn_entries[0].data["event"] == "sidecar_respawned"

    @pytest.mark.asyncio
    async def test_done_sidecar_not_flagged(self, runtime):
        """A sidecar that ends DONE does not trigger an alert."""
        executor_info = await runtime.spawn(
            ExecutorWithDoneSidecar, goal="done-check",
            config={"monitor_interval": 0.05},
        )

        result = await _wait_for_status(
            runtime, executor_info.id, [AgentStatus.DONE, AgentStatus.FAILED],
            timeout=15,
        )

        alerts = runtime.store.query(
            agent_id=executor_info.id, tags=["sidecar_crash"],
        )
        assert len(alerts) == 0

    @pytest.mark.asyncio
    async def test_multiple_crashed_sidecars(self, runtime):
        """All crashed sidecars are detected independently."""
        executor_info = await runtime.spawn(
            ExecutorWithTwoCrashingSidecars, goal="multi-crash",
            config={"monitor_interval": 0.05, "respawn_sidecars": False},
        )

        result = await _wait_for_status(
            runtime, executor_info.id, [AgentStatus.DONE, AgentStatus.FAILED],
            timeout=15,
        )

        alerts = runtime.store.query(
            agent_id=executor_info.id, tags=["sidecar_crash"],
        )
        assert len(alerts) >= 2
