"""Tests for Runtime -- multiprocess spawn, lifecycle cascade, steer routing."""

import asyncio

import pytest

from agentsys.agent import Agent
from agentsys.runtime import Runtime
from agentsys.types import AgentInfo, AgentStatus, EntryType, SteerUrgency


# ---------------------------------------------------------------------------
# Test agent subclasses
# ---------------------------------------------------------------------------

class SimpleAgent(Agent):
    """Quick agent for testing."""
    role = "executor"

    async def run(self):
        for _ in range(3):
            await self.check_pause()
            await asyncio.sleep(0.05)


class SlowAgent(Agent):
    """Long-running agent for lifecycle tests."""
    role = "executor"

    async def run(self):
        while True:
            await self.check_pause()
            await asyncio.sleep(0.1)


class ParentAgent(Agent):
    """Agent that spawns children."""
    role = "orchestrator"

    async def run(self):
        n = self.config.get("num_children", 2)
        for i in range(n):
            await self.spawn_child(SlowAgent, goal=f"child-{i}")
        while True:
            await self.check_pause()
            await asyncio.sleep(0.1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _wait_for_status(runtime, agent_id, statuses, timeout=10):
    """Poll until agent reaches one of the expected statuses."""
    for _ in range(int(timeout / 0.1)):
        info = runtime.get_agent(agent_id)
        if info and info.status in statuses:
            return info
        # Also check on disk
        meta = runtime.store.read_agent_info(agent_id)
        if meta and meta.status in statuses:
            return meta
        await asyncio.sleep(0.1)
    return runtime.get_agent(agent_id)


async def _wait_for_children(runtime, parent_id, count, timeout=10):
    """Poll until parent has the expected number of children in metadata."""
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
# Spawn tests
# ---------------------------------------------------------------------------

class TestSpawn:

    @pytest.mark.asyncio
    async def test_spawn_creates_agent_with_scope(self, runtime):
        info = await runtime.spawn(
            SimpleAgent, goal="do stuff",
            session="sess-1", sweep="sw-1", run="r-1",
        )

        assert isinstance(info, AgentInfo)
        assert info.scope["project"] == "test-proj"
        assert info.scope["session"] == "sess-1"
        assert info.scope["sweep"] == "sw-1"
        assert info.scope["run"] == "r-1"
        assert info.role == "executor"
        assert info.id.startswith("executor-")
        assert info.goal == "do stuff"

    @pytest.mark.asyncio
    async def test_spawn_inherits_parent_scope(self, runtime):
        parent = await runtime.spawn(
            SlowAgent, goal="parent",
            session="sess-A", sweep="sw-1",
        )
        child = await runtime.spawn(
            SimpleAgent, goal="child",
            parent_id=parent.id,
        )

        assert child.scope["project"] == "test-proj"
        assert child.scope["session"] == "sess-A"
        assert child.scope["sweep"] == "sw-1"
        assert child.parent_id == parent.id

        # Parent metadata should have child
        parent_meta = runtime._agent_meta[parent.id]
        assert child.id in parent_meta["children"]

        await runtime.stop(parent.id)

    @pytest.mark.asyncio
    async def test_spawn_override_beats_inheritance(self, runtime):
        parent = await runtime.spawn(
            SlowAgent, goal="parent",
            session="sess-A", sweep="sw-1",
        )
        child = await runtime.spawn(
            SimpleAgent, goal="child",
            parent_id=parent.id,
            sweep="sw-override",
            run="r-new",
        )

        assert child.scope["sweep"] == "sw-override"
        assert child.scope["run"] == "r-new"
        assert child.scope["session"] == "sess-A"

        await runtime.stop(parent.id)

    @pytest.mark.asyncio
    async def test_spawn_auto_start(self, runtime):
        info = await runtime.spawn(SimpleAgent, goal="auto", auto_start=True)
        assert runtime.get_agent(info.id).status == AgentStatus.RUNNING

        no_start = await runtime.spawn(SimpleAgent, goal="no-auto", auto_start=False)
        assert runtime.get_agent(no_start.id).status == AgentStatus.IDLE

        await runtime.stop(info.id)

    @pytest.mark.asyncio
    async def test_spawn_writes_context_entry(self, runtime):
        info = await runtime.spawn(SimpleAgent, goal="test-goal")

        # Wait for process to write the entry
        await asyncio.sleep(0.3)

        entries = runtime.store.query(agent_id=info.id, tags=["lifecycle"])
        assert len(entries) >= 1
        assert entries[0].data["event"] == "spawned"


# ---------------------------------------------------------------------------
# Lifecycle cascade tests
# ---------------------------------------------------------------------------

class TestCascade:

    @pytest.mark.asyncio
    async def test_stop_cascades_to_children(self, runtime):
        parent = await runtime.spawn(ParentAgent, goal="parent", config={"num_children": 2})

        # Wait for parent to spawn children
        children = await _wait_for_children(runtime, parent.id, 2)
        assert len(children) >= 2

        # Stop parent -> should cascade to children
        await runtime.stop(parent.id)
        await asyncio.sleep(0.3)

        for child_id in children:
            info = runtime.get_agent(child_id)
            assert info is not None
            assert info.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_pause_cascades_to_children(self, runtime):
        parent = await runtime.spawn(ParentAgent, goal="parent", config={"num_children": 2})
        children = await _wait_for_children(runtime, parent.id, 2)

        await runtime.pause(parent.id)

        assert runtime.get_agent(parent.id).status == AgentStatus.PAUSED
        for child_id in children:
            info = runtime.get_agent(child_id)
            assert info.status == AgentStatus.PAUSED

        await runtime.stop(parent.id)

    @pytest.mark.asyncio
    async def test_resume_cascades_to_children(self, runtime):
        parent = await runtime.spawn(ParentAgent, goal="parent", config={"num_children": 1})
        children = await _wait_for_children(runtime, parent.id, 1)

        await runtime.pause(parent.id)
        assert runtime.get_agent(parent.id).status == AgentStatus.PAUSED

        await runtime.resume(parent.id)
        assert runtime.get_agent(parent.id).status == AgentStatus.RUNNING

        for child_id in children:
            info = runtime.get_agent(child_id)
            assert info.status == AgentStatus.RUNNING

        await runtime.stop(parent.id)


# ---------------------------------------------------------------------------
# Steer routing tests
# ---------------------------------------------------------------------------

class TestSteer:

    @pytest.mark.asyncio
    async def test_steer_priority(self, runtime):
        info = await runtime.spawn(SlowAgent, goal="target")

        result = await runtime.steer(info.id, "try lr=1e-4", SteerUrgency.PRIORITY)
        assert result is True

        await runtime.stop(info.id)

    @pytest.mark.asyncio
    async def test_steer_critical_stops_and_reinjects(self, runtime):
        info = await runtime.spawn(
            SlowAgent, goal="original goal",
            session="sess-A",
        )
        old_id = info.id
        await asyncio.sleep(0.2)

        result = await runtime.steer(
            old_id, "loss function is wrong", SteerUrgency.CRITICAL,
        )
        assert result is True

        # Old agent should be gone from metadata
        assert runtime.get_agent(old_id) is None

        # A new agent should exist with modified goal
        active = runtime.list_active()
        assert len(active) >= 1
        new_agent = active[0]
        assert "original goal" in new_agent.goal
        assert "loss function is wrong" in new_agent.goal
        assert new_agent.scope["session"] == "sess-A"

        await runtime.stop(new_agent.id)

    @pytest.mark.asyncio
    async def test_steer_dead_agent_returns_false(self, runtime):
        info = await runtime.spawn(SimpleAgent, goal="quick")
        await _wait_for_status(runtime, info.id, [AgentStatus.DONE, AgentStatus.FAILED])

        result = await runtime.steer(info.id, "too late", SteerUrgency.PRIORITY)
        assert result is False

    @pytest.mark.asyncio
    async def test_steer_nonexistent_agent_returns_false(self, runtime):
        result = await runtime.steer("fake-id", "hello", SteerUrgency.PRIORITY)
        assert result is False


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

class TestQueryHelpers:

    @pytest.mark.asyncio
    async def test_agent_tree_structure(self, runtime):
        parent = await runtime.spawn(ParentAgent, goal="root", config={"num_children": 2})
        children = await _wait_for_children(runtime, parent.id, 2)

        tree = runtime.agent_tree()
        assert parent.id in tree.get(None, [])
        assert set(children) == set(tree.get(parent.id, []))

        await runtime.stop(parent.id)

    @pytest.mark.asyncio
    async def test_list_active(self, runtime):
        a1 = await runtime.spawn(SlowAgent, goal="a1")
        a2 = await runtime.spawn(SlowAgent, goal="a2")
        a3 = await runtime.spawn(SimpleAgent, goal="a3", auto_start=False)

        active = runtime.list_active()
        active_ids = {a.id for a in active}
        assert a1.id in active_ids
        assert a2.id in active_ids
        assert a3.id not in active_ids

        await runtime.stop(a1.id)
        await runtime.stop(a2.id)


# ---------------------------------------------------------------------------
# Shutdown and remove
# ---------------------------------------------------------------------------

class TestShutdownAndRemove:

    @pytest.mark.asyncio
    async def test_shutdown_stops_all(self, runtime):
        a1 = await runtime.spawn(SlowAgent, goal="a1")
        a2 = await runtime.spawn(SlowAgent, goal="a2")

        await runtime.shutdown()

        assert len(runtime._agent_meta) == 0

    @pytest.mark.asyncio
    async def test_remove_unregisters_but_memory_persists(self, runtime):
        info = await runtime.spawn(SimpleAgent, goal="ephemeral")
        agent_id = info.id

        # Wait for completion
        await _wait_for_status(runtime, agent_id, [AgentStatus.DONE, AgentStatus.FAILED])

        # Remove from metadata
        await runtime.remove(agent_id)
        assert runtime.get_agent(agent_id) is None

        # But memory entries still exist
        entries = runtime.store.query(agent_id=agent_id)
        assert len(entries) > 0
