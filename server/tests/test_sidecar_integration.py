"""Integration test: run → sidecar flow.

Exercises the full path from creating a tmux pane to running
monitor_job() with a real command, verifying it completes and
reports status correctly.

Requires: tmux (libtmux) — skipped in CI if tmux is unavailable.
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest.mock import patch

# Ensure server/ is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import pytest

try:
    import libtmux
    _HAS_TMUX = True
    try:
        libtmux.Server()
        _TMUX_RUNNING = True
    except Exception:
        _TMUX_RUNNING = False
except ImportError:
    _HAS_TMUX = False
    _TMUX_RUNNING = False

skip_no_tmux = pytest.mark.skipif(
    not (_HAS_TMUX and _TMUX_RUNNING),
    reason="tmux not available or not running",
)


# ---------------------------------------------------------------------------
# Fake callback server — captures status reports and metrics posts
# ---------------------------------------------------------------------------

class _CapturedRequests:
    def __init__(self):
        self.statuses: list[dict] = []
        self.alerts: list[dict] = []
        self.metrics: list[dict] = []
        self.lock = threading.Lock()

    def add_status(self, data: dict):
        with self.lock:
            self.statuses.append(data)

    def add_alert(self, data: dict):
        with self.lock:
            self.alerts.append(data)

    def add_metrics(self, data: dict):
        with self.lock:
            self.metrics.append(data)

    @property
    def latest_status(self) -> str | None:
        with self.lock:
            return self.statuses[-1]["status"] if self.statuses else None


_captured = _CapturedRequests()


class _FakeServerHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that captures sidecar callbacks."""

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if "/status" in self.path:
            _captured.add_status(body)
        elif "/alerts" in self.path:
            _captured.add_alert(body)
            # Return a fake alert_id
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"alert_id": "test-alert"}).encode())
            return
        elif "/metrics" in self.path:
            _captured.add_metrics(body)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def log_message(self, format, *args):
        pass  # silence request logging


# ---------------------------------------------------------------------------
# Integration tests
# ---------------------------------------------------------------------------

@skip_no_tmux
class TestSidecarIntegration(unittest.TestCase):
    """End-to-end test: tmux pane → monitor_job → status callbacks."""

    @classmethod
    def setUpClass(cls):
        """Start a fake callback server and create a tmux session."""
        global _captured
        _captured = _CapturedRequests()

        # Start fake HTTP server
        cls.server = HTTPServer(("127.0.0.1", 0), _FakeServerHandler)
        cls.server_port = cls.server.server_address[1]
        cls.server_url = f"http://127.0.0.1:{cls.server_port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

        # Create a dedicated tmux session for testing
        cls.tmux_server = libtmux.Server()
        cls.tmux_session = cls.tmux_server.new_session(
            session_name="test-sidecar-integration",
            kill_session=True,
        )

    @classmethod
    def tearDownClass(cls):
        """Shut down fake server and kill tmux session."""
        cls.server.shutdown()
        try:
            cls.tmux_session.kill()
        except Exception:
            pass

    def test_monitor_job_success(self):
        """monitor_job should run 'echo hello', detect completion, and report 'finished'."""
        from agent.sidecar_agent import monitor_job

        with tempfile.TemporaryDirectory() as run_dir:
            window = self.tmux_session.new_window(window_name="test-success", attach=False)
            pane = window.active_pane

            thread = threading.Thread(
                target=monitor_job,
                kwargs={
                    "server_url": self.server_url,
                    "job_id": "test-success-job",
                    "command": "echo hello-sidecar-test",
                    "workdir": "/tmp",
                    "run_dir": run_dir,
                    "job_pane": pane,
                },
                daemon=True,
            )
            thread.start()
            thread.join(timeout=15)

            self.assertFalse(thread.is_alive(), "monitor_job should have completed")
            self.assertEqual(_captured.latest_status, "finished")

            # Check that a sidecar.log was created
            log_file = os.path.join(run_dir, "sidecar.log")
            self.assertTrue(os.path.exists(log_file))

    def test_monitor_job_failure(self):
        """monitor_job should detect a non-zero exit and report 'failed'."""
        from agent.sidecar_agent import monitor_job

        global _captured
        _captured = _CapturedRequests()

        with tempfile.TemporaryDirectory() as run_dir:
            window = self.tmux_session.new_window(window_name="test-failure", attach=False)
            pane = window.active_pane

            thread = threading.Thread(
                target=monitor_job,
                kwargs={
                    "server_url": self.server_url,
                    "job_id": "test-failure-job",
                    "command": "exit 42",
                    "workdir": "/tmp",
                    "run_dir": run_dir,
                    "job_pane": pane,
                },
                daemon=True,
            )
            thread.start()
            thread.join(timeout=15)

            self.assertFalse(thread.is_alive(), "monitor_job should have completed")
            self.assertEqual(_captured.latest_status, "failed")

    def test_monitor_job_reports_running(self):
        """monitor_job should report 'running' status early in the lifecycle."""
        from agent.sidecar_agent import monitor_job

        global _captured
        _captured = _CapturedRequests()

        with tempfile.TemporaryDirectory() as run_dir:
            window = self.tmux_session.new_window(window_name="test-running", attach=False)
            pane = window.active_pane

            thread = threading.Thread(
                target=monitor_job,
                kwargs={
                    "server_url": self.server_url,
                    "job_id": "test-running-job",
                    "command": "sleep 1 && echo done",
                    "workdir": "/tmp",
                    "run_dir": run_dir,
                    "job_pane": pane,
                },
                daemon=True,
            )
            thread.start()
            thread.join(timeout=20)

            self.assertFalse(thread.is_alive())
            # Should have reported 'running' at some point
            all_statuses = [s["status"] for s in _captured.statuses]
            self.assertIn("running", all_statuses)
            # Should eventually finish
            self.assertEqual(_captured.latest_status, "finished")


if __name__ == "__main__":
    unittest.main()
