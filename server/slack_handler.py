#!/usr/bin/env python3
"""
Slack Integration Handler for Research Agent

Provides notification capabilities via the Slack Web API.
Sends alerts for run completions, failures, and experiment alerts.
"""

import logging
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("research-agent-server")

# ---------------------------------------------------------------------------
# Try to import slack_sdk; gracefully degrade if not installed
# ---------------------------------------------------------------------------
try:
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
    HAS_SLACK_SDK = True
except ImportError:
    HAS_SLACK_SDK = False
    WebClient = None  # type: ignore
    SlackApiError = Exception  # type: ignore


class SlackNotifier:
    """Manages Slack Bot token, channel, and message dispatch."""

    def __init__(self) -> None:
        self._client: Optional[Any] = None
        self._bot_token: Optional[str] = None
        self._channel: Optional[str] = None
        self._signing_secret: Optional[str] = None
        self._team_name: Optional[str] = None
        self._bot_user_id: Optional[str] = None
        self._enabled: bool = False
        # Per-event notification toggles (default all on when enabled)
        self.notify_on_complete: bool = True
        self.notify_on_failed: bool = True
        self.notify_on_alert: bool = True

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    def configure(
        self,
        bot_token: str,
        channel: str,
        signing_secret: str = "",
        notify_on_complete: bool = True,
        notify_on_failed: bool = True,
        notify_on_alert: bool = True,
    ) -> Dict[str, Any]:
        """Validate the bot token and store configuration.

        Returns a dict with status information.
        Raises RuntimeError on validation failure.
        """
        if not HAS_SLACK_SDK:
            raise RuntimeError(
                "slack-sdk is not installed. "
                "Run: pip install slack-sdk>=3.27.0"
            )

        if not bot_token or not bot_token.strip():
            raise ValueError("Bot token is required")
        if not channel or not channel.strip():
            raise ValueError("Channel is required")

        token = bot_token.strip()
        chan = channel.strip()

        # Validate token by calling auth.test
        client = WebClient(token=token)
        try:
            auth_resp = client.auth_test()
        except SlackApiError as e:
            raise RuntimeError(f"Slack auth failed: {e.response['error']}") from e

        self._client = client
        self._bot_token = token
        self._channel = chan
        self._signing_secret = signing_secret.strip() if signing_secret else ""
        self._team_name = auth_resp.get("team", "")
        self._bot_user_id = auth_resp.get("user_id", "")
        self._enabled = True
        self.notify_on_complete = notify_on_complete
        self.notify_on_failed = notify_on_failed
        self.notify_on_alert = notify_on_alert

        logger.info(
            "Slack configured: team=%s bot=%s channel=%s",
            self._team_name, self._bot_user_id, self._channel,
        )
        return {
            "ok": True,
            "team": self._team_name,
            "bot_user_id": self._bot_user_id,
            "channel": self._channel,
        }

    def disconnect(self) -> None:
        """Clear all configuration and disable notifications."""
        self._client = None
        self._bot_token = None
        self._channel = None
        self._signing_secret = None
        self._team_name = None
        self._bot_user_id = None
        self._enabled = False
        logger.info("Slack disconnected")

    @property
    def is_enabled(self) -> bool:
        return self._enabled and self._client is not None

    def get_status(self) -> Dict[str, Any]:
        """Return current status (safe to expose to frontend)."""
        if not self._enabled:
            return {"enabled": False, "channel": None, "team": None}
        return {
            "enabled": True,
            "team": self._team_name or "",
            "channel": self._channel or "",
            "bot_user_id": self._bot_user_id or "",
            "token_hint": (self._bot_token[:8] + "..." + self._bot_token[-4:])
                if self._bot_token and len(self._bot_token) > 12 else "***",
            "notify_on_complete": self.notify_on_complete,
            "notify_on_failed": self.notify_on_failed,
            "notify_on_alert": self.notify_on_alert,
        }

    def get_persisted_config(self) -> Optional[Dict[str, Any]]:
        """Return configuration dict suitable for saving to settings.json."""
        if not self._enabled:
            return None
        return {
            "bot_token": self._bot_token,
            "channel": self._channel,
            "signing_secret": self._signing_secret or "",
            "notify_on_complete": self.notify_on_complete,
            "notify_on_failed": self.notify_on_failed,
            "notify_on_alert": self.notify_on_alert,
        }

    def load_from_saved(self, data: Optional[Dict[str, Any]]) -> None:
        """Restore configuration from saved settings.json data."""
        if not data or not isinstance(data, dict):
            return
        token = data.get("bot_token", "")
        channel = data.get("channel", "")
        if not token or not channel:
            return
        try:
            self.configure(
                bot_token=token,
                channel=channel,
                signing_secret=data.get("signing_secret", ""),
                notify_on_complete=data.get("notify_on_complete", True),
                notify_on_failed=data.get("notify_on_failed", True),
                notify_on_alert=data.get("notify_on_alert", True),
            )
        except Exception as e:
            logger.warning("Failed to restore Slack config from saved state: %s", e)

    # ------------------------------------------------------------------
    # Low-level send
    # ------------------------------------------------------------------

    def send_notification(
        self,
        title: str,
        message: str,
        severity: str = "info",
        fields: Optional[Dict[str, str]] = None,
        channel_override: Optional[str] = None,
    ) -> bool:
        """Post a Block Kit notification to Slack.

        Returns True on success, False on failure (logged, never raises).
        """
        if not self.is_enabled:
            return False

        color_map = {
            "info": "#2196F3",
            "success": "#4CAF50",
            "warning": "#FF9800",
            "critical": "#F44336",
            "error": "#F44336",
        }
        color = color_map.get(severity, "#9E9E9E")

        # Build Block Kit blocks
        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": title[:150], "emoji": True},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": message[:3000]},
            },
        ]

        if fields:
            field_elements = []
            for k, v in list(fields.items())[:10]:
                field_elements.append({"type": "mrkdwn", "text": f"*{k}*\n{v}"})
            blocks.append({"type": "section", "fields": field_elements})

        blocks.append({
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": f"📡 Research Agent • {time.strftime('%Y-%m-%d %H:%M:%S')}"},
            ],
        })

        target_channel = channel_override or self._channel
        try:
            self._client.chat_postMessage(  # type: ignore[union-attr]
                channel=target_channel,
                text=f"{title}: {message}",  # Fallback for plain-text clients
                blocks=blocks,
                attachments=[{"color": color, "blocks": []}],  # Color bar
            )
            return True
        except SlackApiError as e:
            logger.error("Slack send failed: %s", e.response.get("error", str(e)))
            return False
        except Exception as e:
            logger.error("Slack send unexpected error: %s", e)
            return False

    # ------------------------------------------------------------------
    # Event-specific helpers
    # ------------------------------------------------------------------

    def send_run_completed(self, run: Dict[str, Any]) -> bool:
        """Notify when an experiment run completes successfully."""
        if not self.notify_on_complete:
            return False
        name = run.get("name", run.get("id", "unknown"))
        duration = ""
        if run.get("started_at") and run.get("ended_at"):
            secs = int(run["ended_at"] - run["started_at"])
            mins, s = divmod(secs, 60)
            hrs, m = divmod(mins, 60)
            duration = f"{hrs}h {m}m {s}s" if hrs else f"{m}m {s}s"

        fields: Dict[str, str] = {"Run": name, "Status": "✅ Completed"}
        if duration:
            fields["Duration"] = duration
        if run.get("command"):
            fields["Command"] = f"`{run['command'][:80]}`"

        return self.send_notification(
            title="✅ Run Completed",
            message=f"Experiment *{name}* finished successfully.",
            severity="success",
            fields=fields,
        )

    def send_run_failed(self, run: Dict[str, Any]) -> bool:
        """Notify when an experiment run fails."""
        if not self.notify_on_failed:
            return False
        name = run.get("name", run.get("id", "unknown"))
        error = run.get("error", "Unknown error")
        exit_code = run.get("exit_code")

        fields: Dict[str, str] = {"Run": name, "Status": "❌ Failed"}
        if exit_code is not None:
            fields["Exit Code"] = str(exit_code)
        if error:
            fields["Error"] = error[:200]
        if run.get("command"):
            fields["Command"] = f"`{run['command'][:80]}`"

        return self.send_notification(
            title="❌ Run Failed",
            message=f"Experiment *{name}* failed: {error[:200]}",
            severity="error",
            fields=fields,
        )

    def send_alert(self, alert: Dict[str, Any], run: Optional[Dict[str, Any]] = None) -> bool:
        """Notify when an experiment alert is created."""
        if not self.notify_on_alert:
            return False
        run_name = ""
        if run:
            run_name = run.get("name", run.get("id", "unknown"))
        severity = alert.get("severity", "warning")
        message_text = alert.get("message", "No details")
        choices = alert.get("choices", [])

        fields: Dict[str, str] = {"Severity": severity.upper()}
        if run_name:
            fields["Run"] = run_name
        if choices:
            fields["Choices"] = ", ".join(choices)

        emoji = {"critical": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(severity, "⚠️")
        return self.send_notification(
            title=f"{emoji} Alert: {message_text[:100]}",
            message=message_text,
            severity=severity,
            fields=fields,
        )

    def send_test(self) -> Dict[str, Any]:
        """Send a test notification. Returns result dict."""
        if not self.is_enabled:
            return {"ok": False, "error": "Slack is not configured"}
        ok = self.send_notification(
            title="🧪 Test Notification",
            message="This is a test message from Research Agent. If you see this, Slack integration is working!",
            severity="info",
            fields={"Status": "Connected", "Source": "Settings → Test"},
        )
        return {"ok": ok, "error": None if ok else "Failed to send message"}


# Module-level singleton
slack_notifier = SlackNotifier()
