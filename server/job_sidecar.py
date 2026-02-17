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
import shutil
import subprocess
import requests

try:
    import libtmux
except ImportError:  # pragma: no cover - exercised in minimal unit-test environments
    libtmux = None

from sidecar_smart import (
    load_sidecar_skills,
    materialize_jit_tasks,
    render_skill_bundle,
    run_smart_sidecar_session,
    should_run_smart_analysis,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("job-sidecar")

AGENT_JUDGE_INTERVAL = 30
ALERT_SIGNATURE_TTL_SECONDS = 180
MONITOR_HEARTBEAT_SECONDS = 30
LOG_TAIL_MAX_LINES = 120
LOG_TAIL_MAX_BYTES = 32000
GPU_PREFLIGHT_MAX_WAIT_SECONDS = 180
GPU_PREFLIGHT_POLL_SECONDS = 10
GPU_BUSY_UTIL_THRESHOLD = 85.0
GPU_BUSY_MEM_RATIO_THRESHOLD = 0.85

SEVERITY_ORDER = {"info": 0, "warning": 1, "critical": 2}

_last_log_pos: dict[str, int] = {}


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
    source: str | None = None,
    syndrome: str | None = None,
    evidence: dict | None = None,
    auth_token: str | None = None,
) -> str | None:
    """Create alert via server and return alert_id."""
    payload = {
        "message": message,
        "choices": choices,
        "severity": severity,
    }
    if source:
        payload["source"] = source
    if syndrome:
        payload["syndrome"] = syndrome
    if evidence:
        payload["evidence"] = evidence
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


