"""Run/sweep state machine helpers extracted from server.py."""

import json
import os
import time
import logging
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("research-agent-server")

# ---------------------------------------------------------------------------
# Status constants
# ---------------------------------------------------------------------------

RUN_STATUS_ACTIVE = {"launching", "running"}
RUN_STATUS_PENDING = {"ready", "queued"}
RUN_STATUS_TERMINAL = {"finished", "failed", "stopped"}

SWEEP_STATUS_TERMINAL = {"completed", "failed", "canceled"}
SWEEP_STATUS_EDITABLE = {"draft", "pending"}


# ---------------------------------------------------------------------------
# Exit code / terminal state helpers
# ---------------------------------------------------------------------------

def _coerce_exit_code(raw_value: object) -> Optional[int]:
    if raw_value is None:
        return None
    if isinstance(raw_value, bool):
        return int(raw_value)
    if isinstance(raw_value, int):
        return raw_value
    if isinstance(raw_value, float) and raw_value.is_integer():
        return int(raw_value)
    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped:
            return None
        try:
            return int(stripped)
        except ValueError:
            return None
    return None


def _terminal_status_from_exit_code(exit_code: Optional[int]) -> Optional[str]:
    if exit_code is None:
        return None
    return "finished" if exit_code == 0 else "failed"


def _reconcile_run_terminal_state(run_id: str, run: dict) -> bool:
    changed = False

    normalized_exit_code = _coerce_exit_code(run.get("exit_code"))
    if run.get("exit_code") != normalized_exit_code:
        run["exit_code"] = normalized_exit_code
        changed = True

    completion_file = None
    run_dir = run.get("run_dir")
    if run_dir:
        completion_candidate = os.path.join(run_dir, "job.done")
        if os.path.exists(completion_candidate):
            completion_file = completion_candidate

    if completion_file:
        completion_exit_code: Optional[int] = None
        try:
            with open(completion_file, "r", encoding="utf-8", errors="replace") as f:
                completion_exit_code = _coerce_exit_code(f.read())
        except Exception as e:
            logger.warning("Failed to read completion file for %s: %s", run_id, e)

        if completion_exit_code is not None and run.get("exit_code") != completion_exit_code:
            run["exit_code"] = completion_exit_code
            normalized_exit_code = completion_exit_code
            changed = True

        completion_status = _terminal_status_from_exit_code(completion_exit_code)
        current_status = run.get("status")
        if completion_status and current_status not in RUN_STATUS_TERMINAL:
            run["status"] = completion_status
            changed = True
        elif not completion_status and current_status not in RUN_STATUS_TERMINAL:
            run["status"] = "failed"
            changed = True
            if not run.get("error"):
                run["error"] = "Run ended but exit code could not be parsed"
                changed = True

        if completion_status == "failed" and completion_exit_code not in (None, 0) and not run.get("error"):
            run["error"] = f"Process exited with code {completion_exit_code}"
            changed = True

        if not run.get("ended_at"):
            try:
                run["ended_at"] = os.path.getmtime(completion_file)
            except OSError:
                run["ended_at"] = time.time()
            changed = True
    elif run.get("status") in RUN_STATUS_TERMINAL and not run.get("ended_at"):
        run["ended_at"] = time.time()
        changed = True

    return changed


def _reconcile_all_run_terminal_states(
    runs: Dict[str, dict],
    sweeps: Dict[str, dict],
    save_runs_state: Callable,
) -> bool:
    changed = False
    affected_sweeps: set[str] = set()

    for run_id, run in runs.items():
        if _reconcile_run_terminal_state(run_id, run):
            changed = True
            sweep_id = run.get("sweep_id")
            if sweep_id:
                affected_sweeps.add(sweep_id)

    for sweep_id in affected_sweeps:
        recompute_sweep_state(sweep_id, runs, sweeps)

    if changed:
        save_runs_state()

    return changed


# ---------------------------------------------------------------------------
# Sweep status helpers
# ---------------------------------------------------------------------------

