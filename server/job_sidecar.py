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
MONITOR_HEARTBEAT_SECONDS = 30
LOG_TAIL_MAX_LINES = 120
LOG_TAIL_MAX_BYTES = 32000
GPU_PREFLIGHT_MAX_WAIT_SECONDS = 180
GPU_PREFLIGHT_POLL_SECONDS = 10
GPU_BUSY_UTIL_THRESHOLD = 85.0
GPU_BUSY_MEM_RATIO_THRESHOLD = 0.85
BASELINE_HISTORY_FILE = os.path.join(".agents", "sidecar_history.jsonl")
BASELINE_HISTORY_MAX_ROWS = 400
MIN_ROWS_FOR_PROFILE_ALERTS = 6

SEVERITY_ORDER = {"info": 0, "warning": 1, "critical": 2}

VAL_ACCURACY_KEYS = (
    "val/accuracy",
    "val_accuracy",
    "validation/accuracy",
    "validation_accuracy",
    "eval/accuracy",
    "eval_accuracy",
    "accuracy/val",
)
VAL_LOSS_KEYS = (
    "val/loss",
    "val_loss",
    "validation/loss",
    "validation_loss",
    "eval/loss",
    "eval_loss",
)
REWARD_KEYS = (
    "reward",
    "train/reward",
    "episode_reward",
    "episode/reward",
    "rollout/ep_rew_mean",
    "eval/reward",
    "mean_reward",
)
SUCCESS_RATE_KEYS = (
    "success_rate",
    "train/success_rate",
    "eval/success_rate",
    "success",
    "win_rate",
)
THROUGHPUT_KEYS = (
    "throughput",
    "samples_per_second",
    "tokens_per_second",
    "steps_per_second",
    "train/samples_per_second",
    "train/tokens_per_second",
    "samples/s",
    "tokens/s",
)
KL_KEYS = (
    "kl",
    "train/kl",
    "policy/kl",
    "approx_kl",
    "kl_divergence",
)

LOG_SYNDROME_PATTERNS = [
    {
        "syndrome": "cuda_oom",
        "severity": "critical",
        "regex": re.compile(r"cuda out of memory|cublas_status_alloc_failed|out of memory", re.I),
        "template": "CUDA OOM detected in logs: {snippet}",
    },
    {
        "syndrome": "gpu_busy",
        "severity": "warning",
        "regex": re.compile(r"device busy or unavailable|all cuda-capable devices are busy|resource busy", re.I),
        "template": "GPU appears occupied/unavailable: {snippet}",
    },
    {
        "syndrome": "nccl_failure",
        "severity": "critical",
        "regex": re.compile(r"nccl.*(timeout|error|unhandled)|collective operation timeout", re.I),
        "template": "Distributed backend issue detected: {snippet}",
    },
    {
        "syndrome": "traceback",
        "severity": "warning",
        "regex": re.compile(r"traceback \(most recent call last\)", re.I),
        "template": "Python traceback detected in run logs.",
    },
]

_last_metrics_pos: dict[str, int] = {}
_last_judge_check: dict[str, float] = {}
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


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    mid = len(sorted_values) // 2
    if len(sorted_values) % 2 == 1:
        return sorted_values[mid]
    return (sorted_values[mid - 1] + sorted_values[mid]) / 2.0


def _severity_rank(severity: str | None) -> int:
    if not severity:
        return 0
    return SEVERITY_ORDER.get(severity.strip().lower(), 0)


def _normalize_severity(severity: str | None) -> str:
    normalized = (severity or "warning").strip().lower()
    if normalized not in SEVERITY_ORDER:
        return "warning"
    return normalized


def extract_metric_value(row: dict, keys: tuple[str, ...]) -> float | None:
    for key in keys:
        if key not in row:
            continue
        value = _safe_float(row.get(key))
        if value is not None:
            return value
    return None


def collect_metric_series(rows: list[dict], keys: tuple[str, ...]) -> list[float]:
    values: list[float] = []
    for row in rows:
        value = extract_metric_value(row, keys)
        if value is not None:
            values.append(value)
    return values


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


def infer_workload_profile(command: str, rows: list[dict], recent_logs: list[str]) -> str:
    """Infer a lightweight workload profile to choose playbook rules."""
    command_blob = command.lower()
    metric_keys = " ".join(str(k).lower() for row in rows[-12:] for k in row.keys())
    log_blob = " ".join(line.lower() for line in recent_logs[-30:])
    signal_blob = " ".join([command_blob, metric_keys, log_blob])

    rl_hints = ["ppo", "rlhf", "episode", "actor", "critic", "policy", "reward", "env.step"]
    if any(hint in signal_blob for hint in rl_hints):
        return "reinforcement_learning"

    supervised_hints = ["validation", "val/", "eval/", "cross_entropy", "accuracy", "train/loss"]
    if any(hint in signal_blob for hint in supervised_hints):
        return "supervised"
    return "generic"


