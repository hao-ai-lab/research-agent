"""
Research Agent Server — Wild Loop V2 + Evolutionary Sweep Endpoints

Rewired to use agentsys Runtime for agent lifecycle management.
All /wild/v2/* endpoints live here.
"""

import json
import logging
import os
import time
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_agent_runtime = None
_event_relay = None
_active_alerts = None
_runs = None
_config_builder = None  # callable that returns a config dict

# Per-session L1 agent registry: chat_session_id -> SessionAgent
_session_agents: dict[str, "SessionAgent"] = {}


def _require_runtime():
    """Return 503 JSONResponse if runtime is not yet initialized."""
    if _agent_runtime is None:
        return JSONResponse(
            status_code=503,
            content={"error": "Agent runtime not yet initialized"},
        )
    return None


def _get_or_create_session_agent(chat_session_id: str) -> "SessionAgent":
    """Get or create an L1 SessionAgent for the given chat session.

    Each wild-mode chat session gets its own L1 SessionAgent.
    The agent is wired with a reactive callback so that when its
    children (L2/L3) finish, a synthetic chat turn is triggered
    automatically to process results and respond to the user.
    """
    if chat_session_id in _session_agents:
        return _session_agents[chat_session_id]

    from agentsys.agents.session_agent import SessionAgent

    agent = SessionAgent()
    agent.chat_session_id = chat_session_id
    agent._on_child_complete_callback = _on_child_complete

    _agent_runtime.register_local(
        agent,
        goal=f"Session agent for chat {chat_session_id}",
        config={"workdir": _config_builder()["workdir"] if _config_builder else "."},
    )
    # Start the agent's background loop
    import asyncio
    asyncio.ensure_future(agent.start())

    _session_agents[chat_session_id] = agent
    logger.info("[wild-routes] Created L1 SessionAgent for chat session %s (agent_id=%s)",
                chat_session_id, agent.id)
    return agent


async def _on_child_complete(chat_session_id: str, system_message: str) -> None:
    """Reactive callback: triggered when L1's child finishes.

    Injects a synthetic chat turn so L1 processes the results and
    streams a response to the user via the existing SSE pipeline.
    """
    from chat.routes import trigger_synthetic_chat_turn

    agent = _session_agents.get(chat_session_id)
    if not agent:
        logger.warning("[wild-routes] No L1 agent for chat %s during child callback", chat_session_id)
        return

    # Determine which mode this session uses (default to auto since the agent
    # is deciding what to do with the results)
    mode = "auto"

    await trigger_synthetic_chat_turn(chat_session_id, system_message, mode=mode)
    logger.info("[wild-routes] Triggered synthetic chat turn for session %s", chat_session_id)


def _get_session_agent(chat_session_id: str) -> "SessionAgent | None":
    """Get an existing L1 SessionAgent for the given chat session, or None."""
    return _session_agents.get(chat_session_id)


async def _stop_session_agent(chat_session_id: str) -> bool:
    """Stop and remove the L1 SessionAgent for the given chat session.

    Returns True if an agent was found and stopped.
    """
    agent = _session_agents.pop(chat_session_id, None)
    if agent is None:
        return False
    try:
        await agent.stop()
        logger.info("[wild-routes] Stopped L1 SessionAgent for chat session %s", chat_session_id)
    except Exception as e:
        logger.warning("[wild-routes] Error stopping L1 for chat %s: %s", chat_session_id, e)
    return True


def init(agent_runtime, event_relay, active_alerts_dict, runs_dict, config_builder):
    """Wire in Runtime, EventRelay, and shared state from server.py.

    Args:
        agent_runtime: agentsys.Runtime instance
        event_relay: EventRelay instance
        active_alerts_dict: shared alerts dict
        runs_dict: shared runs dict
        config_builder: callable(**kwargs) -> dict of serializable config
    """
    global _agent_runtime, _event_relay, _active_alerts, _runs, _config_builder
    _agent_runtime = agent_runtime
    _event_relay = event_relay
    _active_alerts = active_alerts_dict
    _runs = runs_dict
    _config_builder = config_builder


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class WildV2StartRequest(BaseModel):
    goal: str
    chat_session_id: Optional[str] = None
    max_iterations: int = 25
    wait_seconds: float = 30.0
    evo_sweep_enabled: bool = False

class WildV2SteerRequest(BaseModel):
    context: str
    experiment_id: Optional[str] = None  # target specific L2; None = all active

class WildV2StopRequest(BaseModel):
    experiment_id: Optional[str] = None  # target specific L2; None = first active