def _normalize_sweep_status(raw_status: Optional[str]) -> str:
    if not raw_status:
        return "pending"
    normalized = raw_status.strip().lower()
    if normalized == "ready":
        return "pending"
    if normalized in {"draft", "pending", "running", "completed", "failed", "canceled"}:
        return normalized
    return "pending"


def _coerce_optional_text(value: object) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    stripped = str(value).strip()
    return stripped or None


def _coerce_optional_int(value: object) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return int(stripped)
        except ValueError:
            return None
    return None


def _coerce_optional_bool(value: object) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False
    return None


def _json_clone(value: object) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    try:
        return json.loads(json.dumps(value))
    except Exception:
        return None


def _derive_sweep_creation_context(
    *,
    name: Optional[str],
    base_command: Optional[str],
    goal: Optional[str],
    max_runs: Optional[int],
    ui_config: Optional[dict],
    parameters: Optional[dict],
    created_at: float,
) -> dict:
    ui = ui_config if isinstance(ui_config, dict) else {}
    parameter_grid = parameters if isinstance(parameters, dict) else {}

    ui_hyperparameters = ui.get("hyperparameters")
    ui_metrics = ui.get("metrics")
    ui_insights = ui.get("insights")

    max_runs_from_ui = _coerce_optional_int(ui.get("maxRuns"))
    parallel_runs = _coerce_optional_int(ui.get("parallelRuns"))

    hyperparameter_count = (
        len(ui_hyperparameters)
        if isinstance(ui_hyperparameters, list)
        else len(parameter_grid)
    )
    metric_count = len(ui_metrics) if isinstance(ui_metrics, list) else None
    insight_count = len(ui_insights) if isinstance(ui_insights, list) else None

    return {
        "name": _coerce_optional_text(ui.get("name")) or _coerce_optional_text(name),
        "goal": _coerce_optional_text(ui.get("goal")) or _coerce_optional_text(goal),
        "description": _coerce_optional_text(ui.get("description")),
        "command": _coerce_optional_text(ui.get("command")) or _coerce_optional_text(base_command),
        "notes": _coerce_optional_text(ui.get("notes")),
        "max_runs": max_runs_from_ui if max_runs_from_ui is not None else _coerce_optional_int(max_runs),
        "parallel_runs": parallel_runs,
        "early_stopping_enabled": _coerce_optional_bool(ui.get("earlyStoppingEnabled")),
        "early_stopping_patience": _coerce_optional_int(ui.get("earlyStoppingPatience")),
        "hyperparameter_count": hyperparameter_count,
        "metric_count": metric_count,
        "insight_count": insight_count,
        "created_at": created_at,
        "ui_config_snapshot": _json_clone(ui),
    }


def _ensure_sweep_creation_context(sweep: dict) -> bool:
    existing = sweep.get("creation_context")
    if isinstance(existing, dict):
        return False

    sweep["creation_context"] = _derive_sweep_creation_context(
        name=_coerce_optional_text(sweep.get("name")),
        base_command=_coerce_optional_text(sweep.get("base_command")),
        goal=_coerce_optional_text(sweep.get("goal")),
        max_runs=_coerce_optional_int(sweep.get("max_runs")),
        ui_config=sweep.get("ui_config") if isinstance(sweep.get("ui_config"), dict) else None,
        parameters=sweep.get("parameters") if isinstance(sweep.get("parameters"), dict) else None,
        created_at=float(sweep.get("created_at") or time.time()),
    )
    return True


def _compute_sweep_progress(sweep: dict, runs: Dict[str, dict]) -> dict:
    """Compute progress counts for a sweep from current run statuses."""
    run_ids = sweep.get("run_ids", []) or []
    sweep_runs = [runs[rid] for rid in run_ids if rid in runs]

    return {
        "total": len(sweep_runs),
        "completed": sum(1 for r in sweep_runs if r.get("status") == "finished"),
        "failed": sum(1 for r in sweep_runs if r.get("status") == "failed"),
        "running": sum(1 for r in sweep_runs if r.get("status") == "running"),
        "launching": sum(1 for r in sweep_runs if r.get("status") == "launching"),
        "ready": sum(1 for r in sweep_runs if r.get("status") == "ready"),
        "queued": sum(1 for r in sweep_runs if r.get("status") == "queued"),
        "canceled": sum(1 for r in sweep_runs if r.get("status") == "stopped"),
    }


