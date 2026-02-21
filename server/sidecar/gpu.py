"""GPU detection, conflict patterns, and retry logic for the job sidecar."""

import json
import logging
import os
import re
import subprocess
import sys

from sidecar.server_api import trigger_alert

logger = logging.getLogger("job-sidecar")

# ---------------------------------------------------------------------------
# GPU conflict detection patterns
# ---------------------------------------------------------------------------

GPU_CONFLICT_PATTERNS = (
    re.compile(r"all CUDA-capable devices are busy or unavailable", re.IGNORECASE),
    re.compile(r"CUDA error:.*busy", re.IGNORECASE),
    re.compile(r"device or resource busy", re.IGNORECASE),
    re.compile(r"CUDA out of memory", re.IGNORECASE),
    re.compile(r"CUBLAS_STATUS_ALLOC_FAILED", re.IGNORECASE),
    re.compile(r"failed to allocate memory on device", re.IGNORECASE),
)


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(value)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _resolve_sidecar_script(name: str) -> str | None:
    """Resolve helper script path in source and frozen modes."""
    candidates = []
    base_dir = os.path.dirname(os.path.abspath(__file__))
    # Scripts live in tools/, go up from sidecar/ to server/, then into tools/
    server_dir = os.path.dirname(base_dir)
    candidates.append(os.path.join(server_dir, "tools", name))
    frozen_dir = getattr(sys, "_MEIPASS", None)
    if frozen_dir:
        candidates.append(os.path.join(frozen_dir, name))

    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def _read_log_tail_since(log_file: str, start_offset: int, max_bytes: int = 60000) -> str:
    if not os.path.isfile(log_file):
        return ""
    try:
        with open(log_file, "rb") as f:
            f.seek(start_offset)
            chunk = f.read()
    except Exception:
        return ""
    if len(chunk) > max_bytes:
        chunk = chunk[-max_bytes:]
    return chunk.decode("utf-8", errors="ignore")


def _looks_like_gpu_conflict(log_tail: str) -> bool:
    for pattern in GPU_CONFLICT_PATTERNS:
        if pattern.search(log_tail):
            return True
    return False


# ---------------------------------------------------------------------------
# GPU wrap settings
# ---------------------------------------------------------------------------

def resolve_gpuwrap_settings(gpuwrap_config: dict | None) -> dict:
    config = gpuwrap_config if isinstance(gpuwrap_config, dict) else {}
    enabled = _truthy(config["enabled"]) if "enabled" in config else False
    raw_retries = config.get("retries", _env_int("RESEARCH_AGENT_GPUWRAP_RETRIES", -1))
    retries: int | None = None  # unlimited by default
    if raw_retries is not None and int(raw_retries) >= 0:
        retries = int(raw_retries)
    retry_delay_seconds = float(config.get("retry_delay_seconds", _env_float("RESEARCH_AGENT_GPUWRAP_RETRY_DELAY_SECONDS", 5.0)))
    return {
        "enabled": enabled,
        "retries": retries,
        "retry_delay_seconds": max(0.1, retry_delay_seconds),
    }


# ---------------------------------------------------------------------------
# GPU detection
# ---------------------------------------------------------------------------

def detect_available_cuda_devices(settings: dict) -> tuple[str, dict | None]:
    detect_script = _resolve_sidecar_script("gpuwrap_detect.py")
    if not detect_script:
        logger.warning("gpuwrap_detect.py not found; falling back to direct command execution")
        return "", None

    cmd = [
        sys.executable,
        detect_script,
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except Exception as e:
        logger.warning("Failed to run gpu detector: %s", e)
        return "", None

    if res.returncode != 0:
        logger.warning("gpu detector failed: %s", (res.stderr or "").strip())
        return "", None

    try:
        payload = json.loads((res.stdout or "").strip() or "{}")
    except json.JSONDecodeError:
        logger.warning("gpu detector returned non-json output")
        return "", None

    if not isinstance(payload, dict):
        return "", None
    cuda_visible_devices = str(payload.get("cuda_visible_devices", "")).strip()
    return cuda_visible_devices, payload


# ---------------------------------------------------------------------------
# GPU retry alert
# ---------------------------------------------------------------------------

def emit_gpu_retry_alert(
    server_url: str,
    job_id: str,
    attempt: int,
    total_attempts: int | None,
    reason: str,
    auth_token: str | None = None,
) -> None:
    if total_attempts is None:
        attempt_label = f"attempt {attempt}"
    else:
        attempt_label = f"attempt {attempt}/{total_attempts}"
    trigger_alert(
        server_url=server_url,
        job_id=job_id,
        message=(
            f"GPU contention detected ({reason}). "
            f"Auto-retrying {attempt_label}."
        ),
        choices=["Acknowledge"],
        severity="warning",
        auth_token=auth_token,
    )
