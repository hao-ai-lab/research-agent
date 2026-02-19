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
# OpenCode Integration  (extracted to chat_streaming.py)
# =============================================================================

from chat_streaming import (  # noqa: E402
    get_opencode_session_for_chat,
    fetch_opencode_session_title,
    send_prompt_to_opencode,
    should_stop_session,
    StreamPartsAccumulator,
    ChatStreamRuntime,
    _persist_active_stream_snapshot,
    _append_runtime_event,
    _finalize_runtime,
    _stream_runtime_events,
    run_opencode_session,
    parse_opencode_event,
    stream_opencode_events,
)


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


# =============================================================================
# Journey Endpoints  (extracted to journey_routes.py)
# =============================================================================

import journey_routes  # noqa: E402
journey_routes.init(
    record_journey_event_fn=_record_journey_event,
    send_prompt_to_opencode_fn=send_prompt_to_opencode,
    stream_opencode_events_fn=stream_opencode_events,
)
app.include_router(journey_routes.router)



# =============================================================================
# Git Diff / File Browser Endpoints  (extracted to git_routes.py)
# =============================================================================

import git_routes  # noqa: E402
app.include_router(git_routes.router)




# =============================================================================
# Chat Endpoints  (extracted to chat_routes.py)
# =============================================================================

import chat_routes  # noqa: E402
chat_routes.init(
    prompt_skill_manager=prompt_skill_manager,
    get_opencode_session_for_chat_fn=get_opencode_session_for_chat,
    fetch_opencode_session_title_fn=fetch_opencode_session_title,
    send_prompt_to_opencode_fn=send_prompt_to_opencode,
    stream_opencode_events_fn=stream_opencode_events,
    should_stop_session_fn=should_stop_session,
    append_runtime_event_fn=_append_runtime_event,
    persist_active_stream_snapshot_fn=_persist_active_stream_snapshot,
    finalize_runtime_fn=_finalize_runtime,
    stream_runtime_events_fn=_stream_runtime_events,
    chat_stream_runtime_cls=ChatStreamRuntime,
    recompute_all_sweep_states_fn=recompute_all_sweep_states,
    wild_v2_engine=wild_v2_engine,
)
chat_routes.wire_v2_engine()
app.include_router(chat_routes.router)





# =============================================================================
# Run, Alert, Metrics, Wild Mode Endpoints  (extracted to run_routes.py)
# =============================================================================

import run_routes  # noqa: E402
run_routes.init(
    runs_dict=runs,
    sweeps_dict=sweeps,
    active_alerts_dict=active_alerts,
    save_runs_state_fn=save_runs_state,
    save_alerts_state_fn=save_alerts_state,
    save_settings_state_fn=save_settings_state,
    launch_run_in_tmux_fn=launch_run_in_tmux,
    recompute_sweep_state_fn=recompute_sweep_state,
    reconcile_all_run_terminal_states_fn=_reconcile_all_run_terminal_states,
    run_response_payload_fn=_run_response_payload,
    sync_run_membership_with_sweep_fn=_sync_run_membership_with_sweep,
    record_journey_event_fn=_record_journey_event,
    normalize_gpuwrap_config_fn=_normalize_gpuwrap_config,
    coerce_exit_code_fn=_coerce_exit_code,
    slack_notifier=slack_notifier,
    get_or_create_session_fn=get_or_create_session,
    run_status_terminal_set=RUN_STATUS_TERMINAL,
    load_run_metrics_fn=_load_run_metrics,
    find_wandb_dir_from_run_dir_fn=_find_wandb_dir_from_run_dir,
    get_wandb_curve_data_fn=_get_wandb_curve_data,
    wandb_metrics_cache_dict=_wandb_metrics_cache,
)
app.include_router(run_routes.router)







# =============================================================================
# Wild Loop V2 + Evolutionary Sweep Endpoints  (extracted to wild_routes.py)
# =============================================================================

import wild_routes  # noqa: E402
wild_routes.init(wild_v2_engine, active_alerts, runs, WildV2Engine)
app.include_router(wild_routes.router)




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






# =============================================================================
# Prompt Skill Endpoints  (extracted to skills_routes.py)
# =============================================================================

skills_routes.init(prompt_skill_manager)
app.include_router(skills_routes.router)


# =============================================================================
# Sweep Endpoints  (extracted to sweep_routes.py)
# =============================================================================

import sweep_routes  # noqa: E402
sweep_routes.init(
    sweeps_dict=sweeps,
    runs_dict=runs,
    save_runs_state_fn=save_runs_state,
    recompute_sweep_state_fn=recompute_sweep_state,
    recompute_all_sweep_states_fn=recompute_all_sweep_states,
    normalize_sweep_status_fn=_normalize_sweep_status,
    ensure_sweep_creation_context_fn=_ensure_sweep_creation_context,
    derive_sweep_creation_context_fn=_derive_sweep_creation_context,
    normalize_gpuwrap_config_fn=_normalize_gpuwrap_config,
    launch_run_in_tmux_fn=launch_run_in_tmux,
    run_status_active_set=RUN_STATUS_ACTIVE,
)
app.include_router(sweep_routes.router)




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
