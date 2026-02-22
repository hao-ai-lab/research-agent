"""SweepCoordinatorAgent -- Level 2 orchestrator that manages N parallel runs.

Expands a parameter grid into individual run configurations, spawns
ExecutorAgents with concurrency control, and aggregates progress.

Builds on the OrchestratorAgent pattern (spawn_child → wait → query results)
but adds parameter expansion, batched parallel execution, and progress tracking.

See the plan: "Sweep = Level 2 orchestrator. Run = Level 3 executor."
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time

from agentsys.agent import Agent, ChildHandle
from agentsys.agents.executor import ExecutorAgent, build_command_with_params
from agentsys.types import AgentStatus, EntryType

logger = logging.getLogger(__name__)


def expand_parameter_grid(parameters: dict, max_runs: int = 1000) -> list[dict]:
    """Expand parameter dict into list of parameter combinations (Cartesian product).

    Ported from sweep_routes.py:75.

    Args:
        parameters: Dict of param_name → list of values.
        max_runs: Cap on total combinations.

    Returns:
        List of dicts, each mapping param_name → single value.
    """
    keys = list(parameters.keys())
    values = [parameters[k] if isinstance(parameters[k], list) else [parameters[k]] for k in keys]
    combinations = list(itertools.product(*values))[:max_runs]
    return [dict(zip(keys, combo)) for combo in combinations]


class SweepCoordinatorAgent(Agent):
    """Orchestrator that expands a parameter grid and spawns ExecutorAgents.

    Config options:
        base_command:  str   -- command template (e.g. "python train.py")
        workdir:       str   -- working directory for all runs
        parameters:    dict  -- param_name → list of values for grid expansion
        max_runs:      int   -- cap on total parameter combinations (default 1000)
        parallel:      int   -- max concurrent runs (default 1)
        sweep_name:    str   -- human-readable name for the sweep
        gpuwrap_config: dict -- GPU wrapper config passed to all executors
        executor_backend: str -- backend for executor agents (default "subprocess")
    """

    role = "orchestrator"
    allowed_child_roles = frozenset({"executor", "sidecar"})
    monitor_interval = 3.0

    # Internal tracking
    _run_handles: dict[str, ChildHandle]
    _run_configs: list[dict]
    _progress: dict

    async def on_start(self) -> None:
        self._run_handles = {}
        self._run_configs = []
        self._progress = {
            "total": 0, "completed": 0, "failed": 0,
            "running": 0, "queued": 0,
        }

    async def run(self) -> None:
        """Expand parameter grid and spawn ExecutorAgents with concurrency control."""
        base_command = self.config.get("base_command", "")
        workdir = self.config.get("workdir", ".")
        parameters = self.config.get("parameters", {})
        max_runs = self.config.get("max_runs", 1000)
        parallel = max(1, self.config.get("parallel", 1))
        sweep_name = self.config.get("sweep_name", self.goal)
        gpuwrap_config = self.config.get("gpuwrap_config")
        executor_backend = self.config.get("executor_backend", "subprocess")

        # Step 1: Expand parameter grid
        if parameters:
            self._run_configs = expand_parameter_grid(parameters, max_runs)
        else:
            # Single run with no parameters
            self._run_configs = [{}]

        total = len(self._run_configs)
        self._progress["total"] = total
        self._progress["queued"] = total

        # Write plan
        self.memory.write(
            {
                "event": "sweep_plan",
                "sweep_name": sweep_name,
                "base_command": base_command,
                "parameters": parameters,
                "total_runs": total,
                "parallel": parallel,
            },
            type=EntryType.PLAN,
            tags=["sweep", "plan"],
        )
        logger.info("[%s] Sweep plan: %d runs, parallel=%d", self.id, total, parallel)

        # Step 2: Spawn executors in batches with concurrency control
        pending_configs = list(enumerate(self._run_configs))
        active_handles: list[tuple[int, ChildHandle]] = []

        while pending_configs or active_handles:
            await self.check_pause()

            # Check for steers
            steer = self.consume_steer()
            if steer:
                await self.on_steer(steer)
                self.memory.write(
                    {"steer": steer.context, "action": "acknowledged"},
                    type=EntryType.CONTEXT,
                    tags=["steer"],
                )

            # Spawn new runs up to parallel limit
            while pending_configs and len(active_handles) < parallel:
                idx, params = pending_configs.pop(0)

                # Build run name and command
                if params:
                    param_label = ", ".join(f"{k}={v}" for k, v in params.items())
                    run_name = f"{sweep_name}[{idx}] {param_label}"
                    command = build_command_with_params(base_command, params)
                else:
                    run_name = f"{sweep_name}[{idx}]"
                    command = base_command

                # Spawn executor
                executor_config = {
                    "backend": executor_backend,
                    "command": command,
                    "workdir": workdir,
                }
                if gpuwrap_config:
                    executor_config["gpuwrap_config"] = gpuwrap_config

                try:
                    handle = await self.spawn_child(
                        ExecutorAgent,
                        goal=run_name,
                        **executor_config,
                    )
                    active_handles.append((idx, handle))
                    self._run_handles[handle.id] = handle
                    self._progress["queued"] -= 1
                    self._progress["running"] += 1
                    logger.info("[%s] Spawned run %d/%d: %s", self.id, idx + 1, total, run_name)
                except Exception as e:
                    logger.error("[%s] Failed to spawn run %d: %s", self.id, idx, e)
                    self._progress["queued"] -= 1
                    self._progress["failed"] += 1

            # Wait for any active handle to complete
            if active_handles:
                completed_indices = []
                for i, (idx, handle) in enumerate(active_handles):
                    if handle.status in (AgentStatus.DONE, AgentStatus.FAILED):
                        completed_indices.append(i)

                        # Update progress
                        self._progress["running"] -= 1
                        if handle.status == AgentStatus.DONE:
                            self._progress["completed"] += 1
                        else:
                            self._progress["failed"] += 1

                        # Query result
                        results = self.query(agent_id=handle.id, type=EntryType.RESULT)
                        result_data = results[0].data if results else {}

                        self.memory.write(
                            {
                                "run_index": idx,
                                "run_id": handle.id,
                                "status": handle.status.value,
                                "result": result_data,
                            },
                            type=EntryType.REFLECTION,
                            tags=["run_complete"],
                        )
                        self.iteration += 1

                # Remove completed handles (reverse order to preserve indices)
                for i in reversed(completed_indices):
                    active_handles.pop(i)

                if not completed_indices:
                    # No completions yet — wait a bit before polling again
                    await asyncio.sleep(0.5)

        # Step 3: Write progress and completion
        self._write_progress()

        self.memory.write(
            {
                "event": "sweep_complete",
                "progress": dict(self._progress),
                "sweep_name": sweep_name,
            },
            type=EntryType.CONTEXT,
            tags=["sweep", "complete"],
        )
        logger.info("[%s] Sweep complete: %s", self.id, self._progress)

    async def on_monitor(self) -> None:
        """Aggregate children statuses and write progress as CONTEXT."""
        self._recompute_progress()
        self._write_progress()

    def _recompute_progress(self) -> None:
        """Recompute progress from current child handle statuses."""
        if not self._run_handles:
            return

        running = 0
        completed = 0
        failed = 0
        for handle in self._run_handles.values():
            status = handle.status
            if status == AgentStatus.RUNNING:
                running += 1
            elif status == AgentStatus.DONE:
                completed += 1
            elif status == AgentStatus.FAILED:
                failed += 1

        queued = self._progress["total"] - running - completed - failed
        self._progress.update({
            "running": running,
            "completed": completed,
            "failed": failed,
            "queued": max(0, queued),
        })

    def _write_progress(self) -> None:
        """Write current progress to FileStore."""
        if self.memory:
            self.memory.write(
                {"progress": dict(self._progress)},
                type=EntryType.CONTEXT,
                tags=["sweep", "progress"],
            )

    def get_progress(self) -> dict:
        """Return current progress dict (for API queries)."""
        self._recompute_progress()
        return dict(self._progress)
