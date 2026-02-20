"""Tests for core agent framework: Agent lifecycle, MessageBus, AgentRuntime."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server'))

from agent.core.agent import Agent, AgentStatus, ForkHandle
from agent.core.bus import MessageBus
from agent.core.message import Message, MessageType
from agent.core.runtime import AgentRuntime


# ── Test Agents ───────────────────────────────────────────────────

class CounterAgent(Agent):
    """Counts iterations, stops after max_iterations."""

    async def run(self):
        max_iters = self.config.get("max_iterations", 3)
        while self.iteration < max_iters and not self.is_cancelled():
            await self._wait_if_paused()
            self.iteration += 1
            await self.send(Message.result(self.id, f"iter {self.iteration}"))
            await asyncio.sleep(0.05)


class FailingAgent(Agent):
    """Raises an exception after 1 iteration."""

    async def run(self):
        self.iteration += 1
        raise RuntimeError("intentional failure")


class SteerableAgent(Agent):
    """Records steering events."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.steers: list[str] = []

    async def run(self):
        for _ in range(10):
            if self.is_cancelled():
                break
            await self._wait_if_paused()
            self.iteration += 1

            steer = self.consume_steer()
            if steer:
                self.steers.append(steer)

            await asyncio.sleep(0.05)


class ForkingAgent(Agent):
    """Forks a child and waits for it."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.child_result: Agent | None = None

    async def run(self):
        handle = await self.fork(CounterAgent, goal="sub-task", max_iterations=2)
        child = await handle.wait(timeout=5.0)
        self.child_result = child
        await self.send(Message.result(
            self.id,
            f"child {child.id} finished with status {child.status.value}",
        ))


class MessageReceiverAgent(Agent):
    """Subscribes to events and records them."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.received: list[Message] = []

    async def run(self):
        while not self.is_cancelled():
            msg = await self.receive(timeout=0.5)
            if msg:
                self.received.append(msg)
            await asyncio.sleep(0.02)


# ── Agent Lifecycle Tests ─────────────────────────────────────────

class TestAgentLifecycle:
    @pytest.mark.asyncio
    async def test_spawn_and_run(self, runtime):
        agent = await runtime.spawn(CounterAgent, goal="count", config={"max_iterations": 3})
        assert agent.status == AgentStatus.RUNNING

        await asyncio.sleep(0.5)
        assert agent.status == AgentStatus.DONE
        assert agent.iteration == 3

    @pytest.mark.asyncio
    async def test_stop(self, runtime):
        agent = await runtime.spawn(CounterAgent, goal="long", config={"max_iterations": 100})
        await asyncio.sleep(0.1)
        await runtime.stop(agent.id)
        assert agent.status == AgentStatus.DONE

    @pytest.mark.asyncio
    async def test_pause_resume(self, runtime):
        agent = await runtime.spawn(CounterAgent, goal="pausable", config={"max_iterations": 100})
        await asyncio.sleep(0.1)

        await runtime.pause(agent.id)
        assert agent.status == AgentStatus.PAUSED

        iter_at_pause = agent.iteration
        await asyncio.sleep(0.3)
        assert agent.iteration == iter_at_pause  # shouldn't advance

        await runtime.resume(agent.id)
        await asyncio.sleep(0.3)
        assert agent.iteration > iter_at_pause  # should advance

        await runtime.stop(agent.id)

    @pytest.mark.asyncio
    async def test_failure_sets_status(self, runtime):
        agent = await runtime.spawn(FailingAgent, goal="fail")
        await asyncio.sleep(0.3)
        assert agent.status == AgentStatus.FAILED

    @pytest.mark.asyncio
    async def test_to_dict(self, runtime):
        agent = await runtime.spawn(CounterAgent, goal="serialize", config={"max_iterations": 1})
        await asyncio.sleep(0.3)
        d = agent.to_dict()
        assert d["id"] == agent.id
        assert d["type"] == "CounterAgent"
        assert d["goal"] == "serialize"
        assert d["status"] == "done"

    @pytest.mark.asyncio
    async def test_multiple_agents(self, runtime):
        """Multiple agents can run concurrently."""
        a1 = await runtime.spawn(CounterAgent, goal="a1", config={"max_iterations": 3})
        a2 = await runtime.spawn(CounterAgent, goal="a2", config={"max_iterations": 5})

        await asyncio.sleep(0.8)
        assert a1.status == AgentStatus.DONE
        assert a1.iteration == 3
        assert a2.status == AgentStatus.DONE
        assert a2.iteration == 5


