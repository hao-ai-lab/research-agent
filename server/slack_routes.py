"""
Research Agent Server — Slack Integration Endpoints

Extracted from server.py. All /integrations/slack/* endpoints live here.
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_slack_notifier = None
_save_settings_state = None


def init(slack_notifier, save_settings_state):
    """Wire in the shared SlackNotifier and settings save function."""
    global _slack_notifier, _save_settings_state
    _slack_notifier = slack_notifier
    _save_settings_state = save_settings_state


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class SlackConfigRequest(BaseModel):
    bot_token: str
    channel: str
    signing_secret: str = ""
    notify_on_complete: bool = True
    notify_on_failed: bool = True
    notify_on_alert: bool = True


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/integrations/slack/configure")
async def configure_slack(req: SlackConfigRequest):
    """Configure Slack integration with bot token and channel."""
    try:
        result = _slack_notifier.configure(
            bot_token=req.bot_token,
            channel=req.channel,
            signing_secret=req.signing_secret,
            notify_on_complete=req.notify_on_complete,
            notify_on_failed=req.notify_on_failed,
            notify_on_alert=req.notify_on_alert,
        )
        _save_settings_state()
        return result
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/integrations/slack/status")
async def get_slack_status():
    """Return current Slack integration status."""
    return _slack_notifier.get_status()


@router.post("/integrations/slack/test")
async def test_slack():
    """Send a test notification to Slack."""
    if not _slack_notifier.is_enabled:
        raise HTTPException(status_code=400, detail="Slack is not configured")
    result = _slack_notifier.send_test()
    if not result["ok"]:
        raise HTTPException(status_code=500, detail=result.get("error", "Send failed"))
    return result


@router.delete("/integrations/slack/configure")
async def disconnect_slack():
    """Disconnect Slack integration."""
    _slack_notifier.disconnect()
    _save_settings_state()
    return {"ok": True, "message": "Slack disconnected"}
