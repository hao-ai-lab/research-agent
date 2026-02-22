"""
Research Agent Server — Memory Bank Endpoints

Extracted from server.py. All /memories/* CRUD endpoints live here as a
FastAPI APIRouter.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from core.models import MemoryCreateRequest, MemoryUpdateRequest

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level reference to the shared MemoryStore.  Wired at init().
# ---------------------------------------------------------------------------
_memory_store = None


def init(memory_store):
    """Wire in the shared MemoryStore instance from server.py."""
    global _memory_store
    _memory_store = memory_store


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/memories")
async def list_memories(
    active_only: bool = False,
    source: Optional[str] = None,
    all: bool = False,
):
    """List memories, optionally filtered.

    Pass ``?all=true`` to include reflections from ALL agents (not just
    the ``memory-system`` agent).  This is the unified view that fixes
    the split-brain where orchestrator reflections were invisible.
    Default (``all=false``) keeps the existing behaviour for backward compat.
    """
    if _memory_store is None:
        return []
    if all:
        entries = _memory_store.list_all_reflections(active_only=active_only)
    else:
        entries = _memory_store.list(active_only=active_only, source=source)
    return [{"id": m.id, "title": m.title, "content": m.content,
             "source": m.source, "tags": m.tags, "session_id": m.session_id,
             "created_at": m.created_at, "is_active": m.is_active}
            for m in entries]


@router.post("/memories")
async def create_memory(req: MemoryCreateRequest):
    """Create a new memory entry."""
    if _memory_store is None:
        raise HTTPException(status_code=503, detail="Memory store not yet initialized")
    entry = _memory_store.add(
        title=req.title,
        content=req.content,
        source=req.source,
        tags=req.tags,
        session_id=req.session_id,
    )
    return entry.to_dict()


@router.patch("/memories/{memory_id}")
async def update_memory(memory_id: str, req: MemoryUpdateRequest):
    """Update a memory (toggle, edit title/content)."""
    if _memory_store is None:
        raise HTTPException(status_code=503, detail="Memory store not yet initialized")
    updates = {k: v for k, v in req.dict().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    entry = _memory_store.update(memory_id, **updates)
    if not entry:
        raise HTTPException(status_code=404, detail="Memory not found")
    return entry.to_dict()


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str):
    """Delete a memory."""
    if _memory_store is None:
        raise HTTPException(status_code=503, detail="Memory store not yet initialized")
    deleted = _memory_store.delete(memory_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"deleted": True, "id": memory_id}
