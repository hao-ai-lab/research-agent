"""Agent ABC and ChildHandle.

Agent is the single core abstraction.  Every entity in the system --
orchestrator, executor, sidecar -- inherits from Agent.

Communication uses two primitives:
  - msg  (low-priority): writes MESSAGE entries to the store.
  - steer (high-priority): injected into the agent's steer_buffer by
    the Runtime.

See agentsys.md section 1.2 for the full interface spec.
"""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from agentsys.memory import MemoryView
from agentsys.types import AgentStatus, Entry, EntryType, Scope, Steer, SteerUrgency

if TYPE_CHECKING:
    from agentsys.runtime import Runtime

logger = logging.getLogger(__name__)


# ======================================================================
# ChildHandle
# ======================================================================

class ChildHandle:
    """Handle returned to parent after spawning a child agent.

    Gives the parent non-intrusive control over the child:
    wait for completion, cancel early, or inspect status.

    In multiprocess mode, uses the filesystem (.meta.json) to poll
    status. In in-process mode (tests), can use a direct agent ref.
    """

    def __init__(
        self,
        agent_id: str,
        task: asyncio.Task | None = None,
        *,
        store: Any = None,
        runtime_proxy: Any = None,
    ) -> None:
        self.id = agent_id
        self._task = task
        self._agent: Agent | None = None  # set by Agent.spawn_child() in in-process mode
        self._store = store
        self._runtime_proxy = runtime_proxy

    @property
    def status(self) -> AgentStatus:
        """Current status of the child agent."""
        # Direct agent reference (in-process mode)
        if self._agent is not None:
            return self._agent.status
        # Runtime/RuntimeProxy — authoritative source for multiprocess mode.
        # For in-process parents (L1→L2), Runtime.get_agent() uses in-memory
        # metadata updated immediately by IPC events, avoiding the filesystem
        # race window where .meta.json still says "idle" during agent startup.
        # For subprocess parents (L2→L3), RuntimeProxy.get_agent() reads from
        # FileStore (same as the _store fallback below).
        if self._runtime_proxy is not None:
            try:
                info = self._runtime_proxy.get_agent(self.id)
                if info is not None:
                    return info.status
            except Exception:
                pass
        # Filesystem fallback (multiprocess mode, no runtime_proxy)
        if self._store is not None:
            info = self._store.read_agent_info(self.id)
            if info is not None:
                return info.status
            return AgentStatus.FAILED
        # Fallback: task-based
        if self._task is None:
            return AgentStatus.IDLE
        if self._task.done():
            return AgentStatus.DONE
        return AgentStatus.RUNNING

    async def wait(self, timeout: float | None = None) -> None:
        """Block until the child finishes.

        In in-process mode, uses asyncio.shield on the task.
        In multiprocess mode, polls .meta.json until DONE/FAILED.
        """
        # In-process: use task directly
        if self._task is not None and not self._task.done():
            shielded = asyncio.shield(self._task)
            try:
                if timeout is not None:
                    await asyncio.wait_for(shielded, timeout=timeout)
                else:
                    await shielded
            except asyncio.CancelledError:
                pass
            return

        # Multiprocess: poll filesystem
        if self._store is not None:
            deadline = None
            if timeout is not None:
                import time
                deadline = time.monotonic() + timeout
            while True:
                info = self._store.read_agent_info(self.id)
                if info is not None and info.status in (AgentStatus.DONE, AgentStatus.FAILED):
                    return
                if deadline is not None:
                    import time
                    if time.monotonic() >= deadline:
                        raise asyncio.TimeoutError(f"Timeout waiting for {self.id}")
                await asyncio.sleep(0.1)

    async def cancel(self) -> None:
        """Request the child agent to stop via the runtime."""
        # In-process mode
        if self._agent and self._agent._runtime:
            await self._agent._runtime.stop(self.id)
            return
        # Multiprocess mode
        if self._runtime_proxy:
            await self._runtime_proxy.stop(self.id)


# ======================================================================
# Agent ABC
# ======================================================================

