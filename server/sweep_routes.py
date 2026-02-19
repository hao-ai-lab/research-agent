"""
Research Agent Server — Sweep Endpoints

Extracted from server.py. All /sweeps/* CRUD + lifecycle endpoints and
their helper functions (expand_parameter_grid, build_command_with_params).
"""

import itertools
import logging
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import config
from models import SweepCreate, SweepUpdate, RunCreate

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_sweeps = None
_runs = None
_save_runs_state = None
_recompute_sweep_state = None
_recompute_all_sweep_states = None
_normalize_sweep_status = None
_ensure_sweep_creation_context = None
_derive_sweep_creation_context = None
_normalize_gpuwrap_config = None
_launch_run_in_tmux = None
_RUN_STATUS_ACTIVE = None


def init(
    sweeps_dict,
    runs_dict,
    save_runs_state_fn,
    recompute_sweep_state_fn,
    recompute_all_sweep_states_fn,
    normalize_sweep_status_fn,
    ensure_sweep_creation_context_fn,
    derive_sweep_creation_context_fn,
    normalize_gpuwrap_config_fn,
    launch_run_in_tmux_fn,
    run_status_active_set,
):
    """Wire in all shared state and helper functions from server.py."""
    global _sweeps, _runs, _save_runs_state
    global _recompute_sweep_state, _recompute_all_sweep_states
    global _normalize_sweep_status, _ensure_sweep_creation_context
    global _derive_sweep_creation_context, _normalize_gpuwrap_config
    global _launch_run_in_tmux, _RUN_STATUS_ACTIVE
    _sweeps = sweeps_dict
    _runs = runs_dict
    _save_runs_state = save_runs_state_fn
    _recompute_sweep_state = recompute_sweep_state_fn
    _recompute_all_sweep_states = recompute_all_sweep_states_fn
    _normalize_sweep_status = normalize_sweep_status_fn
    _ensure_sweep_creation_context = ensure_sweep_creation_context_fn
    _derive_sweep_creation_context = derive_sweep_creation_context_fn
    _normalize_gpuwrap_config = normalize_gpuwrap_config_fn
    _launch_run_in_tmux = launch_run_in_tmux_fn
    _RUN_STATUS_ACTIVE = run_status_active_set


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def expand_parameter_grid(parameters: dict, max_runs: int) -> list:
    """Expand parameter dict into list of parameter combinations."""
    keys = list(parameters.keys())
    values = [parameters[k] if isinstance(parameters[k], list) else [parameters[k]] for k in keys]
    combinations = list(itertools.product(*values))[:max_runs]
    return [dict(zip(keys, combo)) for combo in combinations]


def build_command_with_params(base_command: str, params: dict) -> str:
    """Insert parameters into command string."""
    param_str = " ".join([f"--{k}={v}" for k, v in params.items()])
    return f"{base_command} {param_str}".strip()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class WildSweepCreate(BaseModel):
    name: str = "Wild Loop Sweep"
    goal: str = ""
    chat_session_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/sweeps")
async def list_sweeps(
    limit: int = Query(50, description="Max sweeps to return")
):
    """List all sweeps."""
    _recompute_all_sweep_states()
    backfilled = False
    result = []
    for sweep_id, sweep in _sweeps.items():
        if _ensure_sweep_creation_context(sweep):
            backfilled = True
        result.append({"id": sweep_id, **sweep})

    if backfilled:
        _save_runs_state()

    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


@router.post("/sweeps/wild")
async def create_wild_sweep(req: WildSweepCreate):
    """Create an empty sweep container for wild loop tracking."""
    sweep_id = uuid.uuid4().hex[:12]

    created_at = time.time()
    sweep_data = {
        "name": req.name,
        "base_command": "",
        "workdir": config.WORKDIR,
        "parameters": {},
        "run_ids": [],
        "status": "pending",
        "created_at": created_at,
        "goal": req.goal,
        "is_wild": True,
        "chat_session_id": req.chat_session_id,
        "ui_config": None,
        "creation_context": _derive_sweep_creation_context(
            name=req.name,
            base_command="",
            goal=req.goal,
            max_runs=None,
            ui_config=None,
            parameters={},
            created_at=created_at,
        ),
        "progress": {
            "total": 0,
            "completed": 0,
            "failed": 0,
            "running": 0,
            "launching": 0,
            "ready": 0,
            "queued": 0,
            "canceled": 0,
        },
    }

    _sweeps[sweep_id] = sweep_data
    _recompute_sweep_state(sweep_id)
    _save_runs_state()

    logger.info(f"Created wild sweep {sweep_id}: {req.name} (goal: {req.goal[:80]})")
    return {"id": sweep_id, **sweep_data}


