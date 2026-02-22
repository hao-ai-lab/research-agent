"""SidecarAgent -- monitors a running job, polls metrics, emits alerts.

Mock implementation: generates fake metrics with a simulated loss
curve, detects a "loss spike" on iteration 3, and writes ALERT.
Checks inbox for directives each iteration.

See agentsys.md section 1.3 and usecases.md UC3.
"""

from __future__ import annotations

import asyncio
import logging

from agentsys.agent import Agent
from agentsys.types import EntryType

logger = logging.getLogger(__name__)


class SidecarAgent(Agent):
    """Monitors a running job -- polls metrics, detects anomalies.

    Mock implementation: generates fake metrics (decreasing loss curve
    with a spike on iteration 3) and writes ALERT entries on anomalies.

    Config options:
        num_iterations:  int   -- number of poll cycles (default 5)
        poll_interval:   float -- seconds between polls (default 0.1)
        spike_iteration: int   -- which iteration triggers a loss spike (default 3)
    """

    role = "sidecar"
    allowed_child_roles = frozenset()  # leaf node: cannot spawn anything

    async def run(self) -> None:
        """Monitor loop: poll metrics, detect anomalies, check inbox."""
        num_iterations = self.config.get("num_iterations", 5)
        poll_interval = self.config.get("poll_interval", 0.1)
        spike_iteration = self.config.get("spike_iteration", 3)

        # Write start context
        self.memory.write(
            {"event": "monitoring_started", "goal": self.goal},
            type=EntryType.CONTEXT,
            tags=["start"],
        )

        for i in range(num_iterations):
            # Check pause
            await self.check_pause()

            # Check steers
            steer = self.consume_steer()
            if steer:
                await self.on_steer(steer)
                self.memory.write(
                    {"steer": steer.context, "action": "acknowledged"},
                    type=EntryType.CONTEXT,
                    tags=["steer"],
                )

            # Generate mock metrics (loss decreasing, with spike on iteration 3)
            if i == spike_iteration:
                loss = 5.0  # anomalous spike
            else:
                loss = 2.0 - 0.3 * i

            metrics = {"loss": loss, "step": i * 100, "iteration": i}
            self.memory.write(metrics, type=EntryType.METRICS, tags=["metrics"])

            # Detect anomaly: loss spike
            if i == spike_iteration:
                self.memory.write(
                    {"anomaly": "loss_spike", "value": loss, "step": i * 100},
                    type=EntryType.ALERT,
                    tags=["loss_spike", "anomaly"],
                )
                logger.warning("[%s] ALERT: loss spike at step %d", self.id, i * 100)

            # Check inbox for directives
            inbox = self.memory.store.query(target_id=self.id, type=EntryType.MESSAGE)
            for msg_entry in inbox:
                logger.info("[%s] Inbox msg: %s", self.id, msg_entry.data)
                self.memory.store.delete(msg_entry.key)

            self.iteration = i + 1
            await asyncio.sleep(poll_interval)

        # Write completion context
        self.memory.write(
            {"event": "monitoring_complete", "total_iterations": self.iteration},
            type=EntryType.CONTEXT,
            tags=["complete"],
        )
