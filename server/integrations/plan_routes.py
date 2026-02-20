"""
Research Agent Server — Plan Endpoints

Extracted from server.py. All /plans/* CRUD endpoints live here as a
FastAPI APIRouter.
"""

import time
import uuid
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from core.models import PlanCreate, PlanUpdate, PLAN_STATUSES

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level reference to the shared plans dict.  Wired at init().
# ---------------------------------------------------------------------------
_plans = None
_save_plans_state = None


def init(plans_dict, save_fn):
    """Wire in the shared plans dict and save function from server.py."""
    global _plans, _save_plans_state
    _plans = plans_dict
    _save_plans_state = save_fn


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/plans")
async def list_plans(status: Optional[str] = None, session_id: Optional[str] = None):
    """List all plans, optionally filtered by status or session."""
    result = list(_plans.values())
    if status:
        result = [p for p in result if p.get("status") == status]
    if session_id:
        result = [p for p in result if p.get("session_id") == session_id]
    # Sort by created_at descending (newest first)
    result.sort(key=lambda p: p.get("created_at", 0), reverse=True)
    return result


@router.get("/plans/{plan_id}")
async def get_plan(plan_id: str):
    """Get a single plan by ID."""
    plan = _plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


@router.post("/plans")
async def create_plan(req: PlanCreate):
    """Create a new plan."""
    now = time.time()
    plan_id = str(uuid.uuid4())[:8]
    plan = {
        "id": plan_id,
        "title": req.title,
        "goal": req.goal,
        "session_id": req.session_id,
        "status": "draft",
        "sections": req.sections or {},
        "raw_markdown": req.raw_markdown,
        "created_at": now,
        "updated_at": now,
    }
    _plans[plan_id] = plan
    _save_plans_state()
    return plan


@router.patch("/plans/{plan_id}")
async def update_plan(plan_id: str, req: PlanUpdate):
    """Update a plan's fields."""
    plan = _plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    if req.title is not None:
        plan["title"] = req.title
    if req.status is not None:
        if req.status not in PLAN_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status '{req.status}'. Must be one of: {', '.join(sorted(PLAN_STATUSES))}"
            )
        plan["status"] = req.status
    if req.sections is not None:
        plan["sections"] = req.sections
    if req.raw_markdown is not None:
        plan["raw_markdown"] = req.raw_markdown

    plan["updated_at"] = time.time()
    _save_plans_state()
    return plan


@router.post("/plans/{plan_id}/approve")
async def approve_plan(plan_id: str):
    """Approve a plan, setting its status to 'approved'."""
    plan = _plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if plan["status"] not in ("draft",):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot approve a plan with status '{plan['status']}'. Only draft plans can be approved."
        )
    plan["status"] = "approved"
    plan["updated_at"] = time.time()
    _save_plans_state()
    return plan


@router.post("/plans/{plan_id}/execute")
async def execute_plan(plan_id: str):
    """Mark a plan as 'executing'. Frontend should transition to agent/wild mode."""
    plan = _plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if plan["status"] not in ("approved",):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot execute a plan with status '{plan['status']}'. Only approved plans can be executed."
        )
    plan["status"] = "executing"
    plan["updated_at"] = time.time()
    _save_plans_state()
    return plan


@router.delete("/plans/{plan_id}")
async def delete_plan(plan_id: str):
    """Delete a plan."""
    if plan_id not in _plans:
        raise HTTPException(status_code=404, detail="Plan not found")
    del _plans[plan_id]
    _save_plans_state()
    return {"deleted": True, "id": plan_id}
