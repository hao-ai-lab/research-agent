#!/usr/bin/env python3
"""
Job Sidecar - Agent-driven job execution and monitoring in tmux

This script is spawned by the server in a tmux window to:
1. Create a separate pane for the actual job
2. Execute the command (agent-driven or deterministic fallback)
3. Monitor logs periodically, computing diffs for agent analysis
4. Detect and stream WandB metrics back to the server
5. Trigger alerts via rule-based checks and LLM-based analysis
"""

import argparse
import glob as glob_mod
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
import traceback
import requests
import libtmux

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
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
LOG_DIFF_INTERVAL = 30  # seconds between agent log reviews
METRICS_PUSH_INTERVAL = 10  # seconds between metric pushes to server
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD")

_last_metrics_pos: dict[str, int] = {}
_last_judge_check: dict[str, float] = {}


# ===========================================================================
# HTTP helpers
# ===========================================================================

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


def push_metrics_to_server(
    server_url: str,
    job_id: str,
    metrics_snapshot: dict,
    auth_token: str | None = None,
):
    """Push a metrics snapshot to the dedicated metrics endpoint."""
    try:
        requests.post(
            f"{server_url}/runs/{job_id}/metrics",
            json=metrics_snapshot,
            headers=_auth_headers(auth_token),
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Failed to push metrics: {e}")


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


# ===========================================================================
# Metrics helpers
# ===========================================================================

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


# ===========================================================================
# WandB directory detection
# ===========================================================================


def scan_wandb_dir(workdir: str) -> str | None:
    """Scan workdir/wandb/ for the most recent run directory.

    Works for both online and offline wandb modes since both write local files.
    """
    wandb_root = os.path.join(workdir, "wandb")
    if not os.path.isdir(wandb_root):
        return None

    # wandb creates directories like: run-20250213_120000-abc12345
    # or offline-run-20250213_120000-abc12345
    pattern = os.path.join(wandb_root, "*run-*")
    candidates = sorted(glob_mod.glob(pattern), key=os.path.getmtime, reverse=True)
    for candidate in candidates:
        if os.path.isdir(candidate):
            # Check if files/ subdirectory exists with metrics
            files_dir = os.path.join(candidate, "files")
            if os.path.isdir(files_dir):
                return files_dir
            return candidate
    return None


def find_metrics_file(wandb_dir: str) -> str | None:
    """Find the metrics JSONL file in a wandb run directory."""
    if not wandb_dir or not os.path.exists(wandb_dir):
        return None

    candidates = [
        os.path.join(wandb_dir, "metrics.jsonl"),
        os.path.join(wandb_dir, "files", "metrics.jsonl"),
        os.path.join(wandb_dir, "wandb-history.jsonl"),
        os.path.join(wandb_dir, "files", "wandb-history.jsonl"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


# ===========================================================================
# WandB Metrics Watcher - streams real metrics to server
# ===========================================================================

class WandbMetricsWatcher:
    """Watches wandb metrics files and pushes incremental updates to the server."""

    def __init__(self, server_url: str, job_id: str, auth_token: str | None = None):
        self.server_url = server_url
        self.job_id = job_id
        self.auth_token = auth_token
        self._last_file_pos: int = 0
        self._last_push_time: float = 0
        self._metrics_file: str | None = None
        self._pending_rows: list[dict] = []

    def set_metrics_file(self, path: str):
        if path != self._metrics_file:
            logger.info(f"Metrics watcher tracking: {path}")
            self._metrics_file = path
            self._last_file_pos = 0
            self._pending_rows = []

    def poll(self):
        """Read new lines from metrics file and push if interval elapsed."""
        if not self._metrics_file or not os.path.isfile(self._metrics_file):
            return

        try:
            with open(self._metrics_file, "r") as f:
                f.seek(self._last_file_pos)
                new_data = f.read()
                self._last_file_pos = f.tell()
        except Exception:
            return

        for line in new_data.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    self._pending_rows.append(row)
            except json.JSONDecodeError:
                continue

        now = time.time()
        if self._pending_rows and (now - self._last_push_time >= METRICS_PUSH_INTERVAL):
            self._flush()

    def flush_final(self):
        """Push any remaining rows."""
        if self._metrics_file and os.path.isfile(self._metrics_file):
            try:
                with open(self._metrics_file, "r") as f:
                    f.seek(self._last_file_pos)
                    new_data = f.read()
                for line in new_data.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                        if isinstance(row, dict):
                            self._pending_rows.append(row)
                    except json.JSONDecodeError:
                        continue
            except Exception:
                pass
        if self._pending_rows:
            self._flush()

    def _flush(self):
        snapshot = {
            "rows": self._pending_rows,
            "metrics_file": self._metrics_file,
            "total_rows_sent": len(self._pending_rows),
        }
        push_metrics_to_server(self.server_url, self.job_id, snapshot, self.auth_token)
        logger.info(f"Pushed {len(self._pending_rows)} metric rows to server")
        self._pending_rows = []
        self._last_push_time = time.time()


# ===========================================================================
# Agent Loop - connects to opencode for intelligent log analysis
# ===========================================================================

class SidecarAgentLoop:
    """Agent loop that connects to opencode for intelligent monitoring.

    The agent reviews log diffs periodically to detect issues the rule-based
    system might miss: subtle convergence problems, wrong hyperparameters,
    hardware warnings, etc.

    Falls back gracefully when opencode is unavailable.
    """

    def __init__(
        self,
        opencode_url: str = OPENCODE_URL,
        job_id: str = "",
        run_name: str = "",
        command: str = "",
    ):
        self.opencode_url = opencode_url
        self.job_id = job_id
        self.run_name = run_name
        self.command = command
        self.session_id: str | None = None
        self.available = False
        self._last_log_review: float = 0
        self._prev_log_content: str = ""

    def connect(self):
        """Create a new opencode session for this sidecar agent."""
        try:
            import httpx
            auth = None
            if OPENCODE_PASSWORD:
                auth = httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD)

            with httpx.Client(timeout=10) as client:
                resp = client.post(f"{self.opencode_url}/session", json={}, auth=auth)
                resp.raise_for_status()
                self.session_id = resp.json().get("id")

            if self.session_id:
                logger.info(f"Sidecar agent connected: session={self.session_id}")
                self.available = True
                # Send initial context prompt
                self._send_prompt(
                    f"You are a sidecar agent monitoring ML training job '{self.run_name}' "
                    f"(job_id={self.job_id}). The command being run is:\n"
                    f"```\n{self.command}\n```\n"
                    f"I will periodically show you log diffs. Analyze them for:\n"
                    f"1. Training issues (loss not decreasing, NaN, divergence)\n"
                    f"2. Hardware issues (OOM, CUDA errors)\n"
                    f"3. Configuration mistakes (wrong paths, bad hyperparameters)\n"
                    f"4. Progress updates (what epoch/step, current metrics)\n"
                    f"Respond with a brief JSON: "
                    f'{{"status": "ok"|"warning"|"error", "summary": "...", "action": "none"|"alert"}}\n'
                    f"Keep responses concise."
                )
        except Exception as e:
            logger.warning(f"Sidecar agent unavailable (opencode not reachable): {e}")
            self.available = False

    def _send_prompt(self, content: str) -> str | None:
        """Send a prompt to the opencode session and get the response."""
        if not self.session_id:
            return None
        try:
            import httpx
            auth = None
            if OPENCODE_PASSWORD:
                auth = httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD)

            with httpx.Client(timeout=60) as client:
                resp = client.post(
                    f"{self.opencode_url}/session/{self.session_id}/prompt",
                    json={
                        "parts": [{"type": "text", "text": content}],
                    },
                    auth=auth,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    # Extract text from response parts
                    parts = data.get("parts", [])
                    texts = []
                    for part in parts:
                        if isinstance(part, dict) and part.get("type") == "text":
                            texts.append(part.get("text", ""))
                    return "\n".join(texts) if texts else None
        except Exception as e:
            logger.warning(f"Agent prompt failed: {e}")
            self.available = False
        return None

    def review_log_diff(self, log_file: str) -> dict | None:
        """Read log diff since last check and ask agent to analyze it.

        Returns parsed agent response or None.
        """
        if not self.available:
            return None

        now = time.time()
        if now - self._last_log_review < LOG_DIFF_INTERVAL:
            return None
        self._last_log_review = now

        if not os.path.isfile(log_file):
            return None

        try:
            with open(log_file, "r", errors="replace") as f:
                current_content = f.read()
        except Exception:
            return None

        # Compute diff
        if len(current_content) <= len(self._prev_log_content):
            return None

        diff = current_content[len(self._prev_log_content):]
        self._prev_log_content = current_content

        if not diff.strip():
            return None

        # Truncate diff if too large
        max_diff_chars = 4000
        if len(diff) > max_diff_chars:
            diff = f"... (truncated {len(diff) - max_diff_chars} chars) ...\n" + diff[-max_diff_chars:]

        prompt = (
            f"New log output (diff since last check):\n"
            f"```\n{diff}\n```\n"
            f"Analyze this output. Respond with JSON only."
        )

        response = self._send_prompt(prompt)
        if not response:
            return None

        # Try to parse JSON from response
        try:
            match = re.search(r"\{.*\}", response, re.S)
            if match:
                return json.loads(match.group(0))
        except (json.JSONDecodeError, AttributeError):
            pass

        return None

    def request_command_launch(self, command: str, workdir: str) -> str | None:
        """Ask the agent how to launch the command.

        Returns a modified command string or None to use the original.
        """
        if not self.available:
            return None

        prompt = (
            f"I need to launch this training command in a tmux pane:\n"
            f"```\n{command}\n```\n"
            f"Working directory: {workdir}\n"
            f"Should I modify the command in any way? For example:\n"
            f"- Add CUDA_VISIBLE_DEVICES if GPUs are needed\n"
            f"- Add WANDB_MODE=offline if network is unreliable\n"
            f"- Any environment setup needed\n"
            f"Respond with JSON: "
            f'{{"command": "the command to run", "reason": "why modified or unchanged"}}\n'
            f"If no changes needed, return the original command."
        )

        response = self._send_prompt(prompt)
        if not response:
            return None

        try:
            match = re.search(r"\{.*\}", response, re.S)
            if match:
                data = json.loads(match.group(0))
                modified_cmd = data.get("command", "").strip()
                reason = data.get("reason", "")
                if modified_cmd and modified_cmd != command:
                    logger.info(f"Agent modified command: {reason}")
                    return modified_cmd
        except (json.JSONDecodeError, AttributeError):
            pass

        return None


# ===========================================================================
# Rule-based alerts (unchanged logic, reorganized)
# ===========================================================================

def rulebased_alerts(job_id: str, wandb_dir: str, state: dict) -> dict | None:
    """Deterministic alerts for hard metric anomalies."""
    metrics_path = os.path.join(wandb_dir, "metrics.jsonl")
    if not os.path.isfile(metrics_path):
        # Also try wandb-history.jsonl
        metrics_path = os.path.join(wandb_dir, "wandb-history.jsonl")
    if not os.path.isfile(metrics_path):
        metrics_path = os.path.join(wandb_dir, "files", "wandb-history.jsonl")
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


def alert_judge(job_id: str, wandb_dir: str, workdir: str, state: dict) -> dict:
    """LLM-based alert gate for softer anomalies."""
    metrics_file = find_metrics_file(wandb_dir)
    if not metrics_file:
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


# ===========================================================================
# Tmux helpers
# ===========================================================================

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


# ===========================================================================
# Main monitoring loop
# ===========================================================================

def monitor_job(
    server_url: str,
    job_id: str,
    command: str,
    workdir: str,
    run_dir: str,
    auth_token: str | None = None,
    enable_agent: bool = True,
):
    """Main job monitoring loop with agent and metrics streaming."""
    logger.info(f"Starting job monitor for {job_id}")
    logger.info(f"Command: {command}")
    logger.info(f"Workdir: {workdir}")
    logger.info(f"Run dir: {run_dir}")

    # --- Initialize agent loop ---
    agent: SidecarAgentLoop | None = None
    if enable_agent:
        agent = SidecarAgentLoop(
            opencode_url=OPENCODE_URL,
            job_id=job_id,
            run_name=os.path.basename(run_dir),
            command=command,
        )
        agent.connect()
        if not agent.available:
            logger.info("Agent unavailable, falling back to deterministic mode")
            agent = None

    # --- Initialize metrics watcher ---
    metrics_watcher = WandbMetricsWatcher(server_url, job_id, auth_token)

    # --- Find tmux pane ---
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

    # --- Optionally let agent modify the command ---
    effective_command = command
    if agent:
        modified = agent.request_command_launch(command, workdir)
        if modified:
            logger.info(f"Agent modified command to: {modified}")
            effective_command = modified

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

    # Set WANDB_DIR so wandb writes to a known location under run_dir
    wandb_parent = os.path.join(run_dir, "wandb_data")
    os.makedirs(wandb_parent, exist_ok=True)
    job_pane.send_keys(f"export WANDB_DIR={shlex.quote(wandb_parent)}")
    time.sleep(0.1)

    # Execute command with exit code capture
    wrapped_command = f"({effective_command}); echo $? > {completion_file}"
    logger.info(f"Executing: {wrapped_command}")
    job_pane.send_keys(wrapped_command)

    # Report running status
    report_status(server_url, job_id, "running", {"tmux_pane": job_pane.pane_id}, auth_token=auth_token)

    # --- Monitoring loop ---
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
                report_status(server_url, job_id, "failed", {"error": "Pane disappeared"}, auth_token=auth_token)
                return

            # --- WandB detection (scan known location, then workdir) ---
            if not found_wandb_dir:
                found_wandb_dir = scan_wandb_dir(wandb_parent) or scan_wandb_dir(workdir)
                if found_wandb_dir:
                    logger.info(f"Detected WandB dir: {found_wandb_dir}")
                    report_status(server_url, job_id, "running", {"wandb_dir": found_wandb_dir}, auth_token=auth_token)
                    # Start tracking metrics file
                    mf = find_metrics_file(found_wandb_dir)
                    if mf:
                        metrics_watcher.set_metrics_file(mf)

            # --- Stream metrics ---
            if found_wandb_dir:
                # Re-check metrics file in case it appeared after initial scan
                if not metrics_watcher._metrics_file:
                    mf = find_metrics_file(found_wandb_dir)
                    if mf:
                        metrics_watcher.set_metrics_file(mf)
                metrics_watcher.poll()

            # --- Agent log review ---
            if agent and os.path.isfile(log_file):
                agent_result = agent.review_log_diff(log_file)
                if agent_result:
                    status = agent_result.get("status", "ok")
                    summary = agent_result.get("summary", "")
                    action = agent_result.get("action", "none")
                    logger.info(f"Agent review: status={status}, summary={summary}")

                    if action == "alert" and summary:
                        severity = "warning" if status == "warning" else "critical" if status == "error" else "info"
                        alert_sig = hashlib.sha1(summary.encode()).hexdigest()[:12]
                        if not seen_recent_signature(alert_state, "agent", alert_sig):
                            alert_id = trigger_alert(
                                server_url, job_id, f"[Agent] {summary}",
                                ["Ignore", "Stop Job"], severity, auth_token,
                            )
                            if alert_id:
                                response = wait_for_response(run_dir, alert_id, timeout_seconds=120)
                                if should_stop_from_choice(response):
                                    logger.info("Stopping job due to agent alert response")
                                    job_pane.cmd("kill-pane")
                                    report_status(server_url, job_id, "stopped",
                                                  {"error": "Stopped via agent alert"}, auth_token=auth_token)
                                    return

            # --- Manual alert trigger path ---
            if maybe_trigger_manual_alert(server_url, job_id, workdir, run_dir, auth_token=auth_token):
                logger.info("Stopping job due to manual alert response")
                job_pane.cmd("kill-pane")
                report_status(server_url, job_id, "stopped", {"error": "Stopped via alert response"}, auth_token=auth_token)
                return

            # --- Rule-based alerts, then LLM alert judge ---
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

        except Exception as e:
            logger.error(f"Error in monitoring loop: {e}\n{traceback.format_exc()}")

        time.sleep(check_interval)

    # --- Job completed ---
    # Flush any remaining metrics
    metrics_watcher.flush_final()

    exit_code = "unknown"
    try:
        with open(completion_file, "r") as f:
            exit_code = f.read().strip()
    except Exception:
        pass

    if exit_code == "0":
        logger.info("Job completed successfully")
        report_status(server_url, job_id, "finished", {"exit_code": 0}, auth_token=auth_token)
    else:
        logger.error(f"Job failed with exit code: {exit_code}")
        report_status(server_url, job_id, "failed", {"exit_code": exit_code}, auth_token=auth_token)

    logger.info("Sidecar exiting")


# ===========================================================================
# CLI entry point
# ===========================================================================

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
    parser.add_argument(
        "--no-agent",
        action="store_true",
        help="Disable agent loop (use deterministic mode only)",
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
        enable_agent=not args.no_agent,
    )


if __name__ == "__main__":
    main()
