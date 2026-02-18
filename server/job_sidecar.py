#!/usr/bin/env python3
"""
Job Sidecar - Manages job execution in tmux

This script is spawned by the server in a tmux window to:
1. Create a separate pane for the actual job
2. Execute the command with output capture
3. Monitor completion and report status back to server
"""

import argparse
import glob
import json
import logging
import os
import re
import shlex
import sys
import time
import math
import hashlib
import subprocess
import requests
import libtmux

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("job-sidecar")

LOSS_ALERT_THRESHOLD = 8.0
LOSS_SPIKE_MULTIPLIER = 3.0
RULE_MIN_PREV_POINTS = 3
AGENT_JUDGE_INTERVAL = 30
AGENT_JUDGE_MAX_LINES = 5
AGENT_JUDGE_MAX_BYTES = 8000
ALERT_SIGNATURE_TTL_SECONDS = 180
_last_metrics_pos: dict[str, int] = {}
_last_judge_check: dict[str, float] = {}


def _auth_headers(auth_token: str | None) -> dict:
    if not auth_token:
        return {}
    return {"X-Auth-Token": auth_token}


def report_status(
    server_url: str,
    job_id: str,
    status: str,
    extra_data: dict = None,
    auth_token: str | None = None,
):
    """Report status update to server."""
    data = {"status": status}
    if extra_data:
        data.update(extra_data)
    
    try:
        logger.info(f"Reporting status: {status} with data: {extra_data}")
        requests.post(
            f"{server_url}/runs/{job_id}/status",
            json=data,
            headers=_auth_headers(auth_token),
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Failed to report status: {e}")


def trigger_alert(
    server_url: str,
    job_id: str,
    message: str,
    choices: list[str],
    severity: str = "warning",
    auth_token: str | None = None,
) -> str | None:
    """Create alert via server and return alert_id."""
    payload = {
        "message": message,
        "choices": choices,
        "severity": severity,
    }
    try:
        logger.info("Triggering alert: %s", message)
        res = requests.post(
            f"{server_url}/runs/{job_id}/alerts",
            json=payload,
            headers=_auth_headers(auth_token),
            timeout=5,
        )
        if res.status_code == 200:
            data = res.json()
            return data.get("alert_id")
        logger.warning("Alert creation failed (%s): %s", res.status_code, res.text)
    except Exception as e:
        logger.warning("Alert creation error: %s", e)
    return None


def wait_for_response(run_dir: str, alert_id: str, timeout_seconds: int = 600) -> str | None:
    """Wait for alert response file from server."""
    response_file = os.path.join(run_dir, "alerts", f"{alert_id}.response")
    deadline = time.time() + timeout_seconds
    logger.info("Waiting for response file: %s", response_file)

    while time.time() < deadline:
        if os.path.exists(response_file):
            try:
                with open(response_file, "r") as f:
                    return f.read().strip()
            except Exception:
                pass
        time.sleep(2)

    logger.info("Timed out waiting for alert response (%s)", alert_id)
    return None


def should_stop_from_choice(choice: str | None) -> bool:
    if not choice:
        return False
    lowered = choice.lower()
    return "stop" in lowered or "kill" in lowered or "terminate" in lowered


def read_recent_metrics(metrics_path: str, max_lines: int = 25, max_bytes: int = 24000) -> list[dict]:
    """Read recent metrics.jsonl lines, tolerating partial writes."""
    if not os.path.exists(metrics_path):
        return []

    try:
        size = os.path.getsize(metrics_path)
        start = max(0, size - max_bytes)
        with open(metrics_path, "r") as f:
            f.seek(start)
            chunk = f.read()
    except Exception as e:
        logger.warning("Failed to read metrics file %s: %s", metrics_path, e)
        return []

    lines = [ln for ln in chunk.splitlines() if ln.strip()]
    parsed: list[dict] = []
    for line in lines[-max_lines:]:
        try:
            data = json.loads(line)
            if isinstance(data, dict):
                parsed.append(data)
        except json.JSONDecodeError:
            continue
    return parsed


def extract_loss(metrics: dict) -> float | None:
    """Extract common training loss keys from a metrics row."""
    for key in ("loss", "train/loss", "train_loss", "training_loss"):
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None

def seen_recent_signature(state: dict, namespace: str, signature: str, ttl_seconds: int = ALERT_SIGNATURE_TTL_SECONDS) -> bool:
    """Dedupe alerts by signature in-memory for a short window."""
    now = time.time()
    recent = state.setdefault("recent_signatures", {})
    key = f"{namespace}:{signature}"
    previous = recent.get(key)
    if previous and now - previous < ttl_seconds:
        return True
    recent[key] = now
    return False

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
    cmd = ["opencode", "run", "--model", "opencode/kimi-k2.5-free", prompt]
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


def get_current_pane():
    """Find the tmux pane where this sidecar is running."""
    pane_id = os.environ.get("TMUX_PANE")
    if not pane_id:
        return None
    
    try:
        server = libtmux.Server()
        for session in server.sessions:
            for window in session.windows:
                for pane in window.panes:
                    if pane.pane_id == pane_id:
                        return pane
    except Exception as e:
        logger.error(f"Error finding current pane: {e}")
    return None


def find_wandb_dir_in_rundir(run_dir: str, job_id: str) -> str | None:
    """Scan the predictable WANDB_DIR location for a WandB run directory.

    When we set WANDB_DIR={run_dir}/wandb_data before the user command,
    WandB creates:
      Online:  {run_dir}/wandb_data/wandb/run-{timestamp}-{run_id}/files/
      Offline: {run_dir}/wandb_data/wandb/offline-run-{timestamp}-{run_id}/files/
    """
    wandb_base = os.path.join(run_dir, "wandb_data", "wandb")
    if not os.path.isdir(wandb_base):
        return None
    # Look for run dirs matching our job_id (both online and offline)
    for prefix in ("run", "offline-run"):
        pattern = os.path.join(wandb_base, f"{prefix}-*-{job_id}")
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]  # latest
    # Fallback: any run dir at all (single-run case)
    for prefix in ("run", "offline-run"):
        pattern_any = os.path.join(wandb_base, f"{prefix}-*")
        matches_any = sorted(glob.glob(pattern_any))
        if matches_any:
            return matches_any[-1]
    return None


