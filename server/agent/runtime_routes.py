"""Agent Runtime management endpoints + SSE event stream.

Provides /agents/* endpoints for listing, inspecting, steering, pausing,
resuming, and stopping agents managed by the agentsys Runtime.

Also provides /agents/events SSE endpoint fed by the EventRelay.
"""

import asyncio
import json
import logging
import time

from fastapi import APIRouter
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_agent_runtime = None
_event_relay = None
_runs = None


def init(agent_runtime, event_relay, runs_dict=None):
    """Wire in Runtime, EventRelay, and optional runs dict from server.py."""
    global _agent_runtime, _event_relay, _runs
    _agent_runtime = agent_runtime
    _event_relay = event_relay
    _runs = runs_dict or {}


def _require_runtime():
    """Return 503 JSONResponse if runtime is not yet initialized."""
    if _agent_runtime is None:
        return JSONResponse(
            status_code=503,
            content={"error": "Agent runtime not yet initialized"},
        )
    return None


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class SteerRequest(BaseModel):
    context: str
    urgency: str = "priority"  # "priority" or "critical"


# ---------------------------------------------------------------------------
# Agent management endpoints
#
# IMPORTANT: Specific path routes (/agents/events, /agents/active, etc.)
# must be registered BEFORE the wildcard /agents/{agent_id} route,
# otherwise FastAPI will match "events" as an agent_id parameter.
# ---------------------------------------------------------------------------

@router.get("/agents")
async def list_agents():
    """List all registered agents."""
    err = _require_runtime()
    if err:
        return err
    agents = _agent_runtime.list_agents()
    return [
        {
            "id": a.id,
            "role": a.role,
            "goal": a.goal,
            "status": a.status.value,
            "iteration": a.iteration,
            "parent_id": a.parent_id,
            "children": a.children,
        }
        for a in agents
    ]


@router.get("/agents/active")
async def list_active_agents():
    """List only RUNNING or PAUSED agents."""
    err = _require_runtime()
    if err:
        return err
    agents = _agent_runtime.list_active()
    return [
        {
            "id": a.id,
            "role": a.role,
            "goal": a.goal,
            "status": a.status.value,
            "iteration": a.iteration,
        }
        for a in agents
    ]


@router.get("/agents/status")
async def runtime_status():
    """Full runtime snapshot."""
    err = _require_runtime()
    if err:
        return err
    return _agent_runtime.status()


# ---------------------------------------------------------------------------
# SSE endpoint for EventRelay  (MUST be before /agents/{agent_id})
# ---------------------------------------------------------------------------

@router.get("/agents/tree")
async def agent_tree():
    """Agent hierarchy as a tree for sidebar display.

    Returns nodes filtered to sweep coordinators + run executors.
    Excludes SessionAgent and ResearchAgent (those are internal).
    """
    err = _require_runtime()
    if err:
        return err

    agents = _agent_runtime.list_agents()

    # Build lookup
    agent_map = {a.id: a for a in agents}

    # Filter to user-facing nodes: executors (runs) and orchestrators with executor children (sweeps)
    # Exclude SessionAgent and ResearchAgent (role=orchestrator with no executor children at top level)
    nodes = []
    session_agent_ids = set()

    for a in agents:
        # Identify the SessionAgent (root orchestrator, no parent)
        if a.role == "orchestrator" and a.parent_id is None:
            session_agent_ids.add(a.id)

    # Also exclude ResearchAgent-like orchestrators that are direct children of SessionAgent
    # and don't have executor children
    research_agent_ids = set()
    for a in agents:
        if a.role == "orchestrator" and a.parent_id in session_agent_ids:
            has_executor_child = any(
                agent_map[cid].role == "executor"
                for cid in a.children
                if cid in agent_map
            )
            if not has_executor_child:
                research_agent_ids.add(a.id)

    excluded_ids = session_agent_ids | research_agent_ids

    for a in agents:
        if a.id in excluded_ids:
            continue

        if a.role == "executor":
            # This is a run
            parent_id = a.parent_id
            # If parent is SessionAgent, show as top-level
            if parent_id in excluded_ids:
                parent_id = None

            node = {
                "id": a.id,
                "type": "run",
                "name": a.goal,
                "status": a.status.value if hasattr(a.status, 'value') else str(a.status),
                "parent_id": parent_id,
                "children": [],
                "config": a.config,
            }
            nodes.append(node)

        elif a.role == "orchestrator":
            # Check if it has executor children → it's a sweep
            executor_children = [
                cid for cid in a.children
                if cid in agent_map and agent_map[cid].role == "executor"
            ]
            if executor_children:
                parent_id = a.parent_id
                if parent_id in excluded_ids:
                    parent_id = None

                # Compute progress from children
                progress = {"total": 0, "completed": 0, "running": 0, "failed": 0, "queued": 0}
                for cid in executor_children:
                    child = agent_map.get(cid)
                    if child:
                        progress["total"] += 1
                        status_val = child.status.value if hasattr(child.status, 'value') else str(child.status)
                        if status_val == "done":
                            progress["completed"] += 1
                        elif status_val == "running":
                            progress["running"] += 1
                        elif status_val == "failed":
                            progress["failed"] += 1
                        else:
                            progress["queued"] += 1

                node = {
                    "id": a.id,
                    "type": "sweep",
                    "name": a.goal,
                    "status": a.status.value if hasattr(a.status, 'value') else str(a.status),
                    "parent_id": parent_id,
                    "children": executor_children,
                    "config": a.config,
                    "progress": progress,
                }
                nodes.append(node)

    return {"nodes": nodes}


