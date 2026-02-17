"""Tests for slack_handler.py – SlackNotifier class."""
import json
import unittest
from unittest.mock import patch, MagicMock

# Ensure slack_sdk is available (the handler gracefully degrades if not)
from slack_handler import SlackNotifier


class TestSlackNotifierInit(unittest.TestCase):
    """Tests for initialization and configuration."""

    def test_default_state(self):
        notifier = SlackNotifier()
        self.assertFalse(notifier.is_enabled)
        status = notifier.get_status()
        self.assertFalse(status["enabled"])
        self.assertIsNone(status["channel"])

    def test_configure_missing_token(self):
        notifier = SlackNotifier()
        with self.assertRaises(ValueError):
            notifier.configure(bot_token="", channel="#test")

    def test_configure_missing_channel(self):
        notifier = SlackNotifier()
        with self.assertRaises(ValueError):
            notifier.configure(bot_token="xoxb-test", channel="")


class TestSlackNotifierConfigure(unittest.TestCase):
    """Tests for the configure / disconnect flow."""

    @patch("slack_handler.WebClient")
    def test_configure_success(self, MockWebClient):
        mock_client = MagicMock()
        mock_client.auth_test.return_value = {
            "ok": True,
            "team": "TestTeam",
            "bot_id": "B123",
        }
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        result = notifier.configure(bot_token="xoxb-test-token", channel="#general")

        self.assertTrue(result["ok"])
        self.assertEqual(result["team"], "TestTeam")
        self.assertTrue(notifier.is_enabled)
        MockWebClient.assert_called_once_with(token="xoxb-test-token")

    @patch("slack_handler.WebClient")
    def test_configure_auth_failure(self, MockWebClient):
        from slack_sdk.errors import SlackApiError

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.__getitem__ = lambda self, key: "invalid_auth"
        mock_client.auth_test.side_effect = SlackApiError(
            message="invalid_auth", response=mock_response
        )
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        with self.assertRaises(RuntimeError):
            notifier.configure(bot_token="xoxb-bad-token", channel="#general")

        self.assertFalse(notifier.is_enabled)

    @patch("slack_handler.WebClient")
    def test_disconnect(self, MockWebClient):
        mock_client = MagicMock()
        mock_client.auth_test.return_value = {"ok": True, "team": "T", "bot_id": "B"}
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        notifier.configure(bot_token="xoxb-test", channel="#ch")
        self.assertTrue(notifier.is_enabled)

        notifier.disconnect()
        self.assertFalse(notifier.is_enabled)
        self.assertIsNone(notifier.get_status()["channel"])


class TestSlackNotifierPersistence(unittest.TestCase):
    """Tests for save/load state."""

    @patch("slack_handler.WebClient")
    def test_get_persisted_config(self, MockWebClient):
        mock_client = MagicMock()
        mock_client.auth_test.return_value = {"ok": True, "team": "T", "bot_id": "B"}
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        notifier.configure(
            bot_token="xoxb-persist",
            channel="#save",
            signing_secret="sec123",
            notify_on_complete=False,
        )

        cfg = notifier.get_persisted_config()
        self.assertIsNotNone(cfg)
        self.assertEqual(cfg["channel"], "#save")
        self.assertFalse(cfg["notify_on_complete"])
        # Token should be present but we won't check exact value (security)
        self.assertIn("bot_token", cfg)

    def test_get_persisted_config_disabled(self):
        notifier = SlackNotifier()
        self.assertIsNone(notifier.get_persisted_config())

    @patch("slack_handler.WebClient")
    def test_load_from_saved(self, MockWebClient):
        mock_client = MagicMock()
        mock_client.auth_test.return_value = {"ok": True, "team": "T", "bot_id": "B"}
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        saved = {
            "bot_token": "xoxb-loaded",
            "channel": "#loaded",
            "signing_secret": "s",
            "notify_on_complete": True,
            "notify_on_failed": False,
            "notify_on_alert": True,
        }
        notifier.load_from_saved(saved)
        self.assertTrue(notifier.is_enabled)

    def test_load_from_saved_none(self):
        notifier = SlackNotifier()
        notifier.load_from_saved(None)
        self.assertFalse(notifier.is_enabled)


class TestSlackNotifierSend(unittest.TestCase):
    """Tests for notification methods."""

    @patch("slack_handler.WebClient")
    def _make_enabled_notifier(self, MockWebClient):
        mock_client = MagicMock()
        mock_client.auth_test.return_value = {"ok": True, "team": "T", "bot_id": "B"}
        mock_client.chat_postMessage.return_value = {"ok": True, "ts": "123.456"}
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        notifier.configure(bot_token="xoxb-test", channel="#ch")
        return notifier, mock_client

    def test_send_test(self):
        notifier, mock_client = self._make_enabled_notifier()
        result = notifier.send_test()
        self.assertTrue(result["ok"])
        mock_client.chat_postMessage.assert_called_once()

    def test_send_run_completed(self):
        notifier, mock_client = self._make_enabled_notifier()
        run = {"id": "r1", "name": "test-run", "status": "finished"}
        notifier.send_run_completed(run)
        mock_client.chat_postMessage.assert_called_once()
        call_kwargs = mock_client.chat_postMessage.call_args[1]
        self.assertEqual(call_kwargs["channel"], "#ch")

    def test_send_run_failed(self):
        notifier, mock_client = self._make_enabled_notifier()
        run = {"id": "r2", "name": "fail-run", "status": "failed", "error": "OOM"}
        notifier.send_run_failed(run)
        mock_client.chat_postMessage.assert_called_once()

    def test_send_alert(self):
        notifier, mock_client = self._make_enabled_notifier()
        alert = {"id": "a1", "severity": "critical", "message": "GPU temp high"}
        run = {"id": "r3", "name": "gpu-run"}
        notifier.send_alert(alert, run)
        mock_client.chat_postMessage.assert_called_once()

    def test_send_disabled_notify_on_complete(self):
        """When notify_on_complete is False, send_run_completed should not call Slack."""
        notifier, mock_client = self._make_enabled_notifier()
        notifier.notify_on_complete = False
        run = {"id": "r4", "name": "skip-run", "status": "finished"}
        notifier.send_run_completed(run)
        mock_client.chat_postMessage.assert_not_called()


class TestSlackNotifierStatus(unittest.TestCase):
    """Tests for get_status."""

    @patch("slack_handler.WebClient")
    def test_status_connected(self, MockWebClient):
        mock_client = MagicMock()
        mock_client.auth_test.return_value = {"ok": True, "team": "MyTeam", "bot_id": "B1"}
        MockWebClient.return_value = mock_client

        notifier = SlackNotifier()
        notifier.configure(bot_token="xoxb-x", channel="#status")
        status = notifier.get_status()
        self.assertTrue(status["enabled"])
        self.assertEqual(status["channel"], "#status")
        self.assertEqual(status["team"], "MyTeam")

    def test_status_disconnected(self):
        notifier = SlackNotifier()
        status = notifier.get_status()
        self.assertFalse(status["enabled"])


if __name__ == "__main__":
    unittest.main()
