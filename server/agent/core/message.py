"""Typed messages — the universal communication protocol between agents."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class MessageType(str, Enum):
    """All message types in the system."""

    # Control flow
    STEER = "steer"          # user/parent wants to redirect agent
    INTERRUPT = "interrupt"  # hard stop request

    # Agent lifecycle
    STATUS = "status"        # agent reports its state change
    SPAWN = "spawn"          # a new agent was created
    DONE = "done"            # agent finished its work

    # Work products
    RESULT = "result"        # agent completed a unit of work
    LOG = "log"              # debug / info output
    ERROR = "error"          # something went wrong

    # Events
    EVENT = "event"          # external event (alert, run finished, etc.)

    # Delegation
    DELEGATE = "delegate"    # agent asks another agent to do something


@dataclass(frozen=True, slots=True)
class Message:
    """An immutable message that flows through the bus.

    Attributes:
        id:         Unique message ID.
        type:       What kind of message this is.
        source:     ID of the agent (or "system"/"user") that sent it.
        payload:    Arbitrary data dict — interpretation depends on type.
        target:     Agent ID for directed messages, None for broadcast.
        parent_id:  For request-response threading.
        timestamp:  Unix epoch seconds.
    """

    type: MessageType
    source: str
    payload: dict[str, Any] = field(default_factory=dict)
    target: str | None = None
    parent_id: str | None = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    timestamp: float = field(default_factory=time.time)

    # ── Convenience constructors ──────────────────────────────────────

    @classmethod
    def steer(cls, source: str, target: str, context: str) -> Message:
        """Create a steering message."""
        return cls(
            type=MessageType.STEER,
            source=source,
            target=target,
            payload={"context": context},
        )

    @classmethod
    def status(cls, source: str, status: str, **extra: Any) -> Message:
        """Create a status update message."""
        return cls(
            type=MessageType.STATUS,
            source=source,
            payload={"status": status, **extra},
        )

    @classmethod
    def log(cls, source: str, text: str, level: str = "info") -> Message:
        """Create a log message."""
        return cls(
            type=MessageType.LOG,
            source=source,
            payload={"text": text, "level": level},
        )

    @classmethod
    def result(cls, source: str, summary: str, **data: Any) -> Message:
        """Create a result message."""
        return cls(
            type=MessageType.RESULT,
            source=source,
            payload={"summary": summary, **data},
        )

    @classmethod
    def error(cls, source: str, error: str, **extra: Any) -> Message:
        """Create an error message."""
        return cls(
            type=MessageType.ERROR,
            source=source,
            payload={"error": error, **extra},
        )

    @classmethod
    def event(cls, source: str, title: str, **data: Any) -> Message:
        """Create an event message."""
        return cls(
            type=MessageType.EVENT,
            source=source,
            payload={"title": title, **data},
        )

    @classmethod
    def delegate(cls, source: str, target: str, task: str, **data: Any) -> Message:
        """Create a delegation message (agent → agent)."""
        return cls(
            type=MessageType.DELEGATE,
            source=source,
            target=target,
            payload={"task": task, **data},
        )

    # ── Serialization ─────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type.value,
            "source": self.source,
            "target": self.target,
            "parent_id": self.parent_id,
            "payload": self.payload,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Message:
        return cls(
            id=d["id"],
            type=MessageType(d["type"]),
            source=d["source"],
            target=d.get("target"),
            parent_id=d.get("parent_id"),
            payload=d.get("payload", {}),
            timestamp=d.get("timestamp", 0.0),
        )
