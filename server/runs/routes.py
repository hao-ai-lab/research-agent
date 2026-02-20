"""
Research Agent Server — Run Endpoints

Extracted from server.py. All /runs/* CRUD + lifecycle, /alerts/*,
/wild-mode, and metrics endpoints live here.
"""

import json
import logging
import os
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from core import config
from core.config import resolve_session_workdir
import core.state as state
from core.state import chat_sessions
from core.models import (
    AlertRecord,
    CreateAlertRequest,
    RespondAlertRequest,
    RunCreate,
    RunRerunRequest,
    RunStatusUpdate,
    RunUpdate,
    WildModeRequest,
)

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# Telemetry lifecycle events
from integrations.telemetry import emit_run_event  # noqa: E402

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_runs = None
_sweeps = None
_active_alerts = None
_save_runs_state = None
_save_alerts_state = None
_save_settings_state = None
_launch_run_in_tmux = None
_recompute_sweep_state = None
_reconcile_all_run_terminal_states = None
_run_response_payload = None
_sync_run_membership_with_sweep = None
_record_journey_event = None
_normalize_gpuwrap_config = None
_coerce_exit_code = None
_slack_notifier = None
_get_or_create_session = None
_RUN_STATUS_TERMINAL = None
_load_run_metrics = None
_find_wandb_dir_from_run_dir = None
_get_wandb_curve_data = None
_wandb_metrics_cache = None


def init(
    runs_dict, sweeps_dict, active_alerts_dict,
    save_runs_state_fn, save_alerts_state_fn, save_settings_state_fn,
    launch_run_in_tmux_fn, recompute_sweep_state_fn,
    reconcile_all_run_terminal_states_fn, run_response_payload_fn,
    sync_run_membership_with_sweep_fn, record_journey_event_fn,
    normalize_gpuwrap_config_fn, coerce_exit_code_fn,
    slack_notifier, get_or_create_session_fn,
    run_status_terminal_set,
    load_run_metrics_fn, find_wandb_dir_from_run_dir_fn,
    get_wandb_curve_data_fn, wandb_metrics_cache_dict,
):
    """Wire in all shared state, helpers and callbacks from server.py."""
    global _runs, _sweeps, _active_alerts
    global _save_runs_state, _save_alerts_state, _save_settings_state
    global _launch_run_in_tmux, _recompute_sweep_state
    global _reconcile_all_run_terminal_states, _run_response_payload
    global _sync_run_membership_with_sweep, _record_journey_event
    global _normalize_gpuwrap_config, _coerce_exit_code
    global _slack_notifier, _get_or_create_session
    global _RUN_STATUS_TERMINAL
    global _load_run_metrics, _find_wandb_dir_from_run_dir
    global _get_wandb_curve_data, _wandb_metrics_cache

    _runs = runs_dict
    _sweeps = sweeps_dict
    _active_alerts = active_alerts_dict
    _save_runs_state = save_runs_state_fn
    _save_alerts_state = save_alerts_state_fn
    _save_settings_state = save_settings_state_fn
    _launch_run_in_tmux = launch_run_in_tmux_fn
    _recompute_sweep_state = recompute_sweep_state_fn
    _reconcile_all_run_terminal_states = reconcile_all_run_terminal_states_fn
    _run_response_payload = run_response_payload_fn
    _sync_run_membership_with_sweep = sync_run_membership_with_sweep_fn
    _record_journey_event = record_journey_event_fn
    _normalize_gpuwrap_config = normalize_gpuwrap_config_fn
    _coerce_exit_code = coerce_exit_code_fn
    _slack_notifier = slack_notifier
    _get_or_create_session = get_or_create_session_fn
    _RUN_STATUS_TERMINAL = run_status_terminal_set
    _load_run_metrics = load_run_metrics_fn
    _find_wandb_dir_from_run_dir = find_wandb_dir_from_run_dir_fn
    _get_wandb_curve_data = get_wandb_curve_data_fn
    _wandb_metrics_cache = wandb_metrics_cache_dict


# ---------------------------------------------------------------------------
# Run Endpoints
# ---------------------------------------------------------------------------

