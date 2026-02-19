#!/usr/bin/env python3
"""
Research Agent Server

Provides:
- Multi-session chat management with OpenCode integration
- Tmux-based job scheduling and monitoring
- Real-time log streaming

Run with: python server.py --workdir /path/to/project
"""

import argparse
import glob
from dataclasses import dataclass
import json
import math
import os
import re
import shlex
import sys
import time
import uuid
import logging
import asyncio
import shutil
import socket
import subprocess
from typing import Any, Callable, Dict, Optional, AsyncIterator, List


from wild_loop_v2 import WildV2Engine
from memory_store import MemoryStore
from slack_handler import slack_notifier

import httpx
import uvicorn
import libtmux
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Configure logging — explicit handlers so uvicorn.run() can't override them
_log_formatter = logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s", datefmt="%H:%M:%S")
_log_handler = logging.StreamHandler()
_log_handler.setFormatter(_log_formatter)

# App logger
logger = logging.getLogger("research-agent-server")
logger.setLevel(logging.DEBUG)
logger.addHandler(_log_handler)
logger.propagate = False  # Don't depend on root logger (uvicorn resets it)


# =============================================================================
# Configuration  (extracted to config.py)
# =============================================================================

import config  # noqa: E402

# Re-export immutable constants and functions so existing code keeps working.
# IMPORTANT: mutable path variables (config.WORKDIR, config.DATA_DIR, *_FILE) must be
# accessed as config.VARNAME so they reflect post-init_paths() values.
from config import (  # noqa: E402
    _SERVER_FILE_DIR,
    OPENCODE_CONFIG,
    OPENCODE_URL,
    OPENCODE_USERNAME,
    OPENCODE_PASSWORD,
    MODEL_PROVIDER,
    MODEL_ID,
    RUNTIME_RESEARCH_AGENT_KEY,
    RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED,
    RUNTIME_RESEARCH_AGENT_KEY_LOCK,
    USER_AUTH_TOKEN,
    TMUX_SESSION_NAME,
    SERVER_CALLBACK_URL,
    FRONTEND_STATIC_DIR,
    AUTH_PROTECTED_PREFIXES,
    requires_api_auth,
    init_paths,
    get_auth,
    get_default_opencode_config,
    set_runtime_research_agent_key,
    apply_runtime_research_agent_key,
    _parse_optional_int,
    load_available_opencode_models,
    get_session_model,
)


# =============================================================================
# FastAPI App
# =============================================================================

