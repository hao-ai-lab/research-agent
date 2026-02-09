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
JOBS_DATA_FILE = ""
ALERTS_DATA_FILE = ""
SETTINGS_DATA_FILE = ""
TMUX_SESSION_NAME = os.environ.get("RESEARCH_AGENT_TMUX_SESSION", "research-agent")
SERVER_CALLBACK_URL = "http://127.0.0.1:10000"
FRONTEND_STATIC_DIR = os.environ.get("RESEARCH_AGENT_FRONTEND_DIR", "").strip()

AUTH_PROTECTED_PREFIXES = (
    "/sessions",
    "/chat",
    "/runs",
    "/alerts",
    "/wild",
    "/sweeps",
    "/cluster",
)


def requires_api_auth(path: str) -> bool:
    """Only enforce auth token on API routes."""
    for prefix in AUTH_PROTECTED_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def init_paths(workdir: str):
    """Initialize all paths based on workdir."""
    global WORKDIR, DATA_DIR, CHAT_DATA_FILE, JOBS_DATA_FILE, ALERTS_DATA_FILE, SETTINGS_DATA_FILE
    WORKDIR = os.path.abspath(workdir)
    DATA_DIR = os.path.join(WORKDIR, ".agents")
    CHAT_DATA_FILE = os.path.join(DATA_DIR, "chat_data.json")
    JOBS_DATA_FILE = os.path.join(DATA_DIR, "jobs.json")
    ALERTS_DATA_FILE = os.path.join(DATA_DIR, "alerts.json")
    SETTINGS_DATA_FILE = os.path.join(DATA_DIR, "settings.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "runs"), exist_ok=True)
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
                for sweep in sweeps.values():
                    sweep["status"] = _normalize_sweep_status(sweep.get("status"))
                recompute_all_sweep_states()
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


async def run_opencode_session(chat_session_id: str, opencode_session_id: str, content: str) -> tuple[str, str, list]:
    """Run a prompt and return full text, thinking, and ordered parts."""
    full_text = ""
    full_thinking = ""
    parts = []
    async with httpx.AsyncClient(timeout=None) as client:
        await send_prompt_to_opencode(client, opencode_session_id, content)
        async for event, text_delta, thinking_delta in stream_opencode_events(client, opencode_session_id):
            if should_stop_session(chat_session_id):
                break
            full_text += text_delta
            full_thinking += thinking_delta

            part_id = event.get("id")
            ptype = event.get("ptype")

            if part_id and ptype:
                existing_part = next((p for p in parts if p["id"] == part_id), None)
                if ptype in ("text", "reasoning"):
                    part_type = "thinking" if ptype == "reasoning" else "text"
                    delta = event.get("delta", "")
                    if existing_part:
                        existing_part["content"] += delta
                    else:
                        parts.append({
                            "id": part_id,
                            "type": part_type,
                            "content": delta
                        })
                elif ptype == "tool":
                    if existing_part:
                        existing_part["tool_state"] = event.get("state")
                        if event.get("name"):
                            existing_part["tool_name"] = event.get("name")
                    else:
                        parts.append({
                            "id": part_id,
                            "type": "tool",
                            "content": "",
                            "tool_name": event.get("name"),
                            "tool_state": event.get("state")
                        })

    return full_text, full_thinking, parts


def parse_opencode_event(event_data: dict, target_session_id: str) -> Optional[dict]:
    """Parse an OpenCode SSE event and translate it to our protocol."""
    payload = event_data.get("payload", {})
    etype = payload.get("type", "")
    props = payload.get("properties", {})
    part = props.get("part", {})
    
    event_sid = props.get("sessionID") or part.get("sessionID")
    if event_sid != target_session_id:
        return None
    
    if etype == "message.part.updated":
        ptype = part.get("type")
        delta = props.get("delta", "")
        
        if ptype == "text":
            return {"type": "part_delta", "id": part.get("id"), "ptype": "text", "delta": delta}
        elif ptype == "reasoning":
            return {"type": "part_delta", "id": part.get("id"), "ptype": "reasoning", "delta": delta}
        elif ptype == "tool":
            return {"type": "part_update", "id": part.get("id"), "ptype": "tool", "state": part.get("state"), "name": part.get("name")}
    
    elif etype == "session.status":
        if props.get("status", {}).get("type") == "idle":
            return {"type": "session_status", "status": "idle", "_done": True}
    
    return None


async def stream_opencode_events(client: httpx.AsyncClient, session_id: str) -> AsyncIterator[tuple]:
    """Stream events from OpenCode and yield parsed events."""
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
                if translated.get("ptype") == "text":
                    text_delta = translated.get("delta", "")
                elif translated.get("ptype") == "reasoning":
                    thinking_delta = translated.get("delta", "")
                
                yield translated, text_delta, thinking_delta
                
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
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", [])
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del chat_sessions[session_id]
    save_chat_state()
    return {"message": "Session deleted"}


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message and receive streaming response."""
    session_id = req.session_id
    
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = chat_sessions[session_id]
    messages = session.get("messages", [])
    
    user_msg = {"role": "user", "content": req.message, "timestamp": time.time()}
    messages.append(user_msg)
    session["messages"] = messages
    
    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")
    
    save_chat_state()

    async def response_generator():
        session_stop_flags.pop(session_id, None)
        active_chat_tasks[session_id] = asyncio.current_task()
        try:
            opencode_session_id = await get_opencode_session_for_chat(session_id)
            
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
            content = f"{wild_mode_note}[USER] {req.message}"

            async with httpx.AsyncClient(timeout=None) as client:
                logger.debug("Sending prompt to OpenCode session %s", opencode_session_id)
                logger.debug("Content: %s", content)
                await send_prompt_to_opencode(client, opencode_session_id, content)
                logger.debug("Sent prompt to OpenCode session")
                
                full_text = ""
                full_thinking = ""
                parts = []  # Track ordered parts by ID
                
                logger.debug("Start streaming events from OpenCode session")
                async for event, text_delta, thinking_delta in stream_opencode_events(client, opencode_session_id):
                    if should_stop_session(session_id):
                        break
                    full_text += text_delta
                    full_thinking += thinking_delta
                    
                    # Track parts by ID
                    part_id = event.get("id")
                    ptype = event.get("ptype")
                    
                    if part_id and ptype:
                        # Find existing part or create new one
                        existing_part = next((p for p in parts if p["id"] == part_id), None)
                        
                        if ptype in ("text", "reasoning"):
                            part_type = "thinking" if ptype == "reasoning" else "text"
                            delta = event.get("delta", "")
                            if existing_part:
                                existing_part["content"] += delta
                            else:
                                parts.append({
                                    "id": part_id,
                                    "type": part_type,
                                    "content": delta
                                })
                        elif ptype == "tool":
                            if existing_part:
                                # Update tool state
                                existing_part["tool_state"] = event.get("state")
                                if event.get("name"):
                                    existing_part["tool_name"] = event.get("name")
                            else:
                                parts.append({
                                    "id": part_id,
                                    "type": "tool",
                                    "content": "",
                                    "tool_name": event.get("name"),
                                    "tool_state": event.get("state")
                                })
                    
                    event_to_send = {k: v for k, v in event.items() if not k.startswith("_")}
                    logger.debug("Event: %s", event_to_send)
                    yield json.dumps(event_to_send) + "\n"

                logger.debug("End streaming events from OpenCode session")
                if full_text or full_thinking or parts:
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_text.strip(),
                        "thinking": full_thinking.strip() if full_thinking else None,
                        "parts": parts if parts else None,  # NEW: store ordered parts
                        "timestamp": time.time()
                    }
                    session["messages"].append(assistant_msg)
                    save_chat_state()

        except asyncio.CancelledError:
            logger.info("Chat stream cancelled for session %s", session_id)
        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"
        finally:
            active_chat_tasks.pop(session_id, None)
            session_stop_flags.pop(session_id, None)

    return StreamingResponse(response_generator(), media_type="application/x-ndjson")


@app.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    """Stop streaming for a session (including auto-alert tasks)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session_stop_flags[session_id] = True
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
    result = []
    for sweep_id, sweep in sweeps.items():
        result.append({"id": sweep_id, **sweep})
    
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
    
    sweep_data = {
        "name": req.name,
        "base_command": "",
        "workdir": WORKDIR,
        "parameters": {},
        "run_ids": [],
        "status": "pending",
        "created_at": time.time(),
        "goal": req.goal,
        "is_wild": True,
        "ui_config": None,
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

    # Create draft sweep without materializing runs
    if requested_status == "draft":
        sweep_data = {
            "name": req.name,
            "base_command": req.base_command,
            "workdir": req.workdir or WORKDIR,
            "parameters": req.parameters or {},
            "run_ids": [],
            "status": "draft",
            "created_at": time.time(),
            "goal": req.goal,
            "ui_config": req.ui_config,
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
        "created_at": time.time(),
        "goal": req.goal,
        "ui_config": req.ui_config,
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
