"""RuntimeProxy -- agent-side runtime interface in worker processes.

Injected as agent._runtime in child processes. Communicates with the
supervisor via IPC queues (cmd_queue for commands, event_queue for events).
"""

from __future__ import annotations

import asyncio
import logging
import queue
from typing import TYPE_CHECKING, Any

from agentsys.filestore import FileStore
from agentsys.ipc import CmdType, Command, EventType, Event, cls_to_path
from agentsys.types import AgentInfo, AgentStatus, Steer, SteerUrgency

if TYPE_CHECKING:
    from multiprocessing import Queue
    from agentsys.agent import Agent

logger = logging.getLogger(__name__)


class RuntimeProxy:
    """Agent-side runtime proxy — communicates with supervisor via IPC.

    Provides the same interface that Agent code expects from Runtime:
    spawn(), get_agent(), stop().
    """

    def __init__(
        self,
        agent_id: str,
        store: FileStore,
        cmd_queue: Queue,
        event_queue: Queue,
        project: str,
    ) -> None:
        self.agent_id = agent_id
        self.store = store
        self.cmd_queue = cmd_queue
        self.event_queue = event_queue
        self.project = project
        self._pending_spawns: dict[str, asyncio.Future] = {}
        self._agent: Agent | None = None
        self._cmd_listener_task: asyncio.Task | None = None

    def start_cmd_listener(self, agent: Agent) -> None:
        """Store agent reference and start listening for commands."""
        self._agent = agent
        self._cmd_listener_task = asyncio.create_task(
            self._listen_commands(), name=f"cmd-listener-{self.agent_id}"
        )

    async def _listen_commands(self) -> None:
        """Poll cmd_queue for commands from the supervisor."""
        loop = asyncio.get_event_loop()
        while True:
            try:
                cmd: Command = await loop.run_in_executor(
                    None, lambda: self.cmd_queue.get(timeout=0.5)
                )
            except queue.Empty:
                continue
            except (EOFError, OSError):
                break

            if cmd.type == CmdType.STOP:
                if self._agent:
                    await self._agent.stop()
                break
            elif cmd.type == CmdType.PAUSE:
                if self._agent:
                    await self._agent.pause()
            elif cmd.type == CmdType.RESUME:
                if self._agent:
                    await self._agent.resume()
            elif cmd.type == CmdType.STEER:
                if self._agent:
                    steer = Steer(
                        context=cmd.payload["context"],
                        urgency=SteerUrgency(cmd.payload["urgency"]),
                    )
                    self._agent._inject_steer(steer)
            elif cmd.type == CmdType.SPAWN_RESPONSE:
                req_id = cmd.payload.get("request_id")
                future = self._pending_spawns.pop(req_id, None)
                if future and not future.done():
                    future.set_result(cmd.payload)

    async def spawn(
        self,
        cls: type,
        goal: str,
        *,
        parent_id: str | None = None,
        config: dict | None = None,
        auto_start: bool = True,
        session: str | None = None,
        sweep: str | None = None,
        run: str | None = None,
    ) -> AgentInfo:
        """Request supervisor to spawn a child. Returns AgentInfo."""
        import uuid
        request_id = uuid.uuid4().hex[:8]

        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        self._pending_spawns[request_id] = future

        self.event_queue.put(Event(
            type=EventType.SPAWN_REQUEST,
            agent_id=self.agent_id,
            payload={
                "request_id": request_id,
                "cls_path": cls_to_path(cls),
                "goal": goal,
                "parent_id": parent_id,
                "config": config,
                "auto_start": auto_start,
                "session": session,
                "sweep": sweep,
                "run": run,
            },
        ))

        result = await asyncio.wait_for(future, timeout=30)
        child_id = result["child_id"]

        info = self.store.read_agent_info(child_id)
        if info is None:
            info = AgentInfo(
                id=child_id,
                role=result.get("role", "agent"),
                status=AgentStatus.IDLE,
                goal=goal,
                config=config or {},
                parent_id=parent_id,
                agent_cls_path=result.get("cls_path", ""),
            )
        return info

    def get_agent(self, agent_id: str) -> AgentInfo | None:
        """Read agent info from filesystem. No IPC needed."""
        return self.store.read_agent_info(agent_id)

    async def stop(self, agent_id: str) -> bool:
        """Request supervisor to stop another agent."""
        self.event_queue.put(Event(
            type=EventType.STOP_REQUEST,
            agent_id=self.agent_id,
            payload={"target_id": agent_id},
        ))
        return True

    def emit_event(self, event_type: str, payload: dict) -> None:
        """Send a custom event to the supervisor via event_queue."""
        evt_type = EventType.ITERATION if event_type == "iteration" else EventType.LOG_ENTRY
        self.event_queue.put(Event(
            type=evt_type,
            agent_id=self.agent_id,
            payload={"event_type": event_type, **payload},
        ))

    def cancel_cmd_listener(self) -> None:
        """Cancel the command listener task."""
        if self._cmd_listener_task and not self._cmd_listener_task.done():
            self._cmd_listener_task.cancel()