class WildV2ResolveRequest(BaseModel):
    event_ids: list


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_active_research_agent(experiment_id: str | None = None):
    """Find an active experiment agent (Level 2 ResearchAgent).

    Searches across all per-session L1 agents in the registry.

    Args:
        experiment_id: Optional specific experiment to find. If None,
                       returns the first active experiment.
    """
    if _session_agents:
        if experiment_id:
            return _agent_runtime.get_agent(experiment_id)
        for sa in _session_agents.values():
            eid = sa.get_active_experiment_id()
            if eid:
                return _agent_runtime.get_agent(eid)
        return None
    # Fallback: old behavior (pre-SessionAgent)
    active = _agent_runtime.list_active()
    for a in active:
        if a.role == "orchestrator":
            return a
    return None


def _find_all_active_research_agents():
    """Find ALL active experiment agents (Level 2 ResearchAgents)."""
    if _session_agents:
        agents = []
        for sa in _session_agents.values():
            eids = sa.get_active_experiment_ids()
            for eid in eids:
                info = _agent_runtime.get_agent(eid)
                if info:
                    agents.append(info)
        return agents
    # Fallback
    return [a for a in _agent_runtime.list_active() if a.role == "orchestrator"]


def _find_experiment_agent(experiment_id: str | None = None):
    """Find any experiment agent (active or recently finished).

    Searches across all per-session L1 agents in the registry.
    Used by status/plan/log endpoints that need to show results
    even after the experiment completes.
    """
    if _session_agents:
        if experiment_id:
            return _agent_runtime.get_agent(experiment_id)
        for sa in _session_agents.values():
            eid = sa.get_active_experiment_id()
            if eid:
                return _agent_runtime.get_agent(eid)
        # Check all tracked experiments across all L1s (most recent first)
        for sa in _session_agents.values():
            for exp in reversed(sa.list_experiments()):
                info = _agent_runtime.get_agent(exp["id"])
                if info:
                    return info
        return None
    # Fallback: old behavior
    agents = _agent_runtime.list_agents()
    for a in agents:
        if a.role == "orchestrator":
            return a
    return None


def _read_session_state(agent_id: str, workdir: str) -> dict:
    """Read session state from disk (written by the agent process)."""
    session_dir = os.path.join(workdir, ".agents", "wild", agent_id)
    state_path = os.path.join(session_dir, "state.json")
    if os.path.exists(state_path):
        try:
            with open(state_path) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


# ---------------------------------------------------------------------------
# Wild Loop V2 Endpoints
# ---------------------------------------------------------------------------

@router.post("/wild/v2/start")
async def wild_v2_start(req: WildV2StartRequest):
    """Start a new V2 wild session via SessionAgent (Level 1)."""
    err = _require_runtime()
    if err:
        return err

    # Validate goal
    goal = req.goal.strip() if req.goal else ""
    if not goal:
        return JSONResponse(
            status_code=400,
            content={"error": "Goal cannot be empty"},
        )
    if len(goal) > 5000:
        return JSONResponse(
            status_code=400,
            content={"error": f"Goal too long ({len(goal)} chars, max 5000)"},
        )

    # Build serializable config
    cfg = _config_builder(
        max_iterations=req.max_iterations,
        wait_seconds=req.wait_seconds,
        evo_sweep_enabled=req.evo_sweep_enabled,
        chat_session_id=req.chat_session_id or "",
    )

    # Get or create L1 for this chat session (headless gets a temp session ID)
    chat_sid = req.chat_session_id or f"headless-{int(time.time())}"
    session_agent = _get_or_create_session_agent(chat_sid)
    if session_agent:
        # Route through Level 1 SessionAgent → spawns Level 2 ResearchAgent
        agent_id = await session_agent.start_experiment(
            goal=goal,
            config=cfg,
        )
    else:
        # Fallback: spawn directly (pre-SessionAgent behavior)
        from agentsys.agents.research_agent import ResearchAgent
        info = await _agent_runtime.spawn(
            ResearchAgent,
            goal=goal,
            config=cfg,
            session=req.chat_session_id,
        )
        agent_id = info.id

    # Emit start event
    await _event_relay.emit({
        "type": "agent_started",
        "agent_id": agent_id,
        "goal": goal,
        "max_iterations": req.max_iterations,
    })

    return {
        "session_id": agent_id,
        "goal": goal,
        "status": "running",
        "iteration": 0,
        "max_iterations": req.max_iterations,
        "started_at": time.time(),
    }