@router.get("/runs")
async def list_runs(
    archived: bool = Query(False, description="Include archived runs"),
    limit: int = Query(100, description="Max runs to return")
):
    """List all runs."""
    _reconcile_all_run_terminal_states()
    result = []
    for run_id, run in _runs.items():
        if not archived and run.get("is_archived", False):
            continue
        result.append(_run_response_payload(run_id, run))

    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


@router.post("/runs")
async def create_run(req: RunCreate):
    """Create a new run. Starts in 'ready' state unless auto_start=True."""
    run_id = uuid.uuid4().hex[:12]

    if req.sweep_id and req.sweep_id not in _sweeps:
        raise HTTPException(status_code=404, detail=f"Sweep not found: {req.sweep_id}")

    initial_status = "queued" if req.auto_start else "ready"
    gpuwrap_config = _normalize_gpuwrap_config(req.gpuwrap_config)

    # Resolve workdir: explicit request > session override > server default
    if req.workdir:
        effective_workdir = req.workdir
    elif req.chat_session_id:
        effective_workdir = resolve_session_workdir(
            chat_sessions.get(req.chat_session_id, {})
        )
    else:
        effective_workdir = config.WORKDIR

    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": effective_workdir,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": req.sweep_id,
        "parent_run_id": req.parent_run_id,
        "origin_alert_id": req.origin_alert_id,
        "chat_session_id": req.chat_session_id,
        "gpuwrap_config": gpuwrap_config,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    _runs[run_id] = run_data
    _sync_run_membership_with_sweep(run_id, req.sweep_id)
    _save_runs_state()
    _record_journey_event(
        kind="run_created",
        actor="system",
        session_id=req.chat_session_id,
        run_id=run_id,
        note=req.name,
        metadata={"status": initial_status, "sweep_id": req.sweep_id},
    )
    if initial_status == "queued":
        _record_journey_event(
            kind="run_queued",
            actor="system",
            session_id=req.chat_session_id,
            run_id=run_id,
            note=f"{req.name} queued",
        )

    logger.info(f"Created run {run_id}: {req.name} (status: {initial_status})")
    emit_run_event("run_created", run_id, chat_session_id=req.chat_session_id or "", sweep_id=req.sweep_id or "",
                   metadata={"name": req.name, "status": initial_status})

    if initial_status == "queued":
        try:
            _launch_run_in_tmux(run_id, run_data)
            if run_data.get("sweep_id"):
                _recompute_sweep_state(run_data["sweep_id"])
            _save_runs_state()
        except Exception as e:
            logger.error(f"Failed to auto-start run {run_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return _run_response_payload(run_id, run_data)


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Get run details."""
    _reconcile_all_run_terminal_states()
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_response_payload(run_id, _runs[run_id])


@router.put("/runs/{run_id}")
async def update_run(run_id: str, req: RunUpdate):
    """Update mutable run fields."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    current_status = str(run.get("status", "")).strip().lower()

    if req.command is not None:
        next_command = req.command.strip()
        if not next_command:
            raise HTTPException(status_code=400, detail="Run command cannot be empty")
        if current_status in {"launching", "running"} and next_command != str(run.get("command", "")).strip():
            raise HTTPException(
                status_code=409,
                detail="Cannot edit command while run is active. Stop the run first.",
            )
        run["command"] = next_command

    if req.name is not None:
        next_name = req.name.strip()
        if not next_name:
            raise HTTPException(status_code=400, detail="Run name cannot be empty")
        run["name"] = next_name

    if req.workdir is not None:
        next_workdir = req.workdir.strip()
        if not next_workdir:
            raise HTTPException(status_code=400, detail="Run workdir cannot be empty")
        run["workdir"] = next_workdir

    _save_runs_state()
    return _run_response_payload(run_id, run)


@router.post("/runs/{run_id}/queue")
async def queue_run(run_id: str):
    """Queue a ready run for execution."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    if run["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Run is not ready (status: {run['status']})")

    run["status"] = "queued"
    run["queued_at"] = time.time()
    _record_journey_event(
        kind="run_queued",
        actor="system",
        session_id=run.get("chat_session_id"),
        run_id=run_id,
        note=run.get("name") or run_id,
    )
    if run.get("sweep_id"):
        _recompute_sweep_state(run["sweep_id"])
    _save_runs_state()

    return {"message": "Run queued", "id": run_id, **run}


@router.post("/runs/{run_id}/start")
async def start_run(run_id: str):
    """Start a queued run."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    if run["status"] not in ["queued", "ready"]:
        raise HTTPException(status_code=400, detail=f"Run cannot be started (status: {run['status']})")

    if run["status"] == "ready":
        run["status"] = "queued"
        run["queued_at"] = time.time()
        _record_journey_event(
            kind="run_queued",
            actor="system",
            session_id=run.get("chat_session_id"),
            run_id=run_id,
            note=run.get("name") or run_id,
        )

    try:
        tmux_window = _launch_run_in_tmux(run_id, run)
        _record_journey_event(
            kind="run_launched",
            actor="system",
            session_id=run.get("chat_session_id"),
            run_id=run_id,
            note=run.get("name") or run_id,
            metadata={"tmux_window": tmux_window},
        )
        if run.get("sweep_id"):
            _recompute_sweep_state(run["sweep_id"])
        _save_runs_state()
        return {"message": "Run started", "tmux_window": tmux_window}
    except Exception as e:
        logger.error(f"Failed to start run {run_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Stop a running job."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    if run["status"] not in ["launching", "running"]:
        raise HTTPException(status_code=400, detail=f"Run is not active (status: {run['status']})")

    tmux_window = run.get("tmux_window")
    if tmux_window:
        session = _get_or_create_session()
        if session:
            window = session.windows.get(window_name=tmux_window, default=None)
            if window:
                window.kill()
                logger.info(f"Killed tmux window {tmux_window}")

    run["status"] = "stopped"
    run["stopped_at"] = time.time()
    _record_journey_event(
        kind="run_stopped",
        actor="system",
        session_id=run.get("chat_session_id"),
        run_id=run_id,
        note=run.get("name") or run_id,
    )
    if run.get("sweep_id"):
        _recompute_sweep_state(run["sweep_id"])
    _save_runs_state()
    emit_run_event("run_stopped", run_id, chat_session_id=run.get("chat_session_id") or "",
                   sweep_id=run.get("sweep_id") or "")

    return {"message": "Run stopped"}


@router.post("/runs/{run_id}/rerun")
async def rerun_run(run_id: str, req: Optional[RunRerunRequest] = None):
    """Create a new run based on an existing run."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    source_run = _runs[run_id]
    new_command = req.command if req and req.command else source_run.get("command")
    if not new_command:
        raise HTTPException(status_code=400, detail="Command is required for rerun")

    new_run_id = uuid.uuid4().hex[:12]
    initial_status = "queued" if req and req.auto_start else "ready"
    if req and req.gpuwrap_config is not None:
        gpuwrap_config = _normalize_gpuwrap_config(req.gpuwrap_config)
    else:
        gpuwrap_config = _normalize_gpuwrap_config(source_run.get("gpuwrap_config"))

    new_run = {
        "name": f"{source_run.get('name', 'Run')} (Rerun)",
        "command": new_command,
        "workdir": source_run.get("workdir") or config.WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": source_run.get("sweep_id"),
        "parent_run_id": run_id,
        "origin_alert_id": req.origin_alert_id if req else None,
        "chat_session_id": source_run.get("chat_session_id"),
        "gpuwrap_config": gpuwrap_config,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    _runs[new_run_id] = new_run
    _sync_run_membership_with_sweep(new_run_id, new_run.get("sweep_id"))
    _save_runs_state()
    _record_journey_event(
        kind="run_created",
        actor="system",
        session_id=new_run.get("chat_session_id"),
        run_id=new_run_id,
        note=new_run.get("name") or new_run_id,
        metadata={"status": initial_status, "parent_run_id": run_id},
    )
    if initial_status == "queued":
        _record_journey_event(
            kind="run_queued",
            actor="system",
            session_id=new_run.get("chat_session_id"),
            run_id=new_run_id,
            note=f"{new_run.get('name') or new_run_id} queued",
        )

    if initial_status == "queued":
        try:
            _launch_run_in_tmux(new_run_id, new_run)
            _record_journey_event(
                kind="run_launched",
                actor="system",
                session_id=new_run.get("chat_session_id"),
                run_id=new_run_id,
                note=new_run.get("name") or new_run_id,
                metadata={"rerun_of": run_id},
            )
            if new_run.get("sweep_id"):
                _recompute_sweep_state(new_run["sweep_id"])
            _save_runs_state()
        except Exception as e:
            logger.error(f"Failed to launch rerun {new_run_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return {"id": new_run_id, **new_run}


@router.post("/runs/{run_id}/archive")
async def archive_run(run_id: str):
    """Archive a run."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    _runs[run_id]["is_archived"] = True
    _runs[run_id]["archived_at"] = time.time()
    _save_runs_state()
    return {"message": "Run archived", "run": {"id": run_id, **_runs[run_id]}}


@router.post("/runs/{run_id}/unarchive")
async def unarchive_run(run_id: str):
    """Unarchive a run."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    _runs[run_id]["is_archived"] = False
    _runs[run_id].pop("archived_at", None)
    _save_runs_state()
    return {"message": "Run unarchived", "run": {"id": run_id, **_runs[run_id]}}


@router.post("/runs/{run_id}/status")
async def update_run_status(run_id: str, update: RunStatusUpdate):
    """Update run status (called by sidecar)."""
    logger.info(f"Status update for {run_id}: {update.status}")

    if run_id not in _runs:
        _runs[run_id] = {"created_at": time.time()}

    run = _runs[run_id]

    next_status = update.status.strip().lower()
    if update.exit_code is not None:
        run["exit_code"] = _coerce_exit_code(update.exit_code)
    if update.error:
        run["error"] = update.error
    if update.tmux_pane:
        run["tmux_pane"] = update.tmux_pane
    if update.wandb_dir:
        run["wandb_dir"] = update.wandb_dir

    effective_exit_code = _coerce_exit_code(run.get("exit_code"))
    if run.get("exit_code") != effective_exit_code:
        run["exit_code"] = effective_exit_code

    if next_status == "finished" and effective_exit_code not in (None, 0):
        next_status = "failed"
        if not run.get("error"):
            run["error"] = f"Process exited with code {effective_exit_code}"

    run["status"] = next_status

    if next_status == "running" and not run.get("started_at"):
        run["started_at"] = time.time()
    elif next_status in _RUN_STATUS_TERMINAL:
        run["ended_at"] = time.time()
    _record_journey_event(
        kind=f"run_{next_status}",
        actor="system",
        session_id=run.get("chat_session_id"),
        run_id=run_id,
        note=run.get("name") or run_id,
        metadata={"exit_code": run.get("exit_code"), "error": run.get("error")},
    )

    # Slack notifications for terminal run states
    if _slack_notifier.is_enabled and next_status in _RUN_STATUS_TERMINAL:
        run_data = {"id": run_id, **run}
        if next_status == "finished":
            _slack_notifier.send_run_completed(run_data)
        elif next_status in ("failed", "stopped"):
            _slack_notifier.send_run_failed(run_data)

    if run.get("sweep_id"):
        _recompute_sweep_state(run["sweep_id"])
    _save_runs_state()
    emit_run_event(f"run_{next_status}", run_id, chat_session_id=run.get("chat_session_id") or "",
                   sweep_id=run.get("sweep_id") or "",
                   metadata={"exit_code": run.get("exit_code")})
    return {"message": "Status updated"}


# ---------------------------------------------------------------------------
# Alert Endpoints
# ---------------------------------------------------------------------------

@router.post("/runs/{run_id}/alerts")
async def create_alert(run_id: str, req: CreateAlertRequest):
    """Create a new alert for a run (called by sidecar)."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    if not req.choices:
        raise HTTPException(status_code=400, detail="At least one choice is required")

    severity = (req.severity or "warning").strip().lower()
    if severity not in ["info", "warning", "critical"]:
        severity = "warning"

    alert_id = uuid.uuid4().hex
    alert = AlertRecord(
        id=alert_id,
        run_id=run_id,
        timestamp=time.time(),
        severity=severity,
        message=req.message,
        choices=req.choices,
        status="pending",
    )

    alert_payload = alert.model_dump()

    if _slack_notifier.is_enabled:
        _slack_notifier.send_alert(
            alert=alert_payload,
            run=_runs.get(run_id),
        )

    _active_alerts[alert_id] = alert_payload
    _save_alerts_state()
    logger.info(f"Created alert {alert_id} for run {run_id}: {req.message}")
    return {"alert_id": alert_id}


@router.get("/alerts")
async def list_alerts():
    """List alerts ordered by newest first."""
    alerts = list(_active_alerts.values())
    alerts.sort(key=lambda a: a.get("timestamp", 0), reverse=True)
    return alerts


@router.post("/alerts/{alert_id}/respond")
async def respond_to_alert(alert_id: str, req: RespondAlertRequest):
    """Resolve an alert and persist the response for sidecar consumption."""
    if alert_id not in _active_alerts:
        raise HTTPException(status_code=404, detail="Alert not found")

    alert = _active_alerts[alert_id]
    if req.choice not in alert.get("choices", []):
        raise HTTPException(status_code=400, detail="Invalid choice")

    alert["status"] = "resolved"
    alert["response"] = req.choice
    alert["responded_at"] = time.time()

    run_id = alert.get("run_id")
    run = _runs.get(run_id) if run_id else None

    if not run:
        _save_alerts_state()
        return {"message": "Response recorded, run not found"}

    run_dir = run.get("run_dir") or os.path.join(config.DATA_DIR, "runs", run_id)
    alerts_dir = os.path.join(run_dir, "alerts")
    os.makedirs(alerts_dir, exist_ok=True)
    response_file = os.path.join(alerts_dir, f"{alert_id}.response")

    try:
        with open(response_file, "w") as f:
            f.write(req.choice)
    except Exception as e:
        logger.error(f"Failed writing alert response file for {alert_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to write response file: {e}")

    _save_alerts_state()
    logger.info(f"Recorded alert response for {alert_id}: {req.choice}")
    return {"message": "Response recorded"}


# ---------------------------------------------------------------------------
# Metrics Endpoints
# ---------------------------------------------------------------------------

@router.post("/runs/{run_id}/metrics")
async def post_run_metrics(run_id: str, request: Request):
    """Accept metrics rows from the sidecar and append to stored metrics file."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    body = await request.json()
    rows = body.get("rows", [])
    if not isinstance(rows, list) or len(rows) == 0:
        raise HTTPException(status_code=400, detail="'rows' must be a non-empty array")

    run = _runs[run_id]
    run_dir = run.get("run_dir") or os.path.join(config.DATA_DIR, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    metrics_file = os.path.join(run_dir, "agent_metrics.jsonl")

    try:
        with open(metrics_file, "a") as f:
            for row in rows:
                if isinstance(row, dict):
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.error(f"Failed to write metrics for run {run_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to write metrics")

    _wandb_metrics_cache.pop(metrics_file, None)

    logger.debug(f"Received {len(rows)} metric rows for run {run_id}")
    return {"appended": len(rows)}


@router.get("/runs/{run_id}/metrics")
async def get_run_metrics(run_id: str):
    """Return parsed metrics for a run from stored metrics file."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    run_dir = run.get("run_dir") or os.path.join(config.DATA_DIR, "runs", run_id)
    parsed = _load_run_metrics(run_dir)

    if not parsed or not parsed.get("metricSeries"):
        wandb_dir = run.get("wandb_dir") or _find_wandb_dir_from_run_dir(run_dir)
        wandb_parsed = _get_wandb_curve_data(wandb_dir)
        if wandb_parsed:
            parsed = wandb_parsed

    return parsed or {}


# ---------------------------------------------------------------------------
# Wild Mode
# ---------------------------------------------------------------------------

@router.get("/wild-mode")
async def get_wild_mode():
    """Get current wild mode state."""
    return {"enabled": state.wild_mode_enabled}


@router.post("/wild-mode")
async def set_wild_mode(req: WildModeRequest):
    """Enable or disable wild mode."""
    state.wild_mode_enabled = bool(req.enabled)
    _save_settings_state()
    return {"enabled": state.wild_mode_enabled}
