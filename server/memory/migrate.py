"""One-time migration: memory.json -> FileStore.

Reads the old .agents/memory.json, writes each entry to FileStore as a
REFLECTION entry, then renames the file to .agents/memory.json.migrated
so the migration is idempotent.
"""

from __future__ import annotations

import json
import logging
import os
import uuid

from agentsys.filestore import FileStore
from agentsys.types import Entry, EntryType

logger = logging.getLogger(__name__)

_AGENT_ID = "memory-system"


def migrate_memory_json_to_filestore(
    workdir: str,
    filestore: FileStore,
    project: str = "default",
) -> int:
    """Migrate old memory.json entries to the FileStore.

    Returns the number of entries migrated (0 if already migrated or
    no file exists).
    """
    json_path = os.path.join(workdir, ".agents", "memory.json")

    if not os.path.exists(json_path):
        return 0

    migrated_path = json_path + ".migrated"
    if os.path.exists(migrated_path):
        logger.debug("[memory-migrate] Already migrated (%s exists)", migrated_path)
        return 0

    try:
        with open(json_path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("[memory-migrate] Failed to read %s: %s", json_path, e)
        return 0

    entries = data if isinstance(data, list) else data.get("memories", [])
    count = 0

    for d in entries:
        original_created_at = d.get("created_at", 0.0) or 0.0
        memory_id = d.get("id", uuid.uuid4().hex[:12])
        tags = d.get("tags", [])

        entry = Entry(
            key="",
            agent_id=_AGENT_ID,
            target_id=None,
            type=EntryType.REFLECTION,
            project=project,
            session=d.get("session_id") or None,
            sweep=None,
            run=None,
            role="system",
            tags=[],
            data={
                "memory_id": memory_id,
                "title": d.get("title", ""),
                "content": d.get("content", ""),
                "source": d.get("source", "user"),
                "tags": tags,
                "session_id": d.get("session_id", ""),
                "is_active": d.get("is_active", True),
                "original_created_at": original_created_at,
            },
            created_at=original_created_at,  # preserved by FileStore (non-zero)
        )
        filestore.write(entry)
        count += 1

    # Rename old file so migration is idempotent
    try:
        os.rename(json_path, migrated_path)
    except OSError as e:
        logger.warning("[memory-migrate] Could not rename %s: %s", json_path, e)

    logger.info("[memory-migrate] Migrated %d entries from %s", count, json_path)
    return count