def _resolve_wandb_metrics_source(wandb_dir: str) -> tuple[str | None, str]:
    """Find the metrics source inside a wandb run directory.

    Returns (path, kind) where kind is "jsonl" or "wandb_binary".
    Prefers JSONL if available; falls back to the binary .wandb protobuf file.
    """
    # 1. Check for JSONL files (online runs, or custom setups)
    jsonl_candidates = [
        os.path.join(wandb_dir, "metrics.jsonl"),
        os.path.join(wandb_dir, "files", "metrics.jsonl"),
        os.path.join(wandb_dir, "wandb-history.jsonl"),
        os.path.join(wandb_dir, "files", "wandb-history.jsonl"),
    ]
    for path in jsonl_candidates:
        if os.path.isfile(path):
            logger.info(f"[metrics] Resolved JSONL metrics file: {path}")
            return path, "jsonl"

    # 2. Check for binary .wandb file (offline runs)
    #    The wandb_dir may point to the run dir or its files/ subdir,
    #    so also search the parent directory.
    search_dirs = [wandb_dir]
    parent = os.path.dirname(wandb_dir)
    if parent and parent != wandb_dir:
        search_dirs.append(parent)
    for d in search_dirs:
        wandb_files = sorted(glob.glob(os.path.join(d, "*.wandb")))
        if wandb_files:
            path = wandb_files[-1]  # latest
            logger.info(f"[metrics] Resolved binary .wandb file: {path}")
            return path, "wandb_binary"

    logger.debug(f"[metrics] No metrics source found in {wandb_dir}")
    return None, ""