app = FastAPI(title="Research Agent Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Validate X-Auth-Token header if USER_AUTH_TOKEN is configured."""
    # Allow frontend to provide runtime RESEARCH_AGENT_KEY.
    set_runtime_research_agent_key(request.headers.get("X-Research-Agent-Key"))

    # Skip auth for CORS preflight
    if request.method == "OPTIONS":
        return await call_next(request)
    
    # If no auth token configured, allow all requests
    if not USER_AUTH_TOKEN:
        return await call_next(request)

    # Static frontend routes should be public
    if not requires_api_auth(request.url.path):
        return await call_next(request)
    
    # Validate token
    provided_token = request.headers.get("X-Auth-Token")
    if provided_token != USER_AUTH_TOKEN:
        logger.warning(f"Unauthorized request to {request.url.path}")
        return JSONResponse(
            status_code=401,
            content={"detail": "Unauthorized - invalid or missing X-Auth-Token"}
        )
    
    return await call_next(request)

# =============================================================================
# Models  (extracted to models.py)
# =============================================================================

from models import (  # noqa: E402
    ChatMessage, ChatRequest, CreateSessionRequest, UpdateSessionRequest,
    SystemPromptUpdate, SessionModelUpdate,
    GpuwrapConfig, RunCreate, RunStatusUpdate, RunUpdate,
    SweepCreate, SweepUpdate,
    AlertRecord, CreateAlertRequest, RespondAlertRequest,
    RunRerunRequest, WildModeRequest,
    PLAN_STATUSES, PlanCreate, PlanUpdate,
    ClusterUpdateRequest, ClusterDetectRequest,
    JourneyNextActionsRequest,
    JOURNEY_ACTOR_VALUES, JOURNEY_REC_STATUS_VALUES,
    JOURNEY_PRIORITY_VALUES, JOURNEY_DECISION_STATUS_VALUES,
    JourneyEventCreate, JourneyRecommendationCreate,
    JourneyRecommendationRespondRequest, JourneyDecisionCreate,
    MemoryCreateRequest, MemoryUpdateRequest,
)


# =============================================================================
# Prompt Skill Manager  (extracted to skills_manager.py)
# =============================================================================

from skills_manager import PromptSkillManager, INTERNAL_SKILL_IDS, INTERNAL_SKILL_PREFIXES, _is_internal_skill  # noqa: E402
import skills_routes  # noqa: E402

# Initialize the prompt skill manager
prompt_skill_manager = PromptSkillManager()


# =============================================================================
# State  (extracted to state.py)
# =============================================================================

import state as _state  # noqa: E402
from state import (  # noqa: E402
    # Global state dicts — these are mutable references, so server.py and state.py
    # share the same dict objects. Mutations like chat_sessions["x"] = y propagate.
    chat_sessions, runs, sweeps, active_alerts, plans,
    journey_events, journey_recommendations, journey_decisions,
    wild_mode_enabled, session_stop_flags, active_chat_tasks,
    active_chat_streams, _wandb_metrics_cache,
    # Cluster
    CLUSTER_TYPE_VALUES, CLUSTER_STATUS_VALUES, CLUSTER_SOURCE_VALUES,
    cluster_state, _default_cluster_state,
    _cluster_type_label, _cluster_type_description,
    _normalize_cluster_type, _normalize_cluster_status,
    _normalize_cluster_source, _normalize_cluster_state,
    # Metrics constants
    STREAM_SNAPSHOT_SAVE_INTERVAL_SECONDS, STREAM_SNAPSHOT_SAVE_INTERVAL_EVENTS,
    STREAM_RUNTIME_RETENTION_SECONDS,
    LOSS_KEYS, VAL_LOSS_KEYS, ACCURACY_KEYS, EPOCH_KEYS, STEP_KEYS,
    MAX_HISTORY_POINTS, MAX_METRIC_SERIES_KEYS, IGNORED_METRIC_KEYS,
    # Save/load functions
    save_chat_state, load_chat_state,
    save_runs_state,
    save_alerts_state, load_alerts_state,
    save_plans_state, load_plans_state,
    save_journey_state, load_journey_state,
    # Helpers
    _journey_new_id,
    _to_float, _first_numeric, _extract_step, _is_metric_key,
    _find_wandb_dir_from_run_dir, _resolve_metrics_file, _downsample_history,
)


def _get_run_log_content(run_id: str) -> str:
    """Return log tail for a run as plain text (for engine callbacks)."""
    run = runs.get(run_id)
    if not run:
        return "Run not found"
    run_dir = run.get("run_dir")
    if not run_dir:
        return "No run directory"
    log_file = os.path.join(run_dir, "run.log")
    if not os.path.exists(log_file):
        return "No log file"
    try:
        with open(log_file, "r") as f:
            content = f.read()
        return content[-5000:] if len(content) > 5000 else content
    except Exception as e:
        return f"Error reading log: {e}"


def _create_sweep_sync(spec: dict) -> dict:
    """Synchronous sweep creation wrapper for engine callbacks."""
    sweep_id = uuid.uuid4().hex[:12]
    created_at = time.time()
    sweep_data = {
        "name": spec.get("name", f"sweep-{sweep_id}"),
        "base_command": spec.get("base_command", ""),
        "workdir": spec.get("workdir"),
        "parameters": spec.get("parameters", {}),
        "max_runs": spec.get("max_runs"),
        "status": "pending",
        "run_ids": [],
        "created_at": created_at,
    }
    sweeps[sweep_id] = sweep_data
    return {"id": sweep_id, **sweep_data}


def _start_sweep_sync(sweep_id: str, parallel: int = 1):
    """Synchronous sweep start wrapper for engine callbacks."""
    if sweep_id not in sweeps:
        return
    sweep = sweeps[sweep_id]
    sweep["status"] = "running"
    sweep["parallel"] = parallel


# Wild Loop V2 engine (ralph-style)
wild_v2_engine = WildV2Engine(
    opencode_url=OPENCODE_URL,
    model_provider=MODEL_PROVIDER,
    model_id=MODEL_ID,
    get_workdir=lambda: config.WORKDIR,
    server_url=SERVER_CALLBACK_URL,
    auth_token=USER_AUTH_TOKEN,
    get_auth=get_auth,
    render_fn=prompt_skill_manager.render,
    save_chat_state=lambda: save_chat_state(),
    chat_sessions=chat_sessions,
)

# Memory store (persistent lessons / context)
memory_store = MemoryStore(get_workdir=lambda: config.WORKDIR)
memory_store.load()

# Inject memory store into V2 engine so reflections can write memories
wild_v2_engine.memory_store = memory_store


def _record_journey_event(
    *,
    kind: str,
    actor: str = "system",
    session_id: Optional[str] = None,
    run_id: Optional[str] = None,
    chart_id: Optional[str] = None,
    recommendation_id: Optional[str] = None,
    decision_id: Optional[str] = None,
    note: Optional[str] = None,
    metadata: Optional[dict] = None,
    timestamp: Optional[float] = None,
) -> dict:
    safe_actor = actor if actor in JOURNEY_ACTOR_VALUES else "system"
    event_id = _journey_new_id("jevt")
    payload = {
        "id": event_id,
        "kind": str(kind or "unknown"),
        "actor": safe_actor,
        "session_id": session_id,
        "run_id": run_id,
        "chart_id": chart_id,
        "recommendation_id": recommendation_id,
        "decision_id": decision_id,
        "note": note,
        "metadata": metadata if isinstance(metadata, dict) else {},
        "timestamp": float(timestamp if timestamp is not None else time.time()),
    }
    journey_events[event_id] = payload
    save_journey_state()
    return payload


def save_settings_state():
    """Persist settings to disk."""
    try:
        payload = {
            "cluster": cluster_state,
        }
        # Persist Slack config if enabled
        slack_cfg = slack_notifier.get_persisted_config()
        if slack_cfg:
            payload["slack"] = slack_cfg
        with open(config.SETTINGS_DATA_FILE, "w") as f:
            json.dump(payload, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving settings state: {e}")


def load_settings_state():
    """Load settings from disk."""
    global cluster_state
    if os.path.exists(config.SETTINGS_DATA_FILE):
        try:
            with open(config.SETTINGS_DATA_FILE, "r") as f:
                data = json.load(f)
                cluster_state = _normalize_cluster_state(data.get("cluster"))
                # Restore Slack configuration
                slack_notifier.load_from_saved(data.get("slack"))
        except Exception as e:
            logger.error(f"Error loading settings state: {e}")


def load_runs_state():
    """Load runs and sweeps from disk."""
    global runs, sweeps
    if os.path.exists(config.JOBS_DATA_FILE):
        try:
            with open(config.JOBS_DATA_FILE, "r") as f:
                data = json.load(f)
                runs = data.get("runs", {})
                sweeps = data.get("sweeps", {})
                sweeps_backfilled = False
                for sweep in sweeps.values():
                    sweep["status"] = _normalize_sweep_status(sweep.get("status"))
                    if _ensure_sweep_creation_context(sweep):
                        sweeps_backfilled = True
                recompute_all_sweep_states()
                if sweeps_backfilled:
                    save_runs_state()
        except Exception as e:
            logger.error(f"Error loading runs state: {e}")





def _parse_metrics_history(metrics_file: str) -> dict:
    """Parse a metrics JSONL file into chart-ready history and summary metrics."""
    loss_history: list[dict] = []
    metric_series: Dict[str, list[dict]] = {}
    latest_loss: Optional[float] = None
    latest_accuracy: Optional[float] = None
    latest_epoch: Optional[float] = None
    fallback_step = 0

    try:
        with open(metrics_file, "r", errors="replace") as f:
            for line in f:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue

                fallback_step += 1
                step = _extract_step(row, fallback_step)
                train_loss = _first_numeric(row, LOSS_KEYS)
                val_loss = _first_numeric(row, VAL_LOSS_KEYS)
                accuracy = _first_numeric(row, ACCURACY_KEYS)
                epoch = _first_numeric(row, EPOCH_KEYS)

                if train_loss is not None:
                    point = {"step": step, "trainLoss": round(train_loss, 6)}
                    if val_loss is not None:
                        point["valLoss"] = round(val_loss, 6)
                    loss_history.append(point)
                    latest_loss = train_loss

                if accuracy is not None:
                    latest_accuracy = accuracy

                if epoch is not None:
                    latest_epoch = epoch

                for key, raw_value in row.items():
                    if not _is_metric_key(key):
                        continue
                    numeric_value = _to_float(raw_value)
                    if numeric_value is None:
                        continue
                    metric_series.setdefault(key, []).append(
                        {"step": step, "value": round(numeric_value, 6)}
                    )
    except OSError as e:
        logger.debug(f"Unable to read metrics file {metrics_file}: {e}")
        return {}

    if latest_accuracy is not None and latest_accuracy <= 1.5:
        latest_accuracy *= 100.0

    if latest_epoch is None and loss_history:
        latest_epoch = float(loss_history[-1]["step"])

    parsed: dict = {}
    if loss_history:
        parsed["lossHistory"] = _downsample_history(loss_history)

    if metric_series:
        # Keep payload bounded for very high-dimensional logs.
        ranked_metric_keys = sorted(
            metric_series.keys(),
            key=lambda key: (-len(metric_series[key]), key),
        )[:MAX_METRIC_SERIES_KEYS]
        parsed["metricSeries"] = {
            key: _downsample_history(metric_series[key])
            for key in ranked_metric_keys
        }
        parsed["metricKeys"] = ranked_metric_keys

    parsed["metrics"] = {
        "loss": latest_loss,
        "accuracy": latest_accuracy,
        "epoch": latest_epoch,
    }
    return parsed


def _get_wandb_curve_data(wandb_dir: Optional[str]) -> Optional[dict]:
    metrics_file = _resolve_metrics_file(wandb_dir)
    if not metrics_file:
        return None

    try:
        stat = os.stat(metrics_file)
    except OSError:
        return None

    cached = _wandb_metrics_cache.get(metrics_file)
    if (
        cached
        and cached.get("size") == stat.st_size
        and cached.get("mtime") == stat.st_mtime
    ):
        return cached.get("payload")

    payload = _parse_metrics_history(metrics_file)
    _wandb_metrics_cache[metrics_file] = {
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "payload": payload,
    }
    return payload


def _load_run_metrics(run_dir: Optional[str]) -> dict:
    """Load stored metrics from agent_metrics.jsonl in the run directory."""
    if not run_dir:
        return {}
    metrics_file = os.path.join(run_dir, "agent_metrics.jsonl")
    if not os.path.isfile(metrics_file):
        return {}
    return _parse_metrics_history(metrics_file)


def _run_response_payload(run_id: str, run: dict) -> dict:
    """Build run response payload enriched with metrics.

    Metrics come from two sources, in priority order:
    1. Stored metrics POSTed by the sidecar (agent_metrics.jsonl)
    2. WandB files discovered via wandb_dir or run_dir
    """
    payload = {"id": run_id, **run}

    # Source 1: stored metrics from sidecar POSTs
    parsed = _load_run_metrics(run.get("run_dir"))

    # Source 2: wandb files (fallback)
    if not parsed or not parsed.get("metricSeries"):
        wandb_dir = run.get("wandb_dir")
        if not wandb_dir:
            wandb_dir = _find_wandb_dir_from_run_dir(run.get("run_dir"))
            if wandb_dir:
                run["wandb_dir"] = wandb_dir
                payload["wandb_dir"] = wandb_dir
        wandb_parsed = _get_wandb_curve_data(wandb_dir)
        if wandb_parsed:
            parsed = wandb_parsed

    if not parsed:
        return payload

    parsed_metric_series = parsed.get("metricSeries")
    if parsed_metric_series:
        payload["metricSeries"] = parsed_metric_series
        payload["metricKeys"] = parsed.get("metricKeys", list(parsed_metric_series.keys()))

    # Also provide lossHistory for backward compat with components that still use it
    parsed_history = parsed.get("lossHistory")
    if parsed_history:
        payload["lossHistory"] = parsed_history

    parsed_metrics = parsed.get("metrics") if isinstance(parsed.get("metrics"), dict) else {}
    existing_metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    merged_metrics = {
        "loss": parsed_metrics.get("loss", existing_metrics.get("loss")),
        "accuracy": parsed_metrics.get("accuracy", existing_metrics.get("accuracy")),
        "epoch": parsed_metrics.get("epoch", existing_metrics.get("epoch")),
    }
    if any(isinstance(merged_metrics.get(key), (int, float)) for key in ("loss", "accuracy", "epoch")):
        payload["metrics"] = {
            k: float(v) for k, v in merged_metrics.items() if isinstance(v, (int, float))
        }

    return payload


# =============================================================================
# Run/Sweep State Helpers
# =============================================================================

RUN_STATUS_ACTIVE = {"launching", "running"}
RUN_STATUS_PENDING = {"ready", "queued"}
RUN_STATUS_TERMINAL = {"finished", "failed", "stopped"}

SWEEP_STATUS_TERMINAL = {"completed", "failed", "canceled"}
SWEEP_STATUS_EDITABLE = {"draft", "pending"}


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


def _reconcile_all_run_terminal_states() -> bool:
    changed = False
    affected_sweeps: set[str] = set()

    for run_id, run in runs.items():
        if _reconcile_run_terminal_state(run_id, run):
            changed = True
            sweep_id = run.get("sweep_id")
            if sweep_id:
                affected_sweeps.add(sweep_id)

    for sweep_id in affected_sweeps:
        recompute_sweep_state(sweep_id)

    if changed:
        save_runs_state()

    return changed


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


def _compute_sweep_progress(sweep: dict) -> dict:
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


def recompute_sweep_state(sweep_id: str) -> Optional[dict]:
    """Refresh a single sweep's progress and derived status."""
    sweep = sweeps.get(sweep_id)
    if not sweep:
        return None

    previous_status = _normalize_sweep_status(sweep.get("status"))
    progress = _compute_sweep_progress(sweep)
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


def recompute_all_sweep_states() -> None:
    for sweep_id in list(sweeps.keys()):
        recompute_sweep_state(sweep_id)


def _sync_run_membership_with_sweep(run_id: str, sweep_id: Optional[str]) -> None:
    if not sweep_id:
        return
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail=f"Sweep not found: {sweep_id}")
    run_ids = sweeps[sweep_id].setdefault("run_ids", [])
    if run_id not in run_ids:
        run_ids.append(run_id)
    recompute_sweep_state(sweep_id)


def _run_command_capture(args: list[str], timeout: float = 2.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = (proc.stdout or proc.stderr or "").strip()
        return proc.returncode == 0, output
    except Exception:
        return False, ""


def _count_gpu_devices() -> Optional[int]:
    if not shutil.which("nvidia-smi"):
        return None
    ok, output = _run_command_capture(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=2.5)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_slurm_nodes() -> Optional[int]:
    if not shutil.which("sinfo"):
        return None
    ok, output = _run_command_capture(["sinfo", "-h", "-N"], timeout=2.0)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_kubernetes_nodes() -> Optional[int]:
    if not shutil.which("kubectl"):
        return None
    ok, output = _run_command_capture(["kubectl", "get", "nodes", "--no-headers"], timeout=2.5)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_ssh_hosts() -> int:
    ssh_config = os.path.expanduser("~/.ssh/config")
    if not os.path.exists(ssh_config):
        return 0
    try:
        count = 0
        with open(ssh_config, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line.lower().startswith("host "):
                    continue
                host_targets = [segment for segment in line[5:].split(" ") if segment]
                has_real_target = any(
                    target not in {"*", "?"} and "*" not in target and "?" not in target
                    for target in host_targets
                )
                if has_real_target:
                    count += 1
        return count
    except Exception:
        return 0


def _infer_cluster_from_environment() -> dict:
    now = time.time()
    type_hint = _normalize_cluster_type(os.environ.get("RESEARCH_AGENT_CLUSTER_TYPE"))
    gpu_count = _count_gpu_devices()
    slurm_nodes = _count_slurm_nodes()
    kube_nodes = _count_kubernetes_nodes()
    ssh_hosts = _count_ssh_hosts()

    has_slurm_env = any(key.startswith("SLURM_") for key in os.environ.keys())
    has_kube_env = bool(os.environ.get("KUBERNETES_SERVICE_HOST")) or os.path.exists(
        "/var/run/secrets/kubernetes.io/serviceaccount/token"
    )
    has_ray_env = bool(os.environ.get("RAY_ADDRESS"))
    has_ray_cli = bool(shutil.which("ray"))

    detected_type = "unknown"
    confidence = 0.35
    details: dict[str, Any] = {
        "signals": [],
        "slurm_nodes": slurm_nodes,
        "kubernetes_nodes": kube_nodes,
        "ssh_hosts": ssh_hosts,
    }

    if type_hint != "unknown":
        detected_type = type_hint
        confidence = 0.98
        details["signals"].append("RESEARCH_AGENT_CLUSTER_TYPE")
    elif has_kube_env or (kube_nodes or 0) > 0:
        detected_type = "kubernetes"
        confidence = 0.93 if has_kube_env else 0.82
        details["signals"].append("kubernetes")
    elif has_slurm_env or (slurm_nodes or 0) > 0:
        detected_type = "slurm"
        confidence = 0.9 if has_slurm_env else 0.8
        details["signals"].append("slurm")
    elif has_ray_env or has_ray_cli:
        detected_type = "ray"
        confidence = 0.85 if has_ray_env else 0.65
        details["signals"].append("ray")
    elif ssh_hosts >= 3:
        detected_type = "shared_head_node"
        confidence = 0.64
        details["signals"].append("ssh-host-fanout")
    elif gpu_count is not None and gpu_count > 0:
        detected_type = "local_gpu"
        confidence = 0.78 if gpu_count > 1 else 0.68
        details["signals"].append("nvidia-smi")

    if detected_type == "slurm":
        node_count = slurm_nodes
    elif detected_type == "kubernetes":
        node_count = kube_nodes
    elif detected_type == "shared_head_node":
        node_count = ssh_hosts if ssh_hosts > 0 else None
    elif detected_type == "local_gpu":
        node_count = 1
    else:
        node_count = None

    host = socket.gethostname() if detected_type in {"local_gpu", "shared_head_node"} else None
    status = "healthy" if detected_type != "unknown" else "unknown"

    return {
        "type": detected_type,
        "status": status,
        "source": "detected",
        "label": _cluster_type_label(detected_type),
        "description": _cluster_type_description(detected_type),
        "head_node": host,
        "node_count": node_count,
        "gpu_count": gpu_count,
        "notes": None,
        "confidence": round(confidence, 2),
        "details": details,
        "last_detected_at": now,
        "updated_at": now,
    }


def _current_run_summary() -> dict:
    _reconcile_all_run_terminal_states()
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


# =============================================================================
# Tmux Helpers
# =============================================================================

def get_tmux_server():
    """Get or create tmux server connection."""
    try:
        return libtmux.Server()
    except Exception as e:
        logger.error(f"Failed to connect to tmux server: {e}")
        return None


def get_or_create_session(session_name: Optional[str] = None):
    """Get or create the research-agent tmux session."""
    if session_name is None:
        session_name = TMUX_SESSION_NAME
    server = get_tmux_server()
    if not server:
        return None
    
    try:
        session = server.sessions.get(session_name=session_name, default=None)
        if not session:
            logger.info(f"Creating new tmux session: {session_name}")
            session = server.new_session(session_name=session_name)
        return session
    except Exception as e:
        logger.error(f"Error getting/creating tmux session: {e}")
        return None


def _normalize_gpuwrap_config(config: Any) -> Optional[dict]:
    """Validate and normalize per-run gpuwrap settings."""
    if config is None:
        return None

    try:
        validated = GpuwrapConfig.model_validate(config)
    except Exception:
        logger.warning("Ignoring invalid gpuwrap_config: %r", config)
        return None

    data = validated.model_dump(exclude_none=True)
    return data or None


def launch_run_in_tmux(run_id: str, run_data: dict) -> Optional[str]:
    """Launch a run in a new tmux window with sidecar."""
    session = get_or_create_session()
    if not session:
        raise Exception("Tmux session not available. Start tmux first.")
    
    # Create window name
    run_name = run_data.get("name", run_id)[:20].replace(" ", "-")
    tmux_window_name = f"ra-{run_id[:8]}"
    
    logger.info(f"Launching run {run_id} in window {tmux_window_name}")
    
    # Create window
    window = session.new_window(window_name=tmux_window_name, attach=False)
    pane = window.active_pane
    
    # Setup run directory
    run_dir = os.path.join(config.DATA_DIR, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    
    # Write command to file
    command_file = os.path.join(run_dir, "command.txt")
    with open(command_file, "w") as f:
        f.write(run_data["command"])

    gpuwrap_config = _normalize_gpuwrap_config(run_data.get("gpuwrap_config"))
    if gpuwrap_config:
        run_data["gpuwrap_config"] = gpuwrap_config
        gpuwrap_config_file = os.path.join(run_dir, "gpuwrap_config.json")
        with open(gpuwrap_config_file, "w") as f:
            json.dump(gpuwrap_config, f)
    else:
        run_data["gpuwrap_config"] = None
        gpuwrap_config_file = None
    
    # Get sidecar path
    server_dir = os.path.dirname(os.path.abspath(__file__))
    sidecar_path = os.path.join(server_dir, "job_sidecar.py")
    
    # Build sidecar command
    server_url = SERVER_CALLBACK_URL
    run_workdir = run_data.get("workdir") or config.WORKDIR
    
    if getattr(sys, "frozen", False):
        sidecar_cmd = (
            f"{shlex.quote(sys.executable)} --run-sidecar "
            f"--job_id {shlex.quote(run_id)} "
            f"--server_url {shlex.quote(server_url)} "
            f"--command_file {shlex.quote(command_file)} "
            f"--agent_run_dir {shlex.quote(run_dir)} "
            f"--workdir {shlex.quote(run_workdir)}"
        )
    else:
        sidecar_cmd = (
            f'{shlex.quote(sys.executable)} "{sidecar_path}" '
            f'--job_id {shlex.quote(run_id)} '
            f'--server_url {shlex.quote(server_url)} '
            f'--command_file {shlex.quote(command_file)} '
            f'--agent_run_dir {shlex.quote(run_dir)} '
            f'--workdir {shlex.quote(run_workdir)}'
        )
    if USER_AUTH_TOKEN:
        sidecar_cmd += f" --auth_token {shlex.quote(USER_AUTH_TOKEN)}"
    if gpuwrap_config_file:
        sidecar_cmd += f" --gpuwrap_config_file {shlex.quote(gpuwrap_config_file)}"
    
    logger.info(f"Executing sidecar: {sidecar_cmd}")
    pane.send_keys(sidecar_cmd)
    
    # Update run data
    run_data["status"] = "launching"
    run_data["tmux_window"] = tmux_window_name
    run_data["run_dir"] = run_dir
    run_data["launched_at"] = time.time()
    
    return tmux_window_name


# =============================================================================
# OpenCode Integration
# =============================================================================

async def get_opencode_session_for_chat(chat_session_id: str) -> str:
    """Get or create an OpenCode session for a specific chat session."""
    if chat_session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Chat session not found")
    
    session = chat_sessions[chat_session_id]
    if session.get("opencode_session_id"):
        return session["opencode_session_id"]
    
    async with httpx.AsyncClient() as client:
        await apply_runtime_research_agent_key(client)
        # Bind new OpenCode sessions to this server's workdir to avoid stale project reuse.
        resp = await client.post(
            f"{OPENCODE_URL}/session",
            params={"directory": os.path.abspath(config.WORKDIR)},
            json={},
            auth=get_auth(),
        )
        resp.raise_for_status()
        opencode_id = resp.json().get("id")
        session["opencode_session_id"] = opencode_id
        save_chat_state()
        logger.info(f"Created new OpenCode session {opencode_id} for chat {chat_session_id}")
        return opencode_id


async def fetch_opencode_session_title(opencode_session_id: str) -> Optional[str]:
    """Fetch the auto-generated title from an OpenCode session."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            resp = await client.get(
                f"{OPENCODE_URL}/session/{opencode_session_id}",
                auth=get_auth(),
            )
            resp.raise_for_status()
            data = resp.json()
            title = data.get("title")
            if title and isinstance(title, str) and title.strip():
                return title.strip()
    except Exception as e:
        logger.warning("Failed to fetch OpenCode session title for %s: %s", opencode_session_id, e)
    return None


async def send_prompt_to_opencode(
    client: httpx.AsyncClient,
    session_id: str,
    content: str,
    model_provider: str,
    model_id: str,
):
    """Send a prompt to an OpenCode session using an explicit model."""
    await apply_runtime_research_agent_key(client)
    prompt_payload = {
        "model": {"providerID": model_provider, "modelID": model_id},
        "parts": [{"type": "text", "text": content}]
    }
    resp = await client.post(
        f"{OPENCODE_URL}/session/{session_id}/prompt_async",
        json=prompt_payload,
        auth=get_auth()
    )
    resp.raise_for_status()


def should_stop_session(session_id: str) -> bool:
    """Check if a session is flagged to stop streaming."""
    return session_stop_flags.get(session_id, False)


def _extract_tool_name(part: dict) -> Optional[str]:
    """Best-effort extraction for tool part names across OpenCode versions."""
    state = part.get("state") if isinstance(part, dict) else {}
    if not isinstance(state, dict):
        state = {}
    state_input = state.get("input")
    if not isinstance(state_input, dict):
        state_input = {}

    for candidate in (
        part.get("name"),
        part.get("tool"),
        state.get("title"),
        state_input.get("description"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _coerce_tool_text(value: Any) -> Optional[str]:
    """Convert tool input/output payloads to readable text."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


def _extract_tool_data(part: dict) -> dict[str, Any]:
    """Extract normalized tool fields used for streaming and persistence."""
    state = part.get("state")
    if not isinstance(state, dict):
        state = {}

    state_input = state.get("input")
    if not isinstance(state_input, dict):
        state_input = {}

    metadata = state.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    time_data = state.get("time")
    if not isinstance(time_data, dict):
        time_data = {}

    status = state.get("status")
    if not isinstance(status, str):
        status = None

    tool_input = _coerce_tool_text(state_input) if state_input else None
    output_value = state.get("output")
    if output_value is None:
        output_value = metadata.get("output")
    tool_output = _coerce_tool_text(output_value)

    started_at = time_data.get("start") if isinstance(time_data.get("start"), (int, float)) else None
    ended_at = time_data.get("end") if isinstance(time_data.get("end"), (int, float)) else None
    duration_ms = None
    if isinstance(started_at, (int, float)) and isinstance(ended_at, (int, float)) and ended_at >= started_at:
        duration_ms = int(ended_at - started_at)

    return {
        "tool_status": status,
        "tool_input": tool_input,
        "tool_output": tool_output,
        "tool_started_at": started_at,
        "tool_ended_at": ended_at,
        "tool_duration_ms": duration_ms,
    }


class StreamPartsAccumulator:
    """
    Collect ordered message parts while preserving type transitions.

    Text/reasoning are buffered and flushed whenever we switch type/part ID or
    encounter a tool event. Tool parts are keyed by ID so state updates amend
    the original tool part.
    """

    def __init__(self):
        self._parts: list[dict[str, Any]] = []
        self._text_buffer: Optional[dict[str, Any]] = None
        self._tool_index_by_id: dict[str, int] = {}
        self._text_segment_counts: dict[str, int] = {}

    def consume(self, event: dict):
        ptype = event.get("ptype")
        if ptype in ("text", "reasoning"):
            self._consume_text_or_reasoning(event)
            return
        if ptype == "tool":
            self._flush_text_buffer()
            self._consume_tool_update(event)
            return
        if event.get("type") == "session_status":
            self._flush_text_buffer()

    def snapshot(self) -> list[dict[str, Any]]:
        parts = list(self._parts)
        if self._text_buffer and self._text_buffer.get("content"):
            parts.append({k: v for k, v in self._text_buffer.items() if k != "source_id"})
        return parts

    def finalize(self) -> list[dict[str, Any]]:
        self._flush_text_buffer()
        return list(self._parts)

    def _consume_text_or_reasoning(self, event: dict):
        delta = event.get("delta")
        if not isinstance(delta, str) or delta == "":
            return

        part_id = event.get("id")
        part_type = "thinking" if event.get("ptype") == "reasoning" else "text"
        if self._text_buffer and self._text_buffer.get("source_id") == part_id and self._text_buffer.get("type") == part_type:
            self._text_buffer["content"] += delta
            return

        self._flush_text_buffer()
        base_id = part_id if isinstance(part_id, str) and part_id else f"part_{uuid.uuid4().hex[:12]}"
        segment_index = self._text_segment_counts.get(base_id, 0)
        self._text_segment_counts[base_id] = segment_index + 1
        stored_id = base_id if segment_index == 0 else f"{base_id}#{segment_index}"
        self._text_buffer = {
            "id": stored_id,
            "source_id": base_id,
            "type": part_type,
            "content": delta,
        }

    def _consume_tool_update(self, event: dict):
        part_id = event.get("id")
        if not isinstance(part_id, str) or not part_id:
            return

        existing_index = self._tool_index_by_id.get(part_id)
        tool_name = event.get("name")
        if existing_index is None:
            self._parts.append(
                {
                    "id": part_id,
                    "type": "tool",
                    "content": "",
                    "tool_name": tool_name,
                    "tool_state": event.get("tool_status"),
                    "tool_state_raw": event.get("state"),
                    "tool_input": event.get("tool_input"),
                    "tool_output": event.get("tool_output"),
                    "tool_started_at": event.get("tool_started_at"),
                    "tool_ended_at": event.get("tool_ended_at"),
                    "tool_duration_ms": event.get("tool_duration_ms"),
                }
            )
            self._tool_index_by_id[part_id] = len(self._parts) - 1
            return

        existing_part = self._parts[existing_index]
        existing_part["tool_state"] = event.get("tool_status")
        existing_part["tool_state_raw"] = event.get("state")
        existing_part["tool_input"] = event.get("tool_input")
        existing_part["tool_output"] = event.get("tool_output")
        existing_part["tool_started_at"] = event.get("tool_started_at")
        existing_part["tool_ended_at"] = event.get("tool_ended_at")
        existing_part["tool_duration_ms"] = event.get("tool_duration_ms")
        if tool_name:
            existing_part["tool_name"] = tool_name

    def _flush_text_buffer(self):
        if not self._text_buffer:
            return
        if self._text_buffer.get("content"):
            flushed_part = {k: v for k, v in self._text_buffer.items() if k != "source_id"}
            self._parts.append(flushed_part)
        self._text_buffer = None


class ChatStreamRuntime:
    """In-memory runtime state for a single in-flight assistant response."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.run_id = uuid.uuid4().hex[:12]
        self.status = "running"
        self.error: Optional[str] = None
        self.started_at = time.time()
        self.updated_at = self.started_at
        self.full_text = ""
        self.full_thinking = ""
        self.parts_accumulator = StreamPartsAccumulator()
        self.events: list[dict[str, Any]] = []
        self.next_sequence = 1
        self.last_persist_at = 0.0
        self.last_persist_sequence = 0
        self.subscribers: set[asyncio.Queue] = set()
        self.lock = asyncio.Lock()
        self.cleanup_task: Optional[asyncio.Task] = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "sequence": max(0, self.next_sequence - 1),
            "text": self.full_text,
            "thinking": self.full_thinking,
            "parts": self.parts_accumulator.snapshot(),
            "error": self.error,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


def _public_stream_event(event: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in event.items() if not str(k).startswith("_")}


def _persist_active_stream_snapshot(
    session_id: str,
    runtime: ChatStreamRuntime,
    *,
    force: bool = False,
) -> None:
    session = chat_sessions.get(session_id)
    if not isinstance(session, dict):
        return

    now = time.time()
    current_sequence = max(0, runtime.next_sequence - 1)
    if not force:
        if current_sequence == runtime.last_persist_sequence:
            return
        if (
            current_sequence - runtime.last_persist_sequence < STREAM_SNAPSHOT_SAVE_INTERVAL_EVENTS
            and now - runtime.last_persist_at < STREAM_SNAPSHOT_SAVE_INTERVAL_SECONDS
        ):
            return

    session["active_stream"] = runtime.snapshot()
    save_chat_state()
    runtime.last_persist_at = now
    runtime.last_persist_sequence = current_sequence


async def _append_runtime_event(runtime: ChatStreamRuntime, event: dict[str, Any]) -> dict[str, Any]:
    public_event = _public_stream_event(event)
    runtime.parts_accumulator.consume(public_event)

    if public_event.get("type") == "part_delta":
        delta = public_event.get("delta")
        if isinstance(delta, str):
            if public_event.get("ptype") == "text":
                runtime.full_text += delta
            elif public_event.get("ptype") == "reasoning":
                runtime.full_thinking += delta
    elif public_event.get("type") == "error":
        runtime.error = public_event.get("message") or "Unknown chat stream error"
        runtime.status = "failed"
    elif public_event.get("type") == "session_status" and public_event.get("status") == "idle":
        if runtime.status == "running":
            runtime.status = "completed"

    runtime.updated_at = time.time()
    async with runtime.lock:
        seq_event = {"seq": runtime.next_sequence, **public_event}
        runtime.next_sequence += 1
        runtime.events.append(seq_event)
        subscribers = list(runtime.subscribers)

    for queue in subscribers:
        try:
            queue.put_nowait(seq_event)
        except asyncio.QueueFull:
            logger.warning("Dropping chat stream event for session %s due to full subscriber queue", runtime.session_id)

    return seq_event


async def _close_runtime_subscribers(runtime: ChatStreamRuntime) -> None:
    async with runtime.lock:
        subscribers = list(runtime.subscribers)
        runtime.subscribers.clear()

    for queue in subscribers:
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


async def _expire_runtime_after(session_id: str, runtime: ChatStreamRuntime, delay_seconds: float) -> None:
    try:
        await asyncio.sleep(delay_seconds)
    except asyncio.CancelledError:
        return

    if active_chat_streams.get(session_id) is runtime:
        active_chat_streams.pop(session_id, None)


async def _finalize_runtime(session_id: str, runtime: ChatStreamRuntime, *, retain: bool = True) -> None:
    await _close_runtime_subscribers(runtime)
    if runtime.cleanup_task and not runtime.cleanup_task.done():
        runtime.cleanup_task.cancel()
        runtime.cleanup_task = None

    if not retain:
        if active_chat_streams.get(session_id) is runtime:
            active_chat_streams.pop(session_id, None)
        return

    runtime.cleanup_task = asyncio.create_task(
        _expire_runtime_after(session_id, runtime, STREAM_RUNTIME_RETENTION_SECONDS)
    )


async def _stream_runtime_events(
    session_id: str,
    *,
    from_seq: int = 1,
    run_id: Optional[str] = None,
) -> AsyncIterator[str]:
    runtime = active_chat_streams.get(session_id)
    if runtime is None:
        yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
        return

    if run_id and runtime.run_id != run_id:
        yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
        return

    from_seq = max(1, from_seq)
    queue: asyncio.Queue = asyncio.Queue()
    subscribed = False

    async with runtime.lock:
        backlog = [event for event in runtime.events if int(event.get("seq", 0)) >= from_seq]
        done = runtime.status != "running"
        if not done:
            runtime.subscribers.add(queue)
            subscribed = True

    try:
        for event in backlog:
            yield json.dumps(event) + "\n"
            if event.get("type") == "session_status" and event.get("status") == "idle":
                return

        if done:
            return

        while True:
            item = await queue.get()
            if item is None:
                break
            if int(item.get("seq", 0)) < from_seq:
                continue
            yield json.dumps(item) + "\n"
            if item.get("type") == "session_status" and item.get("status") == "idle":
                break
    finally:
        if subscribed:
            async with runtime.lock:
                runtime.subscribers.discard(queue)


async def run_opencode_session(chat_session_id: str, opencode_session_id: str, content: str) -> tuple[str, str, list]:
    """Run a prompt and return full text, thinking, and ordered parts."""
    session = chat_sessions.get(chat_session_id)
    session_model_provider = MODEL_PROVIDER
    session_model_id = MODEL_ID
    if isinstance(session, dict):
        session_model_provider, session_model_id = get_session_model(session)

    full_text = ""
    full_thinking = ""
    parts_accumulator = StreamPartsAccumulator()
    async with httpx.AsyncClient(timeout=None) as client:
        await send_prompt_to_opencode(
            client,
            opencode_session_id,
            content,
            session_model_provider,
            session_model_id,
        )
        async for event, text_delta, thinking_delta, _tool_update in stream_opencode_events(client, opencode_session_id):
            if should_stop_session(chat_session_id):
                break
            full_text += text_delta
            full_thinking += thinking_delta
            parts_accumulator.consume(event)

    return full_text, full_thinking, parts_accumulator.finalize()


def parse_opencode_event(event_data: dict, target_session_id: str) -> Optional[dict]:
    """Parse an OpenCode SSE event and translate it to our protocol."""
    payload = event_data.get("payload", {})
    if not isinstance(payload, dict):
        return None

    etype = payload.get("type", "")
    props = payload.get("properties", {})
    if not isinstance(props, dict):
        return None
    part = props.get("part", {})
    if not isinstance(part, dict):
        part = {}
    
    session_props = props.get("session")
    if not isinstance(session_props, dict):
        session_props = {}

    event_sid = props.get("sessionID") or part.get("sessionID") or session_props.get("id")
    if event_sid != target_session_id:
        return None
    
    if etype == "message.part.delta":
        delta = props.get("delta")
        if not isinstance(delta, str) or delta == "":
            return None
        field = props.get("field", "")
        part_id = props.get("partID")
        if field in ("text", "reasoning"):
            return {"type": "part_delta", "id": part_id, "ptype": field, "delta": delta}

    elif etype == "message.part.updated":
        ptype = part.get("type")
        part_id = part.get("id")

        if ptype == "text":
            delta = props.get("delta")
            if not isinstance(delta, str) or delta == "":
                return None
            return {"type": "part_delta", "id": part_id, "ptype": "text", "delta": delta}
        elif ptype == "reasoning":
            delta = props.get("delta")
            if not isinstance(delta, str) or delta == "":
                return None
            return {"type": "part_delta", "id": part_id, "ptype": "reasoning", "delta": delta}
        elif ptype == "tool":
            tool_data = _extract_tool_data(part)
            return {
                "type": "part_update",
                "id": part_id,
                "ptype": "tool",
                "state": part.get("state"),
                "name": _extract_tool_name(part),
                **tool_data,
            }

    elif etype == "session.status":
        if props.get("status", {}).get("type") == "idle":
            return {"type": "session_status", "status": "idle", "_done": True}
    
    return None


async def stream_opencode_events(
    client: httpx.AsyncClient, session_id: str
) -> AsyncIterator[tuple[dict, str, str, Optional[dict]]]:
    """Stream parsed OpenCode events with text/thinking deltas and tool updates."""
    url = f"{OPENCODE_URL}/global/event"
    headers = {"Accept": "text/event-stream"}
    
    async with client.stream("GET", url, headers=headers, auth=get_auth()) as response:
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            
            try:
                event_data = json.loads(line[6:])
                
                # Check for error responses from OpenCode
                if "error" in event_data:
                    error_msg = event_data.get("error", "Unknown OpenCode error")
                    logger.error(f"OpenCode returned error: {error_msg}")
                    raise RuntimeError(f"OpenCode error: {error_msg}")
                
                translated = parse_opencode_event(event_data, session_id)
                if translated is None:
                    continue
                
                text_delta = ""
                thinking_delta = ""
                tool_update = None
                ptype = translated.get("ptype")
                if ptype == "text":
                    text_delta = translated.get("delta", "")
                elif ptype == "reasoning":
                    thinking_delta = translated.get("delta", "")
                elif ptype == "tool":
                    tool_update = translated
                
                yield translated, text_delta, thinking_delta, tool_update
                
                if translated.get("_done"):
                    break
            except RuntimeError:
                # Re-raise OpenCode errors
                raise
            except Exception as e:
                logger.error(f"Error parsing event line: {e}")
                continue


# =============================================================================
# Chat Endpoints
# =============================================================================

@app.get("/")
async def health():
    """Health check endpoint, or frontend index if static bundle is configured."""
    if FRONTEND_STATIC_DIR:
        index_file = os.path.join(FRONTEND_STATIC_DIR, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file)
    return {"status": "ok", "service": "research-agent-server", "workdir": config.WORKDIR}


@app.get("/health")
async def health_json():
    """JSON health endpoint."""
    return {"status": "ok", "service": "research-agent-server", "workdir": config.WORKDIR}


def _extract_actions_from_text(raw_text: str, max_actions: int) -> list[str]:
    text = str(raw_text or "").strip()
    if not text:
        return []

    def _normalize(actions: list[Any]) -> list[str]:
        cleaned: list[str] = []
        for item in actions:
            if isinstance(item, str):
                value = item.strip()
                if value:
                    cleaned.append(value)
            if len(cleaned) >= max_actions:
                break
        return cleaned

    # 1) Best case: full JSON object.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            actions = parsed.get("next_best_actions")
            if isinstance(actions, list):
                normalized = _normalize(actions)
                if normalized:
                    return normalized
    except Exception:
        pass

    # 2) Extract JSON object embedded in prose.
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                actions = parsed.get("next_best_actions")
                if isinstance(actions, list):
                    normalized = _normalize(actions)
                    if normalized:
                        return normalized
        except Exception:
            pass

    # 3) Fallback: bullets / numbered lines.
    fallback: list[str] = []
    for line in text.splitlines():
        candidate = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        if candidate:
            fallback.append(candidate)
        if len(fallback) >= max_actions:
            break
    return fallback


@app.post("/journey/next-actions")
async def journey_next_actions(req: JourneyNextActionsRequest):
    """Generate next-best research directions from journey context using OpenCode."""
    journey = req.journey if isinstance(req.journey, dict) else {}
    max_actions = int(req.max_actions or 3)

    title = str(journey.get("title") or "User Research Journey").strip()
    summary = journey.get("summary") if isinstance(journey.get("summary"), dict) else {}
    reflections = journey.get("reflections") if isinstance(journey.get("reflections"), dict) else {}
    events = journey.get("events") if isinstance(journey.get("events"), list) else []
    steps = journey.get("steps") if isinstance(journey.get("steps"), list) else []

    compact_events: list[dict[str, Any]] = []
    for event in events[-20:]:
        if not isinstance(event, dict):
            continue
        compact_events.append({
            "time": event.get("time"),
            "actor": event.get("actor"),
            "event": event.get("event"),
            "note": event.get("note"),
        })

    compact_steps: list[dict[str, Any]] = []
    for step in steps[-20:]:
        if not isinstance(step, dict):
            continue
        compact_steps.append({
            "type": step.get("type"),
            "status": step.get("status"),
            "title": step.get("title"),
            "effort_minutes": step.get("effort_minutes"),
            "confidence": step.get("confidence"),
        })

    prompt_payload = {
        "title": title,
        "summary": summary,
        "reflections": reflections,
        "recent_steps": compact_steps,
        "recent_events": compact_events,
        "constraints": {
            "max_actions": max_actions,
            "audience": "researcher",
            "style": "concrete, actionable, non-generic",
        },
    }

    prompt = (
        "You are a senior research planning assistant. "
        "Given a research journey, propose the next best actions.\n\n"
        "Return strict JSON only with this schema:\n"
        "{\n"
        '  "next_best_actions": ["action 1", "action 2", "action 3"],\n'
        '  "reasoning": "brief 1-2 sentence rationale"\n'
        "}\n\n"
        f"The list must have at most {max_actions} items.\n"
        "Each action must be specific and testable.\n"
        "Avoid generic advice.\n\n"
        f"Journey context:\n{json.dumps(prompt_payload, ensure_ascii=False)}"
    )

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=60.0)) as client:
            await apply_runtime_research_agent_key(client)
            session_resp = await client.post(
                f"{OPENCODE_URL}/session",
                params={"directory": os.path.abspath(config.WORKDIR)},
                json={},
                auth=get_auth(),
            )
            session_resp.raise_for_status()
            opencode_session_id = session_resp.json().get("id")
            if not opencode_session_id:
                raise RuntimeError("OpenCode session creation returned no id")

            await send_prompt_to_opencode(client, opencode_session_id, prompt, MODEL_PROVIDER, MODEL_ID)

            chunks: list[str] = []
            async for event, text_delta, _thinking_delta, _tool_update in stream_opencode_events(client, opencode_session_id):
                if event.get("type") == "part_delta" and event.get("ptype") == "text" and text_delta:
                    chunks.append(text_delta)
                if event.get("type") == "session_status" and event.get("status") == "idle":
                    break

            raw_text = "".join(chunks).strip()
            actions = _extract_actions_from_text(raw_text, max_actions)
            if not actions:
                raise RuntimeError("Model output did not contain usable next actions")

            reasoning = ""
            try:
                parsed = json.loads(raw_text)
                if isinstance(parsed, dict) and isinstance(parsed.get("reasoning"), str):
                    reasoning = parsed.get("reasoning", "").strip()
            except Exception:
                pass

            return {
                "next_best_actions": actions,
                "reasoning": reasoning,
                "source": "llm",
            }
    except Exception as e:
        logger.warning("journey_next_actions failed: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to generate next actions: {e}")


def _journey_record_matches(item: dict, session_id: Optional[str], run_id: Optional[str]) -> bool:
    if session_id and item.get("session_id") != session_id:
        return False
    if run_id and item.get("run_id") != run_id:
        return False
    return True


def _journey_summary(filtered_events: List[dict], filtered_recommendations: List[dict], filtered_decisions: List[dict]) -> dict:
    rec_total = len(filtered_recommendations)
    accepted = sum(1 for r in filtered_recommendations if r.get("status") == "accepted")
    executed = sum(1 for r in filtered_recommendations if r.get("status") == "executed")
    rejected = sum(1 for r in filtered_recommendations if r.get("status") == "rejected")
    return {
        "events": len(filtered_events),
        "recommendations": rec_total,
        "decisions": len(filtered_decisions),
        "accepted_recommendations": accepted,
        "executed_recommendations": executed,
        "rejected_recommendations": rejected,
        "acceptance_rate": (accepted / rec_total) if rec_total > 0 else 0.0,
    }


@app.get("/journey/loop")
async def get_journey_loop(
    session_id: Optional[str] = Query(None, description="Filter by chat session id"),
    run_id: Optional[str] = Query(None, description="Filter by run id"),
    limit: int = Query(300, ge=1, le=2000, description="Max records per list"),
):
    """Return structured journey loop data for growth tracking."""
    filtered_events = [
        event for event in journey_events.values()
        if _journey_record_matches(event, session_id, run_id)
    ]
    filtered_recommendations = [
        rec for rec in journey_recommendations.values()
        if _journey_record_matches(rec, session_id, run_id)
    ]
    filtered_decisions = [
        decision for decision in journey_decisions.values()
        if _journey_record_matches(decision, session_id, run_id)
    ]

    filtered_events.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    filtered_recommendations.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    filtered_decisions.sort(key=lambda x: x.get("created_at", 0), reverse=True)

    return {
        "events": filtered_events[:limit],
        "recommendations": filtered_recommendations[:limit],
        "decisions": filtered_decisions[:limit],
        "summary": _journey_summary(filtered_events, filtered_recommendations, filtered_decisions),
    }


@app.post("/journey/events")
async def create_journey_event(req: JourneyEventCreate):
    """Append a structured journey event."""
    return _record_journey_event(
        kind=req.kind,
        actor=req.actor,
        session_id=req.session_id,
        run_id=req.run_id,
        chart_id=req.chart_id,
        recommendation_id=req.recommendation_id,
        decision_id=req.decision_id,
        note=req.note,
        metadata=req.metadata,
        timestamp=req.timestamp,
    )


@app.get("/journey/recommendations")
async def list_journey_recommendations(
    session_id: Optional[str] = Query(None, description="Filter by chat session id"),
    run_id: Optional[str] = Query(None, description="Filter by run id"),
    limit: int = Query(200, ge=1, le=2000),
):
    rows = [
        row for row in journey_recommendations.values()
        if _journey_record_matches(row, session_id, run_id)
    ]
    rows.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return rows[:limit]


@app.post("/journey/recommendations")
async def create_journey_recommendation(req: JourneyRecommendationCreate):
    """Create a recommendation record for user/agent planning loop."""
    priority = req.priority if req.priority in JOURNEY_PRIORITY_VALUES else "medium"
    rec_id = _journey_new_id("jrec")
    created_at = time.time()
    payload = {
        "id": rec_id,
        "title": req.title.strip(),
        "action": req.action.strip(),
        "rationale": (req.rationale or "").strip() or None,
        "source": (req.source or "agent").strip() or "agent",
        "priority": priority,
        "confidence": req.confidence,
        "status": "pending",
        "session_id": req.session_id,
        "run_id": req.run_id,
        "chart_id": req.chart_id,
        "evidence_refs": [str(x) for x in req.evidence_refs[:20]],
        "created_at": created_at,
        "updated_at": created_at,
        "responded_at": None,
        "user_note": None,
        "modified_action": None,
    }
    journey_recommendations[rec_id] = payload
    save_journey_state()
    _record_journey_event(
        kind="agent_recommendation_issued",
        actor="agent",
        session_id=req.session_id,
        run_id=req.run_id,
        chart_id=req.chart_id,
        recommendation_id=rec_id,
        note=req.title,
        metadata={"priority": priority, "source": payload["source"]},
    )
    return payload


@app.post("/journey/recommendations/{recommendation_id}/respond")
async def respond_journey_recommendation(recommendation_id: str, req: JourneyRecommendationRespondRequest):
    """Update recommendation lifecycle status with user decision."""
    recommendation = journey_recommendations.get(recommendation_id)
    if recommendation is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")

    next_status = (req.status or "").strip().lower()
    if next_status not in JOURNEY_REC_STATUS_VALUES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {req.status}")

    recommendation["status"] = next_status
    recommendation["responded_at"] = time.time()
    recommendation["updated_at"] = recommendation["responded_at"]
    recommendation["user_note"] = (req.user_note or "").strip() or None
    recommendation["modified_action"] = (req.modified_action or "").strip() or None
    save_journey_state()

    event_kind = {
        "accepted": "user_accepted_recommendation",
        "rejected": "user_rejected_recommendation",
        "modified": "user_modified_recommendation",
        "executed": "recommendation_executed",
        "dismissed": "recommendation_dismissed",
    }.get(next_status, "recommendation_updated")

    _record_journey_event(
        kind=event_kind,
        actor="human",
        session_id=recommendation.get("session_id"),
        run_id=recommendation.get("run_id"),
        chart_id=recommendation.get("chart_id"),
        recommendation_id=recommendation_id,
        note=recommendation.get("title"),
        metadata={"status": next_status},
    )
    return recommendation


@app.post("/journey/recommendations/generate")
async def generate_journey_recommendations(req: JourneyNextActionsRequest):
    """Generate next actions with LLM, then persist them as recommendation records."""
    generated = await journey_next_actions(req)
    actions = generated.get("next_best_actions", []) if isinstance(generated, dict) else []
    reasoning = generated.get("reasoning", "") if isinstance(generated, dict) else ""
    source = generated.get("source", "llm") if isinstance(generated, dict) else "llm"

    if not isinstance(actions, list):
        actions = []

    session_id = None
    run_id = None
    if isinstance(req.journey, dict):
        session_id = req.journey.get("session_id") if isinstance(req.journey.get("session_id"), str) else None
        run_id = req.journey.get("run_id") if isinstance(req.journey.get("run_id"), str) else None

    created: list[dict] = []
    for action in actions[: req.max_actions]:
        text = str(action).strip()
        if not text:
            continue
        recommendation = await create_journey_recommendation(
            JourneyRecommendationCreate(
                title=text[:120],
                action=text,
                rationale=reasoning or None,
                source=str(source or "llm"),
                priority="medium",
                session_id=session_id,
                run_id=run_id,
                evidence_refs=[],
            )
        )
        created.append(recommendation)

    return {
        "created": created,
        "reasoning": reasoning,
        "source": source,
    }


@app.get("/journey/decisions")
async def list_journey_decisions(
    session_id: Optional[str] = Query(None, description="Filter by chat session id"),
    run_id: Optional[str] = Query(None, description="Filter by run id"),
    limit: int = Query(200, ge=1, le=2000),
):
    rows = [
        row for row in journey_decisions.values()
        if _journey_record_matches(row, session_id, run_id)
    ]
    rows.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return rows[:limit]


@app.post("/journey/decisions")
async def create_journey_decision(req: JourneyDecisionCreate):
    """Record a decision and optionally link it to a recommendation."""
    status = req.status if req.status in JOURNEY_DECISION_STATUS_VALUES else "recorded"
    decision_id = _journey_new_id("jdec")
    created_at = time.time()
    payload = {
        "id": decision_id,
        "title": req.title.strip(),
        "chosen_action": req.chosen_action.strip(),
        "rationale": (req.rationale or "").strip() or None,
        "outcome": (req.outcome or "").strip() or None,
        "status": status,
        "recommendation_id": req.recommendation_id,
        "session_id": req.session_id,
        "run_id": req.run_id,
        "chart_id": req.chart_id,
        "created_at": created_at,
        "updated_at": created_at,
    }
    journey_decisions[decision_id] = payload
    save_journey_state()
    _record_journey_event(
        kind="decision_recorded",
        actor="human",
        session_id=req.session_id,
        run_id=req.run_id,
        chart_id=req.chart_id,
        recommendation_id=req.recommendation_id,
        decision_id=decision_id,
        note=req.title,
        metadata={"status": status},
    )
    return payload


# =============================================================================
# Git Diff / File Browser Endpoints  (extracted to git_routes.py)
# =============================================================================

import git_routes  # noqa: E402
app.include_router(git_routes.router)




@app.get("/sessions")
async def list_sessions():
    """List all chat sessions."""
    def resolve_session_status(session_id: str, session: dict[str, Any]) -> str:
        has_pending_human_input = any(
            alert.get("status") == "pending" and alert.get("session_id") == session_id
            for alert in active_alerts.values()
        )
        if has_pending_human_input:
            return "awaiting_human"

        runtime = active_chat_streams.get(session_id)
        if runtime and runtime.status == "running":
            return "running"

        raw_status = (runtime.status if runtime else None) or session.get("last_status")
        if raw_status in {"failed", "error"}:
            return "failed"
        if raw_status in {"stopped", "interrupted"}:
            return "questionable"
        if session.get("messages"):
            return "completed"
        return "idle"

    sessions = []
    for sid, session in chat_sessions.items():
        if not isinstance(session, dict):
            continue
        session_model_provider, session_model_id = get_session_model(session)
        sessions.append({
            "id": sid,
            "title": session.get("title", "New Chat"),
            "created_at": session.get("created_at"),
            "message_count": len(session.get("messages", [])),
            "model_provider": session_model_provider,
            "model_id": session_model_id,
            "status": resolve_session_status(sid, session),
        })
    sessions.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return sessions


@app.get("/models")
async def list_models():
    """List available model options from opencode config."""
    return load_available_opencode_models()


@app.post("/sessions")
async def create_session(req: Optional[CreateSessionRequest] = None):
    """Create a new chat session."""
    requested_provider = req.model_provider if req else None
    requested_model_id = req.model_id if req else None
    session_model_provider = str(requested_provider or MODEL_PROVIDER).strip() or MODEL_PROVIDER
    session_model_id = str(requested_model_id or MODEL_ID).strip() or MODEL_ID
    session_id = uuid.uuid4().hex[:12]
    title = req.title if req and req.title else "New Chat"
    chat_sessions[session_id] = {
        "title": title,
        "created_at": time.time(),
        "messages": [],
        "opencode_session_id": None,
        "system_prompt": "",
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "last_status": "idle",
    }
    save_chat_state()
    return {
        "id": session_id,
        "title": title,
        "created_at": chat_sessions[session_id]["created_at"],
        "message_count": 0,
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "status": "idle",
    }


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a chat session with all messages."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    session_model_provider, session_model_id = get_session_model(session)
    runtime = active_chat_streams.get(session_id)
    active_stream = runtime.snapshot() if runtime and runtime.status == "running" else session.get("active_stream")
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", []),
        "system_prompt": session.get("system_prompt", ""),
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "active_stream": active_stream,
    }


@app.patch("/sessions/{session_id}")
async def update_session(session_id: str, req: UpdateSessionRequest):
    """Update a chat session (e.g. rename)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    chat_sessions[session_id]["title"] = req.title
    save_chat_state()
    session = chat_sessions[session_id]
    session_model_provider, session_model_id = get_session_model(session)
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "message_count": len(session.get("messages", [])),
        "model_provider": session_model_provider,
        "model_id": session_model_id,
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del chat_sessions[session_id]
    save_chat_state()
    return {"message": "Session deleted"}


@app.get("/sessions/{session_id}/system-prompt")
async def get_system_prompt(session_id: str):
    """Get the system prompt for a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"system_prompt": chat_sessions[session_id].get("system_prompt", "")}


@app.get("/sessions/{session_id}/model")
async def get_session_model_endpoint(session_id: str):
    """Get the provider/model configured for this session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    if not isinstance(session, dict):
        raise HTTPException(status_code=500, detail="Session data is invalid")
    provider_id, model_id = get_session_model(session)
    return {"provider_id": provider_id, "model_id": model_id}


@app.put("/sessions/{session_id}/model")
async def update_session_model(session_id: str, req: SessionModelUpdate):
    """Update provider/model for subsequent prompts in a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    provider_id = str(req.provider_id or "").strip()
    model_id = str(req.model_id or "").strip()
    if not provider_id or not model_id:
        raise HTTPException(status_code=400, detail="provider_id and model_id are required")

    session = chat_sessions[session_id]
    if not isinstance(session, dict):
        raise HTTPException(status_code=500, detail="Session data is invalid")
    session["model_provider"] = provider_id
    session["model_id"] = model_id
    save_chat_state()
    return {"provider_id": provider_id, "model_id": model_id}


@app.put("/sessions/{session_id}/system-prompt")
async def update_system_prompt(session_id: str, req: SystemPromptUpdate):
    """Update the system prompt for a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    chat_sessions[session_id]["system_prompt"] = req.system_prompt
    save_chat_state()
    return {"system_prompt": req.system_prompt}


# ---------------------------------------------------------------------------
# Mode Registry: data-driven prompt builder
# ---------------------------------------------------------------------------

@dataclass
class ModeConfig:
    """Declares how to build a mode-specific prompt preamble."""
    skill_id: str
    build_state: Callable[[str], dict]  # (message) -> template variables


def _build_agent_state(_message: str) -> dict:
    """Build template variables for agent (default chat) mode."""
    return {
        "experiment_context": _build_experiment_context(),
        "server_url": SERVER_CALLBACK_URL,
        "auth_token": USER_AUTH_TOKEN or "",
    }


def _build_plan_state(message: str) -> dict:
    """Build template variables for plan mode."""
    # Summarize existing plans for context
    existing_plans_summary = "No existing plans."
    if plans:
        lines = []
        for p in sorted(plans.values(), key=lambda x: x.get("created_at", 0), reverse=True)[:5]:
            lines.append(f"- **{p.get('title', 'Untitled')}** ({p.get('status', 'draft')}): {p.get('goal', '')[:100]}")
        existing_plans_summary = "\n".join(lines)
    return {
        "goal": message,
        "experiment_context": _build_experiment_context(),
        "existing_plans": existing_plans_summary,
        "server_url": SERVER_CALLBACK_URL,
        "auth_token": USER_AUTH_TOKEN or "",
    }



MODE_REGISTRY: Dict[str, ModeConfig] = {
    "agent": ModeConfig(skill_id="ra_mode_agent", build_state=_build_agent_state),
    "plan": ModeConfig(skill_id="ra_mode_plan", build_state=_build_plan_state),
}


def _build_chat_prompt(session: dict, message: str, mode: str = "agent", session_id: Optional[str] = None) -> tuple:
    """Build the full prompt for a chat turn, prepending mode-specific preamble.

    Returns (content: str, provenance: dict | None).
    provenance follows the PromptProvenance shape used by the frontend.
    """
    mode_note = ""
    provenance = None

    config = MODE_REGISTRY.get(mode)
    if config:
        variables = config.build_state(message)
        skill = prompt_skill_manager.get(config.skill_id)
        rendered = prompt_skill_manager.render(config.skill_id, variables)
        if rendered:
            mode_note = rendered + "\n\n"
            provenance = {
                "rendered": rendered,
                "user_input": message,
                "skill_id": config.skill_id,
                "skill_name": skill.get("name", config.skill_id) if skill else config.skill_id,
                "template": skill.get("template") if skill else None,
                "variables": variables,
                "prompt_type": mode,
            }
        else:
            logger.warning(f"{config.skill_id} prompt skill not found — sending raw message")

    # For agent mode (no config / no skill), build a simple provenance
    if provenance is None and mode != "wild":
        provenance = {
            "rendered": message,
            "user_input": message,
            "skill_id": None,
            "skill_name": None,
            "template": None,
            "variables": {},
            "prompt_type": mode,
        }

    chat_linking_note = ""
    if session_id:
        chat_linking_note = (
            "[CHAT LINKAGE]\n"
            "For experiment API creations (`POST /runs`, `POST /sweeps`, "
            "`POST /sweeps/wild`, `POST /sweeps/{id}/runs`), include "
            f"`\"chat_session_id\": \"{session_id}\"` in JSON bodies.\n"
            "Use `null` only when intentionally creating entities not tied to this chat.\n"
            "[/CHAT LINKAGE]\n\n"
        )

    content = f"{chat_linking_note}{mode_note}[USER] {message}"
    session_system_prompt = str(session.get("system_prompt", "")).strip()
    if session_system_prompt:
        content = f"[SYSTEM INSTRUCTIONS]\n{session_system_prompt}\n[/SYSTEM INSTRUCTIONS]\n\n{content}"
    if provenance is not None:
        provenance["rendered"] = content
    return content, provenance


def _log_background_chat_task(task: asyncio.Task) -> None:
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("Failed to inspect background chat task")
        return

    if exc:
        logger.error("Background chat worker failed: %s", exc, exc_info=(type(exc), exc, exc.__traceback__))



async def _chat_worker(session_id: str, content: str, runtime: ChatStreamRuntime, *, mode: str = "agent") -> None:
    """Run the OpenCode stream for a chat session independent of HTTP clients."""
    session_stop_flags.pop(session_id, None)
    logger.debug("Starting background chat worker for session %s run %s (mode=%s)", session_id, runtime.run_id, mode)

    try:
        session = chat_sessions.get(session_id)
        session_model_provider = MODEL_PROVIDER
        session_model_id = MODEL_ID
        if isinstance(session, dict):
            session_model_provider, session_model_id = get_session_model(session)

        opencode_session_id = await get_opencode_session_for_chat(session_id)
        async with httpx.AsyncClient(timeout=None) as client:
            logger.debug("Sending prompt to OpenCode session %s", opencode_session_id)
            logger.debug("Content: %s", content)
            await send_prompt_to_opencode(
                client,
                opencode_session_id,
                content,
                session_model_provider,
                session_model_id,
            )
            logger.debug("Sent prompt to OpenCode session %s", opencode_session_id)

            async for event, _text_delta, _thinking_delta, _tool_update in stream_opencode_events(client, opencode_session_id):
                if should_stop_session(session_id):
                    runtime.status = "stopped"
                    break

                await _append_runtime_event(runtime, event)
                _persist_active_stream_snapshot(session_id, runtime)

        if should_stop_session(session_id):
            runtime.status = "stopped"
    except asyncio.CancelledError:
        runtime.status = "stopped"
        logger.info("Background chat worker cancelled for session %s", session_id)
    except Exception as e:
        runtime.status = "failed"
        runtime.error = str(e)
        logger.error("Chat worker failed for session %s: %s", session_id, e, exc_info=True)
        await _append_runtime_event(runtime, {"type": "error", "message": str(e)})
    finally:
        parts = runtime.parts_accumulator.finalize()
        if runtime.full_text or runtime.full_thinking or parts:
            session = chat_sessions.get(session_id)
            if isinstance(session, dict):
                # Keep ALL parts (including text) to preserve the interleaved
                # order of text, thinking, and tool outputs.  The 'content'
                # and 'thinking' fields are convenience aggregates.
                assistant_msg = {
                    "role": "assistant",
                    "content": runtime.full_text.strip(),
                    "thinking": runtime.full_thinking.strip() if runtime.full_thinking else None,
                    "parts": parts if parts else None,
                    "timestamp": time.time(),
                }
                session.setdefault("messages", []).append(assistant_msg)


        # Auto-name: fetch title from OpenCode only once (after the first exchange)
        session = chat_sessions.get(session_id)
        if isinstance(session, dict) and not session.get("title"):
            opencode_sid = session.get("opencode_session_id")
            if opencode_sid:
                oc_title = await fetch_opencode_session_title(opencode_sid)
                if oc_title:
                    session["title"] = oc_title
                    logger.info("Auto-named chat %s from OpenCode: %s", session_id, oc_title)

        session = chat_sessions.get(session_id)
        if isinstance(session, dict):
            session["last_status"] = runtime.status
            session["last_error"] = runtime.error
            session.pop("active_stream", None)
        save_chat_state()

        await _append_runtime_event(runtime, {"type": "session_status", "status": "idle"})
        await _finalize_runtime(session_id, runtime)

        active_chat_tasks.pop(session_id, None)
        session_stop_flags.pop(session_id, None)
        logger.debug("Background chat worker finished for session %s run %s", session_id, runtime.run_id)


async def _start_chat_worker(session_id: str, content: str, mode: str = "agent") -> ChatStreamRuntime:
    existing = active_chat_streams.get(session_id)
    if existing and existing.status == "running":
        raise HTTPException(status_code=409, detail="Session already has an active response")
    if existing:
        await _finalize_runtime(session_id, existing, retain=False)

    runtime = ChatStreamRuntime(session_id)
    active_chat_streams[session_id] = runtime
    _persist_active_stream_snapshot(session_id, runtime, force=True)

    task = asyncio.create_task(_chat_worker(session_id, content, runtime, mode=mode))
    active_chat_tasks[session_id] = task
    task.add_done_callback(_log_background_chat_task)
    return runtime


async def _send_chat_for_v2(chat_session_id: str, prompt: str, display_message: str) -> str:
    """Route a V2 iteration through the frontend's chat session for live streaming.

    1. Adds a user message to the chat session (so the frontend shows the iteration)
    2. Starts the chat worker (which streams the response via SSE)
    3. Waits for completion
    4. Returns the full response text

    This is the callback passed to WildV2Engine.send_chat_message.
    """
    logger.info("[wild-v2-chat] _send_chat_for_v2 called: session=%s, prompt_len=%d, display=%s",
                chat_session_id, len(prompt), display_message)

    if chat_session_id not in chat_sessions:
        logger.error("[wild-v2-chat] Chat session %s not found!", chat_session_id)
        raise ValueError(f"Chat session {chat_session_id} not found")

    session = chat_sessions[chat_session_id]

    # Check if there's already an active stream on this session
    existing_runtime = active_chat_streams.get(chat_session_id)
    if existing_runtime and existing_runtime.status == "running":
        logger.warning("[wild-v2-chat] Session %s already has an active stream (run=%s), waiting for it to finish...",
                       chat_session_id, existing_runtime.run_id)
        # Wait for the existing task to complete before starting a new one
        existing_task = active_chat_tasks.get(chat_session_id)
        if existing_task:
            try:
                await existing_task
                logger.info("[wild-v2-chat] Previous task finished, proceeding")
            except Exception:
                logger.warning("[wild-v2-chat] Previous task failed, proceeding anyway")

    # Add user message showing the iteration context
    user_msg = {
        "role": "user",
        "content": display_message,
        "timestamp": time.time(),
        "wild_v2": True,
    }
    session.setdefault("messages", []).append(user_msg)
    save_chat_state()
    logger.debug("[wild-v2-chat] Added user message to chat session")

    # Start the chat worker — this sends the full prompt to OpenCode and streams
    # the response via SSE, so the frontend picks it up live
    logger.info("[wild-v2-chat] Starting chat worker for session %s", chat_session_id)
    runtime = await _start_chat_worker(chat_session_id, prompt, mode="agent")
    logger.info("[wild-v2-chat] Chat worker started: run_id=%s", runtime.run_id)

    # Wait for the background task to finish
    task = active_chat_tasks.get(chat_session_id)
    if task:
        logger.info("[wild-v2-chat] Waiting for chat worker task to complete...")
        try:
            await task
            logger.info("[wild-v2-chat] Chat worker task completed successfully")
        except Exception as err:
            logger.error("[wild-v2-chat] Chat worker task failed: %s", err, exc_info=True)
    else:
        logger.warning("[wild-v2-chat] No task found in active_chat_tasks for session %s", chat_session_id)

    full_text = runtime.full_text or ""
    logger.info("[wild-v2-chat] Got %d chars from chat session %s (status=%s)",
                len(full_text), chat_session_id, runtime.status)
    return full_text


# Wire the chat streaming callback into the V2 engine
wild_v2_engine._send_chat_message = _send_chat_for_v2


@app.get("/sessions/{session_id}/stream")
async def stream_session(session_id: str, from_seq: int = Query(1, ge=1), run_id: Optional[str] = Query(None)):
    """Attach/re-attach to an in-flight chat stream with catch-up replay."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _stream_runtime_events(session_id, from_seq=from_seq, run_id=run_id),
        media_type="application/x-ndjson",
    )


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message, start background generation, and attach to the stream."""
    session_id = req.session_id

    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    existing_runtime = active_chat_streams.get(session_id)
    if existing_runtime and existing_runtime.status == "running":
        raise HTTPException(status_code=409, detail="Session already has an active response")

    session = chat_sessions[session_id]
    messages = session.get("messages", [])

    user_msg = {"role": "user", "content": req.message, "timestamp": time.time()}
    messages.append(user_msg)
    session["messages"] = messages

    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")

    save_chat_state()

    # Resolve mode: prefer explicit mode field, fall back to legacy booleans
    effective_mode = req.mode
    if effective_mode == "agent":
        if req.wild_mode:
            effective_mode = "wild"
        elif req.plan_mode:
            effective_mode = "plan"
    llm_input = req.prompt_override if req.prompt_override else req.message
    content, provenance = _build_chat_prompt(session, llm_input, effective_mode, session_id=session_id)
    runtime = await _start_chat_worker(session_id, content, mode=effective_mode)

    # Emit provenance as the first SSE event so the frontend can attach it
    if provenance:
        await _append_runtime_event(runtime, {"type": "provenance", **provenance})

    return StreamingResponse(
        _stream_runtime_events(session_id, from_seq=1, run_id=runtime.run_id),
        media_type="application/x-ndjson",
    )


@app.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    """Stop streaming for a session (including auto-alert tasks)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session_stop_flags[session_id] = True
    runtime = active_chat_streams.get(session_id)
    if runtime and runtime.status == "running":
        runtime.status = "stopped"
        _persist_active_stream_snapshot(session_id, runtime, force=True)

    task = active_chat_tasks.get(session_id)
    # For legacy/auto-alert tasks we still cancel directly. Chat workers stop via flag + abort call below.
    if task and not task.done() and runtime is None:
        task.cancel()

    # Also abort the OpenCode session so the model actually stops generating
    opencode_session_id = chat_sessions[session_id].get("opencode_session_id")
    if opencode_session_id:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(
                    f"{OPENCODE_URL}/session/{opencode_session_id}/abort",
                    auth=get_auth()
                )
                logger.info(f"Aborted OpenCode session {opencode_session_id}: {resp.status_code}")
        except Exception as e:
            logger.warning(f"Failed to abort OpenCode session {opencode_session_id}: {e}")

    return {"message": "Stop signal sent"}


# =============================================================================
# Run Endpoints
# =============================================================================

@app.get("/runs")
async def list_runs(
    archived: bool = Query(False, description="Include archived runs"),
    limit: int = Query(100, description="Max runs to return")
):
    """List all runs."""
    _reconcile_all_run_terminal_states()
    result = []
    for run_id, run in runs.items():
        if not archived and run.get("is_archived", False):
            continue
        result.append(_run_response_payload(run_id, run))
    
    # Sort by created_at descending
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


@app.post("/runs")
async def create_run(req: RunCreate):
    """Create a new run. Starts in 'ready' state unless auto_start=True."""
    run_id = uuid.uuid4().hex[:12]

    if req.sweep_id and req.sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail=f"Sweep not found: {req.sweep_id}")
    
    initial_status = "queued" if req.auto_start else "ready"
    gpuwrap_config = _normalize_gpuwrap_config(req.gpuwrap_config)
    
    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": req.workdir or config.WORKDIR,
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
    
    runs[run_id] = run_data
    _sync_run_membership_with_sweep(run_id, req.sweep_id)
    save_runs_state()
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

    # If auto_start is requested, actually launch the run in tmux
    if initial_status == "queued":
        try:
            launch_run_in_tmux(run_id, run_data)
            if run_data.get("sweep_id"):
                recompute_sweep_state(run_data["sweep_id"])
            save_runs_state()
        except Exception as e:
            logger.error(f"Failed to auto-start run {run_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return _run_response_payload(run_id, run_data)


@app.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Get run details."""
    _reconcile_all_run_terminal_states()
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_response_payload(run_id, runs[run_id])


@app.put("/runs/{run_id}")
async def update_run(run_id: str, req: RunUpdate):
    """Update mutable run fields."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]
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

    save_runs_state()
    return _run_response_payload(run_id, run)


@app.post("/runs/{run_id}/queue")
async def queue_run(run_id: str):
    """Queue a ready run for execution."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
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
        recompute_sweep_state(run["sweep_id"])
    save_runs_state()
    
    return {"message": "Run queued", "id": run_id, **run}


@app.post("/runs/{run_id}/start")
async def start_run(run_id: str):
    """Start a queued run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] not in ["queued", "ready"]:
        raise HTTPException(status_code=400, detail=f"Run cannot be started (status: {run['status']})")
    
    # If ready, move to queued first
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
        tmux_window = launch_run_in_tmux(run_id, run)
        _record_journey_event(
            kind="run_launched",
            actor="system",
            session_id=run.get("chat_session_id"),
            run_id=run_id,
            note=run.get("name") or run_id,
            metadata={"tmux_window": tmux_window},
        )
        if run.get("sweep_id"):
            recompute_sweep_state(run["sweep_id"])
        save_runs_state()
        return {"message": "Run started", "tmux_window": tmux_window}
    except Exception as e:
        logger.error(f"Failed to start run {run_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Stop a running job."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] not in ["launching", "running"]:
        raise HTTPException(status_code=400, detail=f"Run is not active (status: {run['status']})")
    
    # Kill tmux window
    tmux_window = run.get("tmux_window")
    if tmux_window:
        session = get_or_create_session()
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
        recompute_sweep_state(run["sweep_id"])
    save_runs_state()
    
    return {"message": "Run stopped"}


@app.post("/runs/{run_id}/rerun")
async def rerun_run(run_id: str, req: Optional[RunRerunRequest] = None):
    """Create a new run based on an existing run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    source_run = runs[run_id]
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

    runs[new_run_id] = new_run
    _sync_run_membership_with_sweep(new_run_id, new_run.get("sweep_id"))
    save_runs_state()
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
            launch_run_in_tmux(new_run_id, new_run)
            _record_journey_event(
                kind="run_launched",
                actor="system",
                session_id=new_run.get("chat_session_id"),
                run_id=new_run_id,
                note=new_run.get("name") or new_run_id,
                metadata={"rerun_of": run_id},
            )
            if new_run.get("sweep_id"):
                recompute_sweep_state(new_run["sweep_id"])
            save_runs_state()
        except Exception as e:
            logger.error(f"Failed to launch rerun {new_run_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return {"id": new_run_id, **new_run}


@app.post("/runs/{run_id}/archive")
async def archive_run(run_id: str):
    """Archive a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    runs[run_id]["is_archived"] = True
    runs[run_id]["archived_at"] = time.time()
    save_runs_state()
    return {"message": "Run archived", "run": {"id": run_id, **runs[run_id]}}


@app.post("/runs/{run_id}/unarchive")
async def unarchive_run(run_id: str):
    """Unarchive a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    runs[run_id]["is_archived"] = False
    runs[run_id].pop("archived_at", None)
    save_runs_state()
    return {"message": "Run unarchived", "run": {"id": run_id, **runs[run_id]}}


@app.post("/runs/{run_id}/status")
async def update_run_status(run_id: str, update: RunStatusUpdate):
    """Update run status (called by sidecar)."""
    logger.info(f"Status update for {run_id}: {update.status}")
    
    if run_id not in runs:
        # Create minimal entry if doesn't exist
        runs[run_id] = {"created_at": time.time()}
    
    run = runs[run_id]
    
    # Update fields
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
    
    # Track timestamps
    if next_status == "running" and not run.get("started_at"):
        run["started_at"] = time.time()
    elif next_status in RUN_STATUS_TERMINAL:
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
    if slack_notifier.is_enabled and next_status in RUN_STATUS_TERMINAL:
        run_data = {"id": run_id, **run}
        if next_status == "finished":
            slack_notifier.send_run_completed(run_data)
        elif next_status in ("failed", "stopped"):
            slack_notifier.send_run_failed(run_data)

    if run.get("sweep_id"):
        recompute_sweep_state(run["sweep_id"])
    save_runs_state()
    return {"message": "Status updated"}


@app.post("/runs/{run_id}/alerts")
async def create_alert(run_id: str, req: CreateAlertRequest):
    """Create a new alert for a run (called by sidecar)."""
    if run_id not in runs:
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

    # Slack notification for alert
    if slack_notifier.is_enabled:
        slack_notifier.send_alert(
            alert=alert_payload,
            run=runs.get(run_id),
        )

    active_alerts[alert_id] = alert_payload
    save_alerts_state()
    logger.info(f"Created alert {alert_id} for run {run_id}: {req.message}")
    return {"alert_id": alert_id}


# ---- Metrics Endpoints (sidecar-pushed) ----

@app.post("/runs/{run_id}/metrics")
async def post_run_metrics(run_id: str, request: Request):
    """Accept metrics rows from the sidecar and append to stored metrics file.

    Body should be JSON with a 'rows' array of metric dictionaries, e.g.:
    {"rows": [{"step": 1, "train/loss": 0.5, "accuracy": 0.6}, ...]}
    """
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    body = await request.json()
    rows = body.get("rows", [])
    if not isinstance(rows, list) or len(rows) == 0:
        raise HTTPException(status_code=400, detail="'rows' must be a non-empty array")

    run = runs[run_id]
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

    # Invalidate cache for this file
    _wandb_metrics_cache.pop(metrics_file, None)

    logger.debug(f"Received {len(rows)} metric rows for run {run_id}")
    return {"appended": len(rows)}


@app.get("/runs/{run_id}/metrics")
async def get_run_metrics(run_id: str):
    """Return parsed metrics for a run from stored metrics file."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]
    run_dir = run.get("run_dir") or os.path.join(config.DATA_DIR, "runs", run_id)
    parsed = _load_run_metrics(run_dir)

    # Fallback to wandb files if no stored metrics
    if not parsed or not parsed.get("metricSeries"):
        wandb_dir = run.get("wandb_dir") or _find_wandb_dir_from_run_dir(run_dir)
        wandb_parsed = _get_wandb_curve_data(wandb_dir)
        if wandb_parsed:
            parsed = wandb_parsed

    return parsed or {}


@app.get("/alerts")
async def list_alerts():
    """List alerts ordered by newest first."""
    alerts = list(active_alerts.values())
    alerts.sort(key=lambda a: a.get("timestamp", 0), reverse=True)
    return alerts


@app.post("/alerts/{alert_id}/respond")
async def respond_to_alert(alert_id: str, req: RespondAlertRequest):
    """Resolve an alert and persist the response for sidecar consumption."""
    if alert_id not in active_alerts:
        raise HTTPException(status_code=404, detail="Alert not found")

    alert = active_alerts[alert_id]
    if req.choice not in alert.get("choices", []):
        raise HTTPException(status_code=400, detail="Invalid choice")

    alert["status"] = "resolved"
    alert["response"] = req.choice
    alert["responded_at"] = time.time()

    run_id = alert.get("run_id")
    run = runs.get(run_id) if run_id else None

    if not run:
        save_alerts_state()
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

    save_alerts_state()
    logger.info(f"Recorded alert response for {alert_id}: {req.choice}")
    return {"message": "Response recorded"}


@app.get("/wild-mode")
async def get_wild_mode():
    """Get current wild mode state."""
    return {"enabled": wild_mode_enabled}


@app.post("/wild-mode")
async def set_wild_mode(req: WildModeRequest):
    """Enable or disable wild mode."""
    global wild_mode_enabled
    wild_mode_enabled = bool(req.enabled)
    save_settings_state()
    return {"enabled": wild_mode_enabled}




# =============================================================================
# Wild Loop V2 Endpoints (Ralph-style)
# =============================================================================

class WildV2StartRequest(BaseModel):
    goal: str
    chat_session_id: Optional[str] = None
    max_iterations: int = 25
    wait_seconds: float = 30.0
    evo_sweep_enabled: bool = False

class WildV2SteerRequest(BaseModel):
    context: str

class WildV2ResolveRequest(BaseModel):
    event_ids: list


@app.post("/wild/v2/start")
async def wild_v2_start(req: WildV2StartRequest):
    """Start a new V2 wild session (ralph-style loop)."""
    result = wild_v2_engine.start(
        goal=req.goal,
        chat_session_id=req.chat_session_id,
        max_iterations=req.max_iterations,
        wait_seconds=req.wait_seconds,
        evo_sweep_enabled=req.evo_sweep_enabled,
    )
    return result


@app.post("/wild/v2/stop")
async def wild_v2_stop():
    """Stop the active V2 wild session."""
    return wild_v2_engine.stop()


@app.post("/wild/v2/pause")
async def wild_v2_pause():
    """Pause the V2 wild session."""
    return wild_v2_engine.pause()


@app.post("/wild/v2/resume")
async def wild_v2_resume():
    """Resume the V2 wild session."""
    return wild_v2_engine.resume()


@app.get("/wild/v2/status")
async def wild_v2_status():
    """Get current V2 session state, plan, and history."""
    return wild_v2_engine.get_status()


@app.get("/wild/v2/events/{session_id}")
async def wild_v2_events(session_id: str):
    """Get pending events for a V2 session (agent calls this).
    
    Events are now managed server-side in active_alerts and runs dicts.
    """
    events = []
    # Collect pending alerts
    for alert_id, alert in active_alerts.items():
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
    for rid, run in runs.items():
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


@app.post("/wild/v2/events/{session_id}/resolve")
async def wild_v2_resolve_events(session_id: str, req: WildV2ResolveRequest):
    """Mark events as resolved (agent calls this after handling)."""
    resolved = 0
    ids_to_resolve = set(req.event_ids)
    for alert_id in list(active_alerts.keys()):
        if alert_id in ids_to_resolve:
            active_alerts[alert_id]["status"] = "resolved"
            resolved += 1
    return {"resolved": resolved}


@app.get("/wild/v2/system-health")
async def wild_v2_system_health():
    """Get system utilization (agent calls this to check resources)."""
    return WildV2Engine.get_system_health_from_runs(runs)


@app.get("/wild/v2/plan/{session_id}")
async def wild_v2_plan(session_id: str):
    """Get the current tasks/plan markdown (reads tasks.md from disk)."""
    return {"plan": wild_v2_engine.get_plan()}


@app.get("/wild/v2/iteration-log/{session_id}")
async def wild_v2_iteration_log(session_id: str):
    """Get the iteration log markdown."""
    return {"log": wild_v2_engine.get_iteration_log()}


@app.post("/wild/v2/steer")
async def wild_v2_steer(req: WildV2SteerRequest):
    """Inject user context for the next iteration."""
    return wild_v2_engine.steer(req.context)


# =============================================================================
# Evolutionary Sweep Endpoints
# =============================================================================

@app.get("/wild/v2/evo-sweep/{session_id}")
async def wild_v2_evo_sweep_status(session_id: str):
    """Get the current evolutionary sweep status for a session."""
    session = wild_v2_engine._session  # type: ignore[attr-defined]
    if not session or session.session_id != session_id:
        return {"active": False, "message": "No active session matches"}
    controller = getattr(session, "_evo_controller", None)
    if controller is None:
        return {"active": False, "sweep_id": None}
    return {
        "active": True,
        "sweep_id": controller.sweep_id,
        "evo_sweep_enabled": session.evo_sweep_enabled,
    }


@app.post("/wild/v2/evo-sweep/{session_id}/stop")
async def wild_v2_evo_sweep_stop(session_id: str):
    """Stop an in-progress evolutionary sweep."""
    session = wild_v2_engine._session  # type: ignore[attr-defined]
    if not session or session.session_id != session_id:
        return {"stopped": False, "message": "No active session matches"}
    controller = getattr(session, "_evo_controller", None)
    if controller is None:
        return {"stopped": False, "message": "No evo sweep in progress"}
    controller.cancel()
    return {"stopped": True, "sweep_id": controller.sweep_id}


# =============================================================================
# Memory Bank Endpoints  (extracted to memory_routes.py)
# =============================================================================

import memory_routes  # noqa: E402
memory_routes.init(memory_store)
app.include_router(memory_routes.router)




# =============================================================================
# Cluster Endpoints  (extracted to cluster_routes.py)
# =============================================================================

import cluster_routes  # noqa: E402
cluster_routes.init(cluster_state, save_settings_state, _current_run_summary, _infer_cluster_from_environment)
app.include_router(cluster_routes.router)




# =============================================================================
# Slack Integration Endpoints  (extracted to slack_routes.py)
# =============================================================================

import slack_routes  # noqa: E402
slack_routes.init(slack_notifier, save_settings_state)
app.include_router(slack_routes.router)




def _build_experiment_context() -> str:
    """Build a summary of current experiment state for mode prompts."""
    lines = ["\n--- Current Experiment State ---"]
    recompute_all_sweep_states()

    active_runs = [{"id": rid, **r} for rid, r in runs.items()
                   if r.get("status") in ["running", "queued", "launching"]]
    finished_runs = [{"id": rid, **r} for rid, r in runs.items()
                     if r.get("status") == "finished"]
    failed_runs = [{"id": rid, **r} for rid, r in runs.items()
                   if r.get("status") == "failed"]

    lines.append(f"Active runs: {len(active_runs)}")
    for r in active_runs[:5]:
        lines.append(f"  - {r['id']}: {r.get('name', '?')} [{r.get('status')}] cmd={r.get('command', '')[:80]}")
    lines.append(f"Finished runs: {len(finished_runs)} | Failed runs: {len(failed_runs)}")
    for r in failed_runs[:3]:
        lines.append(f"  - FAILED {r['id']}: {r.get('name', '?')} error={r.get('error', 'unknown')[:100]}")

    active_sweeps = [{"id": sid, **s} for sid, s in sweeps.items()]
    if active_sweeps:
        lines.append(f"Sweeps: {len(active_sweeps)}")
        for s in active_sweeps[:3]:
            p = s.get("progress", {})
            lines.append(f"  - {s['id']}: {s.get('name', '?')} "
                         f"[{p.get('completed', 0)}/{p.get('total', 0)} done, {p.get('failed', 0)} failed]")

    pending_alerts = [a for a in active_alerts.values() if a.get("status") == "pending"]
    if pending_alerts:
        lines.append(f"Pending alerts: {len(pending_alerts)}")
        for a in pending_alerts[:3]:
            lines.append(f"  - {a['id']}: [{a.get('severity')}] {a.get('message', '')[:80]}")

    lines.append("--- End State ---\n")
    return "\n".join(lines)


# =============================================================================
# Prompt Skill Endpoints  (extracted to skills_routes.py)
# =============================================================================

skills_routes.init(prompt_skill_manager)
app.include_router(skills_routes.router)


# =============================================================================
# Sweep Endpoints
# =============================================================================

def expand_parameter_grid(parameters: dict, max_runs: int) -> list:
    """Expand parameter dict into list of parameter combinations."""
    import itertools
    
    keys = list(parameters.keys())
    values = [parameters[k] if isinstance(parameters[k], list) else [parameters[k]] for k in keys]
    
    combinations = list(itertools.product(*values))[:max_runs]
    
    return [dict(zip(keys, combo)) for combo in combinations]


def build_command_with_params(base_command: str, params: dict) -> str:
    """Insert parameters into command string."""
    # Simple approach: append as CLI args
    param_str = " ".join([f"--{k}={v}" for k, v in params.items()])
    return f"{base_command} {param_str}".strip()


@app.get("/sweeps")
async def list_sweeps(
    limit: int = Query(50, description="Max sweeps to return")
):
    """List all sweeps."""
    recompute_all_sweep_states()
    backfilled = False
    result = []
    for sweep_id, sweep in sweeps.items():
        if _ensure_sweep_creation_context(sweep):
            backfilled = True
        result.append({"id": sweep_id, **sweep})

    if backfilled:
        save_runs_state()
    
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


class WildSweepCreate(BaseModel):
    name: str = "Wild Loop Sweep"
    goal: str = ""
    chat_session_id: Optional[str] = None  # Originating chat session

@app.post("/sweeps/wild")
async def create_wild_sweep(req: WildSweepCreate):
    """Create an empty sweep container for wild loop tracking.
    
    Unlike the regular /sweeps endpoint, this doesn't require parameter grids.
    Runs are added to this sweep via sweep_id when the agent creates them.
    """
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
    
    sweeps[sweep_id] = sweep_data
    recompute_sweep_state(sweep_id)
    save_runs_state()
    
    logger.info(f"Created wild sweep {sweep_id}: {req.name} (goal: {req.goal[:80]})")
    return {"id": sweep_id, **sweep_data}


@app.post("/sweeps")
async def create_sweep(req: SweepCreate):
    """Create a sweep in draft/pending/running mode, optionally with generated runs."""
    sweep_id = uuid.uuid4().hex[:12]
    requested_status = _normalize_sweep_status(req.status)
    if req.auto_start and requested_status == "pending":
        # auto_start implies immediate queue/launch intent
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
        sweeps[sweep_id] = sweep_data
        save_runs_state()
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
        
        runs[run_id] = run_data
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
    
    sweeps[sweep_id] = sweep_data
    recompute_sweep_state(sweep_id)
    save_runs_state()
    
    logger.info(f"Created sweep {sweep_id}: {req.name} with {len(run_ids)} runs (status={requested_status})")
    return {"id": sweep_id, **sweep_data}


@app.put("/sweeps/{sweep_id}")
async def update_sweep(sweep_id: str, req: SweepUpdate):
    """Update an existing sweep configuration/state."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = sweeps[sweep_id]
    current_status = _normalize_sweep_status(sweep.get("status"))
    base_command_update_requested = req.base_command is not None
    non_command_structural_update_requested = any(
        field is not None
        for field in [req.parameters, req.max_runs]
    )
    structural_update_requested = base_command_update_requested or non_command_structural_update_requested

    # Keep running sweeps immutable to avoid mutating active experiments in place.
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
            run = runs.get(run_id)
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

    recompute_sweep_state(sweep_id)
    save_runs_state()
    return {"id": sweep_id, **sweep}


@app.get("/sweeps/{sweep_id}")
async def get_sweep(sweep_id: str):
    """Get sweep details with run status summary."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = recompute_sweep_state(sweep_id) or sweeps[sweep_id]
    if _ensure_sweep_creation_context(sweep):
        save_runs_state()
    return {"id": sweep_id, **sweep}


@app.post("/sweeps/{sweep_id}/start")
async def start_sweep(sweep_id: str, parallel: int = Query(1, description="Max parallel runs")):
    """Start all ready/queued runs in a sweep."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")
    
    sweep = sweeps[sweep_id]
    if _normalize_sweep_status(sweep.get("status")) == "draft":
        raise HTTPException(status_code=400, detail="Draft sweep has no runnable jobs yet")
    started = 0
    attempted = 0
    
    for run_id in sweep.get("run_ids", []):
        if run_id in runs:
            run = runs[run_id]
            if run["status"] in ["ready", "queued"] and started < parallel:
                attempted += 1
                try:
                    # Queue if ready
                    if run["status"] == "ready":
                        run["status"] = "queued"
                        run["queued_at"] = time.time()
                    
                    launch_run_in_tmux(run_id, run)
                    started += 1
                except Exception as e:
                    logger.error(f"Failed to start run {run_id}: {e}")

    recompute_sweep_state(sweep_id)
    save_runs_state()
    
    return {"message": f"Started {started}/{attempted} runs", "sweep_id": sweep_id}


@app.post("/sweeps/{sweep_id}/runs")
async def add_run_to_sweep_directly(sweep_id: str, req: RunCreate):
    """Create a new run and attach it to a sweep in one call.

    This allows adding runs to a sweep even if they are outside the original
    parameter/hyperparameter grid (e.g. a one-off baseline, a manual rerun
    with custom flags, etc.).
    """
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    # Force sweep_id on the run regardless of what was provided
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
        "chat_session_id": req.chat_session_id or sweeps[sweep_id].get("chat_session_id"),
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    runs[run_id] = run_data
    sweeps[sweep_id].setdefault("run_ids", []).append(run_id)
    recompute_sweep_state(sweep_id)
    save_runs_state()

    logger.info(f"Created run {run_id} and attached to sweep {sweep_id}: {req.name} (status: {initial_status})")
    return {"id": run_id, **run_data}


@app.post("/runs/{run_id}/add-to-sweep")
async def add_run_to_sweep(run_id: str, sweep_id: str = Query(..., description="Sweep ID to add the run to")):
    """Add an existing standalone run to a sweep."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    run = runs[run_id]
    old_sweep_id = run.get("sweep_id")
    if old_sweep_id == sweep_id:
        return {"message": f"Run {run_id} is already in sweep {sweep_id}"}

    if old_sweep_id and old_sweep_id in sweeps and run.get("status") in RUN_STATUS_ACTIVE.union({"queued"}):
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot move an active/queued run between sweeps. "
                "Stop it first or rerun into a new sweep."
            ),
        )

    if old_sweep_id and old_sweep_id in sweeps:
        old_ids = sweeps[old_sweep_id].get("run_ids", [])
        sweeps[old_sweep_id]["run_ids"] = [rid for rid in old_ids if rid != run_id]
        recompute_sweep_state(old_sweep_id)

    run["sweep_id"] = sweep_id
    if run_id not in sweeps[sweep_id].get("run_ids", []):
        sweeps[sweep_id].setdefault("run_ids", []).append(run_id)
    recompute_sweep_state(sweep_id)
    save_runs_state()
    return {"message": f"Run {run_id} added to sweep {sweep_id}"}


# =============================================================================
# Log & Artifact Endpoints  (extracted to log_routes.py)
# =============================================================================

import log_routes  # noqa: E402
log_routes.init(runs)
app.include_router(log_routes.router)




# =============================================================================
# Main
# =============================================================================

def start_opencode_server_subprocess(args):
    # Start OpenCode server subprocess
    opencode_process = subprocess.Popen(
        ["opencode", "serve"],
        cwd=args.workdir,
        # TODO: Open up logging
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    logger.info(f"Started OpenCode server (PID: {opencode_process.pid}) in {args.workdir}")
    return


# =============================================================================
# Plan Endpoints  (extracted to plan_routes.py)
# =============================================================================

import plan_routes  # noqa: E402
plan_routes.init(plans, save_plans_state)
app.include_router(plan_routes.router)




def maybe_mount_frontend_static():
    """Serve packaged frontend static files if available."""
    if not FRONTEND_STATIC_DIR:
        return
    if not os.path.isdir(FRONTEND_STATIC_DIR):
        logger.warning("Configured RESEARCH_AGENT_FRONTEND_DIR does not exist: %s", FRONTEND_STATIC_DIR)
        return
    logger.info("Serving frontend static files from %s", FRONTEND_STATIC_DIR)
    app.mount("/", StaticFiles(directory=FRONTEND_STATIC_DIR, html=True), name="frontend-static")

def main():
    global SERVER_CALLBACK_URL
    global TMUX_SESSION_NAME

    if "--run-sidecar" in sys.argv:
        sidecar_index = sys.argv.index("--run-sidecar")
        sidecar_argv = sys.argv[sidecar_index + 1 :]
        import job_sidecar

        job_sidecar.main(sidecar_argv)
        return

    parser = argparse.ArgumentParser(description="Research Agent Server")
    parser.add_argument("--workdir", default=os.getcwd(), help="Working directory for runs and data")
    parser.add_argument("--port", type=int, default=10000, help="Server port")
    parser.add_argument("--host", default="0.0.0.0", help="Server host")
    parser.add_argument(
        "--tmux-session",
        default=TMUX_SESSION_NAME,
        help="Tmux session name for background jobs"
    )
    args = parser.parse_args()
    
    # Initialize paths
    init_paths(args.workdir)
    SERVER_CALLBACK_URL = f"http://127.0.0.1:{args.port}"
    TMUX_SESSION_NAME = args.tmux_session
    
    # Check required environment variables
    if not os.environ.get("RESEARCH_AGENT_KEY"):
        logger.info("💡 Tip: Want free Anthropic credits? Ask the maintainer for a gateway key.")
        logger.info("   Then set it with: export RESEARCH_AGENT_KEY=your-gateway-token")
        logger.info("   Or set RESEARCH_AGENT_KEY in the frontend Settings page.")
    
    if not USER_AUTH_TOKEN:
        logger.info("RESEARCH_AGENT_USER_AUTH_TOKEN is not set — running without server-side auth.")
        logger.info("   You can set your auth token in the GUI Settings page, or export the env var for remote access.")
    
    # Start OpenCode server subprocess
    # start_opencode_server_subprocess(args)
    
    # Load state
    load_chat_state()
    load_runs_state()
    load_alerts_state()
    load_plans_state()
    load_journey_state()
    load_settings_state()
    if cluster_state.get("source") == "unset":
        inferred = _infer_cluster_from_environment()
        cluster_state.update(_normalize_cluster_state(inferred))
        save_settings_state()
    maybe_mount_frontend_static()
    
    logger.info(f"Starting Research Agent Server on {args.host}:{args.port}")
    logger.info(f"Working directory: {config.WORKDIR}")
    
    uvicorn.run(app, host=args.host, port=args.port, log_config=None)


if __name__ == "__main__":
    main()