def summarize_metrics_for_monitoring(rows: list[dict]) -> dict:
    losses = collect_metric_series(rows, ("loss", "train/loss", "train_loss", "training_loss"))
    val_acc = collect_metric_series(rows, VAL_ACCURACY_KEYS)
    val_loss = collect_metric_series(rows, VAL_LOSS_KEYS)
    reward = collect_metric_series(rows, REWARD_KEYS)
    success = collect_metric_series(rows, SUCCESS_RATE_KEYS)
    throughput = collect_metric_series(rows, THROUGHPUT_KEYS)
    summary = {
        "latest_loss": losses[-1] if losses else None,
        "best_loss": min(losses) if losses else None,
        "latest_val_accuracy": val_acc[-1] if val_acc else None,
        "best_val_accuracy": max(val_acc) if val_acc else None,
        "latest_val_loss": val_loss[-1] if val_loss else None,
        "best_val_loss": min(val_loss) if val_loss else None,
        "latest_reward": reward[-1] if reward else None,
        "recent_reward_mean": _mean(reward[-5:]) if reward else None,
        "latest_success_rate": success[-1] if success else None,
        "recent_success_rate_mean": _mean(success[-5:]) if success else None,
        "latest_throughput": throughput[-1] if throughput else None,
        "recent_throughput_mean": _mean(throughput[-5:]) if throughput else None,
    }
    return summary


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


def _build_monitor_note(profile: str, summary: dict, baseline: dict | None) -> str:
    chunks = [f"profile={profile}"]
    if summary.get("latest_loss") is not None:
        chunks.append(f"loss={summary['latest_loss']:.4f}")
    if summary.get("latest_val_accuracy") is not None:
        chunks.append(f"val_acc={summary['latest_val_accuracy']:.4f}")
    if summary.get("latest_reward") is not None:
        chunks.append(f"reward={summary['latest_reward']:.4f}")
    if summary.get("recent_throughput_mean") is not None:
        chunks.append(f"throughput={summary['recent_throughput_mean']:.2f}")
    if baseline and baseline.get("recent_throughput_mean") and summary.get("recent_throughput_mean"):
        base = baseline["recent_throughput_mean"]
        cur = summary["recent_throughput_mean"]
        if base > 0:
            ratio = cur / base
            chunks.append(f"tp_vs_base={ratio:.2f}x")
    return " | ".join(chunks)


def baseline_history_path(workdir: str) -> str:
    return os.path.join(workdir, BASELINE_HISTORY_FILE)


def load_baseline_history(workdir: str, max_rows: int = BASELINE_HISTORY_MAX_ROWS) -> list[dict]:
    path = baseline_history_path(workdir)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()[-max_rows:]
    except OSError:
        return []
    records: list[dict] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            records.append(data)
    return records


def normalize_command_for_fingerprint(command: str) -> str:
    normalized = re.sub(r"CUDA_VISIBLE_DEVICES\s*=\s*[^\s]+", "CUDA_VISIBLE_DEVICES=<masked>", command)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def command_fingerprint(command: str) -> str:
    normalized = normalize_command_for_fingerprint(command)
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]


def baseline_reference_from_history(history: list[dict], fingerprint: str, profile: str) -> dict | None:
    matched = [
        row for row in history
        if row.get("command_fingerprint") == fingerprint and row.get("status") == "finished"
    ]
    if not matched:
        return None
    if profile != "generic":
        profiled = [row for row in matched if row.get("profile") == profile]
        if profiled:
            matched = profiled

    def collect(field: str) -> list[float]:
        vals: list[float] = []
        for row in matched:
            metrics = row.get("summary")
            if not isinstance(metrics, dict):
                continue
            val = _safe_float(metrics.get(field))
            if val is not None:
                vals.append(val)
        return vals

    baseline = {
        "recent_throughput_mean": _median(collect("recent_throughput_mean")),
        "best_val_accuracy": _median(collect("best_val_accuracy")),
        "best_val_loss": _median(collect("best_val_loss")),
        "sample_size": len(matched),
    }
    if baseline["sample_size"] == 0:
        return None
    return baseline


def persist_run_summary(workdir: str, payload: dict):
    path = baseline_history_path(workdir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=True) + "\n")
    except OSError as e:
        logger.warning("Failed writing sidecar baseline history: %s", e)


