"""SidecarAgent — the real job monitoring orchestrator.

The sidecar is "just an agent" — a long-running monitor that wraps a tmux
process, tracks metrics, detects alerts, and reports status.  This module
contains:
  - ``monitor_job()`` — the main synchronous monitoring loop (moved from
    tools/job_sidecar.py)
  - ``SidecarAgent`` — an Agent subclass that wraps monitor_job() so it
    participates in the AgentRuntime lifecycle and MessageBus communication.

The CLI entry point in tools/job_sidecar.py delegates to monitor_job() here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import time
from typing import Any

from agent.core.agent import Agent
from agent.core.message import Message

from sidecar.tmux_manager import get_current_pane, check_wandb_in_pane
from sidecar.server_api import report_status
from sidecar.alerts import (
    rulebased_alerts,
    alert_judge,
    apply_alert_decision,
    maybe_trigger_manual_alert,
)
from sidecar.metrics import find_wandb_dir_in_rundir, post_metrics_delta
from sidecar.gpu import (
    resolve_gpuwrap_settings,
    detect_available_cuda_devices,
    emit_gpu_retry_alert,
    _read_log_tail_since,
    _looks_like_gpu_conflict,
)

logger = logging.getLogger("job-sidecar")


# ---------------------------------------------------------------------------
# monitor_job — the main synchronous monitoring loop
# ---------------------------------------------------------------------------

def monitor_job(
    server_url: str,
    job_id: str,
    command: str,
    workdir: str,
    run_dir: str,
    auth_token: str | None = None,
    gpuwrap_config: dict | None = None,
    job_pane=None,
):
    """Main job monitoring loop.

    Orchestrates tmux pane management, log capture, WandB metrics,
    alert detection, GPU retry, and status reporting.

    Args:
        job_pane: Optional tmux pane to use for the job. When provided
                  (in-process launch), skips pane discovery and split.
                  When None (legacy subprocess path), finds the current
                  pane via $TMUX_PANE and splits it.
    """
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

    if job_pane is not None:
        # In-process path: pane provided by caller
        logger.info(f"Using provided job pane: {job_pane.pane_id}")
    else:
        # Legacy subprocess path: find our tmux pane and split
        current_pane = get_current_pane()
        if not current_pane:
            logger.error("Could not identify current tmux pane")
            report_status(server_url, job_id, "failed", {"error": "No tmux pane found"}, auth_token=auth_token)
            return
        job_pane = current_pane.window.split(attach=False)
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

    settings = resolve_gpuwrap_settings(gpuwrap_config)
    logger.info("GPU settings: %s", settings)

    # Report running status
    report_status(server_url, job_id, "running", {"tmux_pane": job_pane.pane_id}, auth_token=auth_token)

    # Monitoring/retry state
    found_wandb_dir = None
    check_interval = 2
    alert_state: dict = {}
    metrics_lines_posted = 0
    retries = settings["retries"]  # None = unlimited, 0 = no retry, N = N retries
    total_attempts: int | None = None if retries is None else retries + 1
    attempt = 0
    final_exit_code: str | None = None
    final_error: str | None = None

    while total_attempts is None or attempt < total_attempts:
        attempt += 1
        if os.path.exists(completion_file):
            os.remove(completion_file)

        attempt_log_start = 0
        try:
            if os.path.exists(log_file):
                attempt_log_start = os.path.getsize(log_file)
        except Exception:
            attempt_log_start = 0

        cuda_visible_devices = ""
        detector_payload = None
        if settings["enabled"]:
            cuda_visible_devices, detector_payload = detect_available_cuda_devices(settings)
            logger.info("GPU detector payload: %s", detector_payload)
            if detector_payload is None:
                logger.warning("GPU detector unavailable; running without CUDA_VISIBLE_DEVICES pinning")
            elif not cuda_visible_devices:
                reason = "all GPUs have running processes"
                if total_attempts is None or attempt < total_attempts:
                    emit_gpu_retry_alert(
                        server_url=server_url,
                        job_id=job_id,
                        attempt=attempt,
                        total_attempts=total_attempts,
                        reason=reason,
                        auth_token=auth_token,
                    )
                    time.sleep(settings["retry_delay_seconds"])
                    continue
                final_exit_code = "1"
                final_error = reason
                break

        launch_command = command
        if settings["enabled"] and cuda_visible_devices:
            job_pane.send_keys(f"export CUDA_VISIBLE_DEVICES={shlex.quote(cuda_visible_devices)}")
            time.sleep(0.1)
            logger.info(f"Set CUDA_VISIBLE_DEVICES={cuda_visible_devices}")

            launch_command = f"{command}"
            logger.info(
                "Attempt %d/%d with CUDA_VISIBLE_DEVICES=%s",
                attempt,
                total_attempts,
                cuda_visible_devices,
            )
        elif settings["enabled"]:
            logger.info("Attempt %d/%d with GPU wrap enabled but no CUDA selection", attempt, total_attempts)
        else:
            logger.info("Attempt %d/%d with GPU wrap disabled", attempt, total_attempts)

        wrapped_command = f"({launch_command}); echo $? > {shlex.quote(completion_file)}"
        logger.info(f"Executing: {wrapped_command}")
        job_pane.send_keys(wrapped_command)

        while not os.path.exists(completion_file):
            logger.debug("[metrics-loop] Monitoring job...")
            try:
                # Check if pane still exists
                pane_window = job_pane.window
                pane_exists = any(p.pane_id == job_pane.pane_id for p in pane_window.panes)

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
                        logger.debug("[metrics-loop] WandB dir not found yet")

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
                    logger.debug("[metrics-loop] Skipping metrics POST — no wandb_dir found yet")

            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")

            time.sleep(check_interval)

        # Attempt completed
        attempt_exit_code = "unknown"
        try:
            with open(completion_file, "r") as f:
                attempt_exit_code = f.read().strip()
        except Exception:
            attempt_exit_code = "unknown"

        if attempt_exit_code == "0":
            final_exit_code = "0"
            break

        final_exit_code = attempt_exit_code
        tail = _read_log_tail_since(log_file, attempt_log_start)
        retryable_conflict = settings["enabled"] and _looks_like_gpu_conflict(tail)
        if retryable_conflict and (total_attempts is None or attempt < total_attempts):
            emit_gpu_retry_alert(
                server_url=server_url,
                job_id=job_id,
                attempt=attempt,
                total_attempts=total_attempts,
                reason="command failed due to GPU contention",
                auth_token=auth_token,
            )
            time.sleep(settings["retry_delay_seconds"])
            continue
        break

    # Final status
    if final_exit_code == "0":
        logger.info("Job completed successfully")
        report_status(server_url, job_id, "finished", {"exit_code": 0}, auth_token=auth_token)
    else:
        logger.error(f"Job failed with exit code: {final_exit_code}")
        extra: dict = {"exit_code": final_exit_code}
        if final_error:
            extra["error"] = final_error
        report_status(server_url, job_id, "failed", extra, auth_token=auth_token)

    # Final metrics flush
    if found_wandb_dir:
        logger.info(f"[metrics-final] Final metrics flush: wandb_dir={found_wandb_dir}, lines_posted={metrics_lines_posted}")
        final_posted = post_metrics_delta(server_url, job_id, found_wandb_dir, metrics_lines_posted, auth_token=auth_token)
        logger.info(f"[metrics-final] Final flush done: lines_posted {metrics_lines_posted} → {final_posted}")
    else:
        logger.info("[metrics-final] No wandb_dir found during entire run — skipping final flush")

    logger.info("Sidecar exiting")


# ---------------------------------------------------------------------------
# SidecarAgent — Agent subclass wrapping monitor_job()
# ---------------------------------------------------------------------------

class SidecarAgent(Agent):
    """Job monitoring agent — wraps monitor_job() as a proper Agent.

    Config keys:
        server_url: str — Server callback URL
        job_id: str — Run ID being monitored
        command: str — Shell command being executed
        workdir: str — Working directory
        run_dir: str — Run artifact directory
        auth_token: str — Auth token for API callbacks
        gpuwrap_config: dict — Optional GPU wrapper config
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)

        c = self.config
        self._server_url = c.get("server_url", "http://127.0.0.1:10000")
        self._job_id = c.get("job_id", self.id)
        self._command = c.get("command", "")
        self._workdir = c.get("workdir", ".")
        self._run_dir = c.get("run_dir", "/tmp")
        self._auth_token = c.get("auth_token")
        self._gpuwrap_config = c.get("gpuwrap_config")

    async def on_start(self) -> None:
        await self.send(Message.status(
            self.id, "starting",
            job_id=self._job_id,
            command=self._command,
        ))

    async def on_stop(self) -> None:
        await self.send(Message.status(
            self.id, "stopped",
            job_id=self._job_id,
        ))

    async def run(self) -> None:
        """Run monitor_job() in a thread to avoid blocking the event loop."""
        await self.send(Message.status(self.id, "monitoring", job_id=self._job_id))

        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(
                None,
                lambda: monitor_job(
                    server_url=self._server_url,
                    job_id=self._job_id,
                    command=self._command,
                    workdir=self._workdir,
                    run_dir=self._run_dir,
                    auth_token=self._auth_token,
                    gpuwrap_config=self._gpuwrap_config,
                ),
            )
            await self.send(Message.result(
                self.id,
                summary=f"Job {self._job_id} completed",
                job_id=self._job_id,
            ))
        except Exception as err:
            logger.error("[sidecar-agent] monitor_job failed: %s", err, exc_info=True)
            await self.send(Message.error(
                self.id,
                f"Job {self._job_id} failed: {err}",
                job_id=self._job_id,
            ))

    def to_dict(self) -> dict[str, Any]:
        d = super().to_dict()
        d.update({
            "job_id": self._job_id,
            "command": self._command,
            "workdir": self._workdir,
            "run_dir": self._run_dir,
        })
        return d
