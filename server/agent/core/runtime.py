"""AgentRuntime — lifecycle manager for agents.

The runtime is the top-level orchestration layer.  It owns the bus,
manages agent lifecycles, and provides the API surface that the server
(or TUI, or CLI) interacts with.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from agent.core.agent import Agent, AgentStatus
from agent.core.bus import MessageBus
from agent.core.message import Message, MessageType

logger = logging.getLogger(__name__)


class AgentRuntime:
    """Manages agent lifecycles.

    Usage::

        runtime = AgentRuntime()
        agent = await runtime.spawn(MyAgent, goal="do stuff")
        await runtime.steer(agent.id, "change direction")
        await runtime.stop(agent.id)
        await runtime.shutdown()
    """

    def __init__(
        self,
        *,
        bus: MessageBus | None = None,
    ) -> None:
        self.bus = bus or MessageBus()
        self._agents: dict[str, Agent] = {}

    # ── Spawn ─────────────────────────────────────────────────────────

    async def spawn(
        self,
        agent_cls: type[Agent],
        *,
        goal: str = "",
        parent_id: str | None = None,
        config: dict[str, Any] | None = None,
        agent_id: str | None = None,
        auto_start: bool = True,
    ) -> Agent:
        """Create and optionally start a new agent.

        Args:
            agent_cls: The Agent subclass to instantiate.
            goal: The agent's goal/objective.
            parent_id: ID of the parent agent (for forked agents).
            config: Agent-specific configuration.
            agent_id: Optional explicit ID.
            auto_start: If True, start the agent immediately.

        Returns:
            The created agent instance.
        """
        agent = agent_cls(
            agent_id=agent_id,
            goal=goal,
            parent_id=parent_id,
            config=config,
        )

        # Inject dependencies
        agent._bus = self.bus
        agent._runtime = self
        agent._inbox = self.bus.register(agent.id)

        self._agents[agent.id] = agent

        # Publish spawn event
        await self.bus.publish(Message(
            type=MessageType.SPAWN,
            source="runtime",
            payload=agent.to_dict(),
        ))

        if auto_start:
            await agent.start()

        logger.info(
            "[runtime] Spawned %s (id=%s, goal=%s)",
            agent_cls.__name__, agent.id, (goal[:60] if goal else "—"),
        )
        return agent

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def stop(self, agent_id: str) -> bool:
        """Stop a specific agent."""
        agent = self._agents.get(agent_id)
        if not agent:
            return False
        await agent.stop()
        return True

    async def pause(self, agent_id: str) -> bool:
        """Pause a specific agent."""
        agent = self._agents.get(agent_id)
        if not agent:
            return False
        await agent.pause()
        return True

    async def resume(self, agent_id: str) -> bool:
        """Resume a paused agent."""
        agent = self._agents.get(agent_id)
        if not agent:
            return False
        await agent.resume()
        return True

    async def steer(self, agent_id: str, context: str) -> bool:
        """Steer an agent with new context."""
        agent = self._agents.get(agent_id)
        if not agent:
            return False
        await agent.steer(context)
        return True

    async def remove(self, agent_id: str) -> bool:
        """Stop and remove an agent from the runtime."""
        agent = self._agents.get(agent_id)
        if not agent:
            return False
        if agent.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
            await agent.stop()
        self.bus.unregister(agent_id)
        del self._agents[agent_id]
        logger.info("[runtime] Removed agent %s", agent_id)
        return True

    async def shutdown(self) -> None:
        """Stop all agents and clean up."""
        logger.info("[runtime] Shutting down %d agents", len(self._agents))
        for agent in list(self._agents.values()):
            if agent.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                await agent.stop()
        self._agents.clear()
        logger.info("[runtime] Shutdown complete")

    # ── Querying ──────────────────────────────────────────────────────

    def get_agent(self, agent_id: str) -> Agent | None:
        """Get an agent by ID."""
        return self._agents.get(agent_id)

    def list_agents(self) -> list[Agent]:
        """List all agents."""
        return list(self._agents.values())

    def list_active(self) -> list[Agent]:
        """List running or paused agents."""
        return [
            a for a in self._agents.values()
            if a.status in (AgentStatus.RUNNING, AgentStatus.PAUSED)
        ]

    def agent_tree(self) -> dict[str | None, list[str]]:
        """Get the parent→children mapping of all agents."""
        tree: dict[str | None, list[str]] = {}
        for agent in self._agents.values():
            tree.setdefault(agent.parent_id, []).append(agent.id)
        return tree

    # ── System status ─────────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        """Full system snapshot."""
        return {
            "agents": [a.to_dict() for a in self._agents.values()],
            "bus": self.bus.stats(),
            "active_count": len(self.list_active()),
            "total_count": len(self._agents),
        }
