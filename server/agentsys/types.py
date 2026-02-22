"""Shared types for agentsys.

All enums and dataclasses live here to avoid circular imports.
See agentsys.md for the full design spec.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class AgentStatus(str, Enum):
    """Agent lifecycle states."""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"
    FAILED = "failed"


class EntryType(str, Enum):
    """Types of memory entries. See agentsys.md section 2.1."""
    RAW_FILE = "raw_file"
    METRICS = "metrics"
    ALERT = "alert"
    RESULT = "result"
    CONTEXT = "context"
    REFLECTION = "reflection"
    PLAN = "plan"
    MESSAGE = "message"       # directed msg to another agent


class SteerUrgency(str, Enum):
    """Steer priority levels. See agentsys.md section 3.2.

    NOTE was intentionally excluded -- low-priority communication
    uses msg (store-based), not steer (buffer-based).
    """
    PRIORITY = "priority"     # agent checks at next yield point
    CRITICAL = "critical"     # hard interrupt: stop + reinject


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Scope:
    """Agent scope — determines where this agent's memory lives.

    Frozen so it can't be accidentally mutated after spawn.
    Access via attribute: ``agent.scope.run``, ``agent.scope.project``, etc.
    No collision with Agent.run() since it's a separate object.
    """
    project: str
    session: str | None = None
    sweep: str | None = None
    run: str | None = None
    role: str = "agent"

    def to_dict(self) -> dict:
        """Convert to a plain dict (for MemoryView, serialization)."""
        return {
            "project": self.project,
            "session": self.session,
            "sweep": self.sweep,
            "run": self.run,
            "role": self.role,
        }


@dataclass
class Entry:
    """A single entry in the flat memory store. See agentsys.md section 2.1.

    Fields:
        key:        Unique id (auto-generated uuid on write).
        agent_id:   Who produced this entry.
        target_id:  Who this is for (MESSAGE entries only, else None).
        type:       Entry kind (metrics, alert, result, ...).
        project:    Scope field -- logical project namespace.
        session:    Scope field -- session within project.
        sweep:      Scope field -- sweep within session.
        run:        Scope field -- run within sweep.
        role:       Producer's role ("orchestrator" | "executor" | "sidecar").
        tags:       Free-form tags for cross-cutting queries.
        data:       The actual content payload.
        created_at: Timestamp (time.time()).
    """
    key: str
    agent_id: str
    target_id: str | None
    type: EntryType
    project: str
    session: str | None
    sweep: str | None
    run: str | None
    role: str
    tags: list[str]
    data: dict
    created_at: float


@dataclass
class Steer:
    """A pending steer in an agent's buffer.

    Attributes:
        context:   The steer message / instruction.
        urgency:   PRIORITY or CRITICAL.
        timestamp: When the steer was created.
    """
    context: str
    urgency: SteerUrgency
    timestamp: float = field(default_factory=time.time)


@dataclass
class AgentInfo:
    """Lightweight agent metadata — duck-type compatible with Agent for on_monitor().

    Returned by Runtime.spawn() and RuntimeProxy.get_agent() in the
    multiprocess architecture.  Has the same .status, .goal, .config
    attributes that on_monitor() code reads from child agents.
    """
    id: str
    role: str
    status: AgentStatus
    goal: str
    config: dict
    parent_id: str | None = None
    children: list[str] = field(default_factory=list)
    agent_cls_path: str = ""
    iteration: int = 0
    scope: dict | None = None


# ---------------------------------------------------------------------------
# Entry serialization helpers
# ---------------------------------------------------------------------------

def entry_to_dict(entry: Entry) -> dict:
    """Convert an Entry to a JSON-safe dict."""
    return {
        "key": entry.key,
        "agent_id": entry.agent_id,
        "target_id": entry.target_id,
        "type": entry.type.value,
        "project": entry.project,
        "session": entry.session,
        "sweep": entry.sweep,
        "run": entry.run,
        "role": entry.role,
        "tags": list(entry.tags),
        "data": entry.data,
        "created_at": entry.created_at,
    }


def entry_from_dict(d: dict) -> Entry:
    """Reconstruct an Entry from a dict (as stored on disk)."""
    return Entry(
        key=d["key"],
        agent_id=d["agent_id"],
        target_id=d.get("target_id"),
        type=EntryType(d["type"]),
        project=d["project"],
        session=d.get("session"),
        sweep=d.get("sweep"),
        run=d.get("run"),
        role=d["role"],
        tags=d.get("tags", []),
        data=d.get("data", {}),
        created_at=d.get("created_at", 0.0),
    )
