"""Persistent memory store for Wild Loop reflections and user insights.

Memories are stored as JSON in `workdir/.agents/memory.json` and
serve as a long-term knowledge base that gets injected into future
Wild Loop prompts (planning + iteration).

Sources:
  - "reflection" — auto-extracted from post-DONE reflection step
  - "user" — manually added via the Insights panel
  - "agent" — created by the agent during execution
"""

import json
import logging
import os
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data Model
# ---------------------------------------------------------------------------


@dataclass
class MemoryEntry:
    """A single memory / lesson / rule."""

    id: str
    title: str
    content: str
    source: str  # "reflection" | "user" | "agent"
    tags: list[str] = field(default_factory=list)  # e.g. ["lesson", "preference", "convention"]
    session_id: str = ""  # originating wild loop session (if any)
    created_at: float = 0.0
    is_active: bool = True

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "MemoryEntry":
        return cls(
            id=d.get("id", ""),
            title=d.get("title", ""),
            content=d.get("content", ""),
            source=d.get("source", "user"),
            tags=d.get("tags", []),
            session_id=d.get("session_id", ""),
            created_at=d.get("created_at", 0.0),
            is_active=d.get("is_active", True),
        )


# ---------------------------------------------------------------------------
# Memory Store
# ---------------------------------------------------------------------------


class MemoryStore:
    """JSON-backed memory store with CRUD operations.

    Usage:
        store = MemoryStore(get_workdir=lambda: "/path/to/workdir")
        store.load()  # load from disk on startup
        store.add("Title", "Content", source="user")
        store.save()  # persist to disk
    """

    def __init__(self, get_workdir: Callable[[], str]):
        self._get_workdir = get_workdir
        self._memories: dict[str, MemoryEntry] = {}

    # -- Persistence -------------------------------------------------------

    @property
    def _store_path(self) -> str:
        return os.path.join(self._get_workdir(), ".agents", "memory.json")

    def load(self):
        """Load memories from disk. Safe to call even if file doesn't exist."""
        path = self._store_path
        if not os.path.exists(path):
            logger.debug("[memory] No memory file at %s — starting empty", path)
            return
        try:
            with open(path) as f:
                data = json.load(f)
            entries = data if isinstance(data, list) else data.get("memories", [])
            self._memories = {}
            for d in entries:
                entry = MemoryEntry.from_dict(d)
                self._memories[entry.id] = entry
            logger.info("[memory] Loaded %d memories from %s", len(self._memories), path)
        except Exception as e:
            logger.warning("[memory] Failed to load memories: %s", e)

    def save(self):
        """Persist memories to disk as JSON."""
        path = self._store_path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            data = [m.to_dict() for m in self._memories.values()]
            with open(path, "w") as f:
                json.dump(data, f, indent=2)
            logger.debug("[memory] Saved %d memories to %s", len(data), path)
        except Exception as e:
            logger.warning("[memory] Failed to save memories: %s", e)

    # -- CRUD --------------------------------------------------------------

    def add(
        self,
        title: str,
        content: str,
        source: str = "user",
        tags: list[str] | None = None,
        session_id: str = "",
    ) -> MemoryEntry:
        """Create a new memory entry and persist."""
        entry = MemoryEntry(
            id=uuid.uuid4().hex[:12],
            title=title,
            content=content,
            source=source,
            tags=tags or [],
            session_id=session_id,
            created_at=time.time(),
            is_active=True,
        )
        self._memories[entry.id] = entry
        self.save()
        logger.info("[memory] Added memory %s: %s (source=%s)", entry.id, title, source)
        return entry

    def get(self, memory_id: str) -> MemoryEntry | None:
        """Get a memory by ID."""
        return self._memories.get(memory_id)

    def list(
        self,
        active_only: bool = False,
        tags: list[str] | None = None,
        source: str | None = None,
    ) -> list[MemoryEntry]:
        """List memories with optional filters."""
        result = list(self._memories.values())
        if active_only:
            result = [m for m in result if m.is_active]
        if tags:
            tag_set = set(tags)
            result = [m for m in result if tag_set.intersection(m.tags)]
        if source:
            result = [m for m in result if m.source == source]
        # Most recent first
        result.sort(key=lambda m: m.created_at, reverse=True)
        return result

    def toggle(self, memory_id: str) -> MemoryEntry | None:
        """Toggle a memory's active state. Returns updated entry or None."""
        entry = self._memories.get(memory_id)
        if not entry:
            return None
        entry.is_active = not entry.is_active
        self.save()
        logger.info("[memory] Toggled memory %s: is_active=%s", memory_id, entry.is_active)
        return entry

    def update(self, memory_id: str, **kwargs) -> MemoryEntry | None:
        """Update fields on a memory. Returns updated entry or None."""
        entry = self._memories.get(memory_id)
        if not entry:
            return None
        for key, value in kwargs.items():
            if hasattr(entry, key) and key != "id":
                setattr(entry, key, value)
        self.save()
        return entry

    def delete(self, memory_id: str) -> bool:
        """Delete a memory. Returns True if found and deleted."""
        if memory_id in self._memories:
            del self._memories[memory_id]
            self.save()
            logger.info("[memory] Deleted memory %s", memory_id)
            return True
        return False

    def clear(self):
        """Delete all memories."""
        self._memories.clear()
        self.save()

    # -- Prompt helpers ----------------------------------------------------

    def format_for_prompt(self, max_entries: int = 20) -> str:
        """Format active memories as a text block for prompt injection.

        Returns empty string if no active memories.
        """
        active = self.list(active_only=True)
        if not active:
            return ""
        lines = ["## Memory Bank (Lessons & Context from Past Sessions)\n"]
        for i, m in enumerate(active[:max_entries], 1):
            tag_str = ", ".join(m.tags) if m.tags else "general"
            lines.append(f"{i}. **[{tag_str}]** {m.title}")
            if m.content and m.content != m.title:
                # Indent content under the title
                for content_line in m.content.split("\n"):
                    lines.append(f"   {content_line}")
        if len(active) > max_entries:
            lines.append(f"\n_(+ {len(active) - max_entries} more memories)_")
        return "\n".join(lines)
