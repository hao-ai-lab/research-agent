"""Alert detection and response for the job sidecar.

Includes:
  - Rule-based alerts for hard metric anomalies (NaN/Inf, high loss, spikes)
  - LLM-based alert judge for softer anomalies
  - Alert application and manual trigger paths
"""

import hashlib
import json
import logging
import math
import os
import re
import subprocess
import time

from sidecar.server_api import (
    trigger_alert,
    wait_for_response,
    should_stop_from_choice,
)
from sidecar.metrics import read_recent_metrics

logger = logging.getLogger("job-sidecar")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LOSS_ALERT_THRESHOLD = 8.0
LOSS_SPIKE_MULTIPLIER = 3.0
RULE_MIN_PREV_POINTS = 3
AGENT_JUDGE_INTERVAL = 30
AGENT_JUDGE_MAX_LINES = 5
AGENT_JUDGE_MAX_BYTES = 8000
ALERT_SIGNATURE_TTL_SECONDS = 180

# Module-level caches for alert judge rate-limiting
_last_metrics_pos: dict[str, int] = {}
_last_judge_check: dict[str, float] = {}


# ---------------------------------------------------------------------------
# Signature deduplication
# ---------------------------------------------------------------------------

def seen_recent_signature(
    state: dict,
    namespace: str,
    signature: str,
    ttl_seconds: int = ALERT_SIGNATURE_TTL_SECONDS,
) -> bool:
    """Dedupe alerts by signature in-memory for a short window."""
    now = time.time()
    recent = state.setdefault("recent_signatures", {})
    key = f"{namespace}:{signature}"
    previous = recent.get(key)
    if previous and now - previous < ttl_seconds:
        return True
    recent[key] = now
    return False


# ---------------------------------------------------------------------------
# Loss extraction
# ---------------------------------------------------------------------------

def extract_loss(metrics: dict) -> float | None:
    """Extract common training loss keys from a metrics row."""
    for key in ("loss", "train/loss", "train_loss", "training_loss"):
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


# ---------------------------------------------------------------------------
# Rule-based alerts
# ---------------------------------------------------------------------------

def rulebased_alerts(job_id: str, wandb_dir: str, state: dict) -> dict | None:
    """Deterministic alerts for hard metric anomalies."""
    metrics_path = os.path.join(wandb_dir, "metrics.jsonl")
    rows = read_recent_metrics(metrics_path, max_lines=25, max_bytes=24000)
    entries: list[tuple[object, float]] = []
    for row in rows:
        loss = extract_loss(row)
        if loss is None:
            continue
        entries.append((row.get("step"), float(loss)))

    if not entries:
        return None

    finite_entries = [(step, loss) for step, loss in entries if math.isfinite(loss)]
    has_non_finite = len(finite_entries) != len(entries)
    if has_non_finite:
        signature = "nan-inf"
        if seen_recent_signature(state, "rulebased", signature):
            return None
        return {
            "action": "alert",
            "message": "Training loss became NaN/Inf. This run is unstable.",
            "severity": "critical",
            "choices": ["Ignore", "Stop Job"],
            "source": "rulebased",
            "signature": signature,
        }

    current_step, current = finite_entries[-1]
    previous = [loss for _, loss in finite_entries[:-1]]
    mean_prev = (sum(previous) / len(previous)) if previous else 0.0

    high_entry: tuple[object, float] | None = None
    if finite_entries:
        max_entry = max(finite_entries, key=lambda item: item[1])
        if max_entry[1] >= LOSS_ALERT_THRESHOLD:
            high_entry = max_entry

    is_high = high_entry is not None
    is_spike = (
        len(previous) >= RULE_MIN_PREV_POINTS
        and mean_prev > 0
        and current >= mean_prev * LOSS_SPIKE_MULTIPLIER
    )
    if not (is_high or is_spike):
        return None

    if is_high:
        high_step, high_loss = high_entry
        signature = f"high:{round(high_loss, 4)}"
        step_prefix = f"step={high_step}, " if isinstance(high_step, (int, float)) else ""
        message = (
            f"High loss detected ({step_prefix}loss={high_loss:.4f}, "
            f"threshold={LOSS_ALERT_THRESHOLD:.1f})."
        )
    else:
        signature = f"spike:{round(current, 4)}:{round(mean_prev, 4)}"
        message = f"Loss spike detected (loss={current:.4f}, rolling_avg={mean_prev:.4f})."

    if seen_recent_signature(state, "rulebased", signature):
        return None

    return {
        "action": "alert",
        "message": message,
        "severity": "warning",
        "choices": ["Ignore", "Stop Job"],
        "source": "rulebased",
        "signature": signature,
    }


# ---------------------------------------------------------------------------
# LLM-based alert judge
# ---------------------------------------------------------------------------

def should_run_alert_judge(job_id: str, metrics_file: str) -> bool:
    file_size = os.path.getsize(metrics_file)
    last_size = _last_metrics_pos.get(job_id, 0)
    if file_size < last_size:
        last_size = 0
    if file_size == last_size:
        return False
    _last_metrics_pos[job_id] = file_size

    now = time.time()
    last_check = _last_judge_check.get(job_id, 0.0)
    if now - last_check < AGENT_JUDGE_INTERVAL:
        return False
    _last_judge_check[job_id] = now
    return True


