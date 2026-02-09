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
import json
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
from typing import Any, Dict, Optional, AsyncIterator, List

import httpx
import uvicorn
import libtmux
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Configure logging
# logging.basicConfig(level=logging.INFO)
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("research-agent-server")

# =============================================================================
# Configuration
# =============================================================================

# OpenCode configuration
_SERVER_FILE_DIR = os.path.dirname(os.path.abspath(__file__))


def get_default_opencode_config() -> str:
    """Resolve opencode.json path for source and frozen-binary execution."""
    candidates: list[str] = []

    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(os.path.join(meipass, "opencode.json"))
        candidates.append(os.path.join(os.path.dirname(sys.executable), "opencode.json"))

    candidates.append(os.path.join(_SERVER_FILE_DIR, "opencode.json"))

    for path in candidates:
        if path and os.path.exists(path):
            return path

    return candidates[-1]


OPENCODE_CONFIG = os.environ.get("OPENCODE_CONFIG", get_default_opencode_config())
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD")

# Model configuration - uses research-agent provider from opencode.json
# This connects to the Anthropic gateway at Modal
# MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "research-agent")
# MODEL_ID = os.environ.get("MODEL_ID", "claude-3-5-haiku-latest")
# MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "research-agent")
# MODEL_ID = os.environ.get("MODEL_ID", "claude-sonnet-4-20250514")
MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "opencode")
MODEL_ID = os.environ.get("MODEL_ID", "kimi-k2.5-free")

# User authentication token - if set, all API requests must include X-Auth-Token header
USER_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN")

# Will be set by CLI args
WORKDIR = os.getcwd()
DATA_DIR = ""
CHAT_DATA_FILE = ""
CHAT_STREAMS_DIR = ""
CHAT_STREAMS_STATE_FILE = ""
JOBS_DATA_FILE = ""
ALERTS_DATA_FILE = ""
SETTINGS_DATA_FILE = ""
TMUX_SESSION_NAME = os.environ.get("RESEARCH_AGENT_TMUX_SESSION", "research-agent")
SERVER_CALLBACK_URL = "http://127.0.0.1:10000"
FRONTEND_STATIC_DIR = os.environ.get("RESEARCH_AGENT_FRONTEND_DIR", "").strip()

CHAT_STREAM_ACTIVE_STATUSES = {"queued", "running", "stopping"}
CHAT_STREAM_TERMINAL_STATUSES = {"completed", "error", "stopped", "interrupted"}

AUTH_PROTECTED_PREFIXES = (
    "/sessions",
    "/chat",
    "/runs",
    "/alerts",
    "/wild",
    "/sweeps",
    "/cluster",
    "/git",
)


def requires_api_auth(path: str) -> bool:
    """Only enforce auth token on API routes."""
    for prefix in AUTH_PROTECTED_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def init_paths(workdir: str):
    """Initialize all paths based on workdir."""
    global WORKDIR, DATA_DIR, CHAT_DATA_FILE, CHAT_STREAMS_DIR, CHAT_STREAMS_STATE_FILE, JOBS_DATA_FILE, ALERTS_DATA_FILE, SETTINGS_DATA_FILE
    WORKDIR = os.path.abspath(workdir)
    DATA_DIR = os.path.join(WORKDIR, ".agents")
    CHAT_DATA_FILE = os.path.join(DATA_DIR, "chat_data.json")
    CHAT_STREAMS_DIR = os.path.join(DATA_DIR, "chat_streams")
    CHAT_STREAMS_STATE_FILE = os.path.join(DATA_DIR, "chat_streams_state.json")
    JOBS_DATA_FILE = os.path.join(DATA_DIR, "jobs.json")
    ALERTS_DATA_FILE = os.path.join(DATA_DIR, "alerts.json")
    SETTINGS_DATA_FILE = os.path.join(DATA_DIR, "settings.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "runs"), exist_ok=True)
    os.makedirs(CHAT_STREAMS_DIR, exist_ok=True)
    logger.info(f"Initialized with workdir: {WORKDIR}")
    # Change the current working directory to the workdir
    os.chdir(WORKDIR)


def get_auth() -> Optional[httpx.BasicAuth]:
    """Get HTTP basic auth if password is configured."""
    return httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD) if OPENCODE_PASSWORD else None


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
# Models
# =============================================================================

# Chat Models
class ChatMessage(BaseModel):
    role: str
    content: str
    thinking: Optional[str] = None
    timestamp: Optional[float] = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    wild_mode: bool = False


class CreateSessionRequest(BaseModel):
    title: Optional[str] = None


# Run Models
# Run State Machine: ready -> queued -> launching -> running -> finished/failed/stopped
# - ready: Created but not submitted for execution
# - queued: Submitted, waiting to be picked up
# - launching: Tmux window being created
# - running: Command actively executing
# - finished/failed/stopped: Terminal states

class RunCreate(BaseModel):
    name: str
    command: str
    workdir: Optional[str] = None
    sweep_id: Optional[str] = None  # If part of a sweep
    parent_run_id: Optional[str] = None
    origin_alert_id: Optional[str] = None
    auto_start: bool = False  # If True, skip ready and go straight to queued


class RunStatusUpdate(BaseModel):
    status: str  # launching, running, finished, failed, stopped
    exit_code: Optional[int] = None
    error: Optional[str] = None
    tmux_pane: Optional[str] = None
    wandb_dir: Optional[str] = None


class SweepCreate(BaseModel):
    name: str
    base_command: str
    workdir: Optional[str] = None
    parameters: dict  # e.g., {"lr": [0.001, 0.01], "batch_size": [32, 64]}
    max_runs: int = 10
    auto_start: bool = False
    goal: Optional[str] = None
    status: Optional[str] = None  # draft, pending, running
    ui_config: Optional[dict] = None


class SweepUpdate(BaseModel):
    name: Optional[str] = None
    base_command: Optional[str] = None
    workdir: Optional[str] = None
    parameters: Optional[dict] = None
    max_runs: Optional[int] = None
    goal: Optional[str] = None
    status: Optional[str] = None  # draft, pending, running, completed, failed, canceled
    ui_config: Optional[dict] = None


class AlertRecord(BaseModel):
    id: str
    run_id: str
    timestamp: float
    severity: str = "warning"
    message: str
    choices: List[str]
    status: str = "pending"  # pending, resolved
    response: Optional[str] = None
    responded_at: Optional[float] = None
    session_id: Optional[str] = None
    auto_session: bool = False


class CreateAlertRequest(BaseModel):
    message: str
    choices: List[str]
    severity: str = "warning"


class RespondAlertRequest(BaseModel):
    choice: str


class RunRerunRequest(BaseModel):
    command: Optional[str] = None
    auto_start: bool = False
    origin_alert_id: Optional[str] = None


class WildModeRequest(BaseModel):
    enabled: bool


class WildLoopConfigRequest(BaseModel):
    goal: Optional[str] = None
    session_id: Optional[str] = None
    max_iterations: Optional[int] = None
    max_time_seconds: Optional[int] = None
    max_tokens: Optional[int] = None
    custom_condition: Optional[str] = None


class ClusterUpdateRequest(BaseModel):
    type: Optional[str] = None
    status: Optional[str] = None
    source: Optional[str] = None
    head_node: Optional[str] = None
    node_count: Optional[int] = None
    gpu_count: Optional[int] = None
    notes: Optional[str] = None
    details: Optional[dict] = None


class ClusterDetectRequest(BaseModel):
    preferred_type: Optional[str] = None


# =============================================================================
# State
# =============================================================================

chat_sessions: Dict[str, dict] = {}
chat_streams: Dict[str, dict] = {}
active_chat_stream_by_session: Dict[str, str] = {}
runs: Dict[str, dict] = {}
sweeps: Dict[str, dict] = {}
active_alerts: Dict[str, dict] = {}
wild_mode_enabled: bool = False
wild_loop_state: dict = {
    "phase": "idle",
    "iteration": 0,
    "goal": None,
    "session_id": None,
    "started_at": None,
    "is_paused": False,
    "sweep_id": None,
    "termination": {
        "max_iterations": None,
        "max_time_seconds": None,
        "max_tokens": None,
        "custom_condition": None,
    }
}
session_stop_flags: Dict[str, bool] = {}
active_chat_tasks: Dict[str, asyncio.Task] = {}

