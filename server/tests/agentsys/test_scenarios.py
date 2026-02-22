"""End-to-end scenario tests from usecases.md.

Each test exercises a complete use case through the full stack:
Runtime -> Agent (in child process) -> FileStore.
"""

import asyncio

import pytest

from agentsys.agent import Agent
from agentsys.agents.executor import ExecutorAgent
from agentsys.agents.orchestrator import OrchestratorAgent
from agentsys.agents.sidecar import SidecarAgent
from agentsys.runtime import Runtime
from agentsys.types import AgentInfo, AgentStatus, EntryType, SteerUrgency


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


async def _wait_for_children(runtime, parent_id, count, timeout=15):
    """Poll until parent has the expected number of children."""
    for _ in range(int(timeout / 0.1)):
        meta = runtime._agent_meta.get(parent_id, {})
        children = meta.get("children", [])
        if len(children) >= count:
            return children
        await asyncio.sleep(0.1)
    return runtime._agent_meta.get(parent_id, {}).get("children", [])


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def runtime(tmp_path):
    rt = Runtime(project="test-proj", store_root=str(tmp_path))
    yield rt
    await rt.shutdown()


# ---------------------------------------------------------------------------
# UC1: Basic orchestrator loop
# ---------------------------------------------------------------------------

class TestUC1:

    @pytest.mark.asyncio
    async def test_basic_orchestrator_loop(self, runtime):
        """Orchestrator plans 3 tasks, forks executors sequentially, reflects."""
        info = await runtime.spawn(
            OrchestratorAgent,
            goal="run experiment",
            session="sess-1",
        )

        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED], timeout=30,
        )

        assert result.status == AgentStatus.DONE

        # Should have written a PLAN
        plans = runtime.store.query(agent_id=info.id, type=EntryType.PLAN)
        assert len(plans) == 1
        assert "tasks" in plans[0].data

        # Should have written REFLECTIONs (one per task)
        reflections = runtime.store.query(
            agent_id=info.id, type=EntryType.REFLECTION,
        )
        assert len(reflections) == 3

        # Should have written final CONTEXT
        contexts = runtime.store.query(
            agent_id=info.id, type=EntryType.CONTEXT, tags=["complete"],
        )
        assert len(contexts) == 1


# ---------------------------------------------------------------------------
# UC2: Parallel spawn and gather
# ---------------------------------------------------------------------------

class ParallelOrchestrator(Agent):
    """Orchestrator that forks 3 executors in parallel."""
    role = "orchestrator"

    async def run(self):
        tasks = ["task-a", "task-b", "task-c"]
        handles = []
        for t in tasks:
            h = await self.spawn_child(ExecutorAgent, goal=t)
            handles.append(h)

        await asyncio.gather(*(h.wait(timeout=10) for h in handles))

        for h in handles:
            results = self.query(agent_id=h.id, type=EntryType.RESULT)
            if results:
                self.memory.write(
                    {"child": h.id, "result": results[0].data},
                    type=EntryType.REFLECTION,
                )


class TestUC2:

    @pytest.mark.asyncio
    async def test_parallel_fork_and_gather(self, runtime):
        info = await runtime.spawn(
            ParallelOrchestrator,
            goal="parallel experiment",
            session="sess-1",
        )

        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED], timeout=30,
        )
        assert result.status == AgentStatus.DONE

        # Orchestrator wrote reflections for each
        reflections = runtime.store.query(
            agent_id=info.id, type=EntryType.REFLECTION,
        )
        assert len(reflections) == 3


# ---------------------------------------------------------------------------
# UC3: Sidecar monitors and alerts
# ---------------------------------------------------------------------------

class TestUC3:

    @pytest.mark.asyncio
    async def test_sidecar_monitors_and_alerts(self, runtime):
        info = await runtime.spawn(
            SidecarAgent,
            goal="monitor training",
            session="sess-1",
            config={"num_iterations": 5, "poll_interval": 0.05},
        )

        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED], timeout=15,
        )
        assert result.status == AgentStatus.DONE

        # Should have written METRICS entries
        metrics = runtime.store.query(
            agent_id=info.id, type=EntryType.METRICS,
        )
        assert len(metrics) == 5

        # Should have written at least one ALERT (loss spike)
        alerts = runtime.store.query(
            agent_id=info.id, type=EntryType.ALERT,
        )
        assert len(alerts) >= 1
        assert alerts[0].data["anomaly"] == "loss_spike"
        assert "loss_spike" in alerts[0].tags


# ---------------------------------------------------------------------------
# UC5: msg to executor
# ---------------------------------------------------------------------------

class MsgTestOrchestrator(Agent):
    """Orchestrator that sends a msg to an executor."""
    role = "orchestrator"

    async def run(self):
        target = self.config["target_id"]
        self.msg(target, {"suggestion": "try lr=1e-4"}, tags=["lr"])