@router.get("/agents/events")
async def agent_events():
    """SSE stream of agent events from the EventRelay."""
    async def generate():
        queue: asyncio.Queue = asyncio.Queue()

        async def listener(event):
            await queue.put(event)

        _event_relay.add_listener(listener)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event, default=str)}\n\n"
                except asyncio.TimeoutError:
                    # Send keepalive
                    yield f": keepalive {time.time()}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            _event_relay.remove_listener(listener)

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/agents/events/recent")
async def recent_events(n: int = 50):
    """Return the N most recent events."""
    return _event_relay.recent(n)


@router.get("/agents/{agent_id}/entries")
async def get_agent_entries(
    agent_id: str,
    type: str | None = None,
    limit: int = 50,
    tags: str | None = None,
    order: str = "desc",
):
    """Query FileStore entries for a specific agent."""
    err = _require_runtime()
    if err:
        return err
    from agentsys.types import EntryType, entry_to_dict
    query_kwargs = {"agent_id": agent_id, "limit": min(limit, 500), "order": order}
    if type:
        try:
            query_kwargs["type"] = EntryType(type)
        except ValueError:
            return JSONResponse(status_code=400, content={
                "error": f"Invalid type: {type}. Valid: {[t.value for t in EntryType]}"
            })
    if tags:
        query_kwargs["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
    entries = _agent_runtime.store.query(**query_kwargs)
    return [entry_to_dict(e) for e in entries]


# ---------------------------------------------------------------------------
# Wildcard agent routes  (MUST be after all specific /agents/* routes)
# ---------------------------------------------------------------------------

@router.get("/agents/{agent_id}")
async def get_agent(agent_id: str):
    """Get agent details by ID."""
    err = _require_runtime()
    if err:
        return err
    info = _agent_runtime.get_agent(agent_id)
    if not info:
        return {"error": "Agent not found"}
    result = {
        "id": info.id,
        "role": info.role,
        "goal": info.goal,
        "status": info.status.value,
        "iteration": info.iteration,
        "parent_id": info.parent_id,
        "children": info.children,
        "config": info.config,
        "scope": info.scope,
    }
    # Try to read session state from disk
    if info.config:
        workdir = info.config.get("workdir", ".")
        import os
        session_dir = os.path.join(workdir, ".agents", "wild", info.id)
        state_path = os.path.join(session_dir, "state.json")
        if os.path.exists(state_path):
            try:
                with open(state_path) as f:
                    result["session_state"] = json.load(f)
            except Exception:
                pass
    return result


@router.post("/agents/{agent_id}/steer")
async def steer_agent(agent_id: str, req: SteerRequest):
    """Send a steer directive to an agent."""
    err = _require_runtime()
    if err:
        return err
    from agentsys.types import SteerUrgency
    urgency = SteerUrgency.CRITICAL if req.urgency == "critical" else SteerUrgency.PRIORITY
    ok = await _agent_runtime.steer(agent_id, req.context, urgency)
    return {"ok": ok, "agent_id": agent_id, "urgency": req.urgency}


@router.post("/agents/{agent_id}/pause")
async def pause_agent(agent_id: str):
    """Pause an agent."""
    err = _require_runtime()
    if err:
        return err
    ok = await _agent_runtime.pause(agent_id)
    return {"ok": ok, "agent_id": agent_id}


@router.post("/agents/{agent_id}/resume")
async def resume_agent(agent_id: str):
    """Resume a paused agent."""
    err = _require_runtime()
    if err:
        return err
    ok = await _agent_runtime.resume(agent_id)
    return {"ok": ok, "agent_id": agent_id}


@router.delete("/agents/{agent_id}")
async def stop_agent(agent_id: str):
    """Stop an agent."""
    err = _require_runtime()
    if err:
        return err
    ok = await _agent_runtime.stop(agent_id)
    return {"ok": ok, "agent_id": agent_id}


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

# TTL for completed agents before they're eligible for cleanup (seconds)
_AGENT_CLEANUP_TTL = 3600  # 1 hour


@router.post("/agents/cleanup")
async def cleanup_agents(ttl: int = _AGENT_CLEANUP_TTL):
    """Remove completed/failed agents older than TTL from the registry.

    Memory (FileStore entries) is preserved — only the runtime registry
    entry is removed.
    """
    err = _require_runtime()
    if err:
        return err

    agents = _agent_runtime.list_agents()
    now = time.time()
    removed = []

    for a in agents:
        if a.status.value not in ("done", "failed"):
            continue
        # Check if agent has a created_at or use a heuristic
        # Query the agent's last entry timestamp as proxy for completion time
        try:
            entries = _agent_runtime.store.query(agent_id=a.id, limit=1)
            if entries:
                last_time = entries[0].created_at
                if now - last_time > ttl:
                    ok = await _agent_runtime.remove(a.id)
                    if ok:
                        removed.append(a.id)
        except Exception:
            pass

    return {"removed": removed, "count": len(removed)}
