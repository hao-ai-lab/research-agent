"""ExecutorAgent -- runs a single task via a pluggable backend.

Supports three backends:
  - "subprocess" — real command execution via asyncio.create_subprocess_shell
  - "callback"   — calls a provided async function
  - "mock"       — simulated execution with a short delay (default, for tests)

Subprocess backend ports logic from tools/job_sidecar.py:
  - GPU detection and retry via gpuwrap
  - Streaming stdout/stderr to run.log
  - Metrics tailing in on_monitor()
  - Anomaly detection (NaN loss, spikes) → ALERT entries

See agentsys.md section 1.3.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import sys
import time
from pathlib import Path

from agentsys.agent import Agent
from agentsys.types import AgentStatus, EntryType

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants ported from job_sidecar.py
# ---------------------------------------------------------------------------

LOSS_ALERT_THRESHOLD = 8.0
LOSS_SPIKE_MULTIPLIER = 3.0
RULE_MIN_PREV_POINTS = 3
ALERT_SIGNATURE_TTL_SECONDS = 180

GPU_CONFLICT_PATTERNS = (
    re.compile(r"all CUDA-capable devices are busy or unavailable", re.IGNORECASE),
    re.compile(r"CUDA error:.*busy", re.IGNORECASE),
    re.compile(r"device or resource busy", re.IGNORECASE),
    re.compile(r"CUDA out of memory", re.IGNORECASE),
    re.compile(r"CUBLAS_STATUS_ALLOC_FAILED", re.IGNORECASE),
    re.compile(r"failed to allocate memory on device", re.IGNORECASE),
)

# Common loss keys to check in metrics rows
LOSS_KEYS = ("loss", "train/loss", "train_loss", "training_loss")


# ---------------------------------------------------------------------------
# Helper functions (ported from job_sidecar.py + sweep_routes.py)
# ---------------------------------------------------------------------------

def build_command_with_params(base_command: str, params: dict) -> str:
    """Insert parameters into command string as --key=value flags."""
    param_str = " ".join([f"--{k}={v}" for k, v in params.items()])
    return f"{base_command} {param_str}".strip()


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


def resolve_gpuwrap_settings(gpuwrap_config: dict | None) -> dict:
    """Parse gpuwrap config into normalized settings dict."""
    config = gpuwrap_config if isinstance(gpuwrap_config, dict) else {}
    enabled = _truthy(config["enabled"]) if "enabled" in config else False
    raw_retries = config.get("retries", _env_int("RESEARCH_AGENT_GPUWRAP_RETRIES", -1))
    retries: int | None = None  # unlimited by default
    if raw_retries is not None and int(raw_retries) >= 0:
        retries = int(raw_retries)
    retry_delay_seconds = float(config.get(
        "retry_delay_seconds",
        _env_float("RESEARCH_AGENT_GPUWRAP_RETRY_DELAY_SECONDS", 5.0),
    ))
    return {
        "enabled": enabled,
        "retries": retries,
        "retry_delay_seconds": max(0.1, retry_delay_seconds),
    }


def _looks_like_gpu_conflict(log_tail: str) -> bool:
    """Check if log output indicates a GPU conflict."""
    for pattern in GPU_CONFLICT_PATTERNS:
        if pattern.search(log_tail):
            return True
    return False


def _extract_loss(metrics: dict) -> float | None:
    """Extract common training loss keys from a metrics row."""
    for key in LOSS_KEYS:
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def _read_recent_metrics(metrics_path: str, max_lines: int = 25, max_bytes: int = 24000) -> list[dict]:
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


async def _detect_available_cuda_devices() -> tuple[str, dict | None]:
    """Run gpuwrap_detect.py to discover free GPUs. Returns (CUDA_VISIBLE_DEVICES, payload)."""
    detect_script = _resolve_gpuwrap_detect_script()
    if not detect_script:
        logger.warning("gpuwrap_detect.py not found; skipping GPU detection")
        return "", None

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, detect_script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
    except Exception as e:
        logger.warning("Failed to run gpu detector: %s", e)
        return "", None

    if proc.returncode != 0:
        logger.warning("gpu detector failed: %s", (stderr or b"").decode().strip())
        return "", None

    try:
        payload = json.loads((stdout or b"").decode().strip() or "{}")
    except json.JSONDecodeError:
        logger.warning("gpu detector returned non-json output")
        return "", None

    if not isinstance(payload, dict):
        return "", None
    cuda_visible_devices = str(payload.get("cuda_visible_devices", "")).strip()
    return cuda_visible_devices, payload


def _resolve_gpuwrap_detect_script() -> str | None:
    """Resolve gpuwrap_detect.py path relative to tools/."""
    candidates = []
    # Relative to this file: executor.py → agents/ → agentsys/ → server/ → tools/
    base_dir = Path(__file__).resolve().parent.parent.parent / "tools"
    candidates.append(str(base_dir / "gpuwrap_detect.py"))
    frozen_dir = getattr(sys, "_MEIPASS", None)
    if frozen_dir:
        candidates.append(os.path.join(frozen_dir, "gpuwrap_detect.py"))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


class ExecutorAgent(Agent):
    """Executes a single task via a pluggable backend.

    Stateless between tasks (each executor is spawned for one task).
    Writes its result to the store and exits.

    Config options:
        backend:           str   -- "mock" (default), "subprocess", or "callback"
        mock_delay:        float -- simulated execution time (default 0.1s)
        callback:          async callable(goal) -> str  -- for "callback" backend
        command:           str   -- shell command to run (subprocess backend)
        params:            dict  -- parameter dict, merged as --key=value flags
        workdir:           str   -- working directory for subprocess
        gpuwrap_config:    dict  -- GPU wrapper config {enabled, retries, retry_delay_seconds}
        tmux_debug:        bool  -- if True, also pipe output to tmux pane for debugging
        monitor_interval:  float -- seconds between health checks (0 = disabled)
        respawn_sidecars:  bool  -- whether to auto-respawn crashed sidecars (default True)
        max_respawn_count: int   -- global cap on total respawns (default 3)
    """

    role = "executor"
    allowed_child_roles = frozenset({"sidecar"})
    _respawn_count: int = 0
    _run_dir: str = ""
    _metrics_lines_read: int = 0
    _alert_state: dict = {}

    async def on_start(self) -> None:
        mi = self.config.get("monitor_interval", 0)
        # For subprocess backend, enable monitoring by default for metrics tailing
        if self.config.get("backend") == "subprocess" and mi == 0:
            mi = 3.0
        self.monitor_interval = mi
        self._respawn_count = 0
        self._metrics_lines_read = 0
        self._alert_state = {}

    async def on_monitor(self) -> None:
        """Detect crashed sidecars + tail metrics from run directory."""
        # --- Sidecar crash detection (existing logic) ---
        await self._monitor_sidecars()
        # --- Metrics tailing for subprocess runs ---
        await self._tail_metrics()

    async def _monitor_sidecars(self) -> None:
        """Detect crashed sidecars and optionally respawn them."""
        if not self._runtime:
            return

        respawn_sidecars = self.config.get("respawn_sidecars", True)
        max_respawn_count = self.config.get("max_respawn_count", 3)

        for child_id in list(self.children):
            child = self._runtime.get_agent(child_id)

            # Child removed externally
            if child is None:
                self.children.remove(child_id)
                continue

            if child.status == AgentStatus.FAILED:
                # Write alert
                self.memory.write(
                    {"event": "sidecar_crashed", "child_id": child_id,
                     "child_goal": child.goal},
                    type=EntryType.ALERT,
                    tags=["sidecar_crash", "watchdog"],
                )

                # Remove dead child from our list
                self.children.remove(child_id)

                # Read respawn info from the dead child
                from agentsys.types import AgentInfo
                if isinstance(child, AgentInfo) and child.agent_cls_path:
                    from agentsys.ipc import path_to_cls
                    child_cls = path_to_cls(child.agent_cls_path)
                else:
                    child_cls = type(child)
                child_goal = child.goal
                child_config = dict(child.config)

                if respawn_sidecars and self._respawn_count < max_respawn_count:
                    try:
                        await self.spawn_child(child_cls, child_goal, **child_config)
                        self.memory.write(
                            {"event": "sidecar_respawned", "original_id": child_id,
                             "child_goal": child_goal},
                            type=EntryType.CONTEXT,
                            tags=["watchdog", "respawn"],
                        )
                        self._respawn_count += 1
                    except Exception as e:
                        self.memory.write(
                            {"event": "respawn_failed", "child_id": child_id,
                             "error": str(e)},
                            type=EntryType.ALERT,
                            tags=["watchdog", "respawn_failed"],
                        )
                else:
                    reason = ("max respawn count reached"
                              if self._respawn_count >= max_respawn_count
                              else "respawn disabled")
                    self.memory.write(
                        {"event": "sidecar_not_respawned", "child_id": child_id,
                         "reason": reason},
                        type=EntryType.CONTEXT,
                        tags=["watchdog"],
                    )

    async def _tail_metrics(self) -> None:
        """Tail agent_metrics.jsonl from run dir and write new rows as METRICS entries."""
        if not self._run_dir:
            return

        metrics_path = os.path.join(self._run_dir, "agent_metrics.jsonl")
        if not os.path.exists(metrics_path):
            return

        try:
            with open(metrics_path, "r") as f:
                all_lines = f.readlines()
        except OSError:
            return

        new_lines = all_lines[self._metrics_lines_read:]
        if not new_lines:
            return

        rows: list[dict] = []
        for line in new_lines:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

        self._metrics_lines_read = len(all_lines)

        # Write new metrics to FileStore
        if rows:
            self.memory.write(
                {"rows": rows, "count": len(rows)},
                type=EntryType.METRICS,
                tags=["metrics", "tail"],
            )

        # Run anomaly detection on the rows
        self._check_anomalies(rows)

    def _check_anomalies(self, rows: list[dict]) -> None:
        """Detect loss anomalies (NaN, high loss, spikes) and write ALERT entries."""
        entries: list[tuple[object, float]] = []
        for row in rows:
            loss = _extract_loss(row)
            if loss is None:
                continue
            entries.append((row.get("step"), float(loss)))

        if not entries:
            return

        finite_entries = [(step, loss) for step, loss in entries if math.isfinite(loss)]
        has_non_finite = len(finite_entries) != len(entries)

        if has_non_finite:
            signature = "nan-inf"
            if self._seen_recent_signature("rulebased", signature):
                return
            self.memory.write(
                {"event": "anomaly_detected", "type": "nan_inf",
                 "message": "Training loss became NaN/Inf. This run is unstable.",
                 "severity": "critical"},
                type=EntryType.ALERT,
                tags=["anomaly", "nan_inf"],
            )
            return

        if not finite_entries:
            return

        _current_step, current = finite_entries[-1]
        previous = [loss for _, loss in finite_entries[:-1]]
        mean_prev = (sum(previous) / len(previous)) if previous else 0.0

        # Check high loss
        max_entry = max(finite_entries, key=lambda item: item[1])
        is_high = max_entry[1] >= LOSS_ALERT_THRESHOLD

        # Check spike
        is_spike = (
            len(previous) >= RULE_MIN_PREV_POINTS
            and mean_prev > 0
            and current >= mean_prev * LOSS_SPIKE_MULTIPLIER
        )

        if not (is_high or is_spike):
            return

        if is_high:
            high_step, high_loss = max_entry
            signature = f"high:{round(high_loss, 4)}"
            step_prefix = f"step={high_step}, " if isinstance(high_step, (int, float)) else ""
            message = (
                f"High loss detected ({step_prefix}loss={high_loss:.4f}, "
                f"threshold={LOSS_ALERT_THRESHOLD:.1f})."
            )
        else:
            signature = f"spike:{round(current, 4)}:{round(mean_prev, 4)}"
            message = f"Loss spike detected (loss={current:.4f}, rolling_avg={mean_prev:.4f})."

        if self._seen_recent_signature("rulebased", signature):
            return

        self.memory.write(
            {"event": "anomaly_detected", "type": "loss_anomaly",
             "message": message, "severity": "warning"},
            type=EntryType.ALERT,
            tags=["anomaly", "loss"],
        )

    def _seen_recent_signature(self, namespace: str, signature: str) -> bool:
        """Dedupe alerts by signature with TTL."""
        now = time.time()
        recent = self._alert_state.setdefault("recent_signatures", {})
        key = f"{namespace}:{signature}"
        previous = recent.get(key)
        if previous and now - previous < ALERT_SIGNATURE_TTL_SECONDS:
            return True
        recent[key] = now
        return False

    # ── Main run() dispatch ───────────────────────────────────────────

    async def run(self) -> None:
        """Execute the task and write the result."""
        backend = self.config.get("backend", "mock")

        # Write start context
        self.memory.write(
            {"event": "starting_task", "goal": self.goal, "backend": backend},
            type=EntryType.CONTEXT,
            tags=["start"],
        )

        if backend == "subprocess":
            await self._run_subprocess()
        elif backend == "callback" and "callback" in self.config:
            result = await self.config["callback"](self.goal)
            self.memory.write(
                {"output": result},
                type=EntryType.RESULT,
                tags=["result"],
            )
        else:
            # Mock backend: sleep then return canned result
            delay = self.config.get("mock_delay", 0.1)
            await asyncio.sleep(delay)
            result = f"Mock result for: {self.goal}"
            self.memory.write(
                {"output": result},
                type=EntryType.RESULT,
                tags=["result"],
            )

        self.iteration = 1
        logger.info("[%s] Task complete: %s", self.id, self.goal[:60])

    # ── Subprocess backend ────────────────────────────────────────────

    async def _run_subprocess(self) -> None:
        """Run a command as an async subprocess, ported from job_sidecar.py."""
        command = self.config.get("command", "")
        params = self.config.get("params")
        workdir = self.config.get("workdir", ".")

        # Build final command with params
        if params and isinstance(params, dict):
            command = build_command_with_params(command, params)

        if not command:
            self.memory.write(
                {"output": "No command specified", "exit_code": 1},
                type=EntryType.RESULT,
                tags=["result", "error"],
            )
            return

        # Create run directory
        run_dir = os.path.join(workdir, ".agents", "runs", self.id)
        os.makedirs(run_dir, exist_ok=True)
        self._run_dir = run_dir

        # Write command.txt for debugging
        with open(os.path.join(run_dir, "command.txt"), "w") as f:
            f.write(command)

        log_file = os.path.join(run_dir, "run.log")

        # GPU detection and retry loop
        gpuwrap_config = self.config.get("gpuwrap_config")
        settings = resolve_gpuwrap_settings(gpuwrap_config)
        retries = settings["retries"]
        total_attempts: int | None = None if retries is None else retries + 1
        attempt = 0

        exit_code: int | None = None
        error_msg: str | None = None

        while total_attempts is None or attempt < total_attempts:
            attempt += 1

            # GPU detection
            env = os.environ.copy()
            if settings["enabled"]:
                cuda_devices, _payload = await _detect_available_cuda_devices()
                if _payload is None:
                    logger.warning("GPU detector unavailable; running without CUDA pinning")
                elif not cuda_devices:
                    reason = "all GPUs have running processes"
                    if total_attempts is None or attempt < total_attempts:
                        self.memory.write(
                            {"event": "gpu_retry", "attempt": attempt,
                             "reason": reason},
                            type=EntryType.ALERT,
                            tags=["gpu", "retry"],
                        )
                        await asyncio.sleep(settings["retry_delay_seconds"])
                        continue
                    exit_code = 1
                    error_msg = reason
                    break
                else:
                    env["CUDA_VISIBLE_DEVICES"] = cuda_devices
                    logger.info("Attempt %d with CUDA_VISIBLE_DEVICES=%s", attempt, cuda_devices)

            # Set up WANDB env vars
            wandb_data_dir = os.path.join(run_dir, "wandb_data")
            os.makedirs(wandb_data_dir, exist_ok=True)
            env["WANDB_DIR"] = wandb_data_dir
            env["WANDB_RUN_ID"] = self.id

            logger.info("[%s] Executing: %s (workdir=%s)", self.id, command, workdir)

            try:
                proc = await asyncio.create_subprocess_shell(
                    command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=workdir if os.path.isdir(workdir) else None,
                    env=env,
                )

                # Stream output to run.log
                with open(log_file, "ab") as lf:
                    while True:
                        line = await proc.stdout.readline()
                        if not line:
                            break
                        lf.write(line)
                        lf.flush()

                await proc.wait()
                exit_code = proc.returncode

            except Exception as e:
                exit_code = 1
                error_msg = str(e)
                logger.error("[%s] Subprocess error: %s", self.id, e)

            # Check for GPU conflict in log output and retry if applicable
            if exit_code != 0 and settings["enabled"]:
                try:
                    with open(log_file, "rb") as f:
                        # Read last 60KB for GPU conflict check
                        f.seek(max(0, f.seek(0, 2) - 60000))
                        log_tail = f.read().decode("utf-8", errors="ignore")
                except Exception:
                    log_tail = ""

                if _looks_like_gpu_conflict(log_tail):
                    if total_attempts is None or attempt < total_attempts:
                        self.memory.write(
                            {"event": "gpu_conflict_retry", "attempt": attempt,
                             "log_tail_snippet": log_tail[-200:]},
                            type=EntryType.ALERT,
                            tags=["gpu", "conflict", "retry"],
                        )
                        await asyncio.sleep(settings["retry_delay_seconds"])
                        continue

            # If we got here, either success or non-retryable failure
            break

        # Write completion marker
        done_file = os.path.join(run_dir, "job.done")
        with open(done_file, "w") as f:
            f.write(str(exit_code or 0))

        # Final metrics tail before writing result
        await self._tail_metrics()

        # Write result
        result_data = {
            "exit_code": exit_code or 0,
            "run_dir": run_dir,
            "command": command,
        }
        if error_msg:
            result_data["error"] = error_msg

        if exit_code != 0:
            self.memory.write(
                result_data,
                type=EntryType.RESULT,
                tags=["result", "failed"],
            )
            # Set status to FAILED via raising, unless we want to let the
            # agent framework handle it — we'll just log and let run() complete
            # The agent framework sets DONE on normal exit.
            # For non-zero exit code, we manually set status.
            self.status = AgentStatus.FAILED
            logger.warning("[%s] Command failed with exit code %d", self.id, exit_code)
        else:
            self.memory.write(
                result_data,
                type=EntryType.RESULT,
                tags=["result", "success"],
            )
            logger.info("[%s] Command completed successfully", self.id)