# ── Steering Tests ────────────────────────────────────────────────

class TestAgentSteering:
    @pytest.mark.asyncio
    async def test_steer(self, runtime):
        agent = await runtime.spawn(SteerableAgent, goal="initial")
        await asyncio.sleep(0.1)

        await runtime.steer(agent.id, "new direction")
        await asyncio.sleep(0.2)

        assert "new direction" in agent.steers
        await runtime.stop(agent.id)

    @pytest.mark.asyncio
    async def test_consume_steer_clears(self, runtime):
        """consume_steer returns None after first consumption."""
        agent = await runtime.spawn(SteerableAgent, goal="test")
        await asyncio.sleep(0.1)

        await runtime.steer(agent.id, "first steer")
        await asyncio.sleep(0.3)

        # Should have consumed it
        assert len(agent.steers) >= 1
        await runtime.stop(agent.id)


# ── Forking Tests ─────────────────────────────────────────────────

class TestAgentForking:
    @pytest.mark.asyncio
    async def test_fork_and_wait(self, runtime):
        agent = await runtime.spawn(ForkingAgent, goal="parent")
        await asyncio.sleep(1.0)

        assert agent.status == AgentStatus.DONE
        assert agent.child_result is not None
        assert agent.child_result.status == AgentStatus.DONE
        assert len(agent._children) == 1


# ── MessageBus Tests ──────────────────────────────────────────────

class TestMessageBus:
    @pytest.mark.asyncio
    async def test_directed_message(self, bus):
        """Directed messages go to the target agent only."""
        inbox_a = bus.register("a")
        inbox_b = bus.register("b")

        msg = Message.steer("user", "a", "go left")
        await bus.publish(msg)

        assert inbox_a.qsize() == 1
        assert inbox_b.qsize() == 0

    @pytest.mark.asyncio
    async def test_broadcast_with_filter(self, bus):
        """Broadcast messages go to agents whose filters match."""
        inbox_a = bus.register("a")
        bus.subscribe("a", lambda m: m.type == MessageType.EVENT)

        inbox_b = bus.register("b")
        bus.subscribe("b", lambda m: m.type == MessageType.LOG)

        await bus.publish(Message.event("system", "alert triggered"))

        assert inbox_a.qsize() == 1
        assert inbox_b.qsize() == 0

    @pytest.mark.asyncio
    async def test_broadcast_skips_sender(self, bus):
        """Broadcast messages don't go back to the sender."""
        inbox_a = bus.register("a")
        bus.subscribe_all("a")

        await bus.publish(Message.log("a", "hello"))
        assert inbox_a.qsize() == 0

    @pytest.mark.asyncio
    async def test_history(self, bus):
        """Messages are recorded in history."""
        bus.register("a")
        await bus.publish(Message.log("system", "msg1"))
        await bus.publish(Message.event("system", "msg2"))

        history = bus.history()
        assert len(history) == 2
        assert history[0].payload["text"] == "msg1"

    @pytest.mark.asyncio
    async def test_history_filter_by_type(self, bus):
        bus.register("a")
        await bus.publish(Message.log("a", "log msg"))
        await bus.publish(Message.event("a", "event msg"))

        logs = bus.history(msg_type=MessageType.LOG)
        assert len(logs) == 1
        assert logs[0].payload["text"] == "log msg"

    @pytest.mark.asyncio
    async def test_global_listener(self, bus):
        """Global listeners see all messages."""
        captured = []
        bus.add_listener(lambda m: captured.append(m))

        bus.register("a")
        await bus.publish(Message.log("system", "hello"))

        assert len(captured) == 1
        assert captured[0].payload["text"] == "hello"

    @pytest.mark.asyncio
    async def test_unregister(self, bus):
        """Unregistered agents don't receive messages."""
        inbox = bus.register("a")
        bus.unregister("a")

        await bus.publish(Message(type=MessageType.LOG, source="b", target="a"))
        assert inbox.qsize() == 0  # Message routes to old inbox reference, but agent is unregistered

    @pytest.mark.asyncio
    async def test_stats(self, bus):
        bus.register("x")
        bus.register("y")
        stats = bus.stats()
        assert stats["agents_registered"] == 2
        assert stats["total_messages"] == 0


