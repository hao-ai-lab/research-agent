"""Worker process entry point for agent child processes.

Each agent runs in its own OS process with its own asyncio event loop.
The worker creates a FileStore, MemoryView, and RuntimeProxy, wires
them to the agent, and runs the agent's lifecycle.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from agentsys.filestore import FileStore
from agentsys.ipc import EventType, Event, path_to_cls, cls_to_path
from agentsys.memory import MemoryView
from agentsys.proxy import RuntimeProxy
from agentsys.types import AgentStatus, EntryType, Scope

logger = logging.getLogger(__name__)


def run_worker(
    agent_cls_path: str,
    agent_id: str,
    goal: str,
    config: dict | None,
    scope_dict: dict,
    store_root: str,
    project: str,
    parent_id: str | None,
    cmd_queue: Any,
    event_queue: Any,
) -> None:
    """Entry point for child process. Calls asyncio.run(_async_worker(...))."""
    # Configure logging for the subprocess so agent logs are visible
    logging.basicConfig(
        level=logging.INFO,
        format=f"%(asctime)s [{agent_id[:20]}] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        asyncio.run(_async_worker(
            agent_cls_path, agent_id, goal, config, scope_dict,
            store_root, project, parent_id, cmd_queue, event_queue,
        ))
    except Exception as e:
        logger.exception("Worker %s failed: %s", agent_id, e)
        try:
            event_queue.put(Event(
                type=EventType.FAILED,
                agent_id=agent_id,
                payload={"error": str(e)},
            ))
        except Exception:
            pass


async def _async_worker(
    agent_cls_path: str,
    agent_id: str,
    goal: str,
    config: dict | None,
    scope_dict: dict,
    store_root: str,
    project: str,
    parent_id: str | None,
    cmd_queue: Any,
    event_queue: Any,
) -> None:
    """Async worker: create agent, wire, run, report."""
    # 1. Import and instantiate agent class
    agent_cls = path_to_cls(agent_cls_path)
    agent = agent_cls()

    # 2. Create FileStore + MemoryView
    store = FileStore(store_root, project)
    scope = Scope(
        project=scope_dict["project"],
        session=scope_dict.get("session"),
        sweep=scope_dict.get("sweep"),
        run=scope_dict.get("run"),
        role=scope_dict.get("role", agent_cls.role),
    )

    # 3. Wire agent
    agent.id = agent_id
    agent.parent_id = parent_id
    agent.goal = goal
    agent.config = config or {}
    agent.children = []
    agent.scope = scope
    agent.memory = MemoryView(
        agent_id=agent_id,
        scope=scope.to_dict(),
        store=store,
    )

    # 4. Create RuntimeProxy
    proxy = RuntimeProxy(agent_id, store, cmd_queue, event_queue, project)
    agent._runtime = proxy

    # 5. Write spawn CONTEXT entry + initial .meta.json
    agent.memory.write(
        {"event": "spawned", "goal": goal},
        type=EntryType.CONTEXT,
        tags=["lifecycle"],
    )
    _write_meta(store, agent, agent_cls_path)

    # 6. Start command listener
    proxy.start_cmd_listener(agent)

    # 7. Send STARTED event
    event_queue.put(Event(
        type=EventType.STARTED,
        agent_id=agent_id,
        payload={},
    ))

    # 8. Run agent lifecycle
    try:
        await agent.start()
        # Update .meta.json to reflect RUNNING status so ChildHandle.status works
        _write_meta(store, agent, agent_cls_path)
        if agent._task:
            await agent._task
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.exception("Agent %s failed: %s", agent_id, e)
        agent.status = AgentStatus.FAILED

    # 9. Report final status
    final_status = agent.status
    if final_status == AgentStatus.FAILED:
        event_queue.put(Event(
            type=EventType.FAILED,
            agent_id=agent_id,
            payload={"error": "agent failed"},
        ))
    else:
        event_queue.put(Event(
            type=EventType.DONE,
            agent_id=agent_id,
            payload={},
        ))

    # 10. Write final .meta.json
    _write_meta(store, agent, agent_cls_path)

    # 11. Cancel command listener
    proxy.cancel_cmd_listener()


def _write_meta(store: FileStore, agent: Any, cls_path: str) -> None:
    """Serialize agent state to .meta.json."""
    store.write_meta(agent.id, {
        "id": agent.id,
        "role": agent.role,
        "status": agent.status.value if hasattr(agent.status, "value") else str(agent.status),
        "goal": agent.goal,
        "config": agent.config,
        "parent_id": agent.parent_id,
        "children": list(agent.children),
        "agent_cls_path": cls_path,
        "iteration": agent.iteration,
        "scope": agent.scope.to_dict() if hasattr(agent.scope, "to_dict") else agent.scope,
    })