@router.post("/wild/v2/stop")
async def wild_v2_stop(req: WildV2StopRequest | None = None):
    """Stop a V2 wild session. Optionally target a specific experiment_id."""
    err = _require_runtime()
    if err:
        return err
    target_id = req.experiment_id if req else None
    agent = _find_active_research_agent(experiment_id=target_id)
    if not agent:
        return {"stopped": False, "message": "No active session"}

    await _agent_runtime.stop(agent.id)

    await _event_relay.emit({
        "type": "agent_stopped",
        "agent_id": agent.id,
    })

    # Read final state from disk
    workdir = agent.config.get("workdir", ".")
    state = _read_session_state(agent.id, workdir)
    return state if state else {"stopped": True, "agent_id": agent.id}


@router.post("/wild/v2/pause")
async def wild_v2_pause():
    """Pause the V2 wild session."""
    err = _require_runtime()
    if err:
        return err
    agent = _find_active_research_agent()
    if not agent:
        return {"paused": False, "message": "No active session"}

    await _agent_runtime.pause(agent.id)

    workdir = agent.config.get("workdir", ".")
    state = _read_session_state(agent.id, workdir)
    return state if state else {"paused": True, "agent_id": agent.id}


@router.post("/wild/v2/resume")
async def wild_v2_resume():
    """Resume the V2 wild session."""
    err = _require_runtime()
    if err:
        return err
    # Find paused experiment agent across all L1s
    paused = None
    if _session_agents:
        for sa in _session_agents.values():
            for exp in sa.list_experiments():
                if exp["status"] == "paused":
                    paused = _agent_runtime.get_agent(exp["id"])
                    break
            if paused:
                break
    else:
        # Fallback: scan all agents
        agents = _agent_runtime.list_agents()
        for a in agents:
            if a.role == "orchestrator" and a.status.value == "paused":
                paused = a
                break
    if not paused:
        return {"resumed": False, "message": "No paused session"}

    await _agent_runtime.resume(paused.id)

    workdir = paused.config.get("workdir", ".")
    state = _read_session_state(paused.id, workdir)
    return state if state else {"resumed": True, "agent_id": paused.id}


@router.get("/wild/v2/experiments")
async def wild_v2_experiments():
    """List all experiments (active and completed) across all L1 agents."""
    all_experiments = []
    for chat_sid, sa in _session_agents.items():
        experiments = sa.list_experiments()
        for exp in experiments:
            exp["chat_session_id"] = chat_sid
            info = _agent_runtime.get_agent(exp["id"]) if _agent_runtime else None
            if info:
                exp["goal"] = info.goal
                exp["iteration"] = info.iteration
        all_experiments.extend(experiments)
    return {"experiments": all_experiments}


@router.get("/wild/v2/status")
async def wild_v2_status(experiment_id: str | None = None):
    """Get current V2 session state, plan, and history.

    If experiment_id is given, return that specific experiment's status.
    Otherwise return the first active (or most recent) experiment.
    """
    if _agent_runtime is None:
        return {"active": False}

    experiment = _find_experiment_agent(experiment_id=experiment_id)
    if not experiment:
        return {"active": False}

    workdir = experiment.config.get("workdir", ".")
    state = _read_session_state(experiment.id, workdir)

    if state:
        state["active"] = experiment.status.value in ("running", "paused")
        state["session_dir"] = os.path.join(workdir, ".agents", "wild", experiment.id)
        state["workdir"] = workdir

        # Read iteration log
        session_dir = state["session_dir"]
        log_path = os.path.join(session_dir, "iteration_log.md")
        if os.path.exists(log_path):
            try:
                with open(log_path) as f:
                    state["iteration_log"] = f.read()
            except Exception:
                state["iteration_log"] = ""

        # Read plan
        tasks_path = os.path.join(session_dir, "tasks.md")
        if os.path.exists(tasks_path):
            try:
                with open(tasks_path) as f:
                    state["plan"] = f.read()
            except Exception:
                pass

        return state

    # Fallback: minimal response from agent metadata
    return {
        "active": experiment.status.value in ("running", "paused"),
        "session_id": experiment.id,
        "goal": experiment.goal,
        "status": experiment.status.value,
        "iteration": experiment.iteration,
    }


@router.get("/wild/v2/events/{session_id}")
async def wild_v2_events(session_id: str):
    """Get pending events for a V2 session (agent calls this)."""
    events = []
    for alert_id, alert in _active_alerts.items():
        if alert.get("status") == "pending":
            events.append({
                "id": alert_id,
                "type": "alert",
                "title": f"Alert: {alert.get('type', 'unknown')}",
                "detail": alert.get("message", ""),
                "run_id": alert.get("run_id"),
                "created_at": alert.get("created_at", time.time()),
            })
    for rid, run in _runs.items():
        if run.get("status") in ("finished", "failed"):
            events.append({
                "id": f"run-{rid}-{run.get('status')}",
                "type": "run_complete",
                "title": f"Run {run.get('status')}: {run.get('name', rid)}",
                "detail": f"Status: {run.get('status')}",
                "run_id": rid,
                "created_at": time.time(),
            })
    return events