def parse_alert_judge_decision(output: str) -> dict | None:
    if not output or "NOTHING" in output:
        return {"action": "ignore"}
    match = re.search(r"\{.*\}", output, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None

    action = data.get("action")
    if action not in {"alert", "ignore"}:
        return None
    message = (data.get("message") or "").strip()
    severity = (data.get("severity") or "warning").strip().lower()
    if severity not in {"info", "warning", "critical"}:
        severity = "warning"
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        choices = ["Ignore", "Stop Job"]
    return {
        "action": action,
        "message": message,
        "severity": severity,
        "choices": choices,
    }


def run_alert_judge(context: str, workdir: str | None = None) -> dict | None:
    prompt = (
        "[SYSTEM] You are an ML training alert judge. "
        "Decide if this update warrants interrupting a human. "
        "Return ONLY JSON with keys: action ('alert'|'ignore'), "
        "message (string), severity (info|warning|critical), choices (list of strings). "
        "If action is ignore, keep message empty.\n"
        f"Context:\n{context}"
    )
    cmd = ["opencode", "run", "--model", "opencode/minimax-m2.5-free", prompt]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=workdir or None,
        )
    except FileNotFoundError:
        logger.warning("opencode CLI not found; skipping alert_judge.")
        return None
    except Exception as e:
        logger.warning("alert_judge execution failed: %s", e)
        return None

    output = (res.stdout or "").strip()
    logger.info("alert_judge output: %s", output)
    return parse_alert_judge_decision(output)


def alert_judge(job_id: str, wandb_dir: str, workdir: str, state: dict) -> dict:
    """LLM-based alert gate for softer anomalies."""
    metrics_file = os.path.join(wandb_dir, "metrics.jsonl")
    if not os.path.exists(metrics_file):
        return {"action": "ignore"}
    if not should_run_alert_judge(job_id, metrics_file):
        return {"action": "ignore"}

    recent_metrics = read_recent_metrics(
        metrics_file,
        max_lines=AGENT_JUDGE_MAX_LINES,
        max_bytes=AGENT_JUDGE_MAX_BYTES,
    )
    if not recent_metrics:
        return {"action": "ignore"}

    context_blob = {
        "event": "metrics_update",
        "metrics_file": metrics_file,
        "recent_metrics": recent_metrics,
    }
    decision = run_alert_judge(json.dumps(context_blob, ensure_ascii=True), workdir)
    if not decision or decision.get("action") != "alert":
        return {"action": "ignore"}

    message = (decision.get("message") or "Metric anomaly detected.").strip()
    if len(message) > 600:
        message = f"{message[:597]}..."
    signature = hashlib.sha1(message.encode("utf-8")).hexdigest()
    if seen_recent_signature(state, "alert_judge", signature):
        return {"action": "ignore"}

    return {
        "action": "alert",
        "message": message,
        "severity": decision.get("severity") or "warning",
        "choices": decision.get("choices") or ["Ignore", "Stop Job"],
        "source": "alert_judge",
        "signature": signature,
    }


# ---------------------------------------------------------------------------
# Alert application helpers
# ---------------------------------------------------------------------------

def maybe_trigger_manual_alert(
    server_url: str,
    job_id: str,
    workdir: str,
    run_dir: str,
    auth_token: str | None = None,
) -> bool:
    """Manual trigger path for testing alert flow."""
    trigger_file = os.path.join(workdir, "tests", "story", "trigger_alert")
    # Only treat a regular file as a manual trigger sentinel.
    if not os.path.isfile(trigger_file):
        return False

    try:
        os.remove(trigger_file)
    except Exception:
        return False

    alert_id = trigger_alert(
        server_url=server_url,
        job_id=job_id,
        message="Manual Trigger Detected",
        choices=["Ignore", "Stop Job"],
        severity="warning",
        auth_token=auth_token,
    )
    if not alert_id:
        return False

    response = wait_for_response(run_dir, alert_id)
    logger.info("Manual alert response: %s", response)
    return should_stop_from_choice(response)


def apply_alert_decision(
    server_url: str,
    job_id: str,
    run_dir: str,
    decision: dict | None,
    auth_token: str | None = None,
) -> bool:
    if not decision or decision.get("action") != "alert":
        return False

    message = decision.get("message") or "Metric anomaly detected."
    source = decision.get("source") or "alerts"
    logger.warning("%s produced alert: %s", source, message)

    alert_id = trigger_alert(
        server_url=server_url,
        job_id=job_id,
        message=message,
        choices=decision.get("choices") or ["Ignore", "Stop Job"],
        severity=decision.get("severity") or "warning",
        auth_token=auth_token,
    )
    if not alert_id:
        return False

    response = wait_for_response(run_dir, alert_id)
    logger.info("Alert response (%s): %s", source, response)
    return should_stop_from_choice(response)
