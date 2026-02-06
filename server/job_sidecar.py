#!/usr/bin/env python3
"""
Job Sidecar - Manages job execution in tmux

This script is spawned by the server in a tmux window to:
1. Create a separate pane for the actual job
2. Execute the command with output capture
3. Monitor completion and report status back to server
"""

import argparse
import json
import logging
import os
import re
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


def report_status(server_url: str, job_id: str, status: str, extra_data: dict = None):
    """Report status update to server."""
    data = {"status": status}
    if extra_data:
        data.update(extra_data)
    
    try:
        logger.info(f"Reporting status: {status} with data: {extra_data}")
        requests.post(f"{server_url}/runs/{job_id}/status", json=data, timeout=10)
    except Exception as e:
        logger.warning(f"Failed to report status: {e}")


def trigger_alert(
    server_url: str,
    job_id: str,
    message: str,
    choices: list[str],
    severity: str = "warning",
) -> str | None:
    """Create alert via server and return alert_id."""
    payload = {
        "message": message,
        "choices": choices,
        "severity": severity,
    }
    try:
        logger.info("Triggering alert: %s", message)
        res = requests.post(f"{server_url}/runs/{job_id}/alerts", json=payload, timeout=5)
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
    losses = [loss for row in rows if (loss := extract_loss(row)) is not None]
    if not losses:
        return None

    current = losses[-1]
    previous = losses[:-1]
    finite_previous = [x for x in previous if math.isfinite(x)]
    mean_prev = (sum(finite_previous) / len(finite_previous)) if finite_previous else 0.0

    if not math.isfinite(current):
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

    is_high = current >= LOSS_ALERT_THRESHOLD
    is_spike = (
        len(finite_previous) >= RULE_MIN_PREV_POINTS
        and mean_prev > 0
        and current >= mean_prev * LOSS_SPIKE_MULTIPLIER
    )
    if not (is_high or is_spike):
        return None

    if is_high:
        signature = f"high:{round(current, 4)}"
        message = f"High loss detected (loss={current:.4f}, threshold={LOSS_ALERT_THRESHOLD:.1f})."
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
    run_dir: str
):
    """Main job monitoring loop."""
    logger.info(f"Starting job monitor for {job_id}")
    logger.info(f"Command: {command}")
    logger.info(f"Workdir: {workdir}")
    logger.info(f"Run dir: {run_dir}")
    
    # Find our current pane
    current_pane = get_current_pane()
    if not current_pane:
        logger.error("Could not identify current tmux pane")
        report_status(server_url, job_id, "failed", {"error": "No tmux pane found"})
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
    
    # Execute command with exit code capture
    wrapped_command = f"({command}); echo $? > {completion_file}"
    logger.info(f"Executing: {wrapped_command}")
    job_pane.send_keys(wrapped_command)
    
    # Report running status
    report_status(server_url, job_id, "running", {"tmux_pane": job_pane.pane_id})
    
    # Monitoring loop
    found_wandb_dir = None
    check_interval = 2
    alert_state: dict = {}

    while not os.path.exists(completion_file):
        try:
            # Check if pane still exists
            window = current_pane.window
            pane_exists = any(p.pane_id == job_pane.pane_id for p in window.panes)
            
            if not pane_exists:
                logger.error("Job pane disappeared")
                report_status(server_url, job_id, "failed", {"error": "Pane disappeared"})
                return
            
            # Detect WandB
            if not found_wandb_dir:
                found_wandb_dir = check_wandb_in_pane(job_pane.pane_id, workdir)
                if found_wandb_dir:
                    logger.info(f"Detected WandB dir: {found_wandb_dir}")
                    report_status(server_url, job_id, "running", {"wandb_dir": found_wandb_dir})

            # Manual alert trigger path (for testing and operations)
            if maybe_trigger_manual_alert(server_url, job_id, workdir, run_dir):
                logger.info("Stopping job due to manual alert response")
                job_pane.cmd("kill-pane")
                report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"})
                return

            # Rule-based alerts first, then LLM alert judge.
            if found_wandb_dir:
                rule_decision = rulebased_alerts(job_id, found_wandb_dir, alert_state)
                if apply_alert_decision(server_url, job_id, run_dir, rule_decision):
                    logger.info("Stopping job due to rulebased alert response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"})
                    return

                judge_decision = alert_judge(job_id, found_wandb_dir, workdir, alert_state)
                if apply_alert_decision(server_url, job_id, run_dir, judge_decision):
                    logger.info("Stopping job due to alert_judge response")
                    job_pane.cmd("kill-pane")
                    report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"})
                    return

        except Exception as e:
            logger.error(f"Error in monitoring loop: {e}")
        
        time.sleep(check_interval)
    
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
        report_status(server_url, job_id, "finished", {"exit_code": 0})
    else:
        logger.error(f"Job failed with exit code: {exit_code}")
        report_status(server_url, job_id, "failed", {"exit_code": exit_code})
    
    logger.info("Sidecar exiting")


def main():
    parser = argparse.ArgumentParser(description="Job Sidecar")
    parser.add_argument("--job_id", required=True, help="Job ID")
    parser.add_argument("--server_url", required=True, help="Server URL")
    parser.add_argument("--command_file", required=True, help="Path to command file")
    parser.add_argument("--workdir", default=None, help="Working directory")
    parser.add_argument("--agent_run_dir", default=None, help="Run directory for logs")
    args = parser.parse_args()
    
    # Read command from file
    try:
        with open(args.command_file, "r") as f:
            command = f.read().strip()
    except Exception as e:
        logger.error(f"Failed to read command file: {e}")
        report_status(args.server_url, args.job_id, "failed", {"error": f"Failed to read command: {e}"})
        return
    
    # Run monitor
    monitor_job(
        server_url=args.server_url,
        job_id=args.job_id,
        command=command,
        workdir=args.workdir or os.getcwd(),
        run_dir=args.agent_run_dir or "/tmp"
    )


if __name__ == "__main__":
    main()