def detect_log_syndrome_alert(job_id: str, log_path: str, state: dict, lines: list[str] | None = None) -> dict | None:
    if lines is None:
        lines = read_new_log_lines(job_id, log_path)
    if not lines:
        return None
    decisions: list[dict] = []
    for line in lines:
        for pattern in LOG_SYNDROME_PATTERNS:
            if not pattern["regex"].search(line):
                continue
            snippet = line[:180]
            decision = _build_alert_decision(
                source="logwatch",
                syndrome=pattern["syndrome"],
                message=pattern["template"].format(snippet=snippet),
                severity=pattern["severity"],
                evidence={"log_snippet": snippet},
            )
            signature = decision["signature"]
            if seen_recent_signature(state, "logwatch", signature):
                continue
            decisions.append(decision)
    return select_most_urgent_decision(decisions)


def detect_supervised_metric_alert(rows: list[dict], state: dict) -> dict | None:
    if len(rows) < MIN_ROWS_FOR_PROFILE_ALERTS:
        return None
    val_acc = collect_metric_series(rows, VAL_ACCURACY_KEYS)
    decisions: list[dict] = []
    if len(val_acc) >= MIN_ROWS_FOR_PROFILE_ALERTS:
        current = val_acc[-1]
        best_prev = max(val_acc[:-1])
        recent_mean = _mean(val_acc[-3:]) or current
        if best_prev > 0 and (best_prev - current) >= 0.08 and recent_mean <= best_prev * 0.9:
            decision = _build_alert_decision(
                source="playbook",
                syndrome="validation_drop",
                message=(
                    "Validation accuracy dropped materially "
                    f"(current={current:.4f}, best={best_prev:.4f})."
                ),
                severity="warning",
                evidence={"current": current, "best": best_prev},
            )
            if not seen_recent_signature(state, "playbook", decision["signature"]):
                decisions.append(decision)

    val_loss = collect_metric_series(rows, VAL_LOSS_KEYS)
    if len(val_loss) >= MIN_ROWS_FOR_PROFILE_ALERTS:
        current = val_loss[-1]
        best_prev = min(val_loss[:-1])
        recent_mean = _mean(val_loss[-3:]) or current
        if best_prev > 0 and current >= best_prev * 1.5 and recent_mean >= best_prev * 1.4:
            decision = _build_alert_decision(
                source="playbook",
                syndrome="validation_loss_regression",
                message=(
                    "Validation loss regressed strongly "
                    f"(current={current:.4f}, best={best_prev:.4f})."
                ),
                severity="warning",
                evidence={"current": current, "best": best_prev},
            )
            if not seen_recent_signature(state, "playbook", decision["signature"]):
                decisions.append(decision)
    return select_most_urgent_decision(decisions)


def detect_rl_metric_alert(rows: list[dict], state: dict) -> dict | None:
    if len(rows) < MIN_ROWS_FOR_PROFILE_ALERTS:
        return None
    reward = collect_metric_series(rows, REWARD_KEYS)
    success = collect_metric_series(rows, SUCCESS_RATE_KEYS)
    kl_values = collect_metric_series(rows, KL_KEYS)
    decisions: list[dict] = []

    if len(reward) >= MIN_ROWS_FOR_PROFILE_ALERTS:
        current_reward = reward[-1]
        prev_reward = _mean(reward[-6:-1]) or current_reward
        if prev_reward > 0 and current_reward <= prev_reward * 0.5:
            decision = _build_alert_decision(
                source="playbook",
                syndrome="reward_drop",
                message=(
                    "RL reward dropped sharply "
                    f"(current={current_reward:.4f}, recent_mean={prev_reward:.4f})."
                ),
                severity="warning",
                evidence={"current_reward": current_reward, "recent_reward_mean": prev_reward},
            )
            if not seen_recent_signature(state, "playbook", decision["signature"]):
                decisions.append(decision)

    if len(reward) >= MIN_ROWS_FOR_PROFILE_ALERTS and len(success) >= MIN_ROWS_FOR_PROFILE_ALERTS:
        curr_reward = reward[-1]
        prev_reward = _mean(reward[-6:-1]) or curr_reward
        curr_success = success[-1]
        prev_success = _mean(success[-6:-1]) or curr_success
        if prev_reward > 0 and prev_success > 0 and curr_reward >= prev_reward * 1.5 and curr_success <= prev_success * 0.7:
            decision = _build_alert_decision(
                source="playbook",
                syndrome="reward_hacking_suspected",
                message=(
                    "Reward increased while success rate dropped "
                    f"(reward {curr_reward:.4f} vs {prev_reward:.4f}, "
                    f"success {curr_success:.4f} vs {prev_success:.4f})."
                ),
                severity="critical",
                evidence={
                    "current_reward": curr_reward,
                    "recent_reward_mean": prev_reward,
                    "current_success": curr_success,
                    "recent_success_mean": prev_success,
                },
            )
            if not seen_recent_signature(state, "playbook", decision["signature"]):
                decisions.append(decision)

    if len(kl_values) >= MIN_ROWS_FOR_PROFILE_ALERTS:
        current_kl = kl_values[-1]
        prev_kl_max = max(kl_values[-6:-1])
        if prev_kl_max > 0 and current_kl >= prev_kl_max * 2.5 and current_kl > 0.15:
            decision = _build_alert_decision(
                source="playbook",
                syndrome="kl_explosion",
                message=(
                    "KL divergence spiked, policy update may be unstable "
                    f"(current={current_kl:.4f}, previous_max={prev_kl_max:.4f})."
                ),
                severity="warning",
                evidence={"current_kl": current_kl, "previous_max_kl": prev_kl_max},
            )
            if not seen_recent_signature(state, "playbook", decision["signature"]):
                decisions.append(decision)

    return select_most_urgent_decision(decisions)