@router.post("/sweeps")
async def create_sweep(req: SweepCreate):
    """Create a sweep in draft/pending/running mode, optionally with generated runs."""
    sweep_id = uuid.uuid4().hex[:12]
    requested_status = _normalize_sweep_status(req.status)
    if req.auto_start and requested_status == "pending":
        requested_status = "running"

    if requested_status not in {"draft", "pending", "running"}:
        raise HTTPException(status_code=400, detail=f"Unsupported sweep status: {requested_status}")

    created_at = time.time()
    creation_context = _derive_sweep_creation_context(
        name=req.name,
        base_command=req.base_command,
        goal=req.goal,
        max_runs=req.max_runs,
        ui_config=req.ui_config,
        parameters=req.parameters,
        created_at=created_at,
    )

    # Create draft sweep without materializing runs
    if requested_status == "draft":
        sweep_data = {
            "name": req.name,
            "base_command": req.base_command,
            "workdir": req.workdir or config.WORKDIR,
            "parameters": req.parameters or {},
            "run_ids": [],
            "status": "draft",
            "created_at": created_at,
            "goal": req.goal,
            "max_runs": req.max_runs,
            "ui_config": req.ui_config,
            "chat_session_id": req.chat_session_id,
            "creation_context": creation_context,
            "progress": {
                "total": 0,
                "completed": 0,
                "failed": 0,
                "running": 0,
                "launching": 0,
                "ready": 0,
                "queued": 0,
                "canceled": 0,
            },
        }
        _sweeps[sweep_id] = sweep_data
        _save_runs_state()
        logger.info(f"Created draft sweep {sweep_id}: {req.name}")
        return {"id": sweep_id, **sweep_data}

    # Expand parameters into run configurations
    param_combinations = expand_parameter_grid(req.parameters or {}, req.max_runs)

    # Create runs for each combination
    run_ids = []
    for i, params in enumerate(param_combinations):
        run_id = uuid.uuid4().hex[:12]
        command = build_command_with_params(req.base_command, params)

        run_data = {
            "name": f"{req.name} #{i+1}",
            "command": command,
            "workdir": req.workdir or config.WORKDIR,
            "status": "queued" if requested_status == "running" else "ready",
            "created_at": time.time(),
            "is_archived": False,
            "sweep_id": sweep_id,
            "sweep_params": params,
            "chat_session_id": req.chat_session_id,
            "tmux_window": None,
            "run_dir": None,
            "exit_code": None,
            "error": None,
            "wandb_dir": None,
        }

        _runs[run_id] = run_data
        run_ids.append(run_id)

    # Create sweep record
    sweep_data = {
        "name": req.name,
        "base_command": req.base_command,
        "workdir": req.workdir or config.WORKDIR,
        "parameters": req.parameters,
        "run_ids": run_ids,
        "status": "running" if requested_status == "running" else "pending",
        "created_at": created_at,
        "goal": req.goal,
        "max_runs": req.max_runs,
        "ui_config": req.ui_config,
        "chat_session_id": req.chat_session_id,
        "creation_context": creation_context,
        "progress": {
            "total": len(run_ids),
            "completed": 0,
            "failed": 0,
            "running": 0,
            "launching": 0,
            "ready": len(run_ids) if requested_status != "running" else 0,
            "queued": len(run_ids) if requested_status == "running" else 0,
            "canceled": 0,
        },
    }

    _sweeps[sweep_id] = sweep_data
    _recompute_sweep_state(sweep_id)
    _save_runs_state()

    logger.info(f"Created sweep {sweep_id}: {req.name} with {len(run_ids)} runs (status={requested_status})")
    return {"id": sweep_id, **sweep_data}


@router.put("/sweeps/{sweep_id}")
async def update_sweep(sweep_id: str, req: SweepUpdate):
    """Update an existing sweep configuration/state."""
    if sweep_id not in _sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = _sweeps[sweep_id]
    current_status = _normalize_sweep_status(sweep.get("status"))
    base_command_update_requested = req.base_command is not None
    non_command_structural_update_requested = any(
        field is not None
        for field in [req.parameters, req.max_runs]
    )
    structural_update_requested = base_command_update_requested or non_command_structural_update_requested

    if current_status == "running" and structural_update_requested:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot modify base command/parameters/max_runs while sweep is running. "
                "Create a draft revision and launch it as a new sweep."
            ),
        )

    if sweep.get("run_ids") and non_command_structural_update_requested:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot mutate structure for a sweep that already has runs. "
                "Create a draft revision instead."
            ),
        )

    if req.status is not None:
        next_status = _normalize_sweep_status(req.status)
        if next_status == "draft" and sweep.get("run_ids"):
            raise HTTPException(
                status_code=409,
                detail="Cannot move a sweep with existing runs back to draft.",
            )
        sweep["status"] = next_status

    if req.name is not None:
        sweep["name"] = req.name
    if req.base_command is not None:
        next_base_command = req.base_command.strip()
        if not next_base_command:
            raise HTTPException(status_code=400, detail="Sweep base command cannot be empty")
        sweep["base_command"] = next_base_command

        ui_config = sweep.get("ui_config")
        if isinstance(ui_config, dict):
            ui_config["command"] = next_base_command
            ui_config["updatedAt"] = int(time.time())

        creation_context = sweep.get("creation_context")
        if isinstance(creation_context, dict):
            creation_context["command"] = next_base_command

        run_ids = sweep.get("run_ids") or []
        for run_id in run_ids:
            run = _runs.get(run_id)
            if not run:
                continue
            params = run.get("sweep_params")
            if not isinstance(params, dict):
                params = {}
            run["command"] = build_command_with_params(next_base_command, params)
    if req.workdir is not None:
        sweep["workdir"] = req.workdir
    if req.parameters is not None:
        sweep["parameters"] = req.parameters
    if req.goal is not None:
        sweep["goal"] = req.goal
    if req.ui_config is not None:
        sweep["ui_config"] = req.ui_config

    if req.max_runs is not None and req.max_runs > 0:
        sweep["max_runs"] = req.max_runs

    _recompute_sweep_state(sweep_id)
    _save_runs_state()
    return {"id": sweep_id, **sweep}