def _read_wandb_binary_history(
    wandb_file: str, records_read: int
) -> tuple[list[dict], int]:
    """Read history rows from a binary .wandb protobuf file.

    Uses the wandb SDK DataStore to scan records incrementally.
    ``records_read`` is the total number of records already consumed;
    we skip that many on each call so only new rows are returned.

    Returns (rows, new_records_read).
    """
    try:
        from wandb.proto import wandb_internal_pb2 as wandb_pb
        from wandb.sdk.internal import datastore
    except ImportError:
        logger.warning("[metrics] wandb SDK not importable — cannot read binary .wandb file")
        return [], records_read

    ds = datastore.DataStore()
    try:
        ds.open_for_scan(wandb_file)
    except Exception as e:
        logger.warning(f"[metrics] Failed to open .wandb file for scan: {e}")
        return [], records_read

    total_scanned = 0
    rows: list[dict] = []

    try:
        while True:
            data = ds.scan_data()
            if data is None:
                break
            total_scanned += 1

            # Skip records we've already processed
            if total_scanned <= records_read:
                continue

            rec = wandb_pb.Record()
            try:
                rec.ParseFromString(data)
            except Exception:
                continue

            if rec.WhichOneof("record_type") != "history":
                continue

            row: dict = {}
            for item in rec.history.item:
                # WandB stores metric names in nested_key (e.g. ['train/loss'])
                if item.nested_key:
                    key = "/".join(item.nested_key)
                elif item.key:
                    key = item.key
                else:
                    continue
                try:
                    row[key] = json.loads(item.value_json)
                except (json.JSONDecodeError, ValueError):
                    row[key] = item.value_json
            if row:
                rows.append(row)
    except Exception as e:
        logger.warning(f"[metrics] Error scanning .wandb file: {e}")

    return rows, total_scanned


def post_metrics_delta(
    server_url: str,
    job_id: str,
    wandb_dir: str,
    lines_posted: int,
    auth_token: str | None = None,
) -> int:
    """Read new metrics rows from wandb files and POST them to the server.

    ``lines_posted`` tracks progress: for JSONL files it is the line count;
    for binary .wandb files it is the record count.

    Returns the updated lines_posted count.
    """
    logger.info(f"[metrics] post_metrics_delta called: job_id={job_id}, wandb_dir={wandb_dir}, lines_posted={lines_posted}")

    metrics_path, kind = _resolve_wandb_metrics_source(wandb_dir)
    if not metrics_path:
        logger.info(f"[metrics] No metrics source found — skipping POST")
        return lines_posted

    rows: list[dict] = []
    new_total: int = lines_posted

    if kind == "jsonl":
        # --- JSONL text file path (online runs / custom setups) ---
        try:
            with open(metrics_path, "r") as f:
                all_lines = f.readlines()
        except OSError as e:
            logger.error(f"[metrics] Failed to read metrics file {metrics_path}: {e}")
            return lines_posted

        new_lines = all_lines[lines_posted:]
        if not new_lines:
            return lines_posted

        parse_errors = 0
        for line in new_lines:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                parse_errors += 1
        new_total = len(all_lines)
        logger.info(f"[metrics] JSONL: {len(rows)} valid rows from {len(new_lines)} new lines ({parse_errors} parse errors)")

    elif kind == "wandb_binary":
        # --- Binary .wandb protobuf path (offline runs) ---
        rows, new_total = _read_wandb_binary_history(metrics_path, lines_posted)
        logger.info(f"[metrics] Binary: {len(rows)} history rows (records_read {lines_posted} → {new_total})")

    if not rows:
        logger.info(f"[metrics] No new rows — skipping POST")
        return new_total if new_total > lines_posted else lines_posted

    if rows:
        sample_keys = list(rows[0].keys())[:8]
        logger.info(f"[metrics] Sample row keys: {sample_keys}")

    url = f"{server_url}/runs/{job_id}/metrics"
    headers = {"Content-Type": "application/json"}
    if auth_token:
        headers["X-Auth-Token"] = auth_token
    logger.info(f"[metrics] POSTing {len(rows)} rows to {url}")
    try:
        resp = requests.post(url, json={"rows": rows}, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"[metrics] ✅ POST succeeded — posted {len(rows)} rows, lines_posted now={new_total}")
            return new_total
        else:
            logger.warning(f"[metrics] ❌ POST failed: status={resp.status_code} body={resp.text[:300]}")
    except Exception as e:
        logger.warning(f"[metrics] ❌ POST exception: {e}")

    return lines_posted


def check_wandb_in_pane(pane_id: str, workdir: str = None) -> str | None:
    """Detect WandB run directory from tmux pane output."""
    try:
        import subprocess
        res = subprocess.run(
            ["tmux", "capture-pane", "-pt", pane_id, "-J"],
            capture_output=True,
            text=True,
            timeout=5
        )
        content = res.stdout
        
        if "WANDB_RUN_DIR:" in content:
            match = re.search(r"WANDB_RUN_DIR: (\S+)", content)
            if match:
                found_path = match.group(1).strip()
                if workdir and not os.path.isabs(found_path):
                    return os.path.normpath(os.path.join(workdir, found_path))
                return os.path.abspath(found_path)
    except Exception as e:
        logger.warning(f"Error checking for WandB: {e}")
    return None


