"""Tests for Agent ABC lifecycle, spawn_child, steer, and communication."""

import asyncio
import tempfile

import pytest

from agentsys.agent import Agent, ChildHandle
from agentsys.filestore import FileStore
from agentsys.memory import MemoryView
from agentsys.runtime import Runtime
from agentsys.types import AgentStatus, EntryType, Steer, SteerUrgency


# ---------------------------------------------------------------------------
# Test agent subclasses
# ---------------------------------------------------------------------------

class SimpleAgent(Agent):
    """Agent that runs for a few iterations then exits."""
    role = "executor"

    async def run(self):
        for i in range(3):
            await self.check_pause()
            self.iteration = i + 1
            await asyncio.sleep(0.05)


class FailingAgent(Agent):
    """Agent that raises an exception in run()."""
    role = "executor"

    async def run(self):
        raise ValueError("intentional failure")


class SlowAgent(Agent):
    """Agent that sleeps for a long time (for cancel tests)."""
    role = "executor"

    async def run(self):
        await asyncio.sleep(10)


class SteerCheckingAgent(Agent):
    """Agent that checks steers between iterations."""
    role = "executor"
    steers_received: list

    async def run(self):
        self.steers_received = []
        for i in range(5):
            steer = self.consume_steer()
            if steer:
                self.steers_received.append(steer)
            await asyncio.sleep(0.05)


class ForkingAgent(Agent):
    """Agent that spawns a child then waits."""
    role = "orchestrator"
    child_handle: ChildHandle | None = None

    async def run(self):
        self.child_handle = await self.spawn_child(SimpleAgent, goal="sub-task")
        await self.child_handle.wait()


class MsgSendingAgent(Agent):
    """Agent that sends a message then exits."""
    role = "orchestrator"

    async def run(self):
        target = self.config.get("target_id", "exec-1")
        self.msg(target, {"greeting": "hello"})


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.fixture
async def runtime(tmp_path):
    rt = Runtime(project="test", store_root=str(tmp_path))
    yield rt
    await rt.shutdown()


class TestLifecycle:

    @pytest.mark.asyncio
    async def test_agent_start_stop(self, runtime):
        info = await runtime.spawn(SimpleAgent, goal="test")
        assert runtime.get_agent(info.id).status == AgentStatus.RUNNING

        await runtime.stop(info.id)
        # Give process time to stop
        await asyncio.sleep(0.2)
        agent_info = runtime.get_agent(info.id)
        assert agent_info.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_agent_pause_resume(self, runtime):
        info = await runtime.spawn(SlowAgent, goal="slow")
        assert runtime.get_agent(info.id).status == AgentStatus.RUNNING

        await runtime.pause(info.id)
        assert runtime.get_agent(info.id).status == AgentStatus.PAUSED

        await runtime.resume(info.id)
        assert runtime.get_agent(info.id).status == AgentStatus.RUNNING

        await runtime.stop(info.id)

    @pytest.mark.asyncio
    async def test_agent_run_to_completion(self, runtime):
        info = await runtime.spawn(SimpleAgent, goal="finish")

        # Poll for completion
        for _ in range(100):
            await asyncio.sleep(0.1)
            meta = runtime.store.read_agent_info(info.id)
            if meta and meta.status in (AgentStatus.DONE, AgentStatus.FAILED):
                break

        meta = runtime.store.read_agent_info(info.id)
        assert meta.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_agent_failure_sets_failed(self, runtime):
        info = await runtime.spawn(FailingAgent, goal="will fail")

        # Wait for process to finish
        for _ in range(100):
            await asyncio.sleep(0.1)
            meta = runtime.store.read_agent_info(info.id)
            if meta and meta.status in (AgentStatus.DONE, AgentStatus.FAILED):
                break

        meta = runtime.store.read_agent_info(info.id)
        assert meta.status == AgentStatus.FAILED

        # Should have written an error entry
        errors = runtime.store.query(agent_id=info.id, tags=["error"])
        assert len(errors) >= 1


class TestSteer:

    @pytest.mark.asyncio
    async def test_steer_inject_via_runtime(self, runtime):
        """PRIORITY steer is delivered to the agent."""
        info = await runtime.spawn(SlowAgent, goal="slow")
        await asyncio.sleep(0.2)

        result = await runtime.steer(info.id, "try lr=1e-4", SteerUrgency.PRIORITY)
        assert result is True

        await runtime.stop(info.id)


class TestFork:

    @pytest.mark.asyncio
    async def test_fork_via_runtime(self, runtime):
        """Parent spawns a child, both complete."""
        info = await runtime.spawn(ForkingAgent, goal="parent")

        # Wait for completion
        for _ in range(100):
            await asyncio.sleep(0.1)
            meta = runtime.store.read_agent_info(info.id)
            if meta and meta.status in (AgentStatus.DONE, AgentStatus.FAILED):
                break

        meta = runtime.store.read_agent_info(info.id)
        assert meta.status == AgentStatus.DONE


class TestMsg:

    @pytest.mark.asyncio
    async def test_msg_from_agent(self, runtime):
        # Spawn target first
        target = await runtime.spawn(SlowAgent, goal="target")
        sender = await runtime.spawn(
            MsgSendingAgent,
            goal="send msg",
            config={"target_id": target.id},
        )

        # Wait for sender to finish
        for _ in range(100):
            await asyncio.sleep(0.1)
            meta = runtime.store.read_agent_info(sender.id)
            if meta and meta.status in (AgentStatus.DONE, AgentStatus.FAILED):
                break

        # Target should have a message in the store
        inbox = runtime.store.query(target_id=target.id, type=EntryType.MESSAGE)
        assert len(inbox) == 1
        assert inbox[0].data == {"greeting": "hello"}

        await runtime.stop(target.id)
