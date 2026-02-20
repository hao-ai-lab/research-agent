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
import asyncio
import glob
import json
import logging
import math
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx
import libtmux
import uvicorn
from agent.wild_loop_v2 import WildV2Engine
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from integrations.slack_handler import slack_notifier
from memory.store import MemoryStore
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

from core import config  # noqa: E402

# Re-export immutable constants and functions so existing code keeps working.
# IMPORTANT: mutable path variables (config.WORKDIR, config.DATA_DIR, *_FILE) must be
# accessed as config.VARNAME so they reflect post-init_paths() values.
from core.config import (  # noqa: E402
    _SERVER_FILE_DIR,
    AUTH_PROTECTED_PREFIXES,
    FRONTEND_STATIC_DIR,
    MODEL_ID,
    MODEL_PROVIDER,
    OPENCODE_CONFIG,
    OPENCODE_PASSWORD,
    OPENCODE_URL,
    OPENCODE_USERNAME,
    RUNTIME_RESEARCH_AGENT_KEY,
    RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED,
    RUNTIME_RESEARCH_AGENT_KEY_LOCK,
    SERVER_CALLBACK_URL,
    TMUX_SESSION_NAME,
    USER_AUTH_TOKEN,
    _parse_optional_int,
    apply_runtime_research_agent_key,
    get_auth,
    get_default_opencode_config,
    get_session_model,
    init_paths,
    load_available_opencode_models,
    requires_api_auth,
    set_runtime_research_agent_key,
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
        return JSONResponse(status_code=401, content={"detail": "Unauthorized - invalid or missing X-Auth-Token"})

    return await call_next(request)


# =============================================================================
# Models  (extracted to models.py)
# =============================================================================

import skills.routes as skills_routes  # noqa: E402
from core.models import (  # noqa: E402
    JOURNEY_ACTOR_VALUES,
    JOURNEY_DECISION_STATUS_VALUES,
    JOURNEY_PRIORITY_VALUES,
    JOURNEY_REC_STATUS_VALUES,
    PLAN_STATUSES,
    AlertRecord,
    ChatMessage,
    ChatRequest,
    ClusterDetectRequest,
    ClusterUpdateRequest,
    CreateAlertRequest,
    CreateSessionRequest,
    GpuwrapConfig,
    JourneyDecisionCreate,
    JourneyEventCreate,
    JourneyNextActionsRequest,
    JourneyRecommendationCreate,
    JourneyRecommendationRespondRequest,
    MemoryCreateRequest,
    MemoryUpdateRequest,
    PlanCreate,
    PlanUpdate,
    RespondAlertRequest,
    RunCreate,
    RunRerunRequest,
    RunStatusUpdate,
    RunUpdate,
    SessionModelUpdate,
    SweepCreate,
    SweepUpdate,
    SystemPromptUpdate,
    UpdateSessionRequest,
    WildModeRequest,
)

# =============================================================================
# Prompt Skill Manager  (extracted to skills_manager.py)
# =============================================================================
from skills.manager import (  # noqa: E402
    INTERNAL_SKILL_IDS,
    INTERNAL_SKILL_PREFIXES,
    PromptSkillManager,
    _is_internal_skill,
)

# Initialize the prompt skill manager
prompt_skill_manager = PromptSkillManager()


# =============================================================================
# State  (extracted to state.py)
# =============================================================================

import core.state as _state  # noqa: E402
from core.state import (  # noqa: E402
    ACCURACY_KEYS,
    CLUSTER_SOURCE_VALUES,
    CLUSTER_STATUS_VALUES,
    # Cluster
    CLUSTER_TYPE_VALUES,
    EPOCH_KEYS,
    IGNORED_METRIC_KEYS,
    LOSS_KEYS,
    MAX_HISTORY_POINTS,
    MAX_METRIC_SERIES_KEYS,
    STEP_KEYS,
    STREAM_RUNTIME_RETENTION_SECONDS,
    STREAM_SNAPSHOT_SAVE_INTERVAL_EVENTS,
    # Metrics constants
    STREAM_SNAPSHOT_SAVE_INTERVAL_SECONDS,
    VAL_LOSS_KEYS,
    _cluster_type_description,
    _cluster_type_label,
    _default_cluster_state,
    _downsample_history,
    _extract_step,
    _find_wandb_dir_from_run_dir,
    _first_numeric,
    _is_metric_key,
    # Helpers
    _journey_new_id,
    _normalize_cluster_source,
    _normalize_cluster_state,
    _normalize_cluster_status,
    _normalize_cluster_type,
    _resolve_metrics_file,
    _to_float,
    _wandb_metrics_cache,
    active_alerts,
    active_chat_streams,
    active_chat_tasks,
    # Global state dicts — these are mutable references, so server.py and state.py
    # share the same dict objects. Mutations like chat_sessions["x"] = y propagate.
    chat_sessions,
    cluster_state,
    journey_decisions,
    journey_events,
    journey_recommendations,
    load_alerts_state,
    load_chat_state,
    load_journey_state,
    load_plans_state,
    plans,
    runs,
    save_alerts_state,
    # Save/load functions
    save_chat_state,
    save_journey_state,
    save_plans_state,
    save_runs_state,
    session_stop_flags,
    sweeps,
    wild_mode_enabled,
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
        with open(log_file) as f:
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
    session_id: str | None = None,
    run_id: str | None = None,
    chart_id: str | None = None,
    recommendation_id: str | None = None,
    decision_id: str | None = None,
    note: str | None = None,
    metadata: dict | None = None,
    timestamp: float | None = None,
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
            with open(config.SETTINGS_DATA_FILE) as f:
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
            with open(config.JOBS_DATA_FILE) as f:
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
    metric_series: dict[str, list[dict]] = {}
    latest_loss: float | None = None
    latest_accuracy: float | None = None
    latest_epoch: float | None = None
    fallback_step = 0

    try:
        with open(metrics_file, errors="replace") as f:
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
                    metric_series.setdefault(key, []).append({"step": step, "value": round(numeric_value, 6)})
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
        parsed["metricSeries"] = {key: _downsample_history(metric_series[key]) for key in ranked_metric_keys}
        parsed["metricKeys"] = ranked_metric_keys

    parsed["metrics"] = {
        "loss": latest_loss,
        "accuracy": latest_accuracy,
        "epoch": latest_epoch,
    }
    return parsed


def _get_wandb_curve_data(wandb_dir: str | None) -> dict | None:
    metrics_file = _resolve_metrics_file(wandb_dir)
    if not metrics_file:
        return None

    try:
        stat = os.stat(metrics_file)
    except OSError:
        return None

    cached = _wandb_metrics_cache.get(metrics_file)
    if cached and cached.get("size") == stat.st_size and cached.get("mtime") == stat.st_mtime:
        return cached.get("payload")

    payload = _parse_metrics_history(metrics_file)
    _wandb_metrics_cache[metrics_file] = {
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "payload": payload,
    }
    return payload


def _load_run_metrics(run_dir: str | None) -> dict:
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

    raw_parsed_metrics = parsed.get("metrics")
    parsed_metrics = raw_parsed_metrics if isinstance(raw_parsed_metrics, dict) else {}
    raw_existing_metrics = payload.get("metrics")
    existing_metrics = raw_existing_metrics if isinstance(raw_existing_metrics, dict) else {}
    merged_metrics = {
        "loss": parsed_metrics.get("loss", existing_metrics.get("loss")),
        "accuracy": parsed_metrics.get("accuracy", existing_metrics.get("accuracy")),
        "epoch": parsed_metrics.get("epoch", existing_metrics.get("epoch")),
    }
    if any(isinstance(merged_metrics.get(key), (int, float)) for key in ("loss", "accuracy", "epoch")):
        payload["metrics"] = {k: float(v) for k, v in merged_metrics.items() if isinstance(v, (int, float))}

    return payload


# =============================================================================
# Run/Sweep State Helpers + Cluster Detection + Tmux  (extracted to run_helpers.py)
# =============================================================================

# =============================================================================
# OpenCode Integration  (extracted to chat_streaming.py)
# =============================================================================
from chat.streaming import (  # noqa: E402
    ChatStreamRuntime,
    StreamPartsAccumulator,
    _append_runtime_event,
    _finalize_runtime,
    _persist_active_stream_snapshot,
    _stream_runtime_events,
    fetch_opencode_session_title,
    get_opencode_session_for_chat,
    parse_opencode_event,
    run_opencode_session,
    send_prompt_to_opencode,
    should_stop_session,
    stream_opencode_events,
)
from runs.helpers import (  # noqa: E402
    RUN_STATUS_ACTIVE,
    RUN_STATUS_PENDING,
    RUN_STATUS_TERMINAL,
    SWEEP_STATUS_EDITABLE,
    SWEEP_STATUS_TERMINAL,
    _coerce_exit_code,
    _coerce_optional_bool,
    _coerce_optional_int,
    _coerce_optional_text,
    _compute_sweep_progress,
    _count_gpu_devices,
    _count_kubernetes_nodes,
    _count_slurm_nodes,
    _count_ssh_hosts,
    _current_run_summary,
    _derive_sweep_creation_context,
    _ensure_sweep_creation_context,
    _infer_cluster_from_environment,
    _infer_sweep_status,
    _json_clone,
    _normalize_gpuwrap_config,
    _normalize_sweep_status,
    _reconcile_all_run_terminal_states,
    _reconcile_run_terminal_state,
    _run_command_capture,
    _sync_run_membership_with_sweep,
    _terminal_status_from_exit_code,
    get_or_create_session,
    get_tmux_server,
    launch_run_in_tmux,
    recompute_all_sweep_states,
    recompute_sweep_state,
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

import integrations.journey_routes as journey_routes  # noqa: E402

journey_routes.init(
    record_journey_event_fn=_record_journey_event,
    send_prompt_to_opencode_fn=send_prompt_to_opencode,
    stream_opencode_events_fn=stream_opencode_events,
)
app.include_router(journey_routes.router)


# =============================================================================
# Git Diff / File Browser Endpoints  (extracted to git_routes.py)
# =============================================================================

import integrations.git_routes as git_routes  # noqa: E402

app.include_router(git_routes.router)


# =============================================================================
# Chat Endpoints  (extracted to chat_routes.py)
# =============================================================================

import chat.routes as chat_routes  # noqa: E402

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

import runs.routes as run_routes  # noqa: E402

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

import agent.wild_routes as wild_routes  # noqa: E402

wild_routes.init(wild_v2_engine, active_alerts, runs, WildV2Engine)
app.include_router(wild_routes.router)


# =============================================================================
# Memory Bank Endpoints  (extracted to memory_routes.py)
# =============================================================================

import memory.routes as memory_routes  # noqa: E402

memory_routes.init(memory_store)
app.include_router(memory_routes.router)


# =============================================================================
# Cluster Endpoints  (extracted to cluster_routes.py)
# =============================================================================

import integrations.cluster_routes as cluster_routes  # noqa: E402

cluster_routes.init(cluster_state, save_settings_state, _current_run_summary, _infer_cluster_from_environment)
app.include_router(cluster_routes.router)


# =============================================================================
# Slack Integration Endpoints  (extracted to slack_routes.py)
# =============================================================================

import integrations.slack_routes as slack_routes  # noqa: E402

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

import runs.sweep_routes as sweep_routes  # noqa: E402

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

import runs.log_routes as log_routes  # noqa: E402

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
        stderr=subprocess.DEVNULL,
    )
    logger.info(f"Started OpenCode server (PID: {opencode_process.pid}) in {args.workdir}")
    return


# =============================================================================
# Plan Endpoints  (extracted to plan_routes.py)
# =============================================================================

import integrations.plan_routes as plan_routes  # noqa: E402

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
        from tools import job_sidecar

        job_sidecar.main(sidecar_argv)
        return

    parser = argparse.ArgumentParser(description="Research Agent Server")
    parser.add_argument("--workdir", default=os.getcwd(), help="Working directory for runs and data")
    parser.add_argument("--port", type=int, default=10000, help="Server port")
    parser.add_argument("--host", default="0.0.0.0", help="Server host")
    parser.add_argument("--tmux-session", default=TMUX_SESSION_NAME, help="Tmux session name for background jobs")
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