def _resolve_sidecar_script(name: str) -> str | None:
    """Resolve helper script path in source and frozen modes."""
    candidates = []
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(base_dir, name))
    frozen_dir = getattr(sys, "_MEIPASS", None)
    if frozen_dir:
        candidates.append(os.path.join(frozen_dir, name))

    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def _gpuwrap_enabled() -> bool:
    raw = os.environ.get("RESEARCH_AGENT_GPUWRAP_ENABLED", "1")
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(value)


def build_gpuwrap_command(
    command: str,
    job_id: str,
    server_url: str,
    auth_token: str | None = None,
    gpuwrap_config: dict | None = None,
) -> str:
    """Build gpuwrap invocation; fallback to original command if unavailable."""
    config = gpuwrap_config if isinstance(gpuwrap_config, dict) else {}

    if "enabled" in config:
        if not _truthy(config.get("enabled")):
            return command
    elif not _gpuwrap_enabled():
        return command

    gpuwrap_path = _resolve_sidecar_script("gpuwrap.sh")
    if not gpuwrap_path:
        logger.info("gpuwrap.sh not found; running command directly")
        return command

    cmd_parts = [
        "bash",
        shlex.quote(gpuwrap_path),
        "--command",
        shlex.quote(command),
        "--job-id",
        shlex.quote(job_id),
        "--server-url",
        shlex.quote(server_url),
    ]
    if auth_token:
        cmd_parts.extend(["--auth-token", shlex.quote(auth_token)])

    # Per-run overrides (from Create Run form).
    config_to_flag = {
        "retries": "--retries",
        "retry_delay_seconds": "--retry-delay-seconds",
        "gpus_needed": "--gpus-needed",
        "max_memory_used_mb": "--max-memory-used-mb",
        "max_utilization": "--max-utilization",
        "lease_ttl_seconds": "--lease-ttl-seconds",
        "reservation_dir": "--reservation-dir",
    }
    for config_name, flag in config_to_flag.items():
        value = config.get(config_name)
        if value is None:
            continue
        if isinstance(value, str):
            trimmed = value.strip()
            if not trimmed:
                continue
            value = trimmed
        cmd_parts.extend([flag, shlex.quote(str(value))])

    # Global env fallback when per-run override is not present.
    env_to_flag = (
        ("RESEARCH_AGENT_GPUWRAP_RETRIES", "--retries", "retries"),
        ("RESEARCH_AGENT_GPUWRAP_RETRY_DELAY_SECONDS", "--retry-delay-seconds", "retry_delay_seconds"),
        ("RESEARCH_AGENT_GPUWRAP_GPUS_NEEDED", "--gpus-needed", "gpus_needed"),
        ("RESEARCH_AGENT_GPUWRAP_MAX_MEMORY_USED_MB", "--max-memory-used-mb", "max_memory_used_mb"),
        ("RESEARCH_AGENT_GPUWRAP_MAX_UTILIZATION", "--max-utilization", "max_utilization"),
        ("RESEARCH_AGENT_GPUWRAP_LEASE_TTL_SECONDS", "--lease-ttl-seconds", "lease_ttl_seconds"),
        ("RESEARCH_AGENT_GPUWRAP_STATE_DIR", "--reservation-dir", "reservation_dir"),
    )
    for env_name, flag, config_name in env_to_flag:
        if config_name in config:
            continue
        value = os.environ.get(env_name)
        if value:
            cmd_parts.extend([flag, shlex.quote(value)])

    return " ".join(cmd_parts)


