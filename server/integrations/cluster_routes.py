"""
Research Agent Server — Cluster Endpoints

Extracted from server.py. All /cluster/* endpoints live here.
Cluster helper functions are imported from state.py.
"""

import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException

from core.models import ClusterDetectRequest, ClusterUpdateRequest
from core.state import (
    _normalize_cluster_state,
    _normalize_cluster_type,
    _normalize_cluster_status,
    _normalize_cluster_source,
    _cluster_type_label,
    _cluster_type_description,
)

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_cluster_state = None
_save_settings_state = None
_current_run_summary = None
_infer_cluster_fn = None


def init(cluster_state_dict, save_settings_fn, current_run_summary_fn, infer_cluster_fn):
    """Wire in the shared cluster state dict, save function, run summary and cluster detection callbacks."""
    global _cluster_state, _save_settings_state, _current_run_summary, _infer_cluster_fn
    _cluster_state = cluster_state_dict
    _save_settings_state = save_settings_fn
    _current_run_summary = current_run_summary_fn
    _infer_cluster_fn = infer_cluster_fn


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/cluster")
async def get_cluster_state_endpoint():
    """Get the persisted cluster state and current run summary."""
    return {"cluster": _cluster_state, "run_summary": _current_run_summary()}


@router.post("/cluster/detect")
async def detect_cluster(req: Optional[ClusterDetectRequest] = None):
    """Auto-detect cluster setup, or apply a user-specified preferred type."""
    detected = _infer_cluster_fn()
    preferred_type = _normalize_cluster_type(req.preferred_type) if req else "unknown"

    if preferred_type != "unknown":
        now = time.time()
        detected["type"] = preferred_type
        detected["source"] = "manual"
        detected["status"] = "healthy"
        detected["label"] = _cluster_type_label(preferred_type)
        detected["description"] = _cluster_type_description(preferred_type)
        detected["confidence"] = 1.0
        detected["updated_at"] = now
        detected["last_detected_at"] = now

    new_state = _normalize_cluster_state(detected)
    _cluster_state.clear()
    _cluster_state.update(new_state)
    _save_settings_state()
    return {"cluster": _cluster_state, "run_summary": _current_run_summary()}


@router.post("/cluster")
async def update_cluster_state_endpoint(req: ClusterUpdateRequest):
    """Update persisted cluster metadata with user-provided values."""
    now = time.time()
    payload = req.model_dump(exclude_unset=True)
    next_state = dict(_cluster_state)

    if "type" in payload:
        raw_type = payload.get("type")
        normalized_type = _normalize_cluster_type(raw_type)
        if raw_type and normalized_type == "unknown" and raw_type.strip().lower() not in {"unknown", "unset"}:
            raise HTTPException(status_code=400, detail=f"Unsupported cluster type: {raw_type}")
        next_state["type"] = normalized_type
        next_state["label"] = _cluster_type_label(normalized_type)
        next_state["description"] = _cluster_type_description(normalized_type)

    if "status" in payload:
        raw_status = payload.get("status")
        normalized_status = _normalize_cluster_status(raw_status)
        if raw_status and normalized_status == "unknown" and raw_status.strip().lower() != "unknown":
            raise HTTPException(status_code=400, detail=f"Unsupported cluster status: {raw_status}")
        next_state["status"] = normalized_status

    if "source" in payload:
        raw_source = payload.get("source")
        normalized_source = _normalize_cluster_source(raw_source)
        if raw_source and normalized_source == "unset" and raw_source.strip().lower() != "unset":
            raise HTTPException(status_code=400, detail=f"Unsupported cluster source: {raw_source}")
        next_state["source"] = normalized_source
    else:
        next_state["source"] = "manual"

    if "head_node" in payload:
        next_state["head_node"] = payload.get("head_node")
    if "node_count" in payload:
        next_state["node_count"] = payload.get("node_count")
    if "gpu_count" in payload:
        next_state["gpu_count"] = payload.get("gpu_count")
    if "notes" in payload:
        next_state["notes"] = payload.get("notes")
    if "details" in payload:
        next_state["details"] = payload.get("details") if isinstance(payload.get("details"), dict) else {}

    next_state["updated_at"] = now
    new_state = _normalize_cluster_state(next_state)
    _cluster_state.clear()
    _cluster_state.update(new_state)
    _save_settings_state()
    return {"cluster": _cluster_state, "run_summary": _current_run_summary()}