class Agent(ABC):
    """Base class for all agents.

    Subclasses must:
      - Set a class-level ``role`` attribute ("orchestrator" / "executor" / "sidecar").
      - Implement ``async run()`` -- the main agent loop.

    Fields are set by ``Runtime.spawn()``, not by the constructor.
    This keeps agent instantiation decoupled from runtime wiring.

    Lifecycle: IDLE -> start() -> RUNNING -> run() completes -> DONE
                                         \\-> exception -> FAILED
               RUNNING -> pause() -> PAUSED -> resume() -> RUNNING
               any active state -> stop() -> DONE
    """

    # Subclasses MUST override this.
    role: str = "agent"

    # Which child roles this agent type can spawn.
    # None = unrestricted (for custom/test agents).
    # Empty frozenset = leaf node (cannot spawn anything).
    allowed_child_roles: frozenset[str] | None = None

    # Seconds between on_monitor() calls; 0 = disabled.
    monitor_interval: float = 0

    def __init__(self) -> None:
        # --- Identity (set by Runtime.spawn) ---
        self.id: str = ""
        self.parent_id: str | None = None
        self.children: list[str] = []

        # --- Scope (set by Runtime.spawn) ---
        # Stored as a Scope object (frozen dataclass) to avoid collision
        # with the abstract run() method. Access: agent.scope.run, etc.
        self.scope: Scope = Scope(project="", role=self.role)

        # --- State ---
        self.status: AgentStatus = AgentStatus.IDLE
        self.goal: str = ""
        self.iteration: int = 0
        self.config: dict = {}

        # --- Memory (set by Runtime.spawn) ---
        self.memory: MemoryView | None = None  # type: ignore[assignment]

        # --- Internal ---
        self._runtime: Runtime | None = None
        self._task: asyncio.Task | None = None
        self._steer_buffer: list[Steer] = []
        self._steer_event: asyncio.Event = asyncio.Event()
        self._pause_event: asyncio.Event = asyncio.Event()
        self._pause_event.set()  # starts unpaused

    # ------------------------------------------------------------------
    # Lifecycle (implemented here, not abstract)
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the agent's main loop as a background asyncio task."""
        if self.status == AgentStatus.RUNNING:
            logger.warning("[%s] Already running", self.id)
            return
        self.status = AgentStatus.RUNNING
        await self.on_start()
        self._task = asyncio.create_task(
            self._run_loop(), name=f"agent-{self.id}"
        )
        logger.info("[%s] Started (goal=%s)", self.id, self.goal[:80] if self.goal else "")

    async def stop(self) -> None:
        """Gracefully stop the agent and its asyncio task."""
        if self.status not in (AgentStatus.RUNNING, AgentStatus.PAUSED):
            return
        self.status = AgentStatus.DONE

        # Unblock pause if paused
        self._pause_event.set()

        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        logger.info("[%s] Stopped", self.id)

    async def pause(self) -> None:
        """Pause the agent. It will block at the next ``check_pause()`` call."""
        if self.status == AgentStatus.RUNNING:
            self.status = AgentStatus.PAUSED
            self._pause_event.clear()
            logger.info("[%s] Paused", self.id)

    async def resume(self) -> None:
        """Resume a paused agent."""
        if self.status == AgentStatus.PAUSED:
            self.status = AgentStatus.RUNNING
            self._pause_event.set()
            logger.info("[%s] Resumed", self.id)

    # ------------------------------------------------------------------
    # The run loop (internal wrapper around abstract run())
    # ------------------------------------------------------------------

    async def _run_loop(self) -> None:
        """Internal wrapper: calls abstract run(), handles errors and cleanup."""
        watchdog_task: asyncio.Task | None = None
        try:
            if self.monitor_interval > 0:
                watchdog_task = asyncio.create_task(
                    self._watchdog_loop(), name=f"watchdog-{self.id}"
                )
            await self.run()
            if self.status == AgentStatus.RUNNING:
                self.status = AgentStatus.DONE
        except asyncio.CancelledError:
            pass  # normal shutdown via stop()
        except Exception as e:
            self.status = AgentStatus.FAILED
            logger.exception("[%s] Failed: %s", self.id, e)
            if self.memory:
                self.memory.write(
                    {"error": str(e), "type": type(e).__name__},
                    type=EntryType.CONTEXT,
                    tags=["error"],
                )
        finally:
            if watchdog_task and not watchdog_task.done():
                watchdog_task.cancel()
                try:
                    await watchdog_task
                except asyncio.CancelledError:
                    pass
            await self.on_stop()

    async def _watchdog_loop(self) -> None:
        """Periodically calls on_monitor() while the agent is active."""
        try:
            while self.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                await asyncio.sleep(self.monitor_interval)
                if self.status not in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                    break
                await self.check_pause()
                try:
                    await self.on_monitor()
                except Exception as e:
                    logger.exception("[%s] on_monitor error: %s", self.id, e)
                    if self.memory:
                        self.memory.write(
                            {"error": str(e), "type": type(e).__name__},
                            type=EntryType.CONTEXT,
                            tags=["error", "watchdog"],
                        )
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Abstract method (subclasses implement)
    # ------------------------------------------------------------------

    @abstractmethod
    async def run(self) -> None:
        """The main agent loop. Subclasses implement this.

        Should call ``check_pause()`` between iterations and
        ``consume_steer()`` to handle user steering.
        """
        ...

    # ------------------------------------------------------------------
    # Communication: query (delegates to MemoryView / store)
    # ------------------------------------------------------------------

    def query(self, **filters) -> list[Entry]:
        """Query the memory store with arbitrary filters.

        Delegates directly to ``self.memory.store.query(**filters)``.
        """
        return self.memory.store.query(**filters)

    # ------------------------------------------------------------------
    # Steer: consume (agent calls) + inject (runtime calls)
    # ------------------------------------------------------------------

    def consume_steer(self) -> Steer | None:
        """Pop the oldest steer from the buffer (FIFO).

        Returns None if the buffer is empty. Call this between iterations
        in ``run()`` to check for pending steering directives.
        """
        if self._steer_buffer:
            steer = self._steer_buffer.pop(0)
            if not self._steer_buffer:
                self._steer_event.clear()
            return steer
        return None

    def consume_all_steers(self) -> list[Steer]:
        """Drain the entire steer buffer.

        Returns:
            All pending Steer objects (may be empty).
        """
        steers = list(self._steer_buffer)
        self._steer_buffer.clear()
        self._steer_event.clear()
        return steers

    def _inject_steer(self, steer: Steer) -> None:
        """Inject a steer into this agent's buffer. Called by Runtime.

        For PRIORITY steers, sets the steer_event so the agent can
        detect pending steers at its next yield point.
        """
        self._steer_buffer.append(steer)
        if steer.urgency == SteerUrgency.PRIORITY:
            self._steer_event.set()

    # ------------------------------------------------------------------
    # Spawn child
    # ------------------------------------------------------------------

    async def spawn_child(
        self,
        cls: type[Agent],
        goal: str,
        **config: Any,
    ) -> ChildHandle:
        """Spawn a child agent via the runtime.

        The child inherits scope from this agent and runs concurrently.
        No memory is shared — the child starts fresh.

        Args:
            cls:    Agent subclass to instantiate.
            goal:   The child's goal string.
            **config: Passed to child's config dict.

        Returns:
            ChildHandle for waiting on or cancelling the child.
        """
        if not self._runtime:
            raise RuntimeError("Agent has no runtime -- cannot spawn child")

        child = await self._runtime.spawn(
            cls, goal=goal, parent_id=self.id, config=config or None,
        )

        # child may be Agent (in-process) or AgentInfo (multiprocess)
        from agentsys.types import AgentInfo
        if isinstance(child, AgentInfo):
            # Multiprocess: use filesystem-based ChildHandle
            store = self.memory.store if self.memory else None
            handle = ChildHandle(
                agent_id=child.id,
                store=store,
                runtime_proxy=self._runtime,
            )
            self.children.append(child.id)
        else:
            # In-process: use task-based ChildHandle
            handle = ChildHandle(agent_id=child.id, task=child._task)
            handle._agent = child
        return handle

    # ------------------------------------------------------------------
    # Hooks (default no-op, subclasses override)
    # ------------------------------------------------------------------

    async def on_start(self) -> None:
        """Called before ``run()`` begins. Override for setup."""
        pass

    async def on_stop(self) -> None:
        """Called after ``run()`` ends (normally, via cancel, or on failure)."""
        pass

    async def on_steer(self, steer: Steer) -> None:
        """Called when a steer is consumed. Override for custom handling."""
        pass

    async def on_monitor(self) -> None:
        """Called periodically when monitor_interval > 0. Override to check children."""
        pass

    # ------------------------------------------------------------------
    # Event emission
    # ------------------------------------------------------------------

    def _emit_event(self, event_type: str, payload: dict) -> None:
        """Emit a custom event via the runtime proxy.

        Works in both in-process and multiprocess modes. In-process mode
        this is a no-op if the runtime doesn't support emit_event.
        """
        if self._runtime and hasattr(self._runtime, 'emit_event'):
            self._runtime.emit_event(event_type, payload)

    # ------------------------------------------------------------------
    # Pause support
    # ------------------------------------------------------------------

    async def check_pause(self) -> None:
        """Block until resumed if currently paused.

        Call this between iterations in ``run()`` to support pause/resume.
        """
        await self._pause_event.wait()

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        """Serialize agent state for debugging / API responses."""
        return {
            "id": self.id,
            "role": self.role,
            "goal": self.goal,
            "status": self.status.value,
            "iteration": self.iteration,
            "parent_id": self.parent_id,
            "children": list(self.children),
            **self.scope.to_dict(),
        }

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} id={self.id!r} status={self.status.value}>"