def monitor_job(
    server_url: str,
    job_id: str,
    command: str,
    workdir: str,
    run_dir: str,
    auth_token: str | None = None,
    gpuwrap_config: dict | None = None,
):
    """Main job monitoring loop."""
    # Persist sidecar logs to a file so they can be streamed to the frontend.
    sidecar_log_file = os.path.join(run_dir, "sidecar.log")
    file_handler = logging.FileHandler(sidecar_log_file, mode="a")
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'
    ))
    logger.addHandler(file_handler)

    logger.info(f"Starting job monitor for {job_id}")
    logger.info(f"Command: {command}")
    logger.info(f"Workdir: {workdir}")
    logger.info(f"Run dir: {run_dir}")
    
    # Find our current pane
    current_pane = get_current_pane()
    if not current_pane:
        logger.error("Could not identify current tmux pane")
        report_status(server_url, job_id, "failed", {"error": "No tmux pane found"}, auth_token=auth_token)
        return
    
    window = current_pane.window
    
    # Split window to create job pane
    job_pane = window.split(attach=False)
    logger.info(f"Created job pane: {job_pane.pane_id}")
    
    # Change to workdir if specified
    if workdir:
        logger.info(f"Changing directory to: {workdir}")
        job_pane.send_keys(f"cd {workdir}")
        time.sleep(0.2)
    
    # Setup paths
    completion_file = os.path.join(run_dir, "job.done")
    log_file = os.path.join(run_dir, "run.log")
    
    # Clean up old completion file
    if os.path.exists(completion_file):
        os.remove(completion_file)
    
    # Setup log capture via pipe-pane
    try:
        logger.info(f"Piping pane output to {log_file}")
        job_pane.cmd("pipe-pane", f"cat >> {log_file}")
    except Exception as e:
        logger.error(f"Failed to setup pipe-pane: {e}")
    
    # Inject WANDB env vars so output goes to a predictable location
    wandb_data_dir = os.path.join(run_dir, "wandb_data")
    os.makedirs(wandb_data_dir, exist_ok=True)
    job_pane.send_keys(f"export WANDB_DIR={shlex.quote(wandb_data_dir)}")
    time.sleep(0.1)
    job_pane.send_keys(f"export WANDB_RUN_ID={shlex.quote(job_id)}")
    time.sleep(0.1)
    logger.info(f"Set WANDB_DIR={wandb_data_dir}, WANDB_RUN_ID={job_id}")
    
    # Execute command with exit code capture.
    launch_command = build_gpuwrap_command(
        command=command,
        job_id=job_id,
        server_url=server_url,
        auth_token=auth_token,
        gpuwrap_config=gpuwrap_config,
    )
    if launch_command != command:
        logger.info("Running command through gpuwrap")
    wrapped_command = f"({launch_command}); echo $? > {shlex.quote(completion_file)}"
    logger.info(f"Executing: {wrapped_command}")
    job_pane.send_keys(wrapped_command)
    
    # Report running status
    report_status(server_url, job_id, "running", {"tmux_pane": job_pane.pane_id}, auth_token=auth_token)
    
    # Monitoring loop
    found_wandb_dir = None
    check_interval = 2
    alert_state: dict = {}
    metrics_lines_posted = 0

    while not os.path.exists(completion_file):
        logger.debug("[metrics-loop] Monitoring job...")
        try:
            # Check if pane still exists
            window = current_pane.window
            pane_exists = any(p.pane_id == job_pane.pane_id for p in window.panes)
            
            if not pane_exists:
                logger.error("Job pane disappeared")
                report_status(server_url, job_id, "failed", {"error": "Pane disappeared"}, auth_token=auth_token)
                return
            
            # Detect WandB — filesystem scan first, tmux fallback
            if not found_wandb_dir:
                logger.debug(f"[metrics-loop] Scanning for wandb dir: run_dir={run_dir}, job_id={job_id}")
                found_wandb_dir = find_wandb_dir_in_rundir(run_dir, job_id)
                if not found_wandb_dir:
                    found_wandb_dir = check_wandb_in_pane(job_pane.pane_id, workdir)
                if found_wandb_dir:
                    logger.info(f"[metrics-loop] ✅ Detected WandB dir: {found_wandb_dir}")
                    report_status(server_url, job_id, "running", {"wandb_dir": found_wandb_dir}, auth_token=auth_token)
                else:
                    logger.debug(f"[metrics-loop] WandB dir not found yet")

            # Manual alert trigger path (for testing and operations)
            if maybe_trigger_manual_alert(server_url, job_id, workdir, run_dir, auth_token=auth_token):
                logger.info("Stopping job due to manual alert response")
                job_pane.cmd("kill-pane")
                report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                return

            # Rule-based alerts first, then LLM alert judge.
            if found_wandb_dir:
                rule_decision = rulebased_alerts(job_id, found_wandb_dir, alert_state)
                if apply_alert_decision(server_url, job_id, run_dir, rule_decision, auth_token=auth_token):
                    logger.info("Stopping job due to rulebased alert response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                    return

                judge_decision = alert_judge(job_id, found_wandb_dir, workdir, alert_state)
                if apply_alert_decision(server_url, job_id, run_dir, judge_decision, auth_token=auth_token):
                    logger.info("Stopping job due to alert_judge response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                    return

                # POST new metric rows to server
                logger.info(f"[metrics-loop] Calling post_metrics_delta (found_wandb_dir={found_wandb_dir}, lines_posted={metrics_lines_posted})")
                prev_lines = metrics_lines_posted
                metrics_lines_posted = post_metrics_delta(
                    server_url, job_id, found_wandb_dir, metrics_lines_posted, auth_token=auth_token
                )
                if metrics_lines_posted != prev_lines:
                    logger.info(f"[metrics-loop] lines_posted advanced: {prev_lines} → {metrics_lines_posted}")
            else:
                logger.debug(f"[metrics-loop] Skipping metrics POST — no wandb_dir found yet")

        except Exception as e:
            logger.error(f"Error in monitoring loop: {e}")
        
        time.sleep(check_interval)
    
    logger.info("Exited from monitoring loop")
    # Job completed - read exit code
    exit_code = "unknown"
    try:
        with open(completion_file, "r") as f:
            exit_code = f.read().strip()
    except Exception:
        pass
    
    # Final status
    if exit_code == "0":
        logger.info("Job completed successfully")
        report_status(server_url, job_id, "finished", {"exit_code": 0}, auth_token=auth_token)
    else:
        logger.error(f"Job failed with exit code: {exit_code}")
        report_status(server_url, job_id, "failed", {"exit_code": exit_code}, auth_token=auth_token)

    # Final metrics flush
    if found_wandb_dir:
        logger.info(f"[metrics-final] Final metrics flush: wandb_dir={found_wandb_dir}, lines_posted={metrics_lines_posted}")
        final_posted = post_metrics_delta(server_url, job_id, found_wandb_dir, metrics_lines_posted, auth_token=auth_token)
        logger.info(f"[metrics-final] Final flush done: lines_posted {metrics_lines_posted} → {final_posted}")
    else:
        logger.info(f"[metrics-final] No wandb_dir found during entire run — skipping final flush")
    
    logger.info("Sidecar exiting")


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="Job Sidecar")
    parser.add_argument("--job_id", required=True, help="Job ID")
    parser.add_argument("--server_url", required=True, help="Server URL")
    parser.add_argument("--command_file", required=True, help="Path to command file")
    parser.add_argument("--workdir", default=None, help="Working directory")
    parser.add_argument("--agent_run_dir", default=None, help="Run directory for logs")
    parser.add_argument("--gpuwrap_config_file", default=None, help="Optional per-run gpuwrap config JSON path")
    parser.add_argument(
        "--auth_token",
        default=os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", ""),
        help="Optional X-Auth-Token for server callbacks",
    )
    args = parser.parse_args(argv)
    
    # Read command from file
    try:
        with open(args.command_file, "r") as f:
            command = f.read().strip()
    except Exception as e:
        logger.error(f"Failed to read command file: {e}")
        report_status(
            args.server_url,
            args.job_id,
            "failed",
            {"error": f"Failed to read command: {e}"},
            auth_token=args.auth_token or None,
        )
        return

    gpuwrap_config = None
    if args.gpuwrap_config_file:
        try:
            with open(args.gpuwrap_config_file, "r") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                gpuwrap_config = loaded
            else:
                logger.warning("Ignoring gpuwrap config (not an object): %s", args.gpuwrap_config_file)
        except Exception as e:
            logger.warning("Failed to load gpuwrap config file %s: %s", args.gpuwrap_config_file, e)
    
    # Run monitor
    monitor_job(
        server_url=args.server_url,
        job_id=args.job_id,
        command=command,
        workdir=args.workdir or os.getcwd(),
        run_dir=args.agent_run_dir or "/tmp",
        auth_token=args.auth_token or None,
        gpuwrap_config=gpuwrap_config,
    )


if __name__ == "__main__":
    main()
