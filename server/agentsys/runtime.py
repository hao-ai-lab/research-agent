"""Runtime -- process-based agent lifecycle supervisor.

Each agent runs in its own OS process with its own asyncio event loop.
The Runtime manages process lifecycle, IPC queues, and the shared
FileStore. Communication = msg (store-based) + steer (queue-based).
"""

from __future__ import annotations

import asyncio
import logging
import multiprocessing
import tempfile
import uuid
from collections import deque
from typing import Any

# Use "spawn" context to avoid fork-related deadlocks in multithreaded
# processes and future Python versions (3.14+ defaults to spawn).
_mp_ctx = multiprocessing.get_context("spawn")
Process = _mp_ctx.Process
Queue = _mp_ctx.Queue

from agentsys.agent import Agent
from agentsys.filestore import FileStore
from agentsys.ipc import (
    CmdType,
    Command,
    EventType,
    Event,
    cls_to_path,
    path_to_cls,
)
from agentsys.types import AgentInfo, AgentStatus, EntryType, Scope, Steer, SteerUrgency
from agentsys.worker import run_worker

logger = logging.getLogger(__name__)


class Runtime:
    """Process-based agent runtime supervisor.

    Usage::

        rt = Runtime(project="my-experiment")
        info = await rt.spawn(OrchestratorAgent, goal="run sweep")
        await rt.steer(info.id, "focus on reward shaping", SteerUrgency.PRIORITY)
        await rt.shutdown()
    """

    def __init__(self, project: str = "default", store_root: str | None = None) -> None:
        self.project = project
        self._store_root = store_root or tempfile.mkdtemp(prefix="agentsys_")
        self.store = FileStore(self._store_root, project)
        self._processes: dict[str, Process] = {}
        self._cmd_queues: dict[str, Queue] = {}
        self._event_queues: dict[str, Queue] = {}
        self._agent_meta: dict[str, dict] = {}
        self._local_agents: dict[str, Agent] = {}  # in-process agents
        self._event_listener_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Spawn
    # ------------------------------------------------------------------

    async def spawn(
        self,
        cls: type[Agent],
        goal: str,
        *,
        parent_id: str | None = None,
        config: dict | None = None,
        auto_start: bool = True,
        session: str | None = None,
        sweep: str | None = None,
        run: str | None = None,
    ) -> AgentInfo:
        """Create and start an agent in a child process.

        Returns AgentInfo (lightweight metadata), not the Agent instance.
        """
        # 0. Validate hierarchy
        if parent_id and parent_id in self._agent_meta:
            parent_meta = self._agent_meta[parent_id]
            parent_cls_path = parent_meta.get("agent_cls_path", "")
            try:
                parent_cls = path_to_cls(parent_cls_path)
            except Exception:
                parent_cls = None
            if parent_cls is not None:
                allowed = getattr(parent_cls, "allowed_child_roles", None)
                if allowed is not None and cls.role not in allowed:
                    parent_role = parent_meta.get("role", "agent")
                    raise ValueError(
                        f"{parent_role} (id={parent_id}) cannot spawn {cls.role} — "
                        f"allowed children: {sorted(allowed) or 'none'}"
                    )

        # 1. Generate id
        agent_id = f"{cls.role}-{uuid.uuid4().hex[:8]}"

        # 2. Build scope
        if parent_id and parent_id in self._agent_meta:
            ps = self._agent_meta[parent_id].get("scope", {})
            scope_dict = {
                "project": ps.get("project", self.project),
                "session": session if session is not None else ps.get("session"),
                "sweep": sweep if sweep is not None else ps.get("sweep"),
                "run": run if run is not None else ps.get("run"),
                "role": cls.role,
            }
        else:
            scope_dict = {
                "project": self.project,
                "session": session,
                "sweep": sweep,
                "run": run,
                "role": cls.role,
            }

        # 3. Create queues
        cmd_queue: Queue = Queue()
        event_queue: Queue = Queue()

        # 4. Build metadata
        agent_cls_path = cls_to_path(cls)
        meta = {
            "id": agent_id,
            "role": cls.role,
            "status": AgentStatus.IDLE.value,
            "goal": goal,
            "config": config or {},
            "parent_id": parent_id,
            "children": [],
            "agent_cls_path": agent_cls_path,
            "iteration": 0,
            "scope": scope_dict,
        }

        # 5. Write initial .meta.json
        self.store.write_meta(agent_id, meta)
        self._agent_meta[agent_id] = meta
        self._cmd_queues[agent_id] = cmd_queue
        self._event_queues[agent_id] = event_queue

        # 6. Update parent's children list
        if parent_id and parent_id in self._agent_meta:
            self._agent_meta[parent_id].setdefault("children", []).append(agent_id)
            self.store.write_meta(parent_id, self._agent_meta[parent_id])

        # 7. Create process
        process = Process(
            target=run_worker,
            args=(
                agent_cls_path, agent_id, goal, config or {},
                scope_dict, self._store_root, self.project,
                parent_id, cmd_queue, event_queue,
            ),
            daemon=True,
            name=f"agent-{agent_id}",
        )
        self._processes[agent_id] = process

        # 8. Start if requested
        if auto_start:
            process.start()
            # Update in-memory only; worker owns .meta.json once alive
            meta["status"] = AgentStatus.RUNNING.value
            self._agent_meta[agent_id] = meta

            # Start event listener if not running
            if self._event_listener_task is None or self._event_listener_task.done():
                self._event_listener_task = asyncio.create_task(
                    self._event_listener_loop(), name="event-listener"
                )

            # Wait briefly for process to start
            await asyncio.sleep(0.05)

        # 9. Return AgentInfo
        info = AgentInfo(
            id=agent_id,
            role=cls.role,
            status=AgentStatus(meta["status"]),
            goal=goal,
            config=config or {},
            parent_id=parent_id,
            children=[],
            agent_cls_path=agent_cls_path,
            iteration=0,
            scope=scope_dict,
        )

        logger.info(
            "[runtime] Spawned %s (id=%s, goal=%s)",
            cls.__name__, agent_id, goal[:60] if goal else "",
        )
        return info

    # ------------------------------------------------------------------
    # Register in-process agent
    # ------------------------------------------------------------------

    def register_local(
        self,
        agent: Agent,
        goal: str,
        *,
        config: dict | None = None,
        session: str | None = None,
        sweep: str | None = None,
        run: str | None = None,
    ) -> str:
        """Register an already-instantiated agent to run in-process.

        Same wiring as ``spawn()`` (identity, scope, memory, metadata) but
        no subprocess is created.  The agent shares the caller's event loop
        and gets a direct reference to this Runtime instead of a RuntimeProxy.

        The caller must ``await agent.start()`` separately once an async
        context is available (e.g. in a FastAPI startup handler).

        Returns:
            The generated agent_id.
        """
        from agentsys.memory import MemoryView

        agent_id = f"{agent.role}-{uuid.uuid4().hex[:8]}"

        scope_dict = {
            "project": self.project,
            "session": session,
            "sweep": sweep,
            "run": run,
            "role": agent.role,
        }

        # Wire agent
        agent.id = agent_id
        agent.goal = goal
        agent.config = config or {}
        agent.scope = Scope(**scope_dict)
        agent.memory = MemoryView(agent_id, scope_dict, self.store)
        agent._runtime = self  # direct reference, not RuntimeProxy

        # Build metadata
        agent_cls_path = cls_to_path(type(agent))
        meta = {
            "id": agent_id,
            "role": agent.role,
            "status": AgentStatus.IDLE.value,
            "goal": goal,
            "config": config or {},
            "parent_id": None,
            "children": [],
            "agent_cls_path": agent_cls_path,
            "iteration": 0,
            "scope": scope_dict,
        }

        self.store.write_meta(agent_id, meta)
        self._agent_meta[agent_id] = meta
        self._local_agents[agent_id] = agent

        logger.info(
            "[runtime] Registered local %s (id=%s)",
            type(agent).__name__, agent_id,
        )
        return agent_id

    # ------------------------------------------------------------------
    # Event listener
    # ------------------------------------------------------------------

    async def _event_listener_loop(self) -> None:
        """Poll all event queues for events from worker processes."""
        loop = asyncio.get_event_loop()
        try:
            while True:
                any_alive = False
                for agent_id in list(self._event_queues.keys()):
                    eq = self._event_queues.get(agent_id)
                    if eq is None:
                        continue

                    try:
                        while True:
                            try:
                                event: Event = eq.get_nowait()
                            except Exception:
                                break

                            await self._handle_event(event)
                    except Exception as e:
                        logger.debug("Event poll error for %s: %s", agent_id, e)

                    # Check if process is alive
                    proc = self._processes.get(agent_id)
                    if proc and proc.is_alive():
                        any_alive = True
                    elif proc and not proc.is_alive():
                        # Process died — update meta if not already DONE/FAILED
                        meta = self._agent_meta.get(agent_id)
                        if meta is not None and meta.get("status") not in (
                            AgentStatus.DONE.value, AgentStatus.FAILED.value
                        ):
                            meta["status"] = AgentStatus.FAILED.value
                            self._agent_meta[agent_id] = meta
                            self.store.write_meta(agent_id, meta)

                await asyncio.sleep(0.05)

                # If no alive processes, sleep longer but keep listening
                if not any_alive and not any(
                    p.is_alive() for p in self._processes.values() if p is not None
                ):
                    await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            pass

    async def _handle_event(self, event: Event) -> None:
        """Handle a single event from a worker process."""
        if event.type == EventType.STARTED:
            meta = self._agent_meta.get(event.agent_id)
            if meta is not None:
                meta["status"] = AgentStatus.RUNNING.value
                # In-memory only; worker owns .meta.json while alive

        elif event.type == EventType.DONE:
            meta = self._agent_meta.get(event.agent_id)
            if meta is not None:
                meta["status"] = AgentStatus.DONE.value
                # Worker writes final .meta.json before exiting

        elif event.type == EventType.FAILED:
            meta = self._agent_meta.get(event.agent_id)
            if meta is not None:
                meta["status"] = AgentStatus.FAILED.value
                # Worker writes final .meta.json before exiting

        elif event.type == EventType.STOP_REQUEST:
            target_id = event.payload.get("target_id")
            if target_id:
                await self.stop(target_id)

        elif event.type == EventType.SPAWN_REQUEST:
            payload = event.payload

            # Handle spawn request
            try:
                child_cls = path_to_cls(payload["cls_path"])
                child_info = await self.spawn(
                    child_cls,
                    goal=payload["goal"],
                    parent_id=payload.get("parent_id"),
                    config=payload.get("config"),
                    auto_start=payload.get("auto_start", True),
                    session=payload.get("session"),
                    sweep=payload.get("sweep"),
                    run=payload.get("run"),
                )

                # Send response back to requesting agent
                requesting_agent_id = event.agent_id
                cmd_q = self._cmd_queues.get(requesting_agent_id)
                if cmd_q:
                    cmd_q.put(Command(
                        type=CmdType.SPAWN_RESPONSE,
                        payload={
                            "request_id": payload.get("request_id"),
                            "child_id": child_info.id,
                            "role": child_info.role,
                            "cls_path": payload["cls_path"],
                        },
                    ))
            except Exception as e:
                logger.exception("Spawn request failed: %s", e)
                requesting_agent_id = event.agent_id
                cmd_q = self._cmd_queues.get(requesting_agent_id)
                if cmd_q:
                    cmd_q.put(Command(
                        type=CmdType.SPAWN_RESPONSE,
                        payload={
                            "request_id": payload.get("request_id"),
                            "error": str(e),
                        },
                    ))

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def stop(self, agent_id: str) -> bool:
        """Stop an agent and all its descendants."""
        meta = self._agent_meta.get(agent_id)
        if not meta:
            return False

        # Cascade: collect all descendants, stop leaves first
        descendants = self._collect_descendants(agent_id)
        descendants.reverse()

        for aid in descendants:
            await self._stop_single(aid)

        return True

    async def _stop_single(self, agent_id: str) -> None:
        """Stop a single agent (in-process or subprocess)."""
        local = self._local_agents.get(agent_id)
        if local:
            await local.stop()
            meta = self._agent_meta.get(agent_id)
            if meta is not None:
                meta["status"] = AgentStatus.DONE.value
                self._agent_meta[agent_id] = meta
                self.store.write_meta(agent_id, meta)
            return

        cmd_q = self._cmd_queues.get(agent_id)
        if cmd_q:
            try:
                cmd_q.put(Command(type=CmdType.STOP))
            except Exception:
                pass

        proc = self._processes.get(agent_id)
        if proc and proc.is_alive():
            proc.join(timeout=5)
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=2)

        meta = self._agent_meta.get(agent_id)
        if meta is not None:
            if meta.get("status") not in (AgentStatus.DONE.value, AgentStatus.FAILED.value):
                meta["status"] = AgentStatus.DONE.value
            self._agent_meta[agent_id] = meta
            self.store.write_meta(agent_id, meta)

    async def pause(self, agent_id: str) -> bool:
        """Pause an agent and all its descendants."""
        meta = self._agent_meta.get(agent_id)
        if not meta:
            return False

        descendants = self._collect_descendants(agent_id)
        for aid in descendants:
            local = self._local_agents.get(aid)
            if local:
                await local.pause()
            else:
                cmd_q = self._cmd_queues.get(aid)
                if cmd_q:
                    try:
                        cmd_q.put(Command(type=CmdType.PAUSE))
                    except Exception:
                        pass
            m = self._agent_meta.get(aid)
            if m is not None:
                m["status"] = AgentStatus.PAUSED.value
                self._agent_meta[aid] = m
                self.store.write_meta(aid, m)

        return True

    async def resume(self, agent_id: str) -> bool:
        """Resume an agent and all its descendants."""
        meta = self._agent_meta.get(agent_id)
        if not meta:
            return False

        descendants = self._collect_descendants(agent_id)
        for aid in descendants:
            local = self._local_agents.get(aid)
            if local:
                await local.resume()
            else:
                cmd_q = self._cmd_queues.get(aid)
                if cmd_q:
                    try:
                        cmd_q.put(Command(type=CmdType.RESUME))
                    except Exception:
                        pass
            m = self._agent_meta.get(aid)
            if m is not None:
                m["status"] = AgentStatus.RUNNING.value
                self._agent_meta[aid] = m
                self.store.write_meta(aid, m)

        return True

    async def remove(self, agent_id: str) -> bool:
        """Stop an agent, remove from metadata cache. Memory persists."""
        meta = self._agent_meta.get(agent_id)
        if not meta:
            return False

        status = meta.get("status", "")
        if status in (AgentStatus.RUNNING.value, AgentStatus.PAUSED.value):
            await self.stop(agent_id)

        del self._agent_meta[agent_id]
        logger.info("[runtime] Removed agent %s (memory persists)", agent_id)
        return True

    async def shutdown(self) -> None:
        """Stop all agents and clean up."""
        # Find root agents
        root_ids = [
            aid for aid, meta in self._agent_meta.items()
            if meta.get("parent_id") is None
            or meta.get("parent_id") not in self._agent_meta
        ]
        for aid in root_ids:
            await self.stop(aid)

        # Cancel event listener
        if self._event_listener_task and not self._event_listener_task.done():
            self._event_listener_task.cancel()
            try:
                await self._event_listener_task
            except asyncio.CancelledError:
                pass

        # Terminate any remaining processes
        for proc in self._processes.values():
            if proc and proc.is_alive():
                proc.terminate()
                proc.join(timeout=2)

        self._agent_meta.clear()
        self._processes.clear()
        self._cmd_queues.clear()
        self._event_queues.clear()
        self._local_agents.clear()
        logger.info("[runtime] Shutdown complete")

    # ------------------------------------------------------------------
    # Cascade helper
    # ------------------------------------------------------------------

    def _collect_descendants(self, agent_id: str) -> list[str]:
        """BFS collect agent_id + all descendants."""
        descendants: list[str] = []
        queue: deque[str] = deque([agent_id])
        while queue:
            current = queue.popleft()
            descendants.append(current)
            meta = self._agent_meta.get(current, {})
            for child_id in meta.get("children", []):
                if child_id in self._agent_meta:
                    queue.append(child_id)
        return descendants

    # ------------------------------------------------------------------
    # Steer routing
    # ------------------------------------------------------------------

    async def steer(
        self,
        agent_id: str,
        context: str,
        urgency: SteerUrgency = SteerUrgency.PRIORITY,
    ) -> bool:
        """Route a steer directive to an agent."""
        meta = self._agent_meta.get(agent_id)
        if not meta:
            return False

        # Check in-memory status, process liveness, and filesystem status
        status = meta.get("status", "")
        if status in (AgentStatus.DONE.value, AgentStatus.FAILED.value):
            return False
        proc = self._processes.get(agent_id)
        if proc and not proc.is_alive():
            return False
        disk_info = self.store.read_agent_info(agent_id)
        if disk_info and disk_info.status in (AgentStatus.DONE, AgentStatus.FAILED):
            return False

        if urgency == SteerUrgency.PRIORITY:
            local = self._local_agents.get(agent_id)
            if local:
                local._inject_steer(Steer(context=context, urgency=urgency))
            else:
                cmd_q = self._cmd_queues.get(agent_id)
                if cmd_q:
                    cmd_q.put(Command(
                        type=CmdType.STEER,
                        payload={"context": context, "urgency": urgency.value},
                    ))
            logger.info("[runtime] PRIORITY steer -> %s: %s", agent_id, context[:60])
            return True

        elif urgency == SteerUrgency.CRITICAL:
            # Save agent info for respawn
            original_goal = meta.get("goal", "")
            original_config = dict(meta.get("config", {}))
            parent_id = meta.get("parent_id")
            scope = meta.get("scope", {})
            agent_cls_path = meta.get("agent_cls_path", "")

            # Collect descendants before stopping
            descendant_ids = self._collect_descendants(agent_id)

            # Stop agent + all descendants
            descendants_reversed = list(descendant_ids)
            descendants_reversed.reverse()
            for aid in descendants_reversed:
                await self._stop_single(aid)

            # Remove from metadata
            for did in descendant_ids:
                if did in self._agent_meta:
                    del self._agent_meta[did]

            # Remove from parent's children list
            if parent_id and parent_id in self._agent_meta:
                parent_children = self._agent_meta[parent_id].get("children", [])
                if agent_id in parent_children:
                    parent_children.remove(agent_id)
                self.store.write_meta(parent_id, self._agent_meta[parent_id])

            # Respawn with steer context
            try:
                cls = path_to_cls(agent_cls_path)
            except Exception:
                return False

            new_goal = f"{original_goal} [STEER: {context}]"
            new_info = await self.spawn(
                cls,
                goal=new_goal,
                parent_id=parent_id,
                config=original_config,
                session=scope.get("session"),
                sweep=scope.get("sweep"),
                run=scope.get("run"),
            )

            logger.info(
                "[runtime] CRITICAL steer -> respawned %s as %s: %s",
                agent_id, new_info.id, context[:60],
            )
            return True

        return False

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def get_agent(self, agent_id: str) -> AgentInfo | None:
        """Get agent metadata by id.

        For local (in-process) agents, reads live status and iteration
        from the agent object so metadata stays current without needing
        explicit sync.
        """
        meta = self._agent_meta.get(agent_id)
        if not meta:
            return None

        # Use live status for local agents
        status = AgentStatus(meta["status"])
        iteration = meta.get("iteration", 0)
        local = self._local_agents.get(agent_id)
        if local:
            status = local.status
            iteration = local.iteration

        try:
            return AgentInfo(
                id=meta["id"],
                role=meta["role"],
                status=status,
                goal=meta["goal"],
                config=meta.get("config", {}),
                parent_id=meta.get("parent_id"),
                children=meta.get("children", []),
                agent_cls_path=meta.get("agent_cls_path", ""),
                iteration=iteration,
                scope=meta.get("scope"),
            )
        except (KeyError, ValueError):
            return None

    def list_agents(self) -> list[AgentInfo]:
        """List all registered agents."""
        result = []
        for meta in self._agent_meta.values():
            info = self.get_agent(meta["id"])
            if info:
                result.append(info)
        return result

    def list_active(self) -> list[AgentInfo]:
        """List agents that are RUNNING or PAUSED."""
        return [
            a for a in self.list_agents()
            if a.status in (AgentStatus.RUNNING, AgentStatus.PAUSED)
        ]

    def agent_tree(self) -> dict[str | None, list[str]]:
        """Build parent_id -> [child_ids] mapping."""
        tree: dict[str | None, list[str]] = {}
        for meta in self._agent_meta.values():
            tree.setdefault(meta.get("parent_id"), []).append(meta["id"])
        return tree

    def emit_event(self, event_type: str, payload: dict) -> None:
        """Accept custom events from in-process agents.

        In multiprocess mode, agents use RuntimeProxy.emit_event() which
        goes through the IPC event queue.  In in-process / test mode,
        agents may call _emit_event() which delegates here via the Runtime
        reference.  We route these through _handle_event() so the
        EventRelay bridge picks them up.
        """
        evt_type = EventType.ITERATION if event_type == "iteration" else EventType.LOG_ENTRY
        event = Event(
            type=evt_type,
            agent_id="in-process",
            payload={"event_type": event_type, **payload},
        )
        # Schedule _handle_event on the event loop if running, else fire-and-forget
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._handle_event(event))
        except RuntimeError:
            pass  # no event loop — silently drop (e.g., in sync test context)

    def status(self) -> dict:
        """Full system snapshot."""
        agents = self.list_agents()
        return {
            "agents": [
                {
                    "id": a.id, "role": a.role, "goal": a.goal,
                    "status": a.status.value, "iteration": a.iteration,
                    "parent_id": a.parent_id, "children": a.children,
                    **(a.scope or {}),
                }
                for a in agents
            ],
            "store_entries": len(self.store),
            "active_count": len(self.list_active()),
            "total_count": len(agents),
        }

    def __repr__(self) -> str:
        return (
            f"Runtime(project={self.project!r}, "
            f"agents={len(self._agent_meta)}, "
            f"store={len(self.store)} entries)"
        )