@router.post("/wild/v2/events/{session_id}/resolve")
async def wild_v2_resolve_events(session_id: str, req: WildV2ResolveRequest):
    """Mark events as resolved (agent calls this after handling)."""
    resolved = 0
    ids_to_resolve = set(req.event_ids)
    for alert_id in list(_active_alerts.keys()):
        if alert_id in ids_to_resolve:
            _active_alerts[alert_id]["status"] = "resolved"
            resolved += 1
    return {"resolved": resolved}


@router.get("/wild/v2/system-health")
async def wild_v2_system_health():
    """Get system utilization (agent calls this to check resources)."""
    if _runs is None:
        return {"running": 0, "queued": 0, "completed": 0, "failed": 0, "total": 0, "max_concurrent": 5}
    from agentsys.agents.research_agent import ResearchAgent
    return ResearchAgent.get_system_health_from_runs(_runs)


@router.get("/wild/v2/plan/{session_id}")
async def wild_v2_plan(session_id: str):
    """Get the current tasks/plan markdown."""
    if _agent_runtime is None:
        return {"plan": ""}
    experiment = _find_experiment_agent()
    if experiment:
        workdir = experiment.config.get("workdir", ".")
        session_dir = os.path.join(workdir, ".agents", "wild", experiment.id)
        tasks_path = os.path.join(session_dir, "tasks.md")
        if os.path.exists(tasks_path):
            try:
                with open(tasks_path) as f:
                    return {"plan": f.read()}
            except Exception:
                pass
    return {"plan": ""}


@router.get("/wild/v2/iteration-log/{session_id}")
async def wild_v2_iteration_log(session_id: str):
    """Get the iteration log markdown."""
    if _agent_runtime is None:
        return {"log": ""}
    experiment = _find_experiment_agent()
    if experiment:
        workdir = experiment.config.get("workdir", ".")
        session_dir = os.path.join(workdir, ".agents", "wild", experiment.id)
        log_path = os.path.join(session_dir, "iteration_log.md")
        if os.path.exists(log_path):
            try:
                with open(log_path) as f:
                    return {"log": f.read()}
            except Exception:
                pass
    return {"log": ""}


@router.post("/wild/v2/steer")
async def wild_v2_steer(req: WildV2SteerRequest):
    """Inject user context for the next iteration via Runtime steer.

    If experiment_id is set, steers that specific L2. Otherwise steers
    all active L2 agents.
    """
    err = _require_runtime()
    if err:
        return err
    from agentsys.types import SteerUrgency

    if req.experiment_id:
        # Steer a specific experiment
        agents = [_find_active_research_agent(experiment_id=req.experiment_id)]
        agents = [a for a in agents if a]
    else:
        # Steer all active experiments
        agents = _find_all_active_research_agents()

    if not agents:
        return {"ok": False, "message": "No active session"}

    results = []
    for agent in agents:
        ok = await _agent_runtime.steer(agent.id, req.context, SteerUrgency.PRIORITY)
        # Also write context file to disk for the agent to pick up
        workdir = agent.config.get("workdir", ".")
        ctx_path = os.path.join(workdir, ".agents", "wild", agent.id, "context.md")
        try:
            os.makedirs(os.path.dirname(ctx_path), exist_ok=True)
            with open(ctx_path, "w") as f:
                f.write(req.context)
        except Exception:
            pass
        results.append({"agent_id": agent.id, "ok": ok})

    return {"ok": True, "steered": results}


# ---------------------------------------------------------------------------
# Evolutionary Sweep Endpoints
# ---------------------------------------------------------------------------

@router.get("/wild/v2/evo-sweep/{session_id}")
async def wild_v2_evo_sweep_status(session_id: str):
    """Get the current evolutionary sweep status for a session."""
    if _agent_runtime is None:
        return {"active": False, "message": "Runtime not initialized"}
    experiment = _find_experiment_agent()
    if experiment:
        workdir = experiment.config.get("workdir", ".")
        state = _read_session_state(experiment.id, workdir)
        return {
            "active": False,
            "sweep_id": None,
            "evo_sweep_enabled": state.get("evo_sweep_enabled", False),
        }
    return {"active": False, "message": "No active session matches"}


@router.post("/wild/v2/evo-sweep/{session_id}/stop")
async def wild_v2_evo_sweep_stop(session_id: str):
    """Stop an in-progress evolutionary sweep."""
    return {"stopped": False, "message": "Evo sweep stop via IPC not yet implemented"}


