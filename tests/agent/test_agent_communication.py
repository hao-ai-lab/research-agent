"""Tests for agent communication and delegation patterns."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server'))

from agent.core.agent import Agent, AgentStatus
from agent.core.bus import MessageBus
from agent.core.message import Message, MessageType
from agent.core.runtime import AgentRuntime


# ── Specialized Test Agents ───────────────────────────────────────

class WorkerAgent(Agent):
    """Does N iterations of work, emitting results."""

    async def run(self):
        n = self.config.get("work_items", 3)
        for i in range(n):
            if self.is_cancelled():
                break
            await self._wait_if_paused()
            self.iteration += 1
            await self.send(Message.result(self.id, f"completed item {i+1}"))
            await asyncio.sleep(0.05)


class DelegatorAgent(Agent):
    """Forks two workers and collects their results."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.results: list[str] = []

    async def run(self):
        # Fork two workers
        h1 = await self.fork(WorkerAgent, goal="batch-1", work_items=2)
        h2 = await self.fork(WorkerAgent, goal="batch-2", work_items=3)

        # Wait for both
        child1 = await h1.wait(timeout=5.0)
        child2 = await h2.wait(timeout=5.0)

        self.results.append(f"child1: {child1.iteration}")
        self.results.append(f"child2: {child2.iteration}")

        await self.send(Message.result(
            self.id, f"delegated to {len(self._children)} children"
        ))


class ObserverAgent(Agent):
    """Subscribes to all messages and records them."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.observed: list[Message] = []

    async def run(self):
        # Subscribe to everything (done after registration by runtime)
        if self._bus:
            self._bus.subscribe_all(self.id)

        while not self.is_cancelled():
            msg = await self.receive(timeout=0.2)
            if msg:
                self.observed.append(msg)
            await asyncio.sleep(0.02)


class PausableWorker(Agent):
    """A worker that can be paused and steered mid-work."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.steering_history: list[str] = []

    async def run(self):
        for _ in range(20):
            if self.is_cancelled():
                break
            await self._wait_if_paused()

            steer = self.consume_steer()
            if steer:
                self.steering_history.append(steer)

            self.iteration += 1
            await asyncio.sleep(0.05)


# ── Delegation Tests ──────────────────────────────────────────────

class TestAgentDelegation:
    @pytest.mark.asyncio
    async def test_delegator_forks_two_children(self):
        """DelegatorAgent forks two children and collects results."""
        runtime = AgentRuntime()
        agent = await runtime.spawn(DelegatorAgent, goal="delegate work")

        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        assert agent.status == AgentStatus.DONE
        assert len(agent._children) == 2
        assert "child1: 2" in agent.results
        assert "child2: 3" in agent.results

    @pytest.mark.asyncio
    async def test_fork_cancel(self):
        """Cancelling a child via ForkHandle stops it."""
        runtime = AgentRuntime()

        class CancellingParent(Agent):
            async def run(self):
                handle = await self.fork(WorkerAgent, goal="long", work_items=100)
                await asyncio.sleep(0.1)
                await handle.cancel()
                self.iteration = handle.agent.iteration

        parent = await runtime.spawn(CancellingParent, goal="test cancel")
        if parent._task:
            try:
                await asyncio.wait_for(parent._task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        # Child should have been cancelled before 100 iterations
        assert parent.iteration < 100


# ── Communication Tests ──────────────────────────────────────────

class TestAgentCommunication:
    @pytest.mark.asyncio
    async def test_bus_message_history_after_agents_run(self):
        """Running agents' messages appear in bus history."""
        runtime = AgentRuntime()
        agent = await runtime.spawn(WorkerAgent, goal="work", config={"work_items": 3})

        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        results = runtime.bus.history(agent_id=agent.id, msg_type=MessageType.RESULT)
        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_observer_sees_other_agents(self):
        """Observer agent receives messages from other agents."""
        runtime = AgentRuntime()
        observer = await runtime.spawn(ObserverAgent, goal="watch")
        await asyncio.sleep(0.1)  # Let observer subscribe

        worker = await runtime.spawn(WorkerAgent, goal="do work", config={"work_items": 2})
        if worker._task:
            try:
                await asyncio.wait_for(worker._task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        await asyncio.sleep(0.3)  # Let observer process

        await runtime.stop(observer.id)

        # Observer should have seen some messages
        assert len(observer.observed) > 0

    @pytest.mark.asyncio
    async def test_global_listener_for_sse(self):
        """Simulates SSE: global listener captures all messages."""
        runtime = AgentRuntime()
        captured = []
        runtime.bus.add_listener(lambda m: captured.append(m))

        agent = await runtime.spawn(WorkerAgent, goal="test", config={"work_items": 2})
        if agent._task:
            try:
                await asyncio.wait_for(agent._task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        # Should have captured spawner + status + results + done status
        assert len(captured) > 0
        types = {m.type for m in captured}
        assert MessageType.STATUS in types or MessageType.RESULT in types


# ── User Steering Flow Tests ─────────────────────────────────────

class TestUserSteeringFlow:
    @pytest.mark.asyncio
    async def test_pause_steer_resume(self):
        """Full user steering flow: pause → steer → resume."""
        runtime = AgentRuntime()
        agent = await runtime.spawn(PausableWorker, goal="initial task")
        await asyncio.sleep(0.15)

        # Pause
        await runtime.pause(agent.id)
        assert agent.status == AgentStatus.PAUSED
        iter_at_pause = agent.iteration

        # Steer while paused
        await runtime.steer(agent.id, "switch to task B")

        # Resume
        await runtime.resume(agent.id)
        await asyncio.sleep(0.3)

        # Should have advanced and consumed steering
        assert agent.iteration > iter_at_pause
        assert "switch to task B" in agent.steering_history

        await runtime.stop(agent.id)


# ── Concurrent Execution Tests ────────────────────────────────────

class TestConcurrentAgents:
    @pytest.mark.asyncio
    async def test_multiple_agents_concurrent(self):
        """Multiple agents run concurrently and complete independently."""
        runtime = AgentRuntime()

        agents = []
        for i in range(5):
            agent = await runtime.spawn(
                WorkerAgent,
                goal=f"work-{i}",
                config={"work_items": i + 1},
            )
            agents.append(agent)

        # Wait for all to complete
        for agent in agents:
            if agent._task:
                try:
                    await asyncio.wait_for(agent._task, timeout=5.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass

        for i, agent in enumerate(agents):
            assert agent.status == AgentStatus.DONE
            assert agent.iteration == i + 1
