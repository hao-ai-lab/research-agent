"""FileStore -- filesystem-backed store with the same query API as MemoryStore.

Directory layout:
    {root}/{project}/{agent_id}/{timestamp_ms}_{type_value}_{key}.json
    {root}/{project}/{agent_id}/.meta.json

Entries are written atomically (write to .tmp then os.rename).
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
import warnings
from pathlib import Path
from typing import Callable

from agentsys.types import (
    AgentInfo,
    AgentStatus,
    Entry,
    EntryType,
    entry_from_dict,
    entry_to_dict,
)

logger = logging.getLogger(__name__)


class FileStore:
    """Filesystem-backed store with WHERE-clause query semantics.

    Drop-in replacement for MemoryStore — same write/query/delete/latest API.
    """

    def __init__(self, root: str | Path, project: str) -> None:
        self.root = Path(root)
        self.project = project
        self._base = self.root / project
        self._base.mkdir(parents=True, exist_ok=True)
        self._key_to_path: dict[str, Path] = {}
        self._listeners: list[Callable[[Entry], None]] = []

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def write(self, entry: Entry, *, preserve_key: bool = False) -> str:
        """Store an entry, auto-generating key and timestamp.

        Atomic write: .tmp file then os.rename.

        Args:
            preserve_key: If True and entry.key is non-empty, reuse the
                existing key instead of generating a new one.  Useful for
                updates that must keep a stable external ID.
        """
        if not preserve_key or not entry.key:
            entry.key = uuid.uuid4().hex[:12]
        if not entry.created_at:
            entry.created_at = time.time()

        ts_ms = int(entry.created_at * 1000)
        agent_dir = self._base / entry.agent_id
        agent_dir.mkdir(parents=True, exist_ok=True)

        fname = f"{ts_ms}_{entry.type.value}_{entry.key}.json"
        fpath = agent_dir / fname
        tmp_path = fpath.with_suffix(".tmp")

        data = entry_to_dict(entry)
        tmp_path.write_text(json.dumps(data, default=str), encoding="utf-8")
        os.rename(tmp_path, fpath)

        self._key_to_path[entry.key] = fpath

        for cb in self._listeners:
            cb(entry)

        return entry.key

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def delete(self, key: str) -> bool:
        """Remove an entry by key."""
        path = self._key_to_path.pop(key, None)
        if path and path.exists():
            path.unlink()
            return True
        # Fallback: scan all dirs
        for agent_dir in self._base.iterdir():
            if not agent_dir.is_dir():
                continue
            for f in agent_dir.iterdir():
                if f.name.endswith(f"_{key}.json"):
                    f.unlink()
                    return True
        return False

    # ------------------------------------------------------------------
    # Listeners
    # ------------------------------------------------------------------

    def add_listener(self, callback: Callable[[Entry], None]) -> None:
        """Register a callback invoked on every write."""
        self._listeners.append(callback)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(
        self,
        *,
        project: str | None = None,
        session: str | None = None,
        sweep: str | None = None,
        run: str | None = None,
        agent_id: str | None = None,
        target_id: str | None = None,
        role: str | None = None,
        type: EntryType | list[EntryType] | None = None,
        type_not: EntryType | list[EntryType] | None = None,
        tags: list[str] | None = None,
        since: float | None = None,
        before: float | None = None,
        limit: int | None = None,
        order: str = "desc",
    ) -> list[Entry]:
        """Query entries with WHERE-clause semantics (same as MemoryStore)."""
        type_include = _normalize_types(type)
        type_exclude = _normalize_types(type_not)
        tag_set = set(tags) if tags else None

        # Determine which agent dirs to scan
        if agent_id is not None:
            dirs = [self._base / agent_id]
        else:
            dirs = [d for d in self._base.iterdir() if d.is_dir()]

        results: list[Entry] = []

        for agent_dir in dirs:
            if not agent_dir.exists():
                continue
            for fpath in agent_dir.iterdir():
                if fpath.name.startswith(".") or not fpath.name.endswith(".json"):
                    continue
                if fpath.suffix == ".tmp":
                    continue

                parsed = _parse_filename(fpath.name)
                if parsed is None:
                    continue
                ts_ms, type_val, key = parsed

                # Fast filename-based filtering
                if type_include is not None:
                    try:
                        etype = EntryType(type_val)
                    except ValueError:
                        continue
                    if etype not in type_include:
                        continue

                if type_exclude is not None:
                    try:
                        etype = EntryType(type_val)
                    except ValueError:
                        pass
                    else:
                        if etype in type_exclude:
                            continue

                # Read JSON for remaining filters
                try:
                    data = json.loads(fpath.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    warnings.warn(f"Skipping corrupt file: {fpath}")
                    continue

                try:
                    entry = entry_from_dict(data)
                except (KeyError, ValueError):
                    warnings.warn(f"Skipping unreadable entry: {fpath}")
                    continue

                # Update key index
                self._key_to_path[entry.key] = fpath

                # Scope filters
                if project is not None and entry.project != project:
                    continue
                if session is not None and entry.session != session:
                    continue
                if sweep is not None and entry.sweep != sweep:
                    continue
                if run is not None and entry.run != run:
                    continue

                # Identity filters
                if agent_id is not None and entry.agent_id != agent_id:
                    continue
                if target_id is not None and entry.target_id != target_id:
                    continue
                if role is not None and entry.role != role:
                    continue

                # Type filters (full entry-level, covers non-fast path)
                if type_include is not None and entry.type not in type_include:
                    continue
                if type_exclude is not None and entry.type in type_exclude:
                    continue

                # Tag filter (OR)
                if tag_set is not None and not (set(entry.tags) & tag_set):
                    continue

                # Time filters (precise, using entry.created_at)
                if since is not None and entry.created_at < since:
                    continue
                if before is not None and entry.created_at >= before:
                    continue

                results.append(entry)

        # Sort
        reverse = order == "desc"
        results.sort(key=lambda e: e.created_at, reverse=reverse)

        if limit is not None:
            results = results[:limit]

        return results

    def latest(self, **filters) -> Entry | None:
        """Return the single most recent entry matching filters."""
        filters["limit"] = 1
        filters["order"] = "desc"
        results = self.query(**filters)
        return results[0] if results else None

    # ------------------------------------------------------------------
    # Metadata (agent .meta.json)
    # ------------------------------------------------------------------

    def write_meta(self, agent_id: str, meta_dict: dict) -> None:
        """Atomic write to .meta.json for an agent."""
        agent_dir = self._base / agent_id
        agent_dir.mkdir(parents=True, exist_ok=True)
        meta_path = agent_dir / ".meta.json"
        tmp_path = meta_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(meta_dict, default=str), encoding="utf-8")
        os.rename(tmp_path, meta_path)

    def read_meta(self, agent_id: str) -> dict | None:
        """Read .meta.json for an agent."""
        meta_path = self._base / agent_id / ".meta.json"
        if not meta_path.exists():
            return None
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def read_agent_info(self, agent_id: str) -> AgentInfo | None:
        """Read .meta.json and return an AgentInfo."""
        meta = self.read_meta(agent_id)
        if meta is None:
            return None
        try:
            return AgentInfo(
                id=meta["id"],
                role=meta["role"],
                status=AgentStatus(meta["status"]),
                goal=meta["goal"],
                config=meta.get("config", {}),
                parent_id=meta.get("parent_id"),
                children=meta.get("children", []),
                agent_cls_path=meta.get("agent_cls_path", ""),
                iteration=meta.get("iteration", 0),
                scope=meta.get("scope"),
            )
        except (KeyError, ValueError):
            return None

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        count = 0
        for agent_dir in self._base.iterdir():
            if not agent_dir.is_dir():
                continue
            for f in agent_dir.iterdir():
                if not f.name.startswith(".") and f.name.endswith(".json"):
                    count += 1
        return count

    def __repr__(self) -> str:
        return f"FileStore({self._base})"


# ======================================================================
# Helpers
# ======================================================================

def _parse_filename(name: str) -> tuple[int, str, str] | None:
    """Parse '{ts_ms}_{type_value}_{key}.json' -> (ts_ms, type_val, key).

    The key is always a 12-char hex string, so we parse from the right
    to handle type values that contain underscores (e.g. 'raw_file').
    """
    if not name.endswith(".json"):
        return None
    stem = name[:-5]  # strip .json
    # Key is the last 12 chars after the final underscore
    last_sep = stem.rfind("_")
    if last_sep < 0:
        return None
    key = stem[last_sep + 1:]
    if len(key) != 12:
        return None
    rest = stem[:last_sep]
    # Timestamp is everything before the first underscore
    first_sep = rest.find("_")
    if first_sep < 0:
        return None
    try:
        ts_ms = int(rest[:first_sep])
    except ValueError:
        return None
    type_val = rest[first_sep + 1:]
    if not type_val:
        return None
    return ts_ms, type_val, key


def _normalize_types(
    val: EntryType | list[EntryType] | None,
) -> set[EntryType] | None:
    """Convert a single EntryType or list to a set (or None)."""
    if val is None:
        return None
    if isinstance(val, list):
        return set(val)
    return {val}
