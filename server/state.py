"""
Research Agent Server — State Management

Global state dictionaries, save/load persistence functions, and cluster
state helpers. Extracted from server.py.
"""

import asyncio
import glob
import json
import logging
import math
import os
import time
import uuid
from typing import Any, Dict, Optional

import config

logger = logging.getLogger("research-agent-server")

# =============================================================================
# Global State Dictionaries
# =============================================================================

chat_sessions: Dict[str, dict] = {}
runs: Dict[str, dict] = {}
sweeps: Dict[str, dict] = {}
active_alerts: Dict[str, dict] = {}
plans: Dict[str, dict] = {}
journey_events: Dict[str, dict] = {}
journey_recommendations: Dict[str, dict] = {}
journey_decisions: Dict[str, dict] = {}
wild_mode_enabled: bool = False
session_stop_flags: Dict[str, bool] = {}
active_chat_tasks: Dict[str, asyncio.Task] = {}
active_chat_streams: Dict[str, Any] = {}  # Dict[str, ChatStreamRuntime] — forward ref

_wandb_metrics_cache: Dict[str, dict] = {}



# =============================================================================
# Cluster Constants + State
# =============================================================================

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


# =============================================================================
# Metrics / WandB Constants
# =============================================================================

STREAM_SNAPSHOT_SAVE_INTERVAL_SECONDS = 0.75
STREAM_SNAPSHOT_SAVE_INTERVAL_EVENTS = 20
STREAM_RUNTIME_RETENTION_SECONDS = 120.0

LOSS_KEYS = ("loss", "train/loss", "train_loss", "training_loss")
VAL_LOSS_KEYS = ("val/loss", "val_loss", "validation/loss", "eval/loss", "valid/loss")
ACCURACY_KEYS = ("accuracy", "val/accuracy", "eval/accuracy", "train/accuracy", "acc")
EPOCH_KEYS = ("epoch", "train/epoch")
STEP_KEYS = ("step", "_step", "global_step", "trainer/global_step")
MAX_HISTORY_POINTS = 400
MAX_METRIC_SERIES_KEYS = 200
IGNORED_METRIC_KEYS = set(STEP_KEYS) | {
    "_runtime",
    "_timestamp",
    "_wall_time",
    "_timestamp_step",
}


# =============================================================================
# Save / Load Functions
# =============================================================================

