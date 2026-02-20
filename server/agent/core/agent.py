"""Agent — the single core abstraction.

An Agent is anything that:
  1. Has a lifecycle  (start → run → stop)
  2. Sends and receives Messages through a Bus
  3. Can be steered, paused, interrupted, and forked
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from abc import ABC, abstractmethod
from enum import Enum
from typing import TYPE_CHECKING, Any

from agent.core.message import Message, MessageType

if TYPE_CHECKING:
    from agent.core.bus import MessageBus
    from agent.core.runtime import AgentRuntime

logger = logging.getLogger(__name__)


class AgentStatus(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"
    FAILED = "failed"


class Agent(ABC):
    """Base class for all agents.

    Subclasses must implement ``run()`` — the main async loop.

    The runtime injects ``_bus`` and ``_runtime`` before calling ``start()``.
    """

    def __init__(
        self,
        *,
        agent_id: str | None = None,
        goal: str = "",
        parent_id: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.id = agent_id or f"{self.__class__.__name__.lower()}-{uuid.uuid4().hex[:8]}"
        self.goal = goal
        self.parent_id = parent_id
        self.config = config or {}
        self.status = AgentStatus.IDLE
        self.iteration = 0

        # Injected by the runtime before start()
        self._bus: MessageBus | None = None
        self._runtime: AgentRuntime | None = None

        # Internal
        self._task: asyncio.Task[None] | None = None
        self._inbox: asyncio.Queue[Message] = asyncio.Queue()
        self._steer_context: str = ""
        self._steer_event: asyncio.Event = asyncio.Event()
        self._children: list[str] = []  # child agent IDs
        self._cancel_event: asyncio.Event = asyncio.Event()

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the agent's main loop as a background task."""
        if self.status == AgentStatus.RUNNING:
            logger.warning("[%s] Already running", self.id)
            return

        self.status = AgentStatus.RUNNING
        await self._emit(Message.status(self.id, "running", goal=self.goal))
        self._task = asyncio.create_task(self._run_wrapper(), name=f"agent-{self.id}")
        logger.info("[%s] Started (goal=%s)", self.id, self.goal[:80] if self.goal else "")

    async def stop(self) -> None:
        """Gracefully stop the agent."""
        if self.status not in (AgentStatus.RUNNING, AgentStatus.PAUSED):
            return

        self._cancel_event.set()
        self.status = AgentStatus.DONE

        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        # Stop children
        if self._runtime:
            for child_id in list(self._children):
                await self._runtime.stop(child_id)

        await self._emit(Message.status(self.id, "done"))
        logger.info("[%s] Stopped", self.id)

    async def pause(self) -> None:
        """Pause the agent (it checks for pause in between iterations)."""
        if self.status == AgentStatus.RUNNING:
            self.status = AgentStatus.PAUSED
            await self._emit(Message.status(self.id, "paused"))

    async def resume(self) -> None:
        """Resume a paused agent."""
        if self.status == AgentStatus.PAUSED:
            self.status = AgentStatus.RUNNING
            await self._emit(Message.status(self.id, "running"))

    # ── Communication ─────────────────────────────────────────────────

    async def send(self, msg: Message) -> None:
        """Publish a message to the bus."""
        await self._emit(msg)

    async def receive(self, timeout: float | None = None) -> Message | None:
        """Wait for the next inbound message. Returns None on timeout."""
        try:
            if timeout is not None:
                return await asyncio.wait_for(self._inbox.get(), timeout=timeout)
            return await self._inbox.get()
        except asyncio.TimeoutError:
            return None

    def receive_nowait(self) -> Message | None:
        """Non-blocking receive — returns None if inbox is empty."""
        try:
            return self._inbox.get_nowait()
        except asyncio.QueueEmpty:
            return None

    async def deliver(self, msg: Message) -> None:
        """Called by the bus to deliver a message to this agent's inbox."""
        await self._inbox.put(msg)

    async def handle_message(self, msg: Message) -> None:
        """Process an incoming message. Override for custom dispatch."""
        if msg.type == MessageType.STEER:
            self._steer_context = msg.payload.get("context", "")
            self._steer_event.set()
            logger.info("[%s] Steered: %s", self.id, self._steer_context[:80])
        elif msg.type == MessageType.INTERRUPT:
            logger.info("[%s] Interrupted", self.id)
            await self.stop()

    # ── Steering ──────────────────────────────────────────────────────

    async def steer(self, context: str) -> None:
        """Inject steering context (called externally)."""
        self._steer_context = context
        self._steer_event.set()
        await self._emit(Message.steer("user", self.id, context))

    def consume_steer(self) -> str | None:
        """Check and consume any pending steer context.

        Call this at the top of each iteration in ``run()``.
        Returns the context string, or None if no steering was requested.
        """
        if self._steer_event.is_set():
            self._steer_event.clear()
            ctx = self._steer_context
            self._steer_context = ""
            return ctx
        return None

    # ── Forking ───────────────────────────────────────────────────────

    async def fork(
        self,
        agent_cls: type[Agent],
        goal: str,
        **config: Any,
    ) -> ForkHandle:
        """Fork a child agent.

        The child runs concurrently. Use the returned ``ForkHandle``
        to await its completion or cancel it.
        """
        if not self._runtime:
            raise RuntimeError("Agent has no runtime — cannot fork")

        child = await self._runtime.spawn(
            agent_cls,
            goal=goal,
            parent_id=self.id,
            config=config,
        )
        self._children.append(child.id)
        await self._emit(Message.log(self.id, f"Forked child {child.id}: {goal[:60]}"))
        return ForkHandle(child, self._runtime)

    # ── The main loop (subclass implements this) ──────────────────────

    @abstractmethod
    async def run(self) -> None:
        """The agent's main loop.

        Must be implemented by subclasses. Should:
        - Check ``self.status`` to handle pause/stop
        - Call ``self.consume_steer()`` to handle user steering
        - Use ``self.send()`` to publish results/logs
        - Use ``self.iteration`` to track progress
        """
        ...

    # ── Hooks ─────────────────────────────────────────────────────────

    async def on_start(self) -> None:
        """Called before ``run()`` begins. Override for setup."""
        pass

    async def on_stop(self) -> None:
        """Called after ``run()`` ends (normally or via cancellation)."""
        pass

    # ── Internal ──────────────────────────────────────────────────────

    async def _run_wrapper(self) -> None:
        """Wraps ``run()`` with lifecycle management."""
        try:
            await self.on_start()
            await self.run()
            if self.status == AgentStatus.RUNNING:
                self.status = AgentStatus.DONE
                await self._emit(Message.status(self.id, "done"))
        except asyncio.CancelledError:
            logger.info("[%s] Cancelled", self.id)
        except Exception as exc:
            self.status = AgentStatus.FAILED
            await self._emit(Message.error(self.id, str(exc)))
            logger.exception("[%s] Failed: %s", self.id, exc)
        finally:
            await self.on_stop()

    async def _emit(self, msg: Message) -> None:
        """Publish a message if bus is available."""
        if self._bus:
            await self._bus.publish(msg)

    async def _wait_if_paused(self) -> None:
        """Block until resumed. Call this at the top of each iteration."""
        while self.status == AgentStatus.PAUSED:
            await asyncio.sleep(0.2)

    def is_cancelled(self) -> bool:
        """Check if stop was requested."""
        return self._cancel_event.is_set()

    def to_dict(self) -> dict[str, Any]:
        """Serialize agent state for API responses."""
        return {
            "id": self.id,
            "type": self.__class__.__name__,
            "goal": self.goal,
            "status": self.status.value,
            "iteration": self.iteration,
            "parent_id": self.parent_id,
            "children": list(self._children),
            "config": self.config,
        }


class ForkHandle:
    """Handle to a forked child agent.

    Usage::

        handle = await self.fork(MyAgent, "sub-goal")
        # ... do other work ...
        result = await handle.wait()   # blocks until child is done
        handle.cancel()                 # or cancel early
    """

    def __init__(self, agent: Agent, runtime: AgentRuntime) -> None:
        self.agent = agent
        self._runtime = runtime

    @property
    def id(self) -> str:
        return self.agent.id

    @property
    def status(self) -> AgentStatus:
        return self.agent.status

    async def wait(self, timeout: float | None = None) -> Agent:
        """Wait for the child agent to finish."""
        if self.agent._task:
            try:
                await asyncio.wait_for(
                    asyncio.shield(self.agent._task),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                pass
        return self.agent

    async def cancel(self) -> None:
        """Cancel the child agent."""
        await self._runtime.stop(self.agent.id)
