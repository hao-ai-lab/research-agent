"""SidecarAgent — wraps the job_sidecar monitor_job() as a proper Agent.

The sidecar is "just an agent" — a long-running monitor that wraps a tmux
process, tracks metrics, detects alerts, and reports status.  This Agent
subclass wraps the existing `tools/job_sidecar.py` implementation so it
participates in the agentsys Runtime lifecycle and EventRelay communication.

For backward compatibility, the tmux-based launch in `runs/helpers.py`
still spawns job_sidecar.py as a subprocess.  New code can spawn
SidecarAgent via the agentsys Runtime instead.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from agentsys.agent import Agent
from agentsys.types import EntryType

logger = logging.getLogger("sidecar_agent")


class SidecarAgent(Agent):
    """Job monitoring agent — wraps monitor_job() from tools/job_sidecar.py.

    Config keys:
        server_url: str — Server callback URL
        job_id: str — Run ID being monitored
        command: str — Shell command being executed
        workdir: str — Working directory
        run_dir: str — Run artifact directory
        auth_token: str — Auth token for API callbacks
        gpuwrap_config: dict — Optional GPU wrapper config
    """

    role = "sidecar"
    allowed_child_roles = frozenset()  # leaf node: cannot spawn children

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
        self._emit_event("sidecar_status", {
            "status": "starting",
            "job_id": self._job_id,
            "command": self._command,
        })

    async def on_stop(self) -> None:
        self._emit_event("sidecar_status", {
            "status": "stopped",
            "job_id": self._job_id,
        })

    async def run(self) -> None:
        """Run monitor_job() in a thread to avoid blocking the event loop."""
        self._emit_event("sidecar_status", {
            "status": "monitoring",
            "job_id": self._job_id,
        })

        try:
            # Import monitor_job from tools/job_sidecar
            from tools.job_sidecar import monitor_job
        except ImportError:
            try:
                import importlib
                mod = importlib.import_module("tools.job_sidecar")
                monitor_job = mod.monitor_job
            except ImportError as err:
                logger.error("[sidecar-agent] Cannot import monitor_job: %s", err)
                self._emit_event("sidecar_error", {
                    "error": f"Import failed: {err}",
                    "job_id": self._job_id,
                })
                return

        # Run the synchronous monitor_job in a thread
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
            self._emit_event("sidecar_result", {
                "summary": f"Job {self._job_id} completed",
                "job_id": self._job_id,
            })
        except Exception as err:
            logger.error("[sidecar-agent] monitor_job failed: %s", err, exc_info=True)
            self._emit_event("sidecar_error", {
                "error": f"Job {self._job_id} failed: {err}",
                "job_id": self._job_id,
            })
