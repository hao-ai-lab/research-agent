"""
Research Agent Server — Log & Artifact Endpoints

Extracted from server.py.  Routes for reading run logs (with
byte-offset pagination and SSE streaming) and listing run artifacts.
"""

import asyncio
import json
import logging
import os
from typing import Dict

from fastapi import APIRouter, HTTPException, Query
from starlette.responses import StreamingResponse

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level reference to the shared runs dict.  Wired at init().
# ---------------------------------------------------------------------------
_runs: dict[str, dict] = {}


def init(runs_dict):
    """Wire in the shared runs dict from server.py."""
    global _runs
    _runs = runs_dict


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _read_log_paginated(run_id: str, log_filename: str, offset: int, limit: int):
    """Common implementation for paginated log reading."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    run_dir = run.get("run_dir")

    empty = {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    if not run_dir:
        return empty

    log_file = os.path.join(run_dir, log_filename)
    if not os.path.exists(log_file):
        return empty

    limit = min(limit, 100 * 1024)

    try:
        total_size = os.path.getsize(log_file)

        if offset < 0:
            actual_offset = max(0, total_size + offset)
        else:
            actual_offset = min(offset, total_size)

        with open(log_file, errors="replace") as f:
            f.seek(actual_offset)
            content = f.read(limit)

        bytes_read = len(content.encode("utf-8"))
        end_offset = actual_offset + bytes_read

        return {
            "content": content,
            "offset": actual_offset,
            "total_size": total_size,
            "has_more_before": actual_offset > 0,
            "has_more_after": end_offset < total_size,
        }
    except Exception as e:
        logger.error(f"Error reading {log_filename} for {run_id}: {e}")
        return {
            "content": f"Error reading logs: {e}",
            "offset": 0,
            "total_size": 0,
            "has_more_before": False,
            "has_more_after": False,
        }


def _stream_log(run_id: str, log_filename: str):
    """Common implementation for SSE log streaming."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    run_dir = run.get("run_dir")

    async def log_generator():
        if not run_dir:
            yield f"data: {json.dumps({'error': 'No run directory'})}\n\n"
            return

        log_file = os.path.join(run_dir, log_filename)
        last_size = 0

        # Send initial content
        if os.path.exists(log_file):
            with open(log_file, errors="replace") as f:
                content = f.read()
                last_size = len(content.encode("utf-8"))
                yield f"data: {json.dumps({'type': 'initial', 'content': content})}\n\n"

        # Stream updates
        while True:
            await asyncio.sleep(0.5)

            current_run = _runs.get(run_id, {})
            if current_run.get("status") in ["finished", "failed", "stopped"]:
                if os.path.exists(log_file):
                    with open(log_file, errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        if new_content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'status': current_run.get('status')})}\n\n"
                break

            if os.path.exists(log_file):
                current_size = os.path.getsize(log_file)
                if current_size > last_size:
                    with open(log_file, errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        last_size = current_size
                        yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"

    return StreamingResponse(log_generator(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Log Endpoints
# ---------------------------------------------------------------------------


@router.get("/runs/{run_id}/logs")
async def get_run_logs(
    run_id: str,
    offset: int = Query(-10000, description="Byte offset. Negative = from end."),
    limit: int = Query(10000, description="Max bytes to return (max 100KB)"),
):
    """Get run logs with byte-offset pagination."""
    return _read_log_paginated(run_id, "run.log", offset, limit)


@router.get("/runs/{run_id}/logs/stream")
async def stream_run_logs(run_id: str):
    """Stream run logs via SSE."""
    return _stream_log(run_id, "run.log")


@router.get("/runs/{run_id}/sidecar-logs")
async def get_sidecar_logs(
    run_id: str,
    offset: int = Query(-10000, description="Byte offset. Negative = from end."),
    limit: int = Query(10000, description="Max bytes to return (max 100KB)"),
):
    """Get sidecar logs with byte-offset pagination."""
    return _read_log_paginated(run_id, "sidecar.log", offset, limit)


@router.get("/runs/{run_id}/sidecar-logs/stream")
async def stream_sidecar_logs(run_id: str):
    """Stream sidecar logs via SSE."""
    return _stream_log(run_id, "sidecar.log")


# ---------------------------------------------------------------------------
# Artifact Endpoints
# ---------------------------------------------------------------------------


@router.get("/runs/{run_id}/artifacts")
async def list_artifacts(run_id: str):
    """List artifacts for a run."""
    if run_id not in _runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = _runs[run_id]
    run_dir = run.get("run_dir")
    artifacts = []

    if run_dir:
        artifacts_dir = os.path.join(run_dir, "artifacts")
        if os.path.exists(artifacts_dir):
            for name in os.listdir(artifacts_dir):
                path = os.path.join(artifacts_dir, name)
                # Resolve symlinks to get actual path
                actual_path = os.path.realpath(path) if os.path.islink(path) else path
                artifacts.append(
                    {
                        "name": name,
                        "path": actual_path,
                        "type": "other",  # TODO: detect type
                    }
                )

    # Add wandb_dir if present
    if run.get("wandb_dir"):
        artifacts.append({"name": "wandb", "path": run["wandb_dir"], "type": "wandb"})

    return artifacts