def detect_baseline_drift_alert(summary: dict, baseline: dict | None, state: dict) -> dict | None:
    if not baseline:
        return None
    decisions: list[dict] = []
    baseline_tp = _safe_float(baseline.get("recent_throughput_mean"))
    current_tp = _safe_float(summary.get("recent_throughput_mean"))
    if baseline_tp and current_tp and baseline_tp > 0 and current_tp <= baseline_tp * 0.6:
        decision = _build_alert_decision(
            source="baseline",
            syndrome="throughput_regression",
            message=(
                "Throughput is much lower than prior similar runs "
                f"(current={current_tp:.2f}, baseline={baseline_tp:.2f})."
            ),
            severity="warning",
            evidence={"current_throughput": current_tp, "baseline_throughput": baseline_tp},
        )
        if not seen_recent_signature(state, "baseline", decision["signature"]):
            decisions.append(decision)

    baseline_acc = _safe_float(baseline.get("best_val_accuracy"))
    current_acc = _safe_float(summary.get("best_val_accuracy"))
    if baseline_acc and current_acc and current_acc <= baseline_acc - 0.05:
        decision = _build_alert_decision(
            source="baseline",
            syndrome="precision_drift",
            message=(
                "Validation quality is behind prior similar runs "
                f"(current_best={current_acc:.4f}, baseline_best={baseline_acc:.4f})."
            ),
            severity="warning",
            evidence={"current_best_val_accuracy": current_acc, "baseline_best_val_accuracy": baseline_acc},
        )
        if not seen_recent_signature(state, "baseline", decision["signature"]):
            decisions.append(decision)

    return select_most_urgent_decision(decisions)


def build_monitoring_snapshot(profile: str, summary: dict, baseline: dict | None, state: dict) -> dict:
    syndrome_counts = state.get("syndrome_counts")
    if not isinstance(syndrome_counts, dict):
        syndrome_counts = {}
    tags = [profile]
    if baseline:
        tags.append("baseline-aware")
    if syndrome_counts:
        tags.append("alerts-active")
    snapshot = {
        "profile": profile,
        "summary": summary,
        "baseline": baseline or {},
        "syndrome_counts": syndrome_counts,
        "updated_at": time.time(),
    }
    note = _build_monitor_note(profile, summary, baseline)
    return {
        "monitor_note": note[:220],
        "monitor_tags": tags[:8],
        "monitoring": snapshot,
    }


def record_alert_syndrome(state: dict, decision: dict | None):
    if not decision or decision.get("action") != "alert":
        return
    syndrome = (decision.get("syndrome") or decision.get("source") or "unknown").strip().lower()
    if not syndrome:
        syndrome = "unknown"
    counts = state.setdefault("syndrome_counts", {})
    counts[syndrome] = int(counts.get(syndrome, 0)) + 1


def rulebased_alerts(metrics_rows: list[dict], state: dict) -> dict | None:
    """Deterministic alerts for hard metric anomalies."""
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
        step_prefix = f"step={high_step}, " if isinstance(high_step, (int, float)) else ""
        message = (
            f"High loss detected ({step_prefix}loss={high_loss:.4f}, "
            f"threshold={LOSS_ALERT_THRESHOLD:.1f})."
        )
    else:
        message = f"Loss spike detected (loss={current:.4f}, rolling_avg={mean_prev:.4f})."

    decision = _build_alert_decision(
        source="rulebased",
        syndrome="loss_anomaly",
        message=message,
        severity="warning",
    )
    if seen_recent_signature(state, "rulebased", decision["signature"]):
        return None
    return decision

