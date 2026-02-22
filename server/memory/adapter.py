"""MemoryStoreAdapter — wraps agentsys FileStore with the old MemoryStore interface.

Drop-in replacement: routes.py and research_agent.py call the same method
names (.add, .list, .toggle, .update, .delete, .format_for_prompt).

Internally every memory is stored as a REFLECTION entry in the FileStore
with agent_id="memory-system".  The MemoryEntry-like objects returned from
.add() / .list() / .update() are lightweight shims that expose the same
attributes as the old MemoryEntry dataclass.

Key design decisions:
  - A stable ``memory_id`` is stored inside ``Entry.data["memory_id"]``
    so that updates (which replace the FileStore entry) keep the same
    external ID.
  - ``created_at`` is preserved across updates via the ``Entry.created_at``
    field (FileStore.write() honours pre-set timestamps since fix #3).
  - Tags are stored only in ``Entry.data["tags"]`` (single source of truth).
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import List, Optional

from agentsys.filestore import FileStore
from agentsys.types import Entry, EntryType

logger = logging.getLogger(__name__)

_AGENT_ID = "memory-system"


# ---------------------------------------------------------------------------
# MemoryEntry shim  (duck-type compatible with the old memory.store.MemoryEntry)
# ---------------------------------------------------------------------------

@dataclass
class MemoryEntry:
    """A single memory / lesson / rule (compatible with old MemoryStore)."""
    id: str
    title: str
    content: str
    source: str                     # "reflection" | "user" | "agent"
    tags: List[str] = field(default_factory=list)
    session_id: str = ""
    created_at: float = 0.0
    is_active: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


def _entry_to_memory(entry: Entry) -> MemoryEntry:
    """Convert a FileStore Entry to a MemoryEntry shim."""
    d = entry.data
    return MemoryEntry(
        id=d.get("memory_id", entry.key),
        title=d.get("title", ""),
        content=d.get("content", ""),
        source=d.get("source", "user"),
        tags=d.get("tags", []),
        session_id=d.get("session_id", entry.session or ""),
        created_at=d.get("original_created_at", entry.created_at),
        is_active=d.get("is_active", True),
    )


def _memory_to_entry_data(m: MemoryEntry) -> dict:
    """Build the data payload dict for a FileStore entry."""
    return {
        "memory_id": m.id,
        "title": m.title,
        "content": m.content,
        "source": m.source,
        "tags": m.tags,
        "session_id": m.session_id,
        "is_active": m.is_active,
        "original_created_at": m.created_at,
    }


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

class MemoryStoreAdapter:
    """FileStore-backed memory store with the same interface as MemoryStore.

    Args:
        filestore: The shared FileStore instance.
        project:   Project namespace (matches FileStore project).
    """

    def __init__(self, filestore: FileStore, project: str = "default") -> None:
        self._store = filestore
        self._project = project

    # -- Persistence (no-ops — FileStore is always on disk) -----------------

    def load(self) -> None:
        """No-op: FileStore persists automatically."""
        pass

    def save(self) -> None:
        """No-op: FileStore persists automatically."""
        pass

    # -- CRUD ---------------------------------------------------------------

    def add(
        self,
        title: str,
        content: str,
        source: str = "user",
        tags: Optional[List[str]] = None,
        session_id: str = "",
    ) -> MemoryEntry:
        """Create a new memory entry and persist via FileStore."""
        memory_id = uuid.uuid4().hex[:12]
        now = time.time()
        mem = MemoryEntry(
            id=memory_id,
            title=title,
            content=content,
            source=source,
            tags=tags or [],
            session_id=session_id,
            created_at=now,
            is_active=True,
        )
        entry = Entry(
            key="",
            agent_id=_AGENT_ID,
            target_id=None,
            type=EntryType.REFLECTION,
            project=self._project,
            session=session_id or None,
            sweep=None,
            run=None,
            role="system",
            tags=[],  # tags live in data dict only
            data=_memory_to_entry_data(mem),
            created_at=now,
        )
        self._store.write(entry)
        logger.info("[memory-adapter] Added memory %s: %s (source=%s)", memory_id, title, source)
        return mem

    def get(self, memory_id: str) -> Optional[MemoryEntry]:
        """Get a memory by its stable memory_id."""
        for entry in self._query_all():
            if entry.data.get("memory_id", entry.key) == memory_id:
                return _entry_to_memory(entry)
        return None

    def list(
        self,
        active_only: bool = False,
        tags: Optional[List[str]] = None,
        source: Optional[str] = None,
    ) -> List[MemoryEntry]:
        """List memories with optional filters."""
        entries = self._query_all()
        results = [_entry_to_memory(e) for e in entries]

        if active_only:
            results = [m for m in results if m.is_active]
        if tags:
            tag_set = set(tags)
            results = [m for m in results if tag_set.intersection(m.tags)]
        if source:
            results = [m for m in results if m.source == source]

        return results

    def toggle(self, memory_id: str) -> Optional[MemoryEntry]:
        """Toggle a memory's active state."""
        entry = self._find_entry(memory_id)
        if not entry:
            return None

        mem = _entry_to_memory(entry)
        mem.is_active = not mem.is_active

        self._replace_entry(entry, mem)
        logger.info("[memory-adapter] Toggled memory %s -> is_active=%s", memory_id, mem.is_active)
        return mem

    def update(self, memory_id: str, **kwargs) -> Optional[MemoryEntry]:
        """Update fields on a memory."""
        entry = self._find_entry(memory_id)
        if not entry:
            return None

        mem = _entry_to_memory(entry)
        for key, value in kwargs.items():
            if hasattr(mem, key) and key != "id":
                setattr(mem, key, value)

        self._replace_entry(entry, mem)
        return mem

    def delete(self, memory_id: str) -> bool:
        """Delete a memory by its stable memory_id."""
        entry = self._find_entry(memory_id)
        if not entry:
            return False
        deleted = self._store.delete(entry.key)
        if deleted:
            logger.info("[memory-adapter] Deleted memory %s", memory_id)
        return deleted

    def clear(self) -> None:
        """Delete all memories."""
        for e in self._query_all():
            self._store.delete(e.key)

    # -- Unified query (cross-agent) ------------------------------------------

    def list_all_reflections(self, active_only: bool = True, limit: int = 30) -> List[MemoryEntry]:
        """Query REFLECTION entries from ALL agents in the project.

        Unlike ``list()`` which only returns entries from agent_id="memory-system",
        this method finds reflections written by any agent (orchestrator-xxx,
        memory-system, etc.) — fixing the split-brain where agent-produced
        reflections were invisible.
        """
        entries = self._store.query(
            project=self._project,
            type=EntryType.REFLECTION,
            order="desc",
            limit=limit,
        )
        results = [_entry_to_memory(e) for e in entries]
        if active_only:
            results = [m for m in results if m.is_active]
        return results

    # -- Prompt helpers (identical format to old MemoryStore) ----------------

    def format_for_prompt(self, max_entries: int = 20) -> str:
        """Format active memories as text for prompt injection.

        Uses the unified ``list_all_reflections()`` so that agent-produced
        reflections appear alongside user-created memories.
        """
        active = self.list_all_reflections(active_only=True, limit=max_entries)
        if not active:
            return ""
        lines = ["## Memory Bank (Lessons & Context from Past Sessions)\n"]
        for i, m in enumerate(active[:max_entries], 1):
            tag_str = ", ".join(m.tags) if m.tags else "general"
            lines.append(f"{i}. **[{tag_str}]** {m.title}")
            if m.content and m.content != m.title:
                for content_line in m.content.split("\n"):
                    lines.append(f"   {content_line}")
        if len(active) > max_entries:
            lines.append(f"\n_(+ {len(active) - max_entries} more memories)_")
        return "\n".join(lines)

    # -- Internal helpers ---------------------------------------------------

    def _query_all(self) -> list[Entry]:
        """Query all memory entries from the FileStore."""
        return self._store.query(
            agent_id=_AGENT_ID,
            type=EntryType.REFLECTION,
            order="desc",
        )

    def _find_entry(self, memory_id: str) -> Optional[Entry]:
        """Find the FileStore Entry for a given stable memory_id."""
        for entry in self._query_all():
            if entry.data.get("memory_id", entry.key) == memory_id:
                return entry
        return None

    def _replace_entry(self, old_entry: Entry, mem: MemoryEntry) -> None:
        """Delete old entry and write replacement with preserved created_at."""
        self._store.delete(old_entry.key)
        new_entry = Entry(
            key="",
            agent_id=_AGENT_ID,
            target_id=None,
            type=EntryType.REFLECTION,
            project=self._project,
            session=mem.session_id or None,
            sweep=None,
            run=None,
            role="system",
            tags=[],
            data=_memory_to_entry_data(mem),
            created_at=mem.created_at,  # preserved — FileStore won't overwrite non-zero
        )
        self._store.write(new_entry)