# ── AgentRuntime Tests ────────────────────────────────────────────

class TestAgentRuntime:
    @pytest.mark.asyncio
    async def test_list_agents(self, runtime):
        a1 = await runtime.spawn(CounterAgent, goal="a1", config={"max_iterations": 1})
        a2 = await runtime.spawn(CounterAgent, goal="a2", config={"max_iterations": 1})

        agents = runtime.list_agents()
        assert len(agents) == 2

    @pytest.mark.asyncio
    async def test_list_active(self, runtime):
        agent = await runtime.spawn(CounterAgent, goal="test", config={"max_iterations": 100})
        active = runtime.list_active()
        assert len(active) == 1

        await runtime.stop(agent.id)
        active = runtime.list_active()
        assert len(active) == 0

    @pytest.mark.asyncio
    async def test_remove(self, runtime):
        agent = await runtime.spawn(CounterAgent, goal="test", config={"max_iterations": 100})
        assert runtime.get_agent(agent.id) is not None

        await runtime.remove(agent.id)
        assert runtime.get_agent(agent.id) is None

    @pytest.mark.asyncio
    async def test_shutdown(self, runtime):
        await runtime.spawn(CounterAgent, goal="a1", config={"max_iterations": 100})
        await runtime.spawn(CounterAgent, goal="a2", config={"max_iterations": 100})

        await runtime.shutdown()
        assert len(runtime.list_agents()) == 0

    @pytest.mark.asyncio
    async def test_agent_tree(self, runtime):
        parent = await runtime.spawn(ForkingAgent, goal="parent")
        await asyncio.sleep(1.0)

        tree = runtime.agent_tree()
        # Parent has no parent (None key), child has parent
        assert None in tree
        assert parent.id in tree[None]

    @pytest.mark.asyncio
    async def test_status(self, runtime):
        await runtime.spawn(CounterAgent, goal="test", config={"max_iterations": 1})
        await asyncio.sleep(0.3)

        status = runtime.status()
        assert "agents" in status
        assert "bus" in status
        assert status["total_count"] >= 1


# ── Message Tests ─────────────────────────────────────────────────

class TestMessage:
    def test_steer_convenience(self):
        msg = Message.steer("user", "agent-1", "go left")
        assert msg.type == MessageType.STEER
        assert msg.source == "user"
        assert msg.target == "agent-1"
        assert msg.payload["context"] == "go left"

    def test_status_convenience(self):
        msg = Message.status("agent-1", "running", goal="test")
        assert msg.type == MessageType.STATUS
        assert msg.payload["status"] == "running"
        assert msg.payload["goal"] == "test"

    def test_result_convenience(self):
        msg = Message.result("agent-1", "done stuff", key="value")
        assert msg.type == MessageType.RESULT
        assert msg.payload["summary"] == "done stuff"
        assert msg.payload["key"] == "value"

    def test_error_convenience(self):
        msg = Message.error("agent-1", "oh no")
        assert msg.type == MessageType.ERROR
        assert msg.payload["error"] == "oh no"

    def test_delegate_convenience(self):
        msg = Message.delegate("parent", "child", "do task", priority="high")
        assert msg.type == MessageType.DELEGATE
        assert msg.target == "child"
        assert msg.payload["task"] == "do task"

    def test_to_dict_roundtrip(self):
        msg = Message.log("agent-1", "hello", level="debug")
        d = msg.to_dict()
        restored = Message.from_dict(d)
        assert restored.type == msg.type
        assert restored.source == msg.source
        assert restored.payload == msg.payload
        assert restored.id == msg.id

    def test_frozen(self):
        msg = Message.log("agent-1", "test")
        with pytest.raises(AttributeError):
            msg.source = "modified"  # type: ignore[misc]