def _safe_float(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        val = float(value)
    elif isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            val = float(stripped)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(val):
        return None
    return val


def _severity_rank(severity: str | None) -> int:
    if not severity:
        return 0
    return SEVERITY_ORDER.get(severity.strip().lower(), 0)


def _normalize_severity(severity: str | None) -> str:
    normalized = (severity or "warning").strip().lower()
    if normalized not in SEVERITY_ORDER:
        return "warning"
    return normalized


def parse_cuda_visible_devices(command: str) -> list[int]:
    """Extract CUDA_VISIBLE_DEVICES IDs from command text."""
    match = re.search(r"CUDA_VISIBLE_DEVICES\s*=\s*([0-9,\s]+)", command)
    if not match:
        return []
    parsed: list[int] = []
    for token in match.group(1).split(","):
        token = token.strip()
        if not token:
            continue
        if token.isdigit():
            parsed.append(int(token))
    # Preserve order and de-duplicate.
    deduped: list[int] = []
    for gpu_id in parsed:
        if gpu_id not in deduped:
            deduped.append(gpu_id)
    return deduped


def _parse_nvidia_csv_rows(output: str, expected_fields: int) -> list[list[str]]:
    rows: list[list[str]] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < expected_fields:
            continue
        rows.append(parts)
    return rows


def query_gpu_snapshot() -> dict[int, dict]:
    """Return GPU state keyed by GPU index. Empty map if unavailable."""
    if not shutil.which("nvidia-smi"):
        return {}

    base_cmd = ["nvidia-smi", "--format=csv,noheader,nounits"]
    query_gpu_cmd = base_cmd + ["--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total"]
    query_apps_cmd = base_cmd + ["--query-compute-apps=gpu_uuid,pid,used_memory"]

    try:
        gpu_res = subprocess.run(query_gpu_cmd, capture_output=True, text=True, timeout=4)
    except Exception as e:
        logger.warning("Failed to query nvidia-smi GPU snapshot: %s", e)
        return {}

    if gpu_res.returncode != 0:
        return {}

    snapshot: dict[int, dict] = {}
    uuid_to_idx: dict[str, int] = {}
    for row in _parse_nvidia_csv_rows(gpu_res.stdout, 5):
        idx = _safe_float(row[0])
        util = _safe_float(row[2]) or 0.0
        mem_used = _safe_float(row[3]) or 0.0
        mem_total = _safe_float(row[4]) or 0.0
        if idx is None:
            continue
        gpu_idx = int(idx)
        gpu_uuid = row[1]
        snapshot[gpu_idx] = {
            "index": gpu_idx,
            "uuid": gpu_uuid,
            "utilization": util,
            "memory_used": mem_used,
            "memory_total": mem_total,
            "processes": [],
        }
        uuid_to_idx[gpu_uuid] = gpu_idx

    if not snapshot:
        return {}

    try:
        app_res = subprocess.run(query_apps_cmd, capture_output=True, text=True, timeout=4)
    except Exception as e:
        logger.warning("Failed to query nvidia-smi compute-apps: %s", e)
        return snapshot

    if app_res.returncode != 0:
        return snapshot

    for row in _parse_nvidia_csv_rows(app_res.stdout, 3):
        gpu_uuid = row[0]
        if gpu_uuid not in uuid_to_idx:
            continue
        pid = int(_safe_float(row[1]) or 0)
        mem = _safe_float(row[2]) or 0.0
        idx = uuid_to_idx[gpu_uuid]
        snapshot[idx]["processes"].append({"pid": pid, "used_memory": mem})
    return snapshot


def _busy_gpu_indices(snapshot: dict[int, dict], requested: list[int]) -> list[int]:
    busy: list[int] = []
    for idx in requested:
        info = snapshot.get(idx)
        if not info:
            continue
        mem_total = float(info.get("memory_total") or 0.0)
        mem_used = float(info.get("memory_used") or 0.0)
        util = float(info.get("utilization") or 0.0)
        mem_ratio = (mem_used / mem_total) if mem_total > 0 else 0.0
        has_other_processes = any(proc.get("pid") != os.getpid() for proc in info.get("processes", []))
        if has_other_processes or util >= GPU_BUSY_UTIL_THRESHOLD or mem_ratio >= GPU_BUSY_MEM_RATIO_THRESHOLD:
            busy.append(idx)
    return busy


def wait_for_requested_gpus(
    command: str,
    max_wait_seconds: int = GPU_PREFLIGHT_MAX_WAIT_SECONDS,
    poll_seconds: int = GPU_PREFLIGHT_POLL_SECONDS,
) -> dict:
    requested = parse_cuda_visible_devices(command)
    result = {
        "requested_devices": requested,
        "waited_seconds": 0,
        "timed_out": False,
        "busy_devices": [],
        "available": True,
        "reason": "",
    }
    if not requested:
        return result

    if not shutil.which("nvidia-smi"):
        result["reason"] = "nvidia-smi not available; skipping GPU occupancy preflight"
        return result

    started_at = time.time()
    while True:
        snapshot = query_gpu_snapshot()
        busy_devices = _busy_gpu_indices(snapshot, requested)
        elapsed = int(time.time() - started_at)
        result["busy_devices"] = busy_devices
        result["waited_seconds"] = elapsed
        if not busy_devices:
            result["available"] = True
            return result
        if elapsed >= max_wait_seconds:
            result["timed_out"] = True
            result["available"] = False
            return result
        time.sleep(max(1, poll_seconds))


def read_new_log_lines(
    job_id: str,
    log_path: str,
    max_lines: int = LOG_TAIL_MAX_LINES,
    max_bytes: int = LOG_TAIL_MAX_BYTES,
) -> list[str]:
    """Read only newly appended log lines since last call."""
    if not os.path.isfile(log_path):
        return []

    try:
        size = os.path.getsize(log_path)
    except OSError:
        return []

    start = _last_log_pos.get(job_id, 0)
    if size < start:
        start = 0
    if size - start > max_bytes:
        start = max(0, size - max_bytes)

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(start)
            chunk = f.read()
    except OSError:
        return []

    _last_log_pos[job_id] = size
    lines = [ln.strip() for ln in chunk.splitlines() if ln.strip()]
    if len(lines) > max_lines:
        return lines[-max_lines:]
    return lines


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

def resolve_monitor_metrics_file(run_dir: str, wandb_dir: str | None) -> str | None:
    """Prefer sidecar-posted metrics file, fallback to wandb jsonl source."""
    agent_metrics_file = os.path.join(run_dir, "agent_metrics.jsonl")
    if os.path.isfile(agent_metrics_file):
        return agent_metrics_file
    if not wandb_dir:
        return None
    metrics_path, kind = _resolve_wandb_metrics_source(wandb_dir)
    if metrics_path and kind == "jsonl":
        return metrics_path
    return None


def _decision_signature(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def _build_alert_decision(
    source: str,
    syndrome: str,
    message: str,
    severity: str = "warning",
    choices: list[str] | None = None,
    evidence: dict | None = None,
) -> dict:
    signature_seed = f"{source}:{syndrome}:{message}"
    return {
        "action": "alert",
        "source": source,
        "syndrome": syndrome,
        "message": message,
        "severity": _normalize_severity(severity),
        "choices": choices or ["Ignore", "Stop Job"],
        "evidence": evidence or {},
        "signature": _decision_signature(signature_seed),
    }


def select_most_urgent_decision(decisions: list[dict | None]) -> dict | None:
    candidates = [d for d in decisions if d and d.get("action") == "alert"]
    if not candidates:
        return None
    candidates.sort(
        key=lambda d: (
            _severity_rank(d.get("severity")),
            1 if d.get("source") == "rulebased" else 0,
        ),
        reverse=True,
    )
    return candidates[0]


def record_alert_syndrome(state: dict, decision: dict | None):
    if not decision or decision.get("action") != "alert":
        return
    syndrome = (decision.get("syndrome") or decision.get("source") or "unknown").strip().lower()
    if not syndrome:
        syndrome = "unknown"
    counts = state.setdefault("syndrome_counts", {})
    counts[syndrome] = int(counts.get(syndrome, 0)) + 1


def rulebased_alerts(metrics_rows: list[dict], state: dict) -> dict | None:
    """Mechanical deterministic checks only (no smart heuristics)."""
    entries: list[tuple[object, float]] = []
    for row in metrics_rows:
        loss = extract_loss(row)
        if loss is None:
            continue
        entries.append((row.get("step"), float(loss)))

    if not entries:
        return None

    finite_entries = [(step, loss) for step, loss in entries if math.isfinite(loss)]
    has_non_finite = len(finite_entries) != len(entries)
    if has_non_finite:
        decision = _build_alert_decision(
            source="rulebased",
            syndrome="nan_inf_loss",
            message="Training loss became NaN/Inf. This run is unstable.",
            severity="critical",
        )
        if seen_recent_signature(state, "rulebased", decision["signature"]):
            return None
        return decision
    return None


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
        source=decision.get("source"),
        syndrome=decision.get("syndrome"),
        evidence=decision.get("evidence") if isinstance(decision.get("evidence"), dict) else None,
        auth_token=auth_token,
    )
    if not alert_id:
        return False

    timeout_seconds = _safe_float(decision.get("response_timeout_seconds")) if isinstance(decision, dict) else None
    wait_timeout = int(timeout_seconds) if timeout_seconds and timeout_seconds > 0 else 600
    response = wait_for_response(run_dir, alert_id, timeout_seconds=wait_timeout)
    logger.info("Alert response (%s): %s", source, response)
    return should_stop_from_choice(response)


def get_current_pane():
    """Find the tmux pane where this sidecar is running."""
    if libtmux is None:
        logger.error("libtmux is unavailable in this environment")
        return None
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


def monitor_job(
    server_url: str,
    job_id: str,
    command: str,
    workdir: str,
    run_dir: str,
    auth_token: str | None = None,
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
    
    # Alert/memory state for this sidecar process.
    alert_state: dict = {}
    skill_env = os.environ.get("SIDECAR_SMART_SKILLS", "").strip()
    requested_skill_ids = [part.strip() for part in skill_env.split(",") if part.strip()] if skill_env else None
    smart_skills = load_sidecar_skills(skill_ids=requested_skill_ids)
    smart_skill_bundle = render_skill_bundle(smart_skills)
    alert_state["smart_skills_loaded"] = list(smart_skills.keys())

    # Optional GPU preflight for explicit CUDA pinning.
    gpu_preflight = wait_for_requested_gpus(command)
    if gpu_preflight.get("requested_devices"):
        if gpu_preflight.get("waited_seconds") or gpu_preflight.get("reason"):
            preflight_note = (
                f"GPU preflight requested={gpu_preflight.get('requested_devices')} "
                f"waited={gpu_preflight.get('waited_seconds')}s "
                f"busy={gpu_preflight.get('busy_devices') or []}"
            )
            report_status(
                server_url,
                job_id,
                "launching",
                {
                    "monitor_note": preflight_note,
                    "monitor_tags": ["gpu-preflight"],
                    "monitoring": {"gpu_preflight": gpu_preflight},
                },
                auth_token=auth_token,
            )
        if gpu_preflight.get("timed_out") and gpu_preflight.get("busy_devices"):
            preflight_decision = _build_alert_decision(
                source="preflight",
                syndrome="gpu_occupied",
                message=(
                    "Requested GPUs are still occupied after preflight wait: "
                    f"{gpu_preflight.get('busy_devices')}. Continue anyway or stop?"
                ),
                severity="warning",
                choices=["Continue Anyway", "Stop Job"],
                evidence={"gpu_preflight": gpu_preflight},
            )
            preflight_decision["response_timeout_seconds"] = 120
            if apply_alert_decision(server_url, job_id, run_dir, preflight_decision, auth_token=auth_token):
                report_status(
                    server_url,
                    job_id,
                    "stopped",
                    {
                        "error": "Stopped during GPU preflight",
                        "monitor_note": "Run stopped after GPU preflight contention alert.",
                        "monitoring": {"gpu_preflight": gpu_preflight},
                    },
                    auth_token=auth_token,
                )
                return

    # Execute command with exit code capture
    wrapped_command = f"({command}); echo $? > {completion_file}"
    logger.info(f"Executing: {wrapped_command}")
    job_pane.send_keys(wrapped_command)
    
    # Report running status
    report_status(
        server_url,
        job_id,
        "running",
        {
            "tmux_pane": job_pane.pane_id,
            "monitor_note": "run-started",
            "monitor_tags": ["sidecar-v2"],
            "monitoring": {
                "gpu_preflight": gpu_preflight,
                "smart_skills_loaded": list(smart_skills.keys()),
            },
        },
        auth_token=auth_token,
    )
    
    # Monitoring loop
    found_wandb_dir = None
    check_interval = 2
    metrics_lines_posted = 0
    last_heartbeat = 0.0
    last_monitor_note = ""

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

            # POST new metric rows to server first so local agent_metrics.jsonl stays fresh.
            if found_wandb_dir:
                logger.info(f"[metrics-loop] Calling post_metrics_delta (found_wandb_dir={found_wandb_dir}, lines_posted={metrics_lines_posted})")
                prev_lines = metrics_lines_posted
                metrics_lines_posted = post_metrics_delta(
                    server_url, job_id, found_wandb_dir, metrics_lines_posted, auth_token=auth_token
                )
                if metrics_lines_posted != prev_lines:
                    logger.info(f"[metrics-loop] lines_posted advanced: {prev_lines} → {metrics_lines_posted}")
            else:
                logger.debug(f"[metrics-loop] Skipping metrics POST — no wandb_dir found yet")

            metrics_file = resolve_monitor_metrics_file(run_dir, found_wandb_dir)
            recent_rows = read_recent_metrics(metrics_file, max_lines=50, max_bytes=64000) if metrics_file else []
            new_log_lines = read_new_log_lines(job_id, log_file)
            if new_log_lines:
                ring = alert_state.setdefault("recent_logs_buffer", [])
                if isinstance(ring, list):
                    ring.extend(new_log_lines)
                    if len(ring) > 150:
                        del ring[:-150]
                else:
                    alert_state["recent_logs_buffer"] = new_log_lines[-150:]
            log_context = alert_state.get("recent_logs_buffer")
            if not isinstance(log_context, list):
                log_context = []

            rule_decision = rulebased_alerts(recent_rows, alert_state)
            smart_decision = {"action": "ignore"}
            jit_artifacts: list[dict] = []
            if should_run_smart_analysis(
                job_id=job_id,
                metrics_file=metrics_file,
                log_file=log_file,
                state=alert_state,
                min_interval_seconds=AGENT_JUDGE_INTERVAL,
            ):
                smart_decision = run_smart_sidecar_session(
                    job_id=job_id,
                    command=command,
                    run_dir=run_dir,
                    workdir=workdir,
                    metrics_rows=recent_rows,
                    recent_logs=log_context,
                    skill_bundle=smart_skill_bundle,
                )
                jit_artifacts = materialize_jit_tasks(
                    run_dir=run_dir,
                    jit_tasks=smart_decision.get("jit_tasks") if isinstance(smart_decision, dict) else [],
                )

            urgent_decision = select_most_urgent_decision([rule_decision, smart_decision])
            if urgent_decision:
                record_alert_syndrome(alert_state, urgent_decision)
                if apply_alert_decision(server_url, job_id, run_dir, urgent_decision, auth_token=auth_token):
                    logger.info("Stopping job due to sidecar alert response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                    return

            now = time.time()
            latest_loss = extract_loss(recent_rows[-1]) if recent_rows else None
            smart_note = str(smart_decision.get("monitor_note") or "").strip() if isinstance(smart_decision, dict) else ""
            fallback_note = f"metrics={len(recent_rows)} logs={len(log_context)}"
            monitor_note = smart_note or fallback_note
            monitor_tags = ["sidecar-v2", "smart-agent"]
            if isinstance(smart_decision, dict):
                raw_tags = smart_decision.get("monitor_tags")
                if isinstance(raw_tags, list):
                    monitor_tags.extend([str(tag)[:40] for tag in raw_tags[:6] if str(tag).strip()])
            if jit_artifacts:
                monitor_tags.append("jit-artifacts")

            monitoring_payload = {
                "latest_loss": latest_loss,
                "metrics_points": len(recent_rows),
                "log_points": len(log_context),
                "smart_skills_loaded": list(smart_skills.keys()),
                "analysis_summary": (
                    str(smart_decision.get("analysis_summary") or "")[:1200]
                    if isinstance(smart_decision, dict)
                    else ""
                ),
                "jit_artifacts": jit_artifacts,
            }
            if found_wandb_dir:
                monitoring_payload["wandb_dir"] = found_wandb_dir

            if (now - last_heartbeat >= MONITOR_HEARTBEAT_SECONDS) or (monitor_note != last_monitor_note):
                status_payload = {
                    "tmux_pane": job_pane.pane_id,
                    "monitor_note": monitor_note,
                    "monitor_tags": monitor_tags[:8],
                    "monitoring": monitoring_payload,
                }
                if found_wandb_dir:
                    status_payload["wandb_dir"] = found_wandb_dir
                if jit_artifacts:
                    status_payload["monitor_artifacts"] = [a.get("relative_path") for a in jit_artifacts if a.get("relative_path")]
                report_status(server_url, job_id, "running", status_payload, auth_token=auth_token)
                last_heartbeat = now
                last_monitor_note = monitor_note

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
    
    # Run monitor
    monitor_job(
        server_url=args.server_url,
        job_id=args.job_id,
        command=command,
        workdir=args.workdir or os.getcwd(),
        run_dir=args.agent_run_dir or "/tmp",
        auth_token=args.auth_token or None,
    )


if __name__ == "__main__":
    main()