@router.get("/sweeps/{sweep_id}")
async def get_sweep(sweep_id: str):
    """Get sweep details with run status summary."""
    if sweep_id not in _sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = _recompute_sweep_state(sweep_id) or _sweeps[sweep_id]
    if _ensure_sweep_creation_context(sweep):
        _save_runs_state()
    return {"id": sweep_id, **sweep}


@router.post("/sweeps/{sweep_id}/start")
async def start_sweep(sweep_id: str, parallel: int = Query(1, description="Max parallel runs")):
    """Start all ready/queued runs in a sweep."""
    if sweep_id not in _sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = _sweeps[sweep_id]
    if _normalize_sweep_status(sweep.get("status")) == "draft":
        raise HTTPException(status_code=400, detail="Draft sweep has no runnable jobs yet")
    started = 0
    attempted = 0

    for run_id in sweep.get("run_ids", []):
        if run_id in _runs:
            run = _runs[run_id]
            if run["status"] in ["ready", "queued"] and started < parallel:
                attempted += 1
                try:
                    if run["status"] == "ready":
                        run["status"] = "queued"
                        run["queued_at"] = time.time()

                    _launch_run_in_tmux(run_id, run)
                    started += 1
                except Exception as e:
                    logger.error(f"Failed to start run {run_id}: {e}")

    _recompute_sweep_state(sweep_id)
    _save_runs_state()

    return {"message": f"Started {started}/{attempted} runs", "sweep_id": sweep_id}


@router.post("/sweeps/{sweep_id}/runs")
async def add_run_to_sweep_directly(sweep_id: str, req: RunCreate):
    """Create a new run and attach it to a sweep in one call."""
    if sweep_id not in _sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    req.sweep_id = sweep_id

    run_id = uuid.uuid4().hex[:12]
    initial_status = "queued" if req.auto_start else "ready"
    gpuwrap_config = _normalize_gpuwrap_config(req.gpuwrap_config)

    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": req.workdir or config.WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": sweep_id,
        "parent_run_id": req.parent_run_id,
        "origin_alert_id": req.origin_alert_id,
        "gpuwrap_config": gpuwrap_config,
        "chat_session_id": req.chat_session_id or _sweeps[sweep_id].get("chat_session_id"),
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    _runs[run_id] = run_data
    _sweeps[sweep_id].setdefault("run_ids", []).append(run_id)
    _recompute_sweep_state(sweep_id)
    _save_runs_state()

    logger.info(f"Created run {run_id} and attached to sweep {sweep_id}: {req.name} (status: {initial_status})")
    return {"id": run_id, **run_data}


@router.post("/runs/{run_id}/add-to-sweep")
async def add_run_to_sweep(run_id: str, sweep_id: str = Query(..., description="Sweep ID to add the run to")):
    """Add an existing standalone run to a sweep."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")
    if sweep_id not in _sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    run = _runs[run_id]
    old_sweep_id = run.get("sweep_id")
    if old_sweep_id == sweep_id:
        return {"message": f"Run {run_id} is already in sweep {sweep_id}"}

    if old_sweep_id and old_sweep_id in _sweeps and run.get("status") in _RUN_STATUS_ACTIVE.union({"queued"}):
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot move an active/queued run between sweeps. "
                "Stop it first or rerun into a new sweep."
            ),
        )

    if old_sweep_id and old_sweep_id in _sweeps:
        old_ids = _sweeps[old_sweep_id].get("run_ids", [])
        _sweeps[old_sweep_id]["run_ids"] = [rid for rid in old_ids if rid != run_id]
        _recompute_sweep_state(old_sweep_id)

    run["sweep_id"] = sweep_id
    if run_id not in _sweeps[sweep_id].get("run_ids", []):
        _sweeps[sweep_id].setdefault("run_ids", []).append(run_id)
    _recompute_sweep_state(sweep_id)
    _save_runs_state()
    return {"message": f"Run {run_id} added to sweep {sweep_id}"}
