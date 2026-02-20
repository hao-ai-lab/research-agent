"""
Research Agent Server — Memory Bank Endpoints

Extracted from server.py. All /memories/* CRUD endpoints live here as a
FastAPI APIRouter.
"""

import logging
from typing import Optional

from core.models import MemoryCreateRequest, MemoryUpdateRequest
from fastapi import APIRouter, HTTPException

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
async def list_memories(active_only: bool = False, source: str | None = None):
    """List all memories, optionally filtered."""
    entries = _memory_store.list(active_only=active_only, source=source)
    return [
        {
            "id": m.id,
            "title": m.title,
            "content": m.content,
            "source": m.source,
            "tags": m.tags,
            "session_id": m.session_id,
            "created_at": m.created_at,
            "is_active": m.is_active,
        }
        for m in entries
    ]


@router.post("/memories")
async def create_memory(req: MemoryCreateRequest):
    """Create a new memory entry."""
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
    deleted = _memory_store.delete(memory_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"deleted": True, "id": memory_id}