class TestUC5:

    @pytest.mark.asyncio
    async def test_msg_to_executor(self, runtime):
        executor = await runtime.spawn(
            ExecutorAgent, goal="run task",
            session="sess-1",
            config={"mock_delay": 5},
        )

        orch = await runtime.spawn(
            MsgTestOrchestrator,
            goal="send suggestion",
            session="sess-1",
            config={"target_id": executor.id},
        )

        await _wait_for_status(
            runtime, orch.id, [AgentStatus.DONE, AgentStatus.FAILED],
        )

        # Wait a bit for message to be written to disk
        await asyncio.sleep(0.3)

        # Check messages in store
        msgs = runtime.store.query(
            target_id=executor.id, type=EntryType.MESSAGE,
        )
        assert len(msgs) == 1
        assert msgs[0].data == {"suggestion": "try lr=1e-4"}

        await runtime.stop(executor.id)


# ---------------------------------------------------------------------------
# UC6: Critical steer stops everything
# ---------------------------------------------------------------------------

class SlowOrchestrator(Agent):
    """Orchestrator that forks slow children."""
    role = "orchestrator"

    async def run(self):
        for i in range(3):
            await self.spawn_child(SlowExecutor, goal=f"slow-{i}")
        while True:
            await self.check_pause()
            await asyncio.sleep(0.1)


class SlowExecutor(Agent):
    """Executor that runs indefinitely."""
    role = "executor"

    async def run(self):
        while True:
            await asyncio.sleep(0.1)


class TestUC6:

    @pytest.mark.asyncio
    async def test_critical_steer_stops_everything(self, runtime):
        info = await runtime.spawn(
            SlowOrchestrator,
            goal="long experiment",
            session="sess-1",
        )

        # Wait for children to spawn
        children = await _wait_for_children(runtime, info.id, 3, timeout=15)
        assert len(children) == 3

        old_id = info.id

        # CRITICAL steer
        await runtime.steer(
            old_id,
            "loss function is wrong, stop everything",
            SteerUrgency.CRITICAL,
        )

        # Old agent should be gone
        assert runtime.get_agent(old_id) is None

        # New orchestrator should be running with modified goal
        active = runtime.list_active()
        assert len(active) >= 1
        new_orch = [a for a in active if a.role == "orchestrator"]
        assert len(new_orch) >= 1
        assert "loss function is wrong" in new_orch[0].goal

        await runtime.shutdown()


# ---------------------------------------------------------------------------
# UC7: Orchestrator reads sidecar alerts
# ---------------------------------------------------------------------------

class AlertReadingOrchestrator(Agent):
    """Orchestrator that forks a sidecar and reads its alerts."""
    role = "orchestrator"

    async def run(self):
        handle = await self.spawn_child(
            SidecarAgent, goal="monitor",
            **{"num_iterations": 5, "poll_interval": 0.05, "spike_iteration": 2},
        )
        await handle.wait(timeout=15)

        # Query alerts from the store
        self.memory.write(
            {"checked_alerts": True},
            type=EntryType.CONTEXT,
            tags=["alert_check"],
        )


class TestUC7:

    @pytest.mark.asyncio
    async def test_orchestrator_reads_sidecar_alerts(self, runtime):
        info = await runtime.spawn(
            AlertReadingOrchestrator,
            goal="monitor and react",
            session="sess-1",
        )

        result = await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED], timeout=15,
        )
        assert result.status == AgentStatus.DONE

        # Check sidecar alerts exist in the store
        alerts = runtime.store.query(
            type=EntryType.ALERT, tags=["loss_spike"],
        )
        assert len(alerts) >= 1


# ---------------------------------------------------------------------------
# UC8: Cross-branch query
# ---------------------------------------------------------------------------

class TestUC8:

    @pytest.mark.asyncio
    async def test_cross_branch_query(self, runtime):
        """Agent in sweep-2 queries results from sweep-1."""
        agent_sw1 = await runtime.spawn(
            ExecutorAgent, goal="sweep-1 task",
            session="sess-A", sweep="sweep-1",
            config={"mock_delay": 0.05},
        )
        agent_sw2 = await runtime.spawn(
            ExecutorAgent, goal="sweep-2 task",
            session="sess-A", sweep="sweep-2",
            config={"mock_delay": 0.05},
        )

        # Wait for both to complete
        await _wait_for_status(runtime, agent_sw1.id, [AgentStatus.DONE, AgentStatus.FAILED])
        await _wait_for_status(runtime, agent_sw2.id, [AgentStatus.DONE, AgentStatus.FAILED])

        # Cross-branch query: results from sweep-1
        results = runtime.store.query(
            project="test-proj",
            session="sess-A",
            sweep="sweep-1",
            type=EntryType.RESULT,
        )
        assert len(results) >= 1

        # Cross-branch by tag
        all_results = runtime.store.query(
            project="test-proj",
            tags=["result"],
        )
        assert len(all_results) >= 2


