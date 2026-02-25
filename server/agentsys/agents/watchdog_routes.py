"""FastAPI routes for the GlobalWatchdogAgent.

Provides endpoints for querying watchdog health, recent actions,
operational status, triggering manual scans, and hot-updating config.
"""

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level reference.  Wired at init().
# ---------------------------------------------------------------------------
_watchdog_agent = None


def init(watchdog_agent):
    """Wire in the GlobalWatchdogAgent instance from server.py."""
    global _watchdog_agent
    _watchdog_agent = watchdog_agent


def _require_watchdog():
    """Return 503 JSONResponse if watchdog is not initialized."""
    if _watchdog_agent is None:
        return JSONResponse(
            status_code=503,
            content={"error": "Watchdog agent not initialized"},
        )
    return None


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ConfigUpdateRequest(BaseModel):
    """Partial config update — only include fields to change."""
    scan_interval_seconds: float | None = None
    hang_timeout_seconds: float | None = None
    memory_stale_threshold_seconds: float | None = None
    warn_before_kill: bool | None = None
    warn_to_kill_grace_seconds: float | None = None
    orphan_grace_seconds: float | None = None
    llm_diagnosis_enabled: bool | None = None
    alert_dedup_ttl_seconds: float | None = None
    gpu_leak_check_enabled: bool | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/watchdog/health")
async def watchdog_health():
    """Health of all monitored L3 agents."""
    err = _require_watchdog()
    if err:
        return err
    return _watchdog_agent.get_health_summary()


@router.get("/watchdog/actions")
async def watchdog_actions(limit: int = 50):
    """Recent kills/warnings taken by the watchdog."""
    err = _require_watchdog()
    if err:
        return err
    return _watchdog_agent.get_recent_actions(limit=min(limit, 500))


@router.get("/watchdog/status")
async def watchdog_status():
    """Watchdog's own operational status and config."""
    err = _require_watchdog()
    if err:
        return err
    return _watchdog_agent.get_status()


@router.post("/watchdog/scan")
async def watchdog_scan():
    """Manually trigger a scan (calls on_monitor immediately)."""
    err = _require_watchdog()
    if err:
        return err
    try:
        await _watchdog_agent.on_monitor()
        return {"status": "scan_completed", "scan_count": _watchdog_agent._scan_count}
    except Exception as e:
        logger.exception("[watchdog] Manual scan failed: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": f"Scan failed: {e}"},
        )


@router.post("/watchdog/config")
async def watchdog_config_update(req: ConfigUpdateRequest):
    """Hot-update watchdog thresholds without restart."""
    err = _require_watchdog()
    if err:
        return err
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        return _watchdog_agent.get_status()
    return _watchdog_agent.update_config(updates)
