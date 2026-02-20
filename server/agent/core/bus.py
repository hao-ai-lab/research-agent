"""MessageBus — in-process async pub/sub with per-agent inboxes.

The bus is the central nervous system: every message flows through it.
Agents never talk to each other directly — they publish to the bus,
and the bus routes messages based on target + subscriptions.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any, Callable

from agent.core.message import Message, MessageType

logger = logging.getLogger(__name__)

# Type alias for subscription filters
MessageFilter = Callable[[Message], bool]


class MessageBus:
    """Async message bus with pub/sub, per-agent inboxes, and history.

    Usage::

        bus = MessageBus()

        # Register an agent's inbox
        bus.register("agent-1")

        # Subscribe to specific message types
        bus.subscribe("agent-1", lambda m: m.type == MessageType.EVENT)

        # Publish a message (delivered to matching inboxes)
        await bus.publish(Message.log("system", "hello"))

        # Get message history
        history = bus.history(limit=10)
    """

    def __init__(self, history_limit: int = 1000) -> None:
        self._inboxes: dict[str, asyncio.Queue[Message]] = {}
        self._filters: dict[str, list[MessageFilter]] = defaultdict(list)
        self._history: list[Message] = []
        self._history_limit = history_limit
        self._listeners: list[Callable[[Message], Any]] = []
        self._lock = asyncio.Lock()

    # ── Registration ──────────────────────────────────────────────────

    def register(self, agent_id: str) -> asyncio.Queue[Message]:
        """Register an agent and return its inbox queue."""
        if agent_id not in self._inboxes:
            self._inboxes[agent_id] = asyncio.Queue()
            logger.debug("[bus] Registered agent: %s", agent_id)
        return self._inboxes[agent_id]

    def unregister(self, agent_id: str) -> None:
        """Remove an agent and its inbox."""
        self._inboxes.pop(agent_id, None)
        self._filters.pop(agent_id, None)
        logger.debug("[bus] Unregistered agent: %s", agent_id)

    # ── Subscriptions ─────────────────────────────────────────────────

    def subscribe(self, agent_id: str, filter_fn: MessageFilter) -> None:
        """Add a subscription filter for an agent.

        Messages are delivered to an agent if:
        1. They are targeted at that agent (msg.target == agent_id), OR
        2. They match any subscription filter for that agent.

        If no filters are registered, the agent receives nothing
        unless the message is directly targeted.
        """
        self._filters[agent_id].append(filter_fn)

    def subscribe_all(self, agent_id: str) -> None:
        """Subscribe an agent to ALL messages (broadcast receiver)."""
        self.subscribe(agent_id, lambda _: True)

    # ── Publishing ────────────────────────────────────────────────────

    async def publish(self, msg: Message) -> None:
        """Publish a message.

        Routing rules:
        1. If msg.target is set, deliver ONLY to that agent.
        2. Otherwise, deliver to all agents whose filters match.
        3. Always append to history.
        4. Always notify global listeners.
        """
        # Record in history
        self._history.append(msg)
        if len(self._history) > self._history_limit:
            self._history = self._history[-self._history_limit:]

        # Route
        if msg.target:
            # Directed message
            inbox = self._inboxes.get(msg.target)
            if inbox:
                await inbox.put(msg)
            else:
                logger.warning("[bus] No inbox for target %s (msg from %s)", msg.target, msg.source)
        else:
            # Broadcast: deliver to agents whose filters match
            for agent_id, inbox in self._inboxes.items():
                if agent_id == msg.source:
                    continue  # don't deliver to sender
                filters = self._filters.get(agent_id, [])
                if any(f(msg) for f in filters):
                    await inbox.put(msg)

        # Notify global listeners (e.g., SSE stream, TUI)
        for listener in self._listeners:
            try:
                result = listener(msg)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.exception("[bus] Listener error")

    # ── Global listeners ──────────────────────────────────────────────

    def add_listener(self, callback: Callable[[Message], Any]) -> None:
        """Add a global listener called on every message.

        Used by the SSE endpoint and TUI to observe the bus.
        """
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[Message], Any]) -> None:
        """Remove a global listener."""
        try:
            self._listeners.remove(callback)
        except ValueError:
            pass

    # ── History ────────────────────────────────────────────────────────

    def history(
        self,
        agent_id: str | None = None,
        msg_type: MessageType | None = None,
        limit: int = 50,
    ) -> list[Message]:
        """Get message history with optional filters.

        Args:
            agent_id: Filter by source or target.
            msg_type: Filter by message type.
            limit: Max messages to return.
        """
        result = self._history
        if agent_id:
            result = [
                m for m in result
                if m.source == agent_id or m.target == agent_id
            ]
        if msg_type:
            result = [m for m in result if m.type == msg_type]
        return result[-limit:]

    def clear_history(self) -> None:
        """Clear all message history."""
        self._history.clear()

    # ── Inspection ────────────────────────────────────────────────────

    @property
    def agent_ids(self) -> list[str]:
        """All registered agent IDs."""
        return list(self._inboxes.keys())

    def inbox_size(self, agent_id: str) -> int:
        """Number of pending messages in an agent's inbox."""
        inbox = self._inboxes.get(agent_id)
        return inbox.qsize() if inbox else 0

    def stats(self) -> dict[str, Any]:
        """Bus statistics."""
        return {
            "agents_registered": len(self._inboxes),
            "total_messages": len(self._history),
            "listeners": len(self._listeners),
            "inbox_sizes": {
                aid: q.qsize() for aid, q in self._inboxes.items()
            },
        }