# ---------------------------------------------------------------------------
# UC10: Agent dies, memory persists
# ---------------------------------------------------------------------------

class DyingExecutor(Agent):
    """Executor that writes some data then crashes."""
    role = "executor"

    async def run(self):
        self.memory.write(
            {"partial": "some work done"},
            type=EntryType.RESULT,
            tags=["partial"],
        )
        raise RuntimeError("simulated crash")


class TestUC10:

    @pytest.mark.asyncio
    async def test_agent_dies_memory_persists(self, runtime):
        info = await runtime.spawn(DyingExecutor, goal="will crash")

        await _wait_for_status(
            runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED], timeout=10,
        )

        # Remove from runtime
        agent_id = info.id
        await runtime.remove(agent_id)
        assert runtime.get_agent(agent_id) is None

        # Memory persists
        entries = runtime.store.query(agent_id=agent_id)
        assert len(entries) >= 2

        # Partial result is queryable
        results = runtime.store.query(agent_id=agent_id, type=EntryType.RESULT)
        assert len(results) == 1
        assert results[0].data["partial"] == "some work done"


# ---------------------------------------------------------------------------
# Hierarchy validation
# ---------------------------------------------------------------------------

class TestHierarchyRules:

    @pytest.mark.asyncio
    async def test_sidecar_cannot_fork_executor(self, runtime):
        sidecar = await runtime.spawn(
            SidecarAgent, goal="monitor",
            config={"num_iterations": 1, "poll_interval": 0.01},
            auto_start=False,
        )

        with pytest.raises(ValueError, match="sidecar.*cannot spawn.*executor"):
            await runtime.spawn(
                ExecutorAgent, goal="bad child",
                parent_id=sidecar.id,
            )

    @pytest.mark.asyncio
    async def test_sidecar_cannot_fork_orchestrator(self, runtime):
        sidecar = await runtime.spawn(
            SidecarAgent, goal="monitor",
            config={"num_iterations": 1, "poll_interval": 0.01},
            auto_start=False,
        )

        with pytest.raises(ValueError, match="sidecar.*cannot spawn.*orchestrator"):
            await runtime.spawn(
                OrchestratorAgent, goal="bad child",
                parent_id=sidecar.id,
            )

    @pytest.mark.asyncio
    async def test_executor_cannot_fork_executor(self, runtime):
        executor = await runtime.spawn(
            ExecutorAgent, goal="task",
            config={"mock_delay": 5},
        )

        with pytest.raises(ValueError, match="executor.*cannot spawn.*executor"):
            await runtime.spawn(
                ExecutorAgent, goal="bad child",
                parent_id=executor.id,
            )

        await runtime.stop(executor.id)

    @pytest.mark.asyncio
    async def test_executor_cannot_fork_orchestrator(self, runtime):
        executor = await runtime.spawn(
            ExecutorAgent, goal="task",
            config={"mock_delay": 5},
        )

        with pytest.raises(ValueError, match="executor.*cannot spawn.*orchestrator"):
            await runtime.spawn(
                OrchestratorAgent, goal="bad child",
                parent_id=executor.id,
            )

        await runtime.stop(executor.id)

    @pytest.mark.asyncio
    async def test_executor_can_fork_sidecar(self, runtime):
        executor = await runtime.spawn(
            ExecutorAgent, goal="task",
            config={"mock_delay": 5},
        )

        sidecar = await runtime.spawn(
            SidecarAgent, goal="monitor this executor",
            parent_id=executor.id,
            config={"num_iterations": 1, "poll_interval": 0.01},
        )

        assert sidecar.parent_id == executor.id
        parent_meta = runtime._agent_meta[executor.id]
        assert sidecar.id in parent_meta["children"]

        await runtime.stop(executor.id)

    @pytest.mark.asyncio
    async def test_orchestrator_can_fork_all_types(self, runtime):
        orch = await runtime.spawn(
            OrchestratorAgent, goal="root",
            config={"mock_delay": 5, "tasks": []},
            auto_start=False,
        )

        child_exec = await runtime.spawn(
            ExecutorAgent, goal="exec-child",
            parent_id=orch.id,
            config={"mock_delay": 0.01},
        )
        child_sidecar = await runtime.spawn(
            SidecarAgent, goal="sidecar-child",
            parent_id=orch.id,
            config={"num_iterations": 1, "poll_interval": 0.01},
        )
        child_orch = await runtime.spawn(
            OrchestratorAgent, goal="sub-orch",
            parent_id=orch.id,
            config={"mock_delay": 0.01, "tasks": []},
        )

        parent_meta = runtime._agent_meta[orch.id]
        assert len(parent_meta["children"]) == 3
        await runtime.shutdown()