def should_run_alert_judge(job_id: str, metrics_file: str) -> bool:
    try:
        file_size = os.path.getsize(metrics_file)
    except OSError:
        return False
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

def alert_judge(
    job_id: str,
    metrics_file: str | None,
    workdir: str,
    profile: str,
    recent_logs: list[str],
    state: dict,
) -> dict:
    """LLM-based alert gate for softer anomalies."""
    if not metrics_file or not os.path.exists(metrics_file):
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
        "profile": profile,
        "recent_metrics": recent_metrics,
        "recent_logs": recent_logs[-20:],
    }
    decision = run_alert_judge(json.dumps(context_blob, ensure_ascii=True), workdir)
    if not decision or decision.get("action") != "alert":
        return {"action": "ignore"}

    message = (decision.get("message") or "Metric anomaly detected.").strip()
    if len(message) > 600:
        message = f"{message[:597]}..."
    signature = _decision_signature(f"judge:{message}")
    if seen_recent_signature(state, "alert_judge", signature):
        return {"action": "ignore"}

    return {
        "action": "alert",
        "message": message,
        "severity": _normalize_severity(decision.get("severity")),
        "choices": decision.get("choices") or ["Ignore", "Stop Job"],
        "source": "alert_judge",
        "syndrome": "judge_soft_anomaly",
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
    command_fp = command_fingerprint(command)
    baseline_history = load_baseline_history(workdir)

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
                "command_fingerprint": command_fp,
                "gpu_preflight": gpu_preflight,
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

            profile = infer_workload_profile(command, recent_rows, log_context)
            alert_state["profile"] = profile
            summary = summarize_metrics_for_monitoring(recent_rows)
            baseline = baseline_reference_from_history(baseline_history, command_fp, profile)

            log_decision = detect_log_syndrome_alert(job_id, log_file, alert_state, lines=new_log_lines)
            rule_decision = rulebased_alerts(recent_rows, alert_state)
            profile_decision = None
            if profile == "reinforcement_learning":
                profile_decision = detect_rl_metric_alert(recent_rows, alert_state)
            elif profile == "supervised":
                profile_decision = detect_supervised_metric_alert(recent_rows, alert_state)
            baseline_decision = detect_baseline_drift_alert(summary, baseline, alert_state)
            urgent_decision = select_most_urgent_decision([
                log_decision, rule_decision, profile_decision, baseline_decision,
            ])

            if urgent_decision:
                record_alert_syndrome(alert_state, urgent_decision)
                if apply_alert_decision(server_url, job_id, run_dir, urgent_decision, auth_token=auth_token):
                    logger.info("Stopping job due to sidecar playbook alert response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                    return
            else:
                judge_decision = alert_judge(
                    job_id=job_id,
                    metrics_file=metrics_file,
                    workdir=workdir,
                    profile=profile,
                    recent_logs=log_context,
                    state=alert_state,
                )
                if judge_decision and judge_decision.get("action") == "alert":
                    record_alert_syndrome(alert_state, judge_decision)
                if apply_alert_decision(server_url, job_id, run_dir, judge_decision, auth_token=auth_token):
                    logger.info("Stopping job due to alert_judge response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                    return

            now = time.time()
            snapshot = build_monitoring_snapshot(profile, summary, baseline, alert_state)
            monitor_note = snapshot.get("monitor_note", "")
            if (now - last_heartbeat >= MONITOR_HEARTBEAT_SECONDS) or (monitor_note != last_monitor_note):
                status_payload = {
                    "tmux_pane": job_pane.pane_id,
                    **snapshot,
                }
                if found_wandb_dir:
                    status_payload["wandb_dir"] = found_wandb_dir
                report_status(
                    server_url,
                    job_id,
                    "running",
                    status_payload,
                    auth_token=auth_token,
                )
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

    final_metrics_file = resolve_monitor_metrics_file(run_dir, found_wandb_dir)
    final_rows = read_recent_metrics(final_metrics_file, max_lines=200, max_bytes=200000) if final_metrics_file else []
    final_profile = alert_state.get("profile") if isinstance(alert_state.get("profile"), str) else "generic"
    if final_profile == "generic":
        final_profile = infer_workload_profile(command, final_rows, [])
    final_summary = summarize_metrics_for_monitoring(final_rows)
    persist_run_summary(
        workdir,
        {
            "run_id": job_id,
            "status": "finished" if exit_code == "0" else "failed",
            "timestamp": time.time(),
            "profile": final_profile,
            "command_fingerprint": command_fp,
            "summary": final_summary,
        },
    )
    
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