CLUSTER_TYPE_VALUES = {
    "unknown",
    "slurm",
    "local_gpu",
    "kubernetes",
    "ray",
    "shared_head_node",
}
CLUSTER_STATUS_VALUES = {"unknown", "healthy", "degraded", "offline"}
CLUSTER_SOURCE_VALUES = {"unset", "manual", "detected"}


def _default_cluster_state() -> dict:
    now = time.time()
    return {
        "type": "unknown",
        "status": "unknown",
        "source": "unset",
        "label": "Unknown",
        "description": "Cluster has not been configured yet.",
        "head_node": None,
        "node_count": None,
        "gpu_count": None,
        "notes": None,
        "confidence": None,
        "details": {},
        "last_detected_at": None,
        "updated_at": now,
    }


cluster_state: dict = _default_cluster_state()


def save_chat_state():
    """Persist chat sessions to disk."""
    try:
        with open(CHAT_DATA_FILE, "w") as f:
            json.dump({"chat_sessions": chat_sessions}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving chat state: {e}")


def load_chat_state():
    """Load chat sessions from disk."""
    global chat_sessions
    if os.path.exists(CHAT_DATA_FILE):
        try:
            with open(CHAT_DATA_FILE, "r") as f:
                data = json.load(f)
                chat_sessions = data.get("chat_sessions", {})
        except Exception as e:
            logger.error(f"Error loading chat state: {e}")


def _chat_stream_log_path(stream_id: str) -> str:
    return os.path.join(CHAT_STREAMS_DIR, f"{stream_id}.ndjson")


def _chat_stream_status_is_active(status: Any) -> bool:
    return isinstance(status, str) and status in CHAT_STREAM_ACTIVE_STATUSES


def _chat_stream_status_is_terminal(status: Any) -> bool:
    return isinstance(status, str) and status in CHAT_STREAM_TERMINAL_STATUSES


def save_chat_streams_state():
    """Persist chat stream metadata to disk."""
    try:
        with open(CHAT_STREAMS_STATE_FILE, "w") as f:
            json.dump({"chat_streams": chat_streams}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving chat stream state: {e}")


def load_chat_streams_state():
    """Load chat stream metadata and normalize interrupted stream statuses."""
    global chat_streams, active_chat_stream_by_session
    chat_streams = {}
    active_chat_stream_by_session = {}
    if os.path.exists(CHAT_STREAMS_STATE_FILE):
        try:
            with open(CHAT_STREAMS_STATE_FILE, "r") as f:
                data = json.load(f)
                loaded = data.get("chat_streams", {})
                if isinstance(loaded, dict):
                    chat_streams = loaded
        except Exception as e:
            logger.error(f"Error loading chat stream state: {e}")
            chat_streams = {}

    now = time.time()
    changed = False
    interrupted_count = 0
    for stream_id, stream in list(chat_streams.items()):
        if not isinstance(stream, dict):
            del chat_streams[stream_id]
            changed = True
            continue

        stream["id"] = stream_id
        stream_file = stream.get("stream_file")
        if not isinstance(stream_file, str) or not stream_file:
            stream["stream_file"] = _chat_stream_log_path(stream_id)
            changed = True
        elif not os.path.isabs(stream_file):
            stream["stream_file"] = os.path.join(DATA_DIR, stream_file)
            changed = True

        status = stream.get("status")
        if _chat_stream_status_is_active(status):
            # Any active stream in persisted state means the server stopped before
            # finishing the request lifecycle.
            stream["status"] = "interrupted"
            stream["updated_at"] = now
            stream["interrupted_at"] = now
            interrupted_count += 1
            changed = True

    if changed:
        save_chat_streams_state()
    if interrupted_count:
        logger.warning("Marked %d chat stream(s) as interrupted after restart", interrupted_count)


def _append_chat_stream_event(stream_id: str, event: dict, *, persist_state: bool = False):
    """Append one stream event to the session log file."""
    stream = chat_streams.get(stream_id)
    if not stream:
        return

    stream_file = stream.get("stream_file") or _chat_stream_log_path(stream_id)
    stream["stream_file"] = stream_file
    os.makedirs(os.path.dirname(stream_file), exist_ok=True)

    seq = int(stream.get("last_event_seq", 0)) + 1
    event_record = dict(event)
    event_record.setdefault("_seq", seq)
    event_record.setdefault("_ts", time.time())

    with open(stream_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event_record, ensure_ascii=False) + "\n")

    stream["last_event_seq"] = seq
    stream["updated_at"] = time.time()
    if persist_state or seq % 20 == 0:
        save_chat_streams_state()


def _iter_chat_stream_events(stream_file: str):
    if not os.path.exists(stream_file):
        return
    try:
        with open(stream_file, "r", encoding="utf-8", errors="replace") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                if isinstance(event, dict):
                    yield event
    except Exception as e:
        logger.warning(f"Failed to read chat stream log {stream_file}: {e}")


def _find_active_stream_for_session(session_id: str) -> Optional[dict]:
    stream_id = active_chat_stream_by_session.get(session_id)
    if stream_id:
        stream = chat_streams.get(stream_id)
        if stream and _chat_stream_status_is_active(stream.get("status")):
            return stream
        active_chat_stream_by_session.pop(session_id, None)

    # Fallback scan if in-memory index is stale.
    candidates = [
        stream
        for stream in chat_streams.values()
        if isinstance(stream, dict)
        and stream.get("session_id") == session_id
        and _chat_stream_status_is_active(stream.get("status"))
    ]
    if not candidates:
        return None
    latest = max(candidates, key=_stream_created_at)
    latest_id = latest.get("id")
    if isinstance(latest_id, str) and latest_id:
        active_chat_stream_by_session[session_id] = latest_id
    return latest


def _stream_created_at(stream: dict) -> float:
    try:
        return float(stream.get("created_at", 0))
    except Exception:
        return 0.0


def _find_latest_stream_for_session(session_id: str) -> Optional[dict]:
    candidates = [
        stream
        for stream in chat_streams.values()
        if isinstance(stream, dict) and stream.get("session_id") == session_id
    ]
    if not candidates:
        return None
    return max(candidates, key=_stream_created_at)


def _serialize_chat_stream_summary(stream: Optional[dict]) -> Optional[dict]:
    if not stream:
        return None
    return {
        "id": stream.get("id"),
        "session_id": stream.get("session_id"),
        "status": stream.get("status"),
        "created_at": stream.get("created_at"),
        "started_at": stream.get("started_at"),
        "completed_at": stream.get("completed_at"),
        "updated_at": stream.get("updated_at"),
        "error": stream.get("error"),
        "last_event_seq": stream.get("last_event_seq", 0),
        "assistant_committed": bool(stream.get("assistant_committed")),
    }


def save_runs_state():
    """Persist runs and sweeps to disk."""
    try:
        with open(JOBS_DATA_FILE, "w") as f:
            json.dump({"runs": runs, "sweeps": sweeps}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving runs state: {e}")


def load_runs_state():
    """Load runs and sweeps from disk."""
    global runs, sweeps
    if os.path.exists(JOBS_DATA_FILE):
        try:
            with open(JOBS_DATA_FILE, "r") as f:
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


def save_alerts_state():
    """Persist active alerts to disk."""
    try:
        with open(ALERTS_DATA_FILE, "w") as f:
            json.dump({"alerts": list(active_alerts.values())}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving alerts state: {e}")


def load_alerts_state():
    """Load active alerts from disk."""
    global active_alerts
    if os.path.exists(ALERTS_DATA_FILE):
        try:
            with open(ALERTS_DATA_FILE, "r") as f:
                data = json.load(f)
                loaded = data.get("alerts", [])
                active_alerts = {
                    alert["id"]: alert
                    for alert in loaded
                    if isinstance(alert, dict) and alert.get("id")
                }
        except Exception as e:
            logger.error(f"Error loading alerts state: {e}")


def _cluster_type_label(cluster_type: str) -> str:
    mapping = {
        "unknown": "Unknown",
        "slurm": "Slurm",
        "local_gpu": "Local GPU",
        "kubernetes": "Kubernetes",
        "ray": "Ray",
        "shared_head_node": "Shared GPU Head Node",
    }
    return mapping.get(cluster_type, "Unknown")


def _cluster_type_description(cluster_type: str) -> str:
    mapping = {
        "unknown": "Cluster has not been configured yet.",
        "slurm": "Slurm-managed cluster scheduler detected.",
        "local_gpu": "Single-host GPU workstation/cluster detected.",
        "kubernetes": "Kubernetes cluster control plane detected.",
        "ray": "Ray cluster runtime detected.",
        "shared_head_node": "Head node with SSH fan-out to worker nodes.",
    }
    return mapping.get(cluster_type, "Cluster has not been configured yet.")


def _normalize_cluster_type(raw_type: Optional[str]) -> str:
    if not raw_type:
        return "unknown"
    value = raw_type.strip().lower().replace("-", "_")
    aliases = {
        "localgpu": "local_gpu",
        "local_gpu_cluster": "local_gpu",
        "shared_gpu_head_node": "shared_head_node",
        "shared_gpu": "shared_head_node",
        "head_node": "shared_head_node",
        "k8s": "kubernetes",
    }
    value = aliases.get(value, value)
    return value if value in CLUSTER_TYPE_VALUES else "unknown"


def _normalize_cluster_status(raw_status: Optional[str]) -> str:
    if not raw_status:
        return "unknown"
    value = raw_status.strip().lower()
    return value if value in CLUSTER_STATUS_VALUES else "unknown"


def _normalize_cluster_source(raw_source: Optional[str]) -> str:
    if not raw_source:
        return "unset"
    value = raw_source.strip().lower()
    return value if value in CLUSTER_SOURCE_VALUES else "unset"


def _normalize_cluster_state(raw_state: Any) -> dict:
    normalized = _default_cluster_state()
    if not isinstance(raw_state, dict):
        return normalized

    cluster_type = _normalize_cluster_type(raw_state.get("type"))
    normalized.update(
        {
            "type": cluster_type,
            "status": _normalize_cluster_status(raw_state.get("status")),
            "source": _normalize_cluster_source(raw_state.get("source")),
            "label": _cluster_type_label(cluster_type),
            "description": _cluster_type_description(cluster_type),
            "head_node": raw_state.get("head_node"),
            "node_count": raw_state.get("node_count"),
            "gpu_count": raw_state.get("gpu_count"),
            "notes": raw_state.get("notes"),
            "confidence": raw_state.get("confidence"),
            "details": raw_state.get("details") if isinstance(raw_state.get("details"), dict) else {},
            "last_detected_at": raw_state.get("last_detected_at"),
            "updated_at": raw_state.get("updated_at") or time.time(),
        }
    )
    return normalized


def save_settings_state():
    """Persist settings to disk."""
    try:
        with open(SETTINGS_DATA_FILE, "w") as f:
            json.dump(
                {
                    "wild_mode": wild_mode_enabled,
                    "wild_loop": wild_loop_state,
                    "cluster": cluster_state,
                },
                f,
                indent=2,
                default=str,
            )
    except Exception as e:
        logger.error(f"Error saving settings state: {e}")


def load_settings_state():
    """Load settings from disk."""
    global wild_mode_enabled, wild_loop_state, cluster_state
    if os.path.exists(SETTINGS_DATA_FILE):
        try:
            with open(SETTINGS_DATA_FILE, "r") as f:
                data = json.load(f)
                wild_mode_enabled = bool(data.get("wild_mode", False))
                saved_loop = data.get("wild_loop")
                if saved_loop and isinstance(saved_loop, dict):
                    wild_loop_state.update(saved_loop)
                cluster_state = _normalize_cluster_state(data.get("cluster"))
        except Exception as e:
            logger.error(f"Error loading settings state: {e}")


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
    run_dir = os.path.join(DATA_DIR, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    
    # Write command to file
    command_file = os.path.join(run_dir, "command.txt")
    with open(command_file, "w") as f:
        f.write(run_data["command"])
    
    # Get sidecar path
    server_dir = os.path.dirname(os.path.abspath(__file__))
    sidecar_path = os.path.join(server_dir, "job_sidecar.py")
    
    # Build sidecar command
    server_url = SERVER_CALLBACK_URL
    run_workdir = run_data.get("workdir") or WORKDIR
    
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
        resp = await client.post(f"{OPENCODE_URL}/session", json={}, auth=get_auth())
        resp.raise_for_status()
        opencode_id = resp.json().get("id")
        session["opencode_session_id"] = opencode_id
        save_chat_state()
        logger.info(f"Created new OpenCode session {opencode_id} for chat {chat_session_id}")
        return opencode_id


async def send_prompt_to_opencode(client: httpx.AsyncClient, session_id: str, content: str):
    """Send a prompt to an OpenCode session."""
    prompt_payload = {
        "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
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


async def run_opencode_session(chat_session_id: str, opencode_session_id: str, content: str) -> tuple[str, str, list]:
    """Run a prompt and return full text, thinking, and ordered parts."""
    full_text = ""
    full_thinking = ""
    parts_accumulator = StreamPartsAccumulator()
    async with httpx.AsyncClient(timeout=None) as client:
        await send_prompt_to_opencode(client, opencode_session_id, content)
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
    
    if etype == "message.part.updated":
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
    return {"status": "ok", "service": "research-agent-server", "workdir": WORKDIR}


@app.get("/health")
async def health_json():
    """JSON health endpoint."""
    return {"status": "ok", "service": "research-agent-server", "workdir": WORKDIR}


# =============================================================================
# Git Diff Endpoints
# =============================================================================

GIT_DIFF_MAX_LINES_PER_FILE = 400
GIT_DIFF_DEFAULT_FILE_LIMIT = 200
GIT_FILES_DEFAULT_LIMIT = 5000
GIT_FILE_MAX_BYTES = 120000
_HUNK_HEADER_RE = re.compile(r"^@@ -(?P<old>\d+)(?:,\d+)? \+(?P<new>\d+)(?:,\d+)? @@")


def _run_git_command(args: List[str], timeout_seconds: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", WORKDIR, *args],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _is_git_repo() -> bool:
    try:
        result = _run_git_command(["rev-parse", "--is-inside-work-tree"], timeout_seconds=5)
    except Exception:
        return False
    return result.returncode == 0 and result.stdout.strip() == "true"


def _collect_changed_files(limit: int) -> List[Dict[str, str]]:
    files_by_path: Dict[str, str] = {}

    diff_names = _run_git_command(["diff", "--name-status", "-z", "HEAD", "--"], timeout_seconds=15)
    if diff_names.returncode != 0:
        raise RuntimeError(diff_names.stderr.strip() or "Failed to list git diff files")

    tokens = [token for token in diff_names.stdout.split("\x00") if token]
    index = 0
    while index < len(tokens):
        status_token = tokens[index]
        status_code = status_token[:1] if status_token else "M"
        index += 1

        path = ""
        if status_code in {"R", "C"}:
            if index + 1 >= len(tokens):
                break
            index += 1  # Skip old path
            path = tokens[index]
            index += 1
            status_code = "M"
        else:
            if index >= len(tokens):
                break
            path = tokens[index]
            index += 1

        if not path:
            continue

        status = "modified"
        if status_code == "A":
            status = "added"
        elif status_code == "D":
            status = "deleted"
        files_by_path[path] = status

    untracked = _run_git_command(["ls-files", "--others", "--exclude-standard", "-z"], timeout_seconds=10)
    if untracked.returncode == 0:
        for path in untracked.stdout.split("\x00"):
            if path:
                files_by_path[path] = "added"

    changed = [
        {"path": path, "status": files_by_path[path]}
        for path in sorted(files_by_path.keys())
    ]
    return changed[:limit]


def _parse_unified_diff(diff_text: str, max_lines: int = GIT_DIFF_MAX_LINES_PER_FILE) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    old_line: Optional[int] = None
    new_line: Optional[int] = None

    for raw_line in diff_text.splitlines():
        if raw_line.startswith(("diff --git ", "index ", "--- ", "+++ ")):
            continue

        if raw_line.startswith("Binary files "):
            parsed.append(
                {"type": "hunk", "text": "Binary file changed.", "oldLine": None, "newLine": None}
            )
            break

        if raw_line.startswith("\\ No newline at end of file"):
            continue

        if raw_line.startswith("@@"):
            match = _HUNK_HEADER_RE.match(raw_line)
            if match:
                old_line = int(match.group("old"))
                new_line = int(match.group("new"))
            else:
                old_line = None
                new_line = None

            parsed.append({"type": "hunk", "text": raw_line, "oldLine": None, "newLine": None})

        elif raw_line.startswith("+"):
            parsed.append({"type": "add", "text": raw_line[1:], "oldLine": None, "newLine": new_line})
            if new_line is not None:
                new_line += 1

        elif raw_line.startswith("-"):
            parsed.append({"type": "remove", "text": raw_line[1:], "oldLine": old_line, "newLine": None})
            if old_line is not None:
                old_line += 1

        elif raw_line.startswith(" "):
            parsed.append({"type": "context", "text": raw_line[1:], "oldLine": old_line, "newLine": new_line})
            if old_line is not None:
                old_line += 1
            if new_line is not None:
                new_line += 1

        if len(parsed) >= max_lines:
            parsed.append(
                {
                    "type": "hunk",
                    "text": f"... diff truncated to {max_lines} lines ...",
                    "oldLine": None,
                    "newLine": None,
                }
            )
            break

    return parsed


def _build_untracked_file_lines(path: str, max_lines: int = GIT_DIFF_MAX_LINES_PER_FILE) -> List[Dict[str, Any]]:
    workdir_real = os.path.realpath(WORKDIR)
    file_path = os.path.realpath(os.path.join(WORKDIR, path))

    if not (file_path == workdir_real or file_path.startswith(workdir_real + os.sep)):
        return [{"type": "hunk", "text": "Invalid path outside repository.", "oldLine": None, "newLine": None}]

    if not os.path.exists(file_path):
        return [{"type": "hunk", "text": "File not found in working tree.", "oldLine": None, "newLine": None}]

    try:
        with open(file_path, "rb") as handle:
            content = handle.read()
    except Exception as exc:
        return [{"type": "hunk", "text": f"Unable to read file: {exc}", "oldLine": None, "newLine": None}]

    if b"\x00" in content:
        return [{"type": "hunk", "text": "Binary file added.", "oldLine": None, "newLine": None}]

    lines = content.decode("utf-8", errors="replace").splitlines()
    parsed: List[Dict[str, Any]] = [
        {"type": "hunk", "text": f"@@ -0,0 +1,{len(lines)} @@", "oldLine": None, "newLine": None}
    ]

    if not lines:
        parsed.append({"type": "add", "text": "", "oldLine": None, "newLine": 1})
        return parsed

    for line_number, line_text in enumerate(lines[:max_lines], start=1):
        parsed.append({"type": "add", "text": line_text, "oldLine": None, "newLine": line_number})

    if len(lines) > max_lines:
        parsed.append(
            {
                "type": "hunk",
                "text": f"... file truncated to {max_lines} lines ...",
                "oldLine": None,
                "newLine": None,
            }
        )

    return parsed


def _build_file_diff(path: str, status: str, unified: int) -> Dict[str, Any]:
    lines: List[Dict[str, Any]] = []

    if status == "added":
        tracked_check = _run_git_command(["ls-files", "--error-unmatch", "--", path], timeout_seconds=5)
        if tracked_check.returncode == 0:
            diff_result = _run_git_command(
                ["diff", "--no-color", f"--unified={unified}", "HEAD", "--", path],
                timeout_seconds=20,
            )
            if diff_result.returncode == 0:
                lines = _parse_unified_diff(diff_result.stdout)
            else:
                lines = [{"type": "hunk", "text": "Unable to render file diff.", "oldLine": None, "newLine": None}]
        else:
            lines = _build_untracked_file_lines(path)
    else:
        diff_result = _run_git_command(
            ["diff", "--no-color", f"--unified={unified}", "HEAD", "--", path],
            timeout_seconds=20,
        )
        if diff_result.returncode == 0:
            lines = _parse_unified_diff(diff_result.stdout)
        else:
            lines = [{"type": "hunk", "text": "Unable to render file diff.", "oldLine": None, "newLine": None}]

    if not lines:
        if status == "deleted":
            lines = [{"type": "hunk", "text": "File deleted with no textual hunks.", "oldLine": None, "newLine": None}]
        elif status == "added":
            lines = [{"type": "hunk", "text": "New file with no textual content.", "oldLine": None, "newLine": None}]
        else:
            lines = [{"type": "hunk", "text": "No textual diff available.", "oldLine": None, "newLine": None}]

    additions = sum(1 for line in lines if line.get("type") == "add")
    deletions = sum(1 for line in lines if line.get("type") == "remove")

    return {
        "path": path,
        "status": status,
        "additions": additions,
        "deletions": deletions,
        "lines": lines,
    }


def _resolve_repo_path(relative_path: str) -> Optional[str]:
    """Resolve repository-relative file path and block traversal outside WORKDIR."""
    if not relative_path:
        return None

    normalized = relative_path.strip().replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
        return None

    repo_root = os.path.realpath(WORKDIR)
    target = os.path.realpath(os.path.join(WORKDIR, normalized))

    if target == repo_root or target.startswith(repo_root + os.sep):
        return target
    return None


@app.get("/git/diff")
async def get_repo_diff(
    unified: int = Query(3, ge=0, le=12, description="Unified context lines per diff hunk"),
    limit: int = Query(GIT_DIFF_DEFAULT_FILE_LIMIT, ge=1, le=500, description="Maximum number of files to return"),
):
    """Return the repository diff for changed files in the current workdir."""
    if not _is_git_repo():
        return {"repo_path": WORKDIR, "head": None, "files": []}

    head_result = _run_git_command(["rev-parse", "--short", "HEAD"], timeout_seconds=5)
    head = head_result.stdout.strip() if head_result.returncode == 0 else None

    try:
        changed_files = _collect_changed_files(limit)
    except Exception as exc:
        logger.error(f"Failed to collect git diff files: {exc}")
        raise HTTPException(status_code=500, detail="Failed to load repository diff")

    files = [_build_file_diff(item["path"], item["status"], unified) for item in changed_files]
    return {"repo_path": WORKDIR, "head": head, "files": files}


@app.get("/git/files")
async def get_repo_files(
    limit: int = Query(GIT_FILES_DEFAULT_LIMIT, ge=1, le=20000, description="Maximum number of files to return"),
):
    """Return repository files for file explorer mode."""
    if not _is_git_repo():
        return {"repo_path": WORKDIR, "files": []}

    files_result = _run_git_command(
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        timeout_seconds=20,
    )
    if files_result.returncode != 0:
        logger.error(f"Failed to list git files: {files_result.stderr.strip()}")
        raise HTTPException(status_code=500, detail="Failed to list repository files")

    files = sorted({path for path in files_result.stdout.split("\x00") if path})
    return {"repo_path": WORKDIR, "files": files[:limit]}


@app.get("/git/file")
async def get_repo_file(
    path: str = Query(..., description="Repository-relative file path"),
    max_bytes: int = Query(
        GIT_FILE_MAX_BYTES,
        ge=1024,
        le=500000,
        description="Maximum bytes to read",
    ),
):
    """Return text content for a repository file."""
    if not _is_git_repo():
        raise HTTPException(status_code=404, detail="Not a git repository")

    resolved = _resolve_repo_path(path)
    if not resolved:
        raise HTTPException(status_code=400, detail="Invalid file path")

    if not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="File not found")
    if os.path.isdir(resolved):
        raise HTTPException(status_code=400, detail="Path is a directory")

    try:
        with open(resolved, "rb") as handle:
            data = handle.read(max_bytes + 1)
    except Exception as exc:
        logger.error(f"Failed to read file {path}: {exc}")
        raise HTTPException(status_code=500, detail="Failed to read file")

    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]

    if b"\x00" in data:
        return {"path": path, "content": "", "binary": True, "truncated": truncated}

    return {
        "path": path,
        "content": data.decode("utf-8", errors="replace"),
        "binary": False,
        "truncated": truncated,
    }


def _build_chat_content(req: ChatRequest) -> str:
    wild_mode_note = ""
    if req.wild_mode:
        # Build Ralph-style loop prompt
        iteration = wild_loop_state.get("iteration", 0) + 1
        goal = wild_loop_state.get("goal") or "No specific goal set"
        max_iter = wild_loop_state.get("termination", {}).get("max_iterations")
        custom_cond = wild_loop_state.get("termination", {}).get("custom_condition")

        # Build experiment state summary
        experiment_context = _build_experiment_context()

        iter_display = f"{iteration}"
        if max_iter:
            iter_display += f" / {max_iter}"
        else:
            iter_display += " (unlimited)"

        # Include sweep_id so the agent associates runs with this wild loop
        sweep_id = wild_loop_state.get("sweep_id")
        sweep_note = ""
        if sweep_id:
            sweep_note = (
                f"\n## Active Wild Sweep\n"
                f"Sweep ID: `{sweep_id}` — When creating new runs, use `sweep_id=\"{sweep_id}\"` "
                f"so they are tracked as part of this wild loop session.\n"
            )

        wild_mode_note = (
            f"# Wild Loop — Iteration {iter_display}\n\n"
            f"You are in an autonomous experiment loop. Work on the goal below until you can genuinely complete it.\n\n"
            f"## Your Goal\n{goal}\n\n"
            f"{experiment_context}\n"
            f"{sweep_note}"
            f"## Instructions\n"
            f"1. Read the current state of runs, sweeps, and alerts above\n"
            f"2. Plan what work remains to achieve the goal\n"
            f"3. Take action: create runs, start sweeps, analyze results, fix failures\n"
            f"4. If you launched runs, WAIT for them — output CONTINUE and check results next iteration\n"
            f"5. Run verification: check logs, metrics, and run status before claiming completion\n"
            f"6. At the END of your response, output exactly ONE promise tag:\n"
            f"   - `<promise>CONTINUE</promise>` — DEFAULT. Use this if you did anything or are waiting for results\n"
            f"   - `<promise>COMPLETE</promise>` — ONLY when goal is fully verified with evidence\n"
            f"   - `<promise>NEEDS_HUMAN</promise>` — if you need human intervention\n\n"
            f"## Critical Rules\n"
            f"- When in doubt, output CONTINUE. It is always safe to continue.\n"
            f"- Creating or launching runs is NOT completion — you must check their results\n"
            f"- ONLY output COMPLETE when you have verified evidence the goal is achieved\n"
            f"- Do NOT declare COMPLETE just because you took an action — verify it worked\n"
            f"- If stuck, try a different approach\n"
            f"- The loop will continue until you succeed or are stopped\n"
        )
        if custom_cond:
            wild_mode_note += f"- Custom stop condition: {custom_cond}\n"
        wild_mode_note += "\nNow, work on the goal. Good luck!\n\n"
    return f"{wild_mode_note}[USER] {req.message}"


def _append_assistant_message(
    session_id: str,
    stream_id: str,
    *,
    full_text: str,
    full_thinking: str,
    parts: list[dict[str, Any]],
) -> bool:
    if session_id not in chat_sessions:
        return False

    has_payload = bool(full_text or full_thinking or parts)
    if not has_payload:
        return False

    session = chat_sessions[session_id]
    messages = session.setdefault("messages", [])
    for existing in messages:
        if isinstance(existing, dict) and existing.get("stream_id") == stream_id:
            return True

    assistant_msg = {
        "role": "assistant",
        "content": full_text.strip(),
        "thinking": full_thinking.strip() if full_thinking else None,
        "parts": parts if parts else None,
        "timestamp": time.time(),
        "stream_id": stream_id,
    }
    messages.append(assistant_msg)
    save_chat_state()
    return True


def _rebuild_output_from_stream_log(stream_file: str) -> tuple[str, str, list[dict[str, Any]], Optional[str]]:
    full_text = ""
    full_thinking = ""
    terminal_status: Optional[str] = None
    parts_accumulator = StreamPartsAccumulator()
    for event in _iter_chat_stream_events(stream_file) or []:
        etype = event.get("type")
        ptype = event.get("ptype")

        if etype == "part_delta":
            delta = event.get("delta", "")
            if ptype == "text":
                full_text += delta
            elif ptype == "reasoning":
                full_thinking += delta
        parts_accumulator.consume(event)

        if etype == "session_status" and event.get("status") == "idle":
            terminal_status = "completed"
        elif etype == "error":
            terminal_status = "error"
        elif etype == "session_status" and event.get("status") == "stopped":
            terminal_status = "stopped"

    return full_text, full_thinking, parts_accumulator.finalize(), terminal_status


def recover_uncommitted_chat_streams():
    """Recover persisted stream logs after server restart."""
    changed_stream_state = False
    for stream_id, stream in chat_streams.items():
        if not isinstance(stream, dict):
            continue
        if stream.get("assistant_committed"):
            continue

        stream_file = stream.get("stream_file")
        session_id = stream.get("session_id")
        if not isinstance(stream_file, str) or not stream_file:
            continue
        if not isinstance(session_id, str) or session_id not in chat_sessions:
            continue
        if not os.path.exists(stream_file):
            continue

        full_text, full_thinking, parts, terminal_status = _rebuild_output_from_stream_log(stream_file)
        if terminal_status == "completed":
            committed = _append_assistant_message(
                session_id,
                stream_id,
                full_text=full_text,
                full_thinking=full_thinking,
                parts=parts,
            )
            stream["assistant_committed"] = bool(committed) or stream.get("assistant_committed", False)
            stream["status"] = "completed"
            stream["completed_at"] = stream.get("completed_at") or time.time()
            stream["updated_at"] = time.time()
            changed_stream_state = True
        elif terminal_status == "error":
            stream["status"] = "error"
            stream["completed_at"] = stream.get("completed_at") or time.time()
            stream["updated_at"] = time.time()
            changed_stream_state = True
        elif terminal_status == "stopped":
            stream["status"] = "stopped"
            stream["completed_at"] = stream.get("completed_at") or time.time()
            stream["updated_at"] = time.time()
            changed_stream_state = True

    if changed_stream_state:
        save_chat_streams_state()


def _set_chat_stream_status(
    stream_id: str,
    *,
    status: str,
    error: Optional[str] = None,
    started_at: Optional[float] = None,
    completed_at: Optional[float] = None,
    assistant_committed: Optional[bool] = None,
    opencode_session_id: Optional[str] = None,
):
    stream = chat_streams.get(stream_id)
    if not stream:
        return
    stream["status"] = status
    stream["updated_at"] = time.time()
    if started_at is not None:
        stream["started_at"] = started_at
    if completed_at is not None:
        stream["completed_at"] = completed_at
    if error is not None:
        stream["error"] = error
    if assistant_committed is not None:
        stream["assistant_committed"] = assistant_committed
    if opencode_session_id is not None:
        stream["opencode_session_id"] = opencode_session_id
    save_chat_streams_state()


async def _run_chat_stream(stream_id: str, session_id: str, content: str):
    """Background task that runs OpenCode and appends events to disk."""
    session_stop_flags.pop(session_id, None)
    started_at = time.time()
    _set_chat_stream_status(stream_id, status="running", started_at=started_at)

    full_text = ""
    full_thinking = ""
    stopped = False
    parts_accumulator = StreamPartsAccumulator()

    try:
        opencode_session_id = await get_opencode_session_for_chat(session_id)
        _set_chat_stream_status(stream_id, status="running", opencode_session_id=opencode_session_id)

        async with httpx.AsyncClient(timeout=None) as client:
            logger.debug("Sending prompt to OpenCode session %s", opencode_session_id)
            logger.debug("Content: %s", content)
            await send_prompt_to_opencode(client, opencode_session_id, content)
            logger.debug("Sent prompt to OpenCode session")

            logger.debug("Start streaming events from OpenCode session")
            async for event, text_delta, thinking_delta, _tool_update in stream_opencode_events(client, opencode_session_id):
                if should_stop_session(session_id):
                    stopped = True
                    break

                full_text += text_delta
                full_thinking += thinking_delta
                parts_accumulator.consume(event)

                event_to_persist = {k: v for k, v in event.items() if not k.startswith("_")}
                _append_chat_stream_event(stream_id, event_to_persist)

            logger.debug("End streaming events from OpenCode session")

        if stopped:
            # Emit a terminal status so reconnecting clients stop tailing cleanly.
            _append_chat_stream_event(stream_id, {"type": "session_status", "status": "stopped"}, persist_state=True)

        parts = parts_accumulator.finalize()
        committed = _append_assistant_message(
            session_id,
            stream_id,
            full_text=full_text,
            full_thinking=full_thinking,
            parts=parts,
        )

        final_status = "stopped" if stopped else "completed"
        _set_chat_stream_status(
            stream_id,
            status=final_status,
            completed_at=time.time(),
            assistant_committed=committed,
        )
    except asyncio.CancelledError:
        logger.info("Chat stream cancelled for session %s", session_id)
        _append_chat_stream_event(stream_id, {"type": "session_status", "status": "stopped"}, persist_state=True)
        parts = parts_accumulator.finalize()
        committed = _append_assistant_message(
            session_id,
            stream_id,
            full_text=full_text,
            full_thinking=full_thinking,
            parts=parts,
        )
        _set_chat_stream_status(
            stream_id,
            status="stopped",
            completed_at=time.time(),
            assistant_committed=committed,
        )
    except Exception as e:
        logger.error(f"Chat error: {e}", exc_info=True)
        _append_chat_stream_event(stream_id, {"type": "error", "message": str(e)}, persist_state=True)
        _set_chat_stream_status(
            stream_id,
            status="error",
            error=str(e),
            completed_at=time.time(),
            assistant_committed=False,
        )
    finally:
        # Keep auto-alert behavior intact: only clear this slot if this is still
        # the tracked task for the session.
        tracked_task = active_chat_tasks.get(session_id)
        if tracked_task is asyncio.current_task():
            active_chat_tasks.pop(session_id, None)
        if active_chat_stream_by_session.get(session_id) == stream_id:
            active_chat_stream_by_session.pop(session_id, None)
        session_stop_flags.pop(session_id, None)


def _create_chat_stream_task(session_id: str, content: str) -> str:
    stream_id = uuid.uuid4().hex[:12]
    stream_file = _chat_stream_log_path(stream_id)
    created_at = time.time()
    stream = {
        "id": stream_id,
        "session_id": session_id,
        "status": "queued",
        "stream_file": stream_file,
        "created_at": created_at,
        "updated_at": created_at,
        "started_at": None,
        "completed_at": None,
        "error": None,
        "last_event_seq": 0,
        "assistant_committed": False,
        "opencode_session_id": None,
    }
    chat_streams[stream_id] = stream
    active_chat_stream_by_session[session_id] = stream_id
    os.makedirs(os.path.dirname(stream_file), exist_ok=True)
    with open(stream_file, "a", encoding="utf-8"):
        pass
    save_chat_streams_state()

    task = asyncio.create_task(_run_chat_stream(stream_id, session_id, content))
    active_chat_tasks[session_id] = task
    return stream_id


def _resolve_stream_for_session(session_id: str, stream_id: Optional[str] = None) -> Optional[dict]:
    if stream_id:
        stream = chat_streams.get(stream_id)
        if not stream or stream.get("session_id") != session_id:
            return None
        return stream

    active_stream = _find_active_stream_for_session(session_id)
    if active_stream:
        return active_stream
    return _find_latest_stream_for_session(session_id)


async def _chat_stream_log_generator(stream_id: str, cursor: int = 0, follow: bool = True):
    stream = chat_streams.get(stream_id)
    if not stream:
        yield json.dumps({"type": "error", "message": "Stream not found"}) + "\n"
        return

    stream_file = stream.get("stream_file")
    if not isinstance(stream_file, str) or not os.path.exists(stream_file):
        yield json.dumps({"type": "error", "message": "Stream log not found"}) + "\n"
        return

    try:
        total_size = os.path.getsize(stream_file)
    except Exception:
        total_size = 0
    cursor = max(0, min(cursor, total_size))

    with open(stream_file, "r", encoding="utf-8", errors="replace") as f:
        f.seek(cursor)
        while True:
            line = f.readline()
            if line:
                if line.endswith("\n"):
                    yield line
                else:
                    yield line + "\n"
                continue

            current_status = chat_streams.get(stream_id, {}).get("status")
            if not follow or _chat_stream_status_is_terminal(current_status):
                break
            await asyncio.sleep(0.2)


@app.get("/sessions")
async def list_sessions():
    """List all chat sessions."""
    sessions = [
        {
            "id": sid,
            "title": session.get("title", "New Chat"),
            "created_at": session.get("created_at"),
            "message_count": len(session.get("messages", []))
        }
        for sid, session in chat_sessions.items()
    ]
    sessions.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return sessions


@app.post("/sessions")
async def create_session(req: Optional[CreateSessionRequest] = None):
    """Create a new chat session."""
    session_id = uuid.uuid4().hex[:12]
    title = req.title if req and req.title else "New Chat"
    chat_sessions[session_id] = {
        "title": title,
        "created_at": time.time(),
        "messages": [],
        "opencode_session_id": None
    }
    save_chat_state()
    return {"id": session_id, "title": title, "created_at": chat_sessions[session_id]["created_at"], "message_count": 0}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a chat session with all messages."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    active_stream = _find_active_stream_for_session(session_id)
    latest_stream = _find_latest_stream_for_session(session_id)
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", []),
        "active_stream": _serialize_chat_stream_summary(active_stream),
        "latest_stream": _serialize_chat_stream_summary(latest_stream),
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    # Stop any active stream first.
    session_stop_flags[session_id] = True
    active_task = active_chat_tasks.get(session_id)
    if active_task and not active_task.done():
        active_task.cancel()

    # Remove stream metadata/logs for this session.
    for stream_id, stream in list(chat_streams.items()):
        if not isinstance(stream, dict) or stream.get("session_id") != session_id:
            continue
        stream_file = stream.get("stream_file")
        if isinstance(stream_file, str) and os.path.exists(stream_file):
            try:
                os.remove(stream_file)
            except Exception as e:
                logger.warning(f"Failed to remove stream log {stream_file}: {e}")
        chat_streams.pop(stream_id, None)
    active_chat_stream_by_session.pop(session_id, None)
    save_chat_streams_state()

    del chat_sessions[session_id]
    save_chat_state()
    return {"message": "Session deleted"}


@app.get("/sessions/{session_id}/stream/status")
async def get_chat_stream_status(session_id: str):
    """Return active/latest stream metadata for reconnecting clients."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    active_stream = _find_active_stream_for_session(session_id)
    latest_stream = _find_latest_stream_for_session(session_id)
    return {
        "active_stream": _serialize_chat_stream_summary(active_stream),
        "latest_stream": _serialize_chat_stream_summary(latest_stream),
    }


@app.get("/sessions/{session_id}/stream")
async def stream_session_chat(
    session_id: str,
    stream_id: Optional[str] = Query(None, description="Specific stream ID to attach to"),
    cursor: int = Query(0, ge=0, description="Byte offset in the NDJSON stream log"),
    follow: bool = Query(True, description="Keep tailing while stream is active"),
):
    """Replay/tail a persisted chat stream log for reconnection catch-up."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    stream = _resolve_stream_for_session(session_id, stream_id=stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="No stream found for this session")

    resolved_stream_id = stream.get("id")
    if not isinstance(resolved_stream_id, str) or not resolved_stream_id:
        raise HTTPException(status_code=500, detail="Stream metadata is invalid")

    return StreamingResponse(
        _chat_stream_log_generator(resolved_stream_id, cursor=cursor, follow=follow),
        media_type="application/x-ndjson",
    )


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message and attach the client to a persisted chat stream log."""
    session_id = req.session_id
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    active_stream = _find_active_stream_for_session(session_id)
    if active_stream:
        active_id = active_stream.get("id")
        raise HTTPException(
            status_code=409,
            detail=f"Session already has an active stream ({active_id})",
        )

    session = chat_sessions[session_id]
    messages = session.get("messages", [])
    user_msg = {"role": "user", "content": req.message, "timestamp": time.time()}
    messages.append(user_msg)
    session["messages"] = messages
    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")
    save_chat_state()

    content = _build_chat_content(req)
    stream_id = _create_chat_stream_task(session_id, content)
    return StreamingResponse(
        _chat_stream_log_generator(stream_id, cursor=0, follow=True),
        media_type="application/x-ndjson",
    )


@app.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    """Stop streaming for a session (including auto-alert tasks)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session_stop_flags[session_id] = True
    active_stream = _find_active_stream_for_session(session_id)
    if active_stream:
        active_stream_id = active_stream.get("id")
        if isinstance(active_stream_id, str) and active_stream_id:
            _set_chat_stream_status(active_stream_id, status="stopping")

    task = active_chat_tasks.get(session_id)
    if task and not task.done():
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

    return {
        "message": "Stop signal sent",
        "stream_id": active_stream.get("id") if active_stream else None,
    }


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
        result.append({"id": run_id, **run})
    
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
    
    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": req.workdir or WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": req.sweep_id,
        "parent_run_id": req.parent_run_id,
        "origin_alert_id": req.origin_alert_id,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }
    
    runs[run_id] = run_data
    _sync_run_membership_with_sweep(run_id, req.sweep_id)
    save_runs_state()
    
    logger.info(f"Created run {run_id}: {req.name} (status: {initial_status})")
    return {"id": run_id, **run_data}


@app.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Get run details."""
    _reconcile_all_run_terminal_states()
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"id": run_id, **runs[run_id]}


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
    
    try:
        tmux_window = launch_run_in_tmux(run_id, run)
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

    new_run = {
        "name": f"{source_run.get('name', 'Run')} (Rerun)",
        "command": new_command,
        "workdir": source_run.get("workdir") or WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": source_run.get("sweep_id"),
        "parent_run_id": run_id,
        "origin_alert_id": req.origin_alert_id if req else None,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    runs[new_run_id] = new_run
    _sync_run_membership_with_sweep(new_run_id, new_run.get("sweep_id"))
    save_runs_state()

    if initial_status == "queued":
        try:
            launch_run_in_tmux(new_run_id, new_run)
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

    if wild_mode_enabled:
        session_id = uuid.uuid4().hex[:12]
        chat_sessions[session_id] = {
            "title": f"Alert: {runs[run_id].get('name', run_id)}",
            "created_at": time.time(),
            "messages": [],
            "opencode_session_id": None
        }
        alert_payload["session_id"] = session_id
        alert_payload["auto_session"] = True
        save_chat_state()

        async def auto_alert_chat():
            active_chat_tasks[session_id] = asyncio.current_task()
            session_stop_flags.pop(session_id, None)
            try:
                run_data = runs.get(run_id, {})
                user_visible_message = (
                    f"Resolve alert {alert_id} for {run_data.get('name', run_id)}. "
                    f"Severity: {severity}. Message: {req.message}"
                )
                prompt = (
                    "[SYSTEM] Wild mode is ON. Be proactive and resolve the alert if safe.\n"
                    "You are handling an experiment alert. Provide a concise diagnosis, "
                    "suggest actions, and propose a response from the allowed choices.\n\n"
                    f"[USER] Alert ID: {alert_id}\n"
                    f"Run: {run_data.get('name', run_id)}\n"
                    f"Command: {run_data.get('command', '')}\n"
                    f"Severity: {severity}\n"
                    f"Message: {req.message}\n"
                    f"Choices: {', '.join(req.choices)}\n"
                    "If a rerun is needed, explain why and what you would change."
                )

                user_msg = {"role": "user", "content": user_visible_message, "timestamp": time.time()}
                chat_sessions[session_id]["messages"].append(user_msg)
                save_chat_state()

                opencode_session_id = await get_opencode_session_for_chat(session_id)
                full_text, full_thinking, parts = await run_opencode_session(session_id, opencode_session_id, prompt)
                if full_text or full_thinking or parts:
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_text.strip(),
                        "thinking": full_thinking.strip() if full_thinking else None,
                        "parts": parts if parts else None,
                        "timestamp": time.time()
                    }
                    chat_sessions[session_id]["messages"].append(assistant_msg)
                    save_chat_state()
            except asyncio.CancelledError:
                logger.info("Auto alert chat cancelled for session %s", session_id)
            except Exception as e:
                # Log error and store an error message in the session so users can see what went wrong
                logger.error(f"Auto alert chat failed for session {session_id}: {e}", exc_info=True)
                error_msg = {
                    "role": "assistant",
                    "content": f"[Error] Failed to process alert automatically: {str(e)}",
                    "timestamp": time.time()
                }
                chat_sessions[session_id]["messages"].append(error_msg)
                save_chat_state()
            finally:
                active_chat_tasks.pop(session_id, None)
                session_stop_flags.pop(session_id, None)

        asyncio.create_task(auto_alert_chat())

    active_alerts[alert_id] = alert_payload
    save_alerts_state()
    logger.info(f"Created alert {alert_id} for run {run_id}: {req.message}")
    return {"alert_id": alert_id}


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

    run_dir = run.get("run_dir") or os.path.join(DATA_DIR, "runs", run_id)
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


@app.get("/wild/status")
async def get_wild_status():
    """Get the current wild loop state."""
    return wild_loop_state


@app.post("/wild/status")
async def update_wild_status(phase: str = None, iteration: int = None,
                             goal: str = None, session_id: str = None,
                             is_paused: bool = None):
    """Update wild loop state from frontend."""
    if phase is not None:
        wild_loop_state["phase"] = phase
    if iteration is not None:
        wild_loop_state["iteration"] = iteration
    if goal is not None:
        wild_loop_state["goal"] = goal
    if session_id is not None:
        wild_loop_state["session_id"] = session_id
    if is_paused is not None:
        wild_loop_state["is_paused"] = is_paused
    if phase == "idle":
        wild_loop_state["started_at"] = None
    elif wild_loop_state["started_at"] is None and phase not in ["idle", "complete"]:
        wild_loop_state["started_at"] = time.time()
    save_settings_state()
    return wild_loop_state


@app.post("/wild/configure")
async def configure_wild_loop(req: WildLoopConfigRequest):
    """Configure wild loop termination conditions and goal."""
    if req.goal is not None:
        wild_loop_state["goal"] = req.goal
    if req.session_id is not None:
        wild_loop_state["session_id"] = req.session_id
    termination = wild_loop_state["termination"]
    if req.max_iterations is not None:
        termination["max_iterations"] = req.max_iterations
    if req.max_time_seconds is not None:
        termination["max_time_seconds"] = req.max_time_seconds
    if req.max_tokens is not None:
        termination["max_tokens"] = req.max_tokens
    if req.custom_condition is not None:
        termination["custom_condition"] = req.custom_condition
    save_settings_state()
    return wild_loop_state


@app.get("/cluster")
async def get_cluster_state():
    """Get the persisted cluster state and current run summary."""
    return {"cluster": cluster_state, "run_summary": _current_run_summary()}


@app.post("/cluster/detect")
async def detect_cluster(req: Optional[ClusterDetectRequest] = None):
    """Auto-detect cluster setup, or apply a user-specified preferred type."""
    global cluster_state

    detected = _infer_cluster_from_environment()
    preferred_type = _normalize_cluster_type(req.preferred_type) if req else "unknown"

    if preferred_type != "unknown":
        now = time.time()
        detected["type"] = preferred_type
        detected["source"] = "manual"
        detected["status"] = "healthy"
        detected["label"] = _cluster_type_label(preferred_type)
        detected["description"] = _cluster_type_description(preferred_type)
        detected["confidence"] = 1.0
        detected["updated_at"] = now
        detected["last_detected_at"] = now

    cluster_state = _normalize_cluster_state(detected)
    save_settings_state()
    return {"cluster": cluster_state, "run_summary": _current_run_summary()}


@app.post("/cluster")
async def update_cluster_state(req: ClusterUpdateRequest):
    """Update persisted cluster metadata with user-provided values."""
    global cluster_state

    now = time.time()
    payload = req.model_dump(exclude_unset=True)
    next_state = dict(cluster_state)

    if "type" in payload:
        raw_type = payload.get("type")
        normalized_type = _normalize_cluster_type(raw_type)
        if raw_type and normalized_type == "unknown" and raw_type.strip().lower() not in {"unknown", "unset"}:
            raise HTTPException(status_code=400, detail=f"Unsupported cluster type: {raw_type}")
        next_state["type"] = normalized_type
        next_state["label"] = _cluster_type_label(normalized_type)
        next_state["description"] = _cluster_type_description(normalized_type)

    if "status" in payload:
        raw_status = payload.get("status")
        normalized_status = _normalize_cluster_status(raw_status)
        if raw_status and normalized_status == "unknown" and raw_status.strip().lower() != "unknown":
            raise HTTPException(status_code=400, detail=f"Unsupported cluster status: {raw_status}")
        next_state["status"] = normalized_status

    if "source" in payload:
        raw_source = payload.get("source")
        normalized_source = _normalize_cluster_source(raw_source)
        if raw_source and normalized_source == "unset" and raw_source.strip().lower() != "unset":
            raise HTTPException(status_code=400, detail=f"Unsupported cluster source: {raw_source}")
        next_state["source"] = normalized_source
    else:
        next_state["source"] = "manual"

    if "head_node" in payload:
        next_state["head_node"] = payload.get("head_node")
    if "node_count" in payload:
        next_state["node_count"] = payload.get("node_count")
    if "gpu_count" in payload:
        next_state["gpu_count"] = payload.get("gpu_count")
    if "notes" in payload:
        next_state["notes"] = payload.get("notes")
    if "details" in payload:
        next_state["details"] = payload.get("details") if isinstance(payload.get("details"), dict) else {}

    next_state["updated_at"] = now
    cluster_state = _normalize_cluster_state(next_state)
    save_settings_state()
    return {"cluster": cluster_state, "run_summary": _current_run_summary()}


def _build_experiment_context() -> str:
    """Build a summary of current experiment state for the wild mode prompt."""
    lines = ["\n--- Current Experiment State ---"]
    recompute_all_sweep_states()

    # Active runs
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

    # Sweeps
    active_sweeps = [{"id": sid, **s} for sid, s in sweeps.items()]
    if active_sweeps:
        lines.append(f"Sweeps: {len(active_sweeps)}")
        for s in active_sweeps[:3]:
            p = s.get("progress", {})
            lines.append(f"  - {s['id']}: {s.get('name', '?')} "
                         f"[{p.get('completed', 0)}/{p.get('total', 0)} done, {p.get('failed', 0)} failed]")

    # Pending alerts
    pending_alerts = [a for a in active_alerts.values() if a.get("status") == "pending"]
    if pending_alerts:
        lines.append(f"Pending alerts: {len(pending_alerts)}")
        for a in pending_alerts[:3]:
            lines.append(f"  - {a['id']}: [{a.get('severity')}] {a.get('message', '')[:80]}")

    # Goal
    if wild_loop_state.get("goal"):
        lines.append(f"Goal: {wild_loop_state['goal']}")

    lines.append("--- End State ---\n")
    return "\n".join(lines)


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
    return f"{base_command} {param_str}"


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
        "workdir": WORKDIR,
        "parameters": {},
        "run_ids": [],
        "status": "pending",
        "created_at": created_at,
        "goal": req.goal,
        "is_wild": True,
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
    wild_loop_state["sweep_id"] = sweep_id
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
            "workdir": req.workdir or WORKDIR,
            "parameters": req.parameters or {},
            "run_ids": [],
            "status": "draft",
            "created_at": created_at,
            "goal": req.goal,
            "max_runs": req.max_runs,
            "ui_config": req.ui_config,
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
            "workdir": req.workdir or WORKDIR,
            "status": "queued" if requested_status == "running" else "ready",
            "created_at": time.time(),
            "is_archived": False,
            "sweep_id": sweep_id,
            "sweep_params": params,
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
        "workdir": req.workdir or WORKDIR,
        "parameters": req.parameters,
        "run_ids": run_ids,
        "status": "running" if requested_status == "running" else "pending",
        "created_at": created_at,
        "goal": req.goal,
        "max_runs": req.max_runs,
        "ui_config": req.ui_config,
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
    structural_update_requested = any(
        field is not None
        for field in [req.base_command, req.parameters, req.max_runs]
    )

    # Keep running sweeps immutable to avoid mutating active experiments in place.
    if current_status == "running" and structural_update_requested:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot modify base command/parameters/max_runs while sweep is running. "
                "Create a draft revision and launch it as a new sweep."
            ),
        )

    if sweep.get("run_ids") and structural_update_requested:
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
        sweep["base_command"] = req.base_command
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
# Log Endpoints
# =============================================================================

@app.get("/runs/{run_id}/logs")
async def get_run_logs(
    run_id: str,
    offset: int = Query(-10000, description="Byte offset. Negative = from end."),
    limit: int = Query(10000, description="Max bytes to return (max 100KB)")
):
    """Get run logs with byte-offset pagination."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    
    if not run_dir:
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    
    log_file = os.path.join(run_dir, "run.log")
    if not os.path.exists(log_file):
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    
    # Cap limit at 100KB
    limit = min(limit, 100 * 1024)
    
    try:
        total_size = os.path.getsize(log_file)
        
        # Calculate actual offset
        if offset < 0:
            actual_offset = max(0, total_size + offset)
        else:
            actual_offset = min(offset, total_size)
        
        with open(log_file, "r", errors="replace") as f:
            f.seek(actual_offset)
            content = f.read(limit)
        
        bytes_read = len(content.encode('utf-8'))
        end_offset = actual_offset + bytes_read
        
        return {
            "content": content,
            "offset": actual_offset,
            "total_size": total_size,
            "has_more_before": actual_offset > 0,
            "has_more_after": end_offset < total_size
        }
    except Exception as e:
        logger.error(f"Error reading logs for {run_id}: {e}")
        return {"content": f"Error reading logs: {e}", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}


@app.get("/runs/{run_id}/logs/stream")
async def stream_run_logs(run_id: str):
    """Stream run logs via SSE."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    
    async def log_generator():
        if not run_dir:
            yield f"data: {json.dumps({'error': 'No run directory'})}\n\n"
            return
        
        log_file = os.path.join(run_dir, "run.log")
        last_size = 0
        
        # Send initial content
        if os.path.exists(log_file):
            with open(log_file, "r", errors="replace") as f:
                content = f.read()
                last_size = len(content.encode('utf-8'))
                yield f"data: {json.dumps({'type': 'initial', 'content': content})}\n\n"
        
        # Stream updates
        while True:
            await asyncio.sleep(0.5)
            
            # Check if run is still active
            current_run = runs.get(run_id, {})
            if current_run.get("status") in ["finished", "failed", "stopped"]:
                # Send final content and close
                if os.path.exists(log_file):
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        if new_content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'status': current_run.get('status')})}\n\n"
                break
            
            # Check for new content
            if os.path.exists(log_file):
                current_size = os.path.getsize(log_file)
                if current_size > last_size:
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        last_size = current_size
                        yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
    
    return StreamingResponse(log_generator(), media_type="text/event-stream")


# =============================================================================
# Artifact Endpoints
# =============================================================================

@app.get("/runs/{run_id}/artifacts")
async def list_artifacts(run_id: str):
    """List artifacts for a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    artifacts = []
    
    if run_dir:
        artifacts_dir = os.path.join(run_dir, "artifacts")
        if os.path.exists(artifacts_dir):
            for name in os.listdir(artifacts_dir):
                path = os.path.join(artifacts_dir, name)
                # Resolve symlinks to get actual path
                actual_path = os.path.realpath(path) if os.path.islink(path) else path
                artifacts.append({
                    "name": name,
                    "path": actual_path,
                    "type": "other"  # TODO: detect type
                })
    
    # Add wandb_dir if present
    if run.get("wandb_dir"):
        artifacts.append({
            "name": "wandb",
            "path": run["wandb_dir"],
            "type": "wandb"
        })
    
    return artifacts


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
        logger.warning("⚠️  RESEARCH_AGENT_KEY environment variable is not set!")
        logger.warning("   The Anthropic gateway requires this for authentication.")
        logger.warning("   Set it with: export RESEARCH_AGENT_KEY=your-gateway-token")
    
    if not USER_AUTH_TOKEN:
        logger.warning("⚠️  RESEARCH_AGENT_USER_AUTH_TOKEN is not set!")
        logger.warning("   Your server has NO authentication - anyone can access it.")
        logger.warning("   For secure remote access, generate a token with:")
        logger.warning("     ./generate_auth_token.sh")
        logger.warning("   Then set: export RESEARCH_AGENT_USER_AUTH_TOKEN=<token>")
    
    # Start OpenCode server subprocess
    # start_opencode_server_subprocess(args)
    
    # Load state
    load_chat_state()
    load_chat_streams_state()
    recover_uncommitted_chat_streams()
    load_runs_state()
    load_alerts_state()
    load_settings_state()
    if cluster_state.get("source") == "unset":
        inferred = _infer_cluster_from_environment()
        cluster_state.update(_normalize_cluster_state(inferred))
        save_settings_state()
    maybe_mount_frontend_static()
    
    logger.info(f"Starting Research Agent Server on {args.host}:{args.port}")
    logger.info(f"Working directory: {WORKDIR}")
    
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
