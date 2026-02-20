"""
Research Agent Server — Wild Loop V2 + Evolutionary Sweep Endpoints

Extracted from server.py. All /wild/v2/* endpoints live here.
"""

import logging
import time
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_wild_v2_engine = None
_active_alerts = None
_runs = None
_WildV2Engine = None


def init(wild_v2_engine, active_alerts_dict, runs_dict, WildV2Engine_cls):
    """Wire in shared state and engine from server.py."""
    global _wild_v2_engine, _active_alerts, _runs, _WildV2Engine
    _wild_v2_engine = wild_v2_engine
    _active_alerts = active_alerts_dict
    _runs = runs_dict
    _WildV2Engine = WildV2Engine_cls


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class WildV2StartRequest(BaseModel):
    goal: str
    chat_session_id: Optional[str] = None
    max_iterations: int = 25
    wait_seconds: float = 30.0
    evo_sweep_enabled: bool = False

class WildV2StopRequest(BaseModel):
    chat_session_id: Optional[str] = None

class WildV2PauseRequest(BaseModel):
    chat_session_id: Optional[str] = None

class WildV2ResumeRequest(BaseModel):
    chat_session_id: Optional[str] = None

class WildV2SteerRequest(BaseModel):
    context: str
    chat_session_id: Optional[str] = None

class WildV2ResolveRequest(BaseModel):
    event_ids: list


# ---------------------------------------------------------------------------
# Wild Loop V2 Endpoints
# ---------------------------------------------------------------------------

@router.post("/wild/v2/start")
async def wild_v2_start(req: WildV2StartRequest):
    """Start a new V2 wild session (ralph-style loop)."""
    result = _wild_v2_engine.start(
        goal=req.goal,
        chat_session_id=req.chat_session_id,
        max_iterations=req.max_iterations,
        wait_seconds=req.wait_seconds,
        evo_sweep_enabled=req.evo_sweep_enabled,
    )
    return result


@router.post("/wild/v2/stop")
async def wild_v2_stop(req: WildV2StopRequest):
    """Stop a V2 wild session."""
    return _wild_v2_engine.stop(chat_session_id=req.chat_session_id)


@router.post("/wild/v2/pause")
async def wild_v2_pause(req: WildV2PauseRequest):
    """Pause a V2 wild session."""
    return _wild_v2_engine.pause(chat_session_id=req.chat_session_id)


@router.post("/wild/v2/resume")
async def wild_v2_resume(req: WildV2ResumeRequest):
    """Resume a V2 wild session."""
    return _wild_v2_engine.resume(chat_session_id=req.chat_session_id)


@router.get("/wild/v2/status")
async def wild_v2_status(chat_session_id: Optional[str] = Query(None)):
    """Get V2 session state, plan, and history.

    If chat_session_id is provided, returns that session's state.
    Otherwise, falls back to the most recently started session.
    """
    return _wild_v2_engine.get_status(chat_session_id=chat_session_id)


@router.get("/wild/v2/events/{session_id}")
async def wild_v2_events(session_id: str):
    """Get pending events for a V2 session (agent calls this)."""
    events = []
    # Collect pending alerts
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
    # Collect completed/failed runs
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
    return _WildV2Engine.get_system_health_from_runs(_runs)


@router.get("/wild/v2/plan/{session_id}")
async def wild_v2_plan(session_id: str, chat_session_id: Optional[str] = Query(None)):
    """Get the current tasks/plan markdown (reads tasks.md from disk)."""
    return {"plan": _wild_v2_engine.get_plan(chat_session_id=chat_session_id)}


@router.get("/wild/v2/iteration-log/{session_id}")
async def wild_v2_iteration_log(session_id: str, chat_session_id: Optional[str] = Query(None)):
    """Get the iteration log markdown."""
    return {"log": _wild_v2_engine.get_iteration_log(chat_session_id=chat_session_id)}


@router.post("/wild/v2/steer")
async def wild_v2_steer(req: WildV2SteerRequest):
    """Inject user context for the next iteration."""
    return _wild_v2_engine.steer(req.context, chat_session_id=req.chat_session_id)


# ---------------------------------------------------------------------------
# Evolutionary Sweep Endpoints
# ---------------------------------------------------------------------------

@router.get("/wild/v2/evo-sweep/{session_id}")
async def wild_v2_evo_sweep_status(session_id: str, chat_session_id: Optional[str] = Query(None)):
    """Get the current evolutionary sweep status for a session."""
    # Try to find session by chat_session_id first, fall back to wild session_id match
    session = None
    if chat_session_id:
        session = _wild_v2_engine._get_session(chat_session_id)
    if not session:
        # Legacy: search by wild session_id
        session = _wild_v2_engine._session
        if session and session.session_id != session_id:
            session = None
    if not session:
        return {"active": False, "message": "No active session matches"}
    controller = getattr(session, "_evo_controller", None)
    if controller is None:
        return {"active": False, "sweep_id": None}
    return {
        "active": True,
        "sweep_id": controller.sweep_id,
        "evo_sweep_enabled": session.evo_sweep_enabled,
    }


@router.post("/wild/v2/evo-sweep/{session_id}/stop")
async def wild_v2_evo_sweep_stop(session_id: str, chat_session_id: Optional[str] = Query(None)):
    """Stop an in-progress evolutionary sweep."""
    session = None
    if chat_session_id:
        session = _wild_v2_engine._get_session(chat_session_id)
    if not session:
        session = _wild_v2_engine._session
        if session and session.session_id != session_id:
            session = None
    if not session:
        return {"stopped": False, "message": "No active session matches"}
    controller = getattr(session, "_evo_controller", None)
    if controller is None:
        return {"stopped": False, "message": "No evo sweep in progress"}
    controller.cancel()
    return {"stopped": True, "sweep_id": controller.sweep_id}
