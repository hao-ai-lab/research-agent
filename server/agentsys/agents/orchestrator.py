"""OrchestratorAgent -- plans tasks, spawns executors, reflects.

Mock implementation: generates a fixed task list, spawns mock executors
sequentially, waits for each, queries results, writes reflections.

See agentsys.md section 1.3 and usecases.md UC1/UC2.
"""

from __future__ import annotations

import asyncio
import logging

from agentsys.agent import Agent
from agentsys.agents.executor import ExecutorAgent
from agentsys.types import EntryType

logger = logging.getLogger(__name__)


class OrchestratorAgent(Agent):
    """Plans and delegates tasks to executors.

    Mock implementation: generates a fixed task list, spawns ExecutorAgents
    for each task sequentially, waits for completion, queries results,
    and writes reflections.

    Key behaviors demonstrated:
      - Sequential spawn_child + wait (UC1)
      - Writing PLAN, REFLECTION, CONTEXT entries
      - Checking steers between tasks
      - Querying child results

    Config options:
        tasks:       list[str]  -- task descriptions (default: 3 mock tasks)
        executor_cls: type      -- executor class to spawn (default: ExecutorAgent)
    """

    role = "orchestrator"
    allowed_child_roles = frozenset({"orchestrator", "executor", "sidecar"})

    async def run(self) -> None:
        """Main orchestrator loop: plan -> spawn executors -> reflect."""
        tasks = self.config.get("tasks", [
            "task-1: setup environment",
            "task-2: implement feature",
            "task-3: run tests",
        ])
        executor_cls = self.config.get("executor_cls", ExecutorAgent)

        # Step 1: Write plan
        self.memory.write(
            {"tasks": tasks, "strategy": "sequential"},
            type=EntryType.PLAN,
            tags=["plan"],
        )
        logger.info("[%s] Plan: %d tasks", self.id, len(tasks))

        # Step 2: Execute each task
        for i, task in enumerate(tasks):
            # Check for pause
            await self.check_pause()

            # Check for steers between tasks
            steer = self.consume_steer()
            if steer:
                await self.on_steer(steer)
                self.memory.write(
                    {"steer": steer.context, "action": "acknowledged"},
                    type=EntryType.CONTEXT,
                    tags=["steer"],
                )

            # Spawn executor (pass mock_delay through so children run at same pace)
            executor_config = {}
            if "mock_delay" in self.config:
                executor_config["mock_delay"] = self.config["mock_delay"]
            handle = await self.spawn_child(executor_cls, goal=task, **executor_config)

            # Wait for completion
            try:
                await handle.wait(timeout=30)
            except asyncio.TimeoutError:
                await handle.cancel()
                self.memory.write(
                    {"task": task, "error": "timeout"},
                    type=EntryType.CONTEXT,
                    tags=["timeout"],
                )
                continue

            # Query child's result
            results = self.query(
                agent_id=handle.id,
                type=EntryType.RESULT,
            )
            result_data = results[0].data if results else {"output": "no result"}

            # Write reflection
            self.memory.write(
                {
                    "task": task,
                    "result": result_data,
                    "status": handle.status.value,
                },
                type=EntryType.REFLECTION,
                tags=["iteration"],
            )

            self.iteration += 1
            logger.info("[%s] Task %d/%d complete", self.id, i + 1, len(tasks))

        # Step 3: Final context
        self.memory.write(
            {"event": "all_tasks_complete", "total_iterations": self.iteration},
            type=EntryType.CONTEXT,
            tags=["complete"],
        )