def save_chat_state():
    """Persist chat sessions to disk."""
    try:
        with open(config.CHAT_DATA_FILE, "w") as f:
            json.dump({"chat_sessions": chat_sessions}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving chat state: {e}")


def load_chat_state():
    """Load chat sessions from disk."""
    global chat_sessions
    if os.path.exists(config.CHAT_DATA_FILE):
        try:
            with open(config.CHAT_DATA_FILE, "r") as f:
                data = json.load(f)
                chat_sessions = data.get("chat_sessions", {})
                for session in chat_sessions.values():
                    if not isinstance(session, dict):
                        continue
                    active_stream = session.get("active_stream")
                    if isinstance(active_stream, dict) and active_stream.get("status") == "running":
                        # Streaming workers are in-memory only; mark stale snapshots as interrupted on restart.
                        active_stream["status"] = "interrupted"
        except Exception as e:
            logger.error(f"Error loading chat state: {e}")


def save_runs_state():
    """Persist runs and sweeps to disk."""
    try:
        with open(config.JOBS_DATA_FILE, "w") as f:
            json.dump({"runs": runs, "sweeps": sweeps}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving runs state: {e}")


def save_alerts_state():
    """Persist active alerts to disk."""
    try:
        with open(config.ALERTS_DATA_FILE, "w") as f:
            json.dump({"alerts": list(active_alerts.values())}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving alerts state: {e}")


def load_alerts_state():
    """Load active alerts from disk."""
    global active_alerts
    if os.path.exists(config.ALERTS_DATA_FILE):
        try:
            with open(config.ALERTS_DATA_FILE, "r") as f:
                data = json.load(f)
                loaded = data.get("alerts", [])
                active_alerts = {
                    alert["id"]: alert
                    for alert in loaded
                    if isinstance(alert, dict) and alert.get("id")
                }
        except Exception as e:
            logger.error(f"Error loading alerts state: {e}")


def save_plans_state():
    """Persist plans to disk."""
    try:
        with open(config.PLANS_DATA_FILE, "w") as f:
            json.dump({"plans": list(plans.values())}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving plans state: {e}")


def load_plans_state():
    """Load plans from disk."""
    global plans
    if os.path.exists(config.PLANS_DATA_FILE):
        try:
            with open(config.PLANS_DATA_FILE, "r") as f:
                data = json.load(f)
                loaded = data.get("plans", [])
                plans = {
                    plan["id"]: plan
                    for plan in loaded
                    if isinstance(plan, dict) and plan.get("id")
                }
        except Exception as e:
            logger.error(f"Error loading plans state: {e}")


def save_journey_state():
    """Persist journey events/recommendations/decisions to disk."""
    try:
        with open(config.JOURNEY_STATE_FILE, "w") as f:
            json.dump(
                {
                    "events": list(journey_events.values()),
                    "recommendations": list(journey_recommendations.values()),
                    "decisions": list(journey_decisions.values()),
                },
                f,
                indent=2,
                default=str,
            )
    except Exception as e:
        logger.error(f"Error saving journey state: {e}")


def load_journey_state():
    """Load journey events/recommendations/decisions from disk."""
    global journey_events, journey_recommendations, journey_decisions
    if os.path.exists(config.JOURNEY_STATE_FILE):
        try:
            with open(config.JOURNEY_STATE_FILE, "r") as f:
                data = json.load(f)
                loaded_events = data.get("events", [])
                loaded_recommendations = data.get("recommendations", [])
                loaded_decisions = data.get("decisions", [])
                journey_events = {
                    item["id"]: item
                    for item in loaded_events
                    if isinstance(item, dict) and item.get("id")
                }
                journey_recommendations = {
                    item["id"]: item
                    for item in loaded_recommendations
                    if isinstance(item, dict) and item.get("id")
                }
                journey_decisions = {
                    item["id"]: item
                    for item in loaded_decisions
                    if isinstance(item, dict) and item.get("id")
                }
        except Exception as e:
            logger.error(f"Error loading journey state: {e}")


# =============================================================================
# Journey Helpers
# =============================================================================

def _journey_new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# =============================================================================
# Metrics Helpers
# =============================================================================

def _to_float(value: object) -> Optional[float]:
    """Convert primitive numeric values to float."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    if isinstance(value, str):
        try:
            converted = float(value.strip())
            return converted if math.isfinite(converted) else None
        except ValueError:
            return None
    return None


def _first_numeric(row: dict, keys: tuple[str, ...]) -> Optional[float]:
    for key in keys:
        if key in row:
            value = _to_float(row.get(key))
            if value is not None:
                return value
    return None


def _extract_step(row: dict, fallback_step: int) -> int:
    step = _first_numeric(row, STEP_KEYS)
    if step is None:
        return fallback_step
    if step < 0:
        return fallback_step
    return int(step)


def _is_metric_key(key: object) -> bool:
    if not isinstance(key, str) or not key:
        return False
    if key in IGNORED_METRIC_KEYS:
        return False
    # W&B internal metadata keys are usually underscore-prefixed.
    if key.startswith("_"):
        return False
    return True


def _find_wandb_dir_from_run_dir(run_dir: Optional[str]) -> Optional[str]:
    """Scan the predictable wandb_data/ path inside run_dir for a WandB run directory."""
    if not run_dir:
        return None
    wandb_base = os.path.join(run_dir, "wandb_data", "wandb")
    if not os.path.isdir(wandb_base):
        return None
    matches = sorted(glob.glob(os.path.join(wandb_base, "run-*")))
    return matches[-1] if matches else None


def _resolve_metrics_file(wandb_dir: Optional[str]) -> Optional[str]:
    """Resolve likely metrics file paths from a wandb run directory."""
    if not wandb_dir:
        return None

    base_path = wandb_dir
    if not os.path.isabs(base_path):
        base_path = os.path.join(config.WORKDIR, base_path)

    if os.path.isfile(base_path):
        return base_path if base_path.endswith(".jsonl") else None
    if not os.path.isdir(base_path):
        return None

    candidates = [
        os.path.join(base_path, "metrics.jsonl"),
        os.path.join(base_path, "files", "metrics.jsonl"),
        os.path.join(base_path, "wandb-history.jsonl"),
        os.path.join(base_path, "files", "wandb-history.jsonl"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _downsample_history(history: list[dict], max_points: int = MAX_HISTORY_POINTS) -> list[dict]:
    if len(history) <= max_points:
        return history
    stride = max(1, math.ceil(len(history) / max_points))
    sampled = history[::stride]
    if sampled[-1] != history[-1]:
        sampled.append(history[-1])
    return sampled[:max_points]