def _infer_sweep_status(previous_status: str, progress: dict) -> str:
    """Derive a sweep status from run state counts."""
    total = progress.get("total", 0)
    running = progress.get("running", 0) + progress.get("launching", 0)
    queued = progress.get("queued", 0)
    ready = progress.get("ready", 0)
    completed = progress.get("completed", 0)
    failed = progress.get("failed", 0)
    canceled = progress.get("canceled", 0)
    terminal = completed + failed + canceled

    if previous_status == "draft" and total == 0:
        return "draft"
    if total == 0:
        return "pending"
    if running > 0:
        return "running"
    if queued > 0:
        return "pending"
    if ready > 0:
        return "pending"
    if terminal < total:
        return "running"
    if failed > 0:
        return "failed"
    if completed > 0:
        return "completed"
    return "canceled"


def recompute_sweep_state(
    sweep_id: str,
    runs: Dict[str, dict],
    sweeps: Dict[str, dict],
) -> Optional[dict]:
    """Refresh a single sweep's progress and derived status."""
    sweep = sweeps.get(sweep_id)
    if not sweep:
        return None

    previous_status = _normalize_sweep_status(sweep.get("status"))
    progress = _compute_sweep_progress(sweep, runs)
    next_status = _infer_sweep_status(previous_status, progress)

    sweep["status"] = next_status
    sweep["progress"] = progress

    if next_status == "running":
        if not sweep.get("started_at"):
            sweep["started_at"] = time.time()
        sweep.pop("completed_at", None)
    elif next_status in SWEEP_STATUS_TERMINAL:
        sweep["completed_at"] = sweep.get("completed_at") or time.time()
    else:
        sweep.pop("completed_at", None)

    return sweep


def recompute_all_sweep_states(
    runs: Dict[str, dict],
    sweeps: Dict[str, dict],
) -> None:
    for sweep_id in list(sweeps.keys()):
        recompute_sweep_state(sweep_id, runs, sweeps)


def _sync_run_membership_with_sweep(
    run_id: str,
    sweep_id: Optional[str],
    runs: Dict[str, dict],
    sweeps: Dict[str, dict],
) -> None:
    if not sweep_id:
        return
    if sweep_id not in sweeps:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Sweep not found: {sweep_id}")
    run_ids = sweeps[sweep_id].setdefault("run_ids", [])
    if run_id not in run_ids:
        run_ids.append(run_id)
    recompute_sweep_state(sweep_id, runs, sweeps)


def _current_run_summary(
    runs: Dict[str, dict],
    sweeps: Dict[str, dict],
    save_runs_state: Callable,
) -> dict:
    _reconcile_all_run_terminal_states(runs, sweeps, save_runs_state)
    active_runs = [run for run in runs.values() if not run.get("is_archived", False)]
    return {
        "total": len(active_runs),
        "running": sum(1 for run in active_runs if run.get("status") == "running"),
        "launching": sum(1 for run in active_runs if run.get("status") == "launching"),
        "queued": sum(1 for run in active_runs if run.get("status") == "queued"),
        "ready": sum(1 for run in active_runs if run.get("status") == "ready"),
        "failed": sum(1 for run in active_runs if run.get("status") == "failed"),
        "finished": sum(1 for run in active_runs if run.get("status") == "finished"),
    }


# ---------------------------------------------------------------------------
# Grid expansion
# ---------------------------------------------------------------------------

def expand_parameter_grid(parameters: dict, max_runs: int) -> list:
    """Expand parameter dict into list of parameter combinations."""
    import itertools

    keys = list(parameters.keys())
    values = [parameters[k] if isinstance(parameters[k], list) else [parameters[k]] for k in keys]

    combinations = list(itertools.product(*values))[:max_runs]

    return [dict(zip(keys, combo)) for combo in combinations]


def build_command_with_params(base_command: str, params: dict) -> str:
    """Insert parameters into command string."""
    param_str = " ".join([f"--{k}={v}" for k, v in params.items()])
    return f"{base_command} {param_str}".strip()
