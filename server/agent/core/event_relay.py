"""EventRelay — replaces MessageBus for SSE streaming.

Receives events from the agentsys Runtime's IPC event listener and
direct calls, relays them to SSE listeners (frontend) and log listeners.

Events are plain dicts, e.g.:
    {"type": "agent_status", "agent_id": "...", "status": "running", ...}
    {"type": "iteration_complete", "agent_id": "...", "iteration": 3, ...}
    {"type": "agent_done", "agent_id": "...", "reflection": "..."}
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

logger = logging.getLogger(__name__)


class EventRelay:
    """Replaces MessageBus. Receives events from Runtime IPC + direct calls,
    relays to SSE listeners (frontend) and log listeners."""

    def __init__(self) -> None:
        self._listeners: list[Callable] = []
        self._history: list[dict] = []

    def add_listener(self, fn: Callable) -> None:
        """Register a listener called on every emitted event."""
        self._listeners.append(fn)

    def remove_listener(self, fn: Callable) -> None:
        """Unregister a previously added listener."""
        try:
            self._listeners.remove(fn)
        except ValueError:
            pass

    async def emit(self, event: dict) -> None:
        """Emit an event to all listeners.

        Adds a timestamp if not present, appends to the ring buffer,
        and calls all registered listeners (sync or async).
        """
        if "timestamp" not in event:
            event["timestamp"] = time.time()

        self._history.append(event)
        if len(self._history) > 1000:
            self._history = self._history[-500:]

        for fn in list(self._listeners):
            try:
                if asyncio.iscoroutinefunction(fn):
                    await fn(event)
                else:
                    fn(event)
            except Exception:
                logger.debug("EventRelay listener error", exc_info=True)

    def recent(self, n: int = 50, since: float = 0) -> list[dict]:
        """Return the N most recent events, optionally filtered by timestamp.

        Args:
            n: Maximum number of events to return.
            since: Only return events with timestamp > since (for SSE reconnect replay).
                   Use 0 to skip time filtering.
        """
        if since > 0:
            filtered = [e for e in self._history if e.get("timestamp", 0) > since]
            return filtered[-n:]
        return self._history[-n:]

    @property
    def listener_count(self) -> int:
        return len(self._listeners)
