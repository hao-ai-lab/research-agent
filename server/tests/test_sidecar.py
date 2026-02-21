"""Tests for the decomposed sidecar modules.

Covers: server_api, alerts, metrics, gpu, tmux_manager, and the
monitor_job() orchestrator in agent/sidecar_agent.py.
"""

import json
import math
import os
import tempfile
import textwrap
import unittest
from unittest.mock import MagicMock, patch, PropertyMock


# ---------------------------------------------------------------------------
# sidecar.server_api
# ---------------------------------------------------------------------------

class TestServerApi(unittest.TestCase):
    def test_auth_headers_with_token(self):
        from sidecar.server_api import _auth_headers
        self.assertEqual(_auth_headers("tok-123"), {"X-Auth-Token": "tok-123"})

    def test_auth_headers_without_token(self):
        from sidecar.server_api import _auth_headers
        self.assertEqual(_auth_headers(None), {})
        self.assertEqual(_auth_headers(""), {})

    def test_should_stop_from_choice(self):
        from sidecar.server_api import should_stop_from_choice
        self.assertTrue(should_stop_from_choice("Stop Job"))
        self.assertTrue(should_stop_from_choice("Kill process"))
        self.assertTrue(should_stop_from_choice("Terminate"))
        self.assertFalse(should_stop_from_choice("Ignore"))
        self.assertFalse(should_stop_from_choice(None))
        self.assertFalse(should_stop_from_choice(""))

    @patch("sidecar.server_api.requests.post")
    def test_report_status_posts_correctly(self, mock_post):
        from sidecar.server_api import report_status
        mock_post.return_value = MagicMock(status_code=200)
        report_status("http://localhost:10000", "job-1", "running", {"tmux_pane": "%5"}, auth_token="tok")

        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        self.assertIn("/runs/job-1/status", args[0])
        self.assertEqual(kwargs["json"]["status"], "running")
        self.assertEqual(kwargs["headers"]["X-Auth-Token"], "tok")

    @patch("sidecar.server_api.requests.post")
    def test_trigger_alert_returns_alert_id(self, mock_post):
        from sidecar.server_api import trigger_alert
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"alert_id": "alert-42"},
        )
        result = trigger_alert("http://localhost:10000", "job-1", "Loss spike", ["Ignore", "Stop"])
        self.assertEqual(result, "alert-42")

    @patch("sidecar.server_api.requests.post")
    def test_trigger_alert_returns_none_on_failure(self, mock_post):
        from sidecar.server_api import trigger_alert
        mock_post.return_value = MagicMock(status_code=500, text="error")
        result = trigger_alert("http://localhost:10000", "job-1", "Loss spike", ["Ignore"])
        self.assertIsNone(result)

    def test_wait_for_response_reads_file(self):
        from sidecar.server_api import wait_for_response
        with tempfile.TemporaryDirectory() as tmpdir:
            alerts_dir = os.path.join(tmpdir, "alerts")
            os.makedirs(alerts_dir)
            response_file = os.path.join(alerts_dir, "alert-1.response")
            with open(response_file, "w") as f:
                f.write("Stop Job\n")
            result = wait_for_response(tmpdir, "alert-1", timeout_seconds=1)
            self.assertEqual(result, "Stop Job")


# ---------------------------------------------------------------------------
# sidecar.alerts
# ---------------------------------------------------------------------------

class TestAlerts(unittest.TestCase):
    def test_extract_loss_standard_keys(self):
        from sidecar.alerts import extract_loss
        self.assertEqual(extract_loss({"loss": 2.5}), 2.5)
        self.assertEqual(extract_loss({"train/loss": 1.0}), 1.0)
        self.assertEqual(extract_loss({"train_loss": 0.5}), 0.5)
        self.assertIsNone(extract_loss({"accuracy": 0.9}))

    def test_seen_recent_signature_dedup(self):
        from sidecar.alerts import seen_recent_signature
        state = {}
        self.assertFalse(seen_recent_signature(state, "test", "sig-1", ttl_seconds=60))
        self.assertTrue(seen_recent_signature(state, "test", "sig-1", ttl_seconds=60))
        # Different signature
        self.assertFalse(seen_recent_signature(state, "test", "sig-2", ttl_seconds=60))

    def test_rulebased_alerts_nan_detection(self):
        from sidecar.alerts import rulebased_alerts
        with tempfile.TemporaryDirectory() as tmpdir:
            metrics_path = os.path.join(tmpdir, "metrics.jsonl")
            rows = [
                {"step": 1, "loss": 1.0},
                {"step": 2, "loss": float("nan")},
            ]
            with open(metrics_path, "w") as f:
                for row in rows:
                    f.write(json.dumps(row) + "\n")
            result = rulebased_alerts("job-1", tmpdir, {})
            self.assertIsNotNone(result)
            self.assertEqual(result["action"], "alert")
            self.assertEqual(result["severity"], "critical")
            self.assertIn("NaN", result["message"])

    def test_rulebased_alerts_high_loss(self):
        from sidecar.alerts import rulebased_alerts
        with tempfile.TemporaryDirectory() as tmpdir:
            metrics_path = os.path.join(tmpdir, "metrics.jsonl")
            rows = [{"step": i, "loss": 10.0} for i in range(5)]
            with open(metrics_path, "w") as f:
                for row in rows:
                    f.write(json.dumps(row) + "\n")
            result = rulebased_alerts("job-1", tmpdir, {})
            self.assertIsNotNone(result)
            self.assertEqual(result["action"], "alert")
            self.assertIn("High loss", result["message"])

    def test_rulebased_alerts_no_alert_for_normal(self):
        from sidecar.alerts import rulebased_alerts
        with tempfile.TemporaryDirectory() as tmpdir:
            metrics_path = os.path.join(tmpdir, "metrics.jsonl")
            rows = [{"step": i, "loss": 0.5 - i * 0.01} for i in range(10)]
            with open(metrics_path, "w") as f:
                for row in rows:
                    f.write(json.dumps(row) + "\n")
            result = rulebased_alerts("job-1", tmpdir, {})
            self.assertIsNone(result)

    def test_parse_alert_judge_decision_valid(self):
        from sidecar.alerts import parse_alert_judge_decision
        output = '{"action": "alert", "message": "Loss is diverging", "severity": "warning", "choices": ["Ignore", "Stop"]}'
        result = parse_alert_judge_decision(output)
        self.assertEqual(result["action"], "alert")
        self.assertEqual(result["message"], "Loss is diverging")

    def test_parse_alert_judge_decision_nothing(self):
        from sidecar.alerts import parse_alert_judge_decision
        result = parse_alert_judge_decision("NOTHING to report")
        self.assertEqual(result["action"], "ignore")

    def test_parse_alert_judge_decision_invalid(self):
        from sidecar.alerts import parse_alert_judge_decision
        result = parse_alert_judge_decision("just some text")
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# sidecar.metrics
# ---------------------------------------------------------------------------

class TestMetrics(unittest.TestCase):
    def test_read_recent_metrics_basic(self):
        from sidecar.metrics import read_recent_metrics
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "metrics.jsonl")
            with open(path, "w") as f:
                for i in range(5):
                    f.write(json.dumps({"step": i, "loss": 1.0 / (i + 1)}) + "\n")
            rows = read_recent_metrics(path, max_lines=3)
            self.assertEqual(len(rows), 3)
            self.assertEqual(rows[-1]["step"], 4)

    def test_read_recent_metrics_nonexistent(self):
        from sidecar.metrics import read_recent_metrics
        rows = read_recent_metrics("/nonexistent/path.jsonl")
        self.assertEqual(rows, [])

    def test_read_recent_metrics_tolerates_bad_lines(self):
        from sidecar.metrics import read_recent_metrics
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "metrics.jsonl")
            with open(path, "w") as f:
                f.write('{"step": 1, "loss": 0.5}\n')
                f.write("not json\n")
                f.write('{"step": 2, "loss": 0.3}\n')
            rows = read_recent_metrics(path)
            self.assertEqual(len(rows), 2)

    def test_find_wandb_dir_in_rundir_not_found(self):
        from sidecar.metrics import find_wandb_dir_in_rundir
        with tempfile.TemporaryDirectory() as tmpdir:
            result = find_wandb_dir_in_rundir(tmpdir, "job-123")
            self.assertIsNone(result)

    def test_find_wandb_dir_in_rundir_found(self):
        from sidecar.metrics import find_wandb_dir_in_rundir
        with tempfile.TemporaryDirectory() as tmpdir:
            wandb_run_dir = os.path.join(tmpdir, "wandb_data", "wandb", "run-20260101-job-123")
            os.makedirs(wandb_run_dir)
            result = find_wandb_dir_in_rundir(tmpdir, "job-123")
            self.assertEqual(result, wandb_run_dir)

    def test_resolve_wandb_metrics_source_jsonl(self):
        from sidecar.metrics import _resolve_wandb_metrics_source
        with tempfile.TemporaryDirectory() as tmpdir:
            jsonl = os.path.join(tmpdir, "metrics.jsonl")
            with open(jsonl, "w") as f:
                f.write("{}\n")
            path, kind = _resolve_wandb_metrics_source(tmpdir)
            self.assertEqual(path, jsonl)
            self.assertEqual(kind, "jsonl")

    def test_resolve_wandb_metrics_source_none(self):
        from sidecar.metrics import _resolve_wandb_metrics_source
        with tempfile.TemporaryDirectory() as tmpdir:
            path, kind = _resolve_wandb_metrics_source(tmpdir)
            self.assertIsNone(path)
            self.assertEqual(kind, "")

    @patch("sidecar.metrics.requests.post")
    def test_post_metrics_delta_posts_new_rows(self, mock_post):
        from sidecar.metrics import post_metrics_delta
        mock_post.return_value = MagicMock(status_code=200)
        with tempfile.TemporaryDirectory() as tmpdir:
            jsonl = os.path.join(tmpdir, "metrics.jsonl")
            with open(jsonl, "w") as f:
                for i in range(3):
                    f.write(json.dumps({"step": i, "loss": 0.5}) + "\n")
            result = post_metrics_delta("http://localhost:10000", "job-1", tmpdir, 0)
            self.assertEqual(result, 3)
            mock_post.assert_called_once()

    @patch("sidecar.metrics.requests.post")
    def test_post_metrics_delta_skips_when_no_new(self, mock_post):
        from sidecar.metrics import post_metrics_delta
        with tempfile.TemporaryDirectory() as tmpdir:
            jsonl = os.path.join(tmpdir, "metrics.jsonl")
            with open(jsonl, "w") as f:
                f.write(json.dumps({"step": 0, "loss": 0.5}) + "\n")
            result = post_metrics_delta("http://localhost:10000", "job-1", tmpdir, 1)
            self.assertEqual(result, 1)
            mock_post.assert_not_called()


# ---------------------------------------------------------------------------
# sidecar.gpu
# ---------------------------------------------------------------------------

class TestGpu(unittest.TestCase):
    def test_truthy(self):
        from sidecar.gpu import _truthy
        self.assertTrue(_truthy(True))
        self.assertTrue(_truthy("yes"))
        self.assertTrue(_truthy("1"))
        self.assertFalse(_truthy(False))
        self.assertFalse(_truthy("false"))
        self.assertFalse(_truthy("0"))
        self.assertFalse(_truthy(""))

    def test_resolve_gpuwrap_settings_defaults(self):
        from sidecar.gpu import resolve_gpuwrap_settings
        settings = resolve_gpuwrap_settings(None)
        self.assertFalse(settings["enabled"])
        self.assertIsNone(settings["retries"])
        self.assertGreater(settings["retry_delay_seconds"], 0)

    def test_resolve_gpuwrap_settings_enabled(self):
        from sidecar.gpu import resolve_gpuwrap_settings
        settings = resolve_gpuwrap_settings({"enabled": True, "retries": 3, "retry_delay_seconds": 10})
        self.assertTrue(settings["enabled"])
        self.assertEqual(settings["retries"], 3)
        self.assertEqual(settings["retry_delay_seconds"], 10)

    def test_looks_like_gpu_conflict(self):
        from sidecar.gpu import _looks_like_gpu_conflict
        self.assertTrue(_looks_like_gpu_conflict("RuntimeError: CUDA out of memory"))
        self.assertTrue(_looks_like_gpu_conflict("all CUDA-capable devices are busy or unavailable"))
        self.assertFalse(_looks_like_gpu_conflict("Training started successfully"))
        self.assertFalse(_looks_like_gpu_conflict(""))

    def test_read_log_tail_since(self):
        from sidecar.gpu import _read_log_tail_since
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = os.path.join(tmpdir, "run.log")
            with open(log_file, "w") as f:
                f.write("line 1\nline 2\nline 3\n")
            # Read from offset 0
            tail = _read_log_tail_since(log_file, 0)
            self.assertIn("line 1", tail)
            self.assertIn("line 3", tail)
            # Read from middle
            tail = _read_log_tail_since(log_file, 7)
            self.assertNotIn("line 1", tail)
            self.assertIn("line 2", tail)

    def test_read_log_tail_since_nonexistent(self):
        from sidecar.gpu import _read_log_tail_since
        tail = _read_log_tail_since("/nonexistent/file.log", 0)
        self.assertEqual(tail, "")

    @patch("sidecar.gpu.trigger_alert")
    def test_emit_gpu_retry_alert(self, mock_trigger):
        from sidecar.gpu import emit_gpu_retry_alert
        emit_gpu_retry_alert("http://localhost", "job-1", 2, 5, "GPUs busy")
        mock_trigger.assert_called_once()
        call_kwargs = mock_trigger.call_args[1]
        self.assertIn("2/5", call_kwargs["message"])
        self.assertIn("GPUs busy", call_kwargs["message"])

    @patch("sidecar.gpu.trigger_alert")
    def test_emit_gpu_retry_alert_unlimited(self, mock_trigger):
        from sidecar.gpu import emit_gpu_retry_alert
        emit_gpu_retry_alert("http://localhost", "job-1", 7, None, "busy")
        call_kwargs = mock_trigger.call_args[1]
        self.assertIn("attempt 7", call_kwargs["message"])
        self.assertNotIn("/", call_kwargs["message"])


# ---------------------------------------------------------------------------
# sidecar.tmux_manager
# ---------------------------------------------------------------------------

class TestTmuxManager(unittest.TestCase):
    def test_get_current_pane_no_env(self):
        from sidecar.tmux_manager import get_current_pane
        with patch.dict(os.environ, {}, clear=True):
            result = get_current_pane()
            self.assertIsNone(result)


# ---------------------------------------------------------------------------
# agent.sidecar_agent
# ---------------------------------------------------------------------------

class TestSidecarAgent(unittest.TestCase):
    def test_agent_instantiation(self):
        from agent.sidecar_agent import SidecarAgent
        agent = SidecarAgent(config={"job_id": "test-job", "command": "echo hello"})
        d = agent.to_dict()
        self.assertEqual(d["job_id"], "test-job")
        self.assertEqual(d["command"], "echo hello")
        self.assertEqual(d["workdir"], ".")
        self.assertEqual(d["run_dir"], "/tmp")

    def test_agent_defaults(self):
        from agent.sidecar_agent import SidecarAgent
        agent = SidecarAgent(config={})
        self.assertEqual(agent._server_url, "http://127.0.0.1:10000")
        self.assertEqual(agent._command, "")

    def test_monitor_job_is_importable(self):
        from agent.sidecar_agent import monitor_job
        import inspect
        sig = inspect.signature(monitor_job)
        self.assertIn("job_pane", sig.parameters)
        self.assertIn("server_url", sig.parameters)


# ---------------------------------------------------------------------------
# tools.job_sidecar (CLI shim)
# ---------------------------------------------------------------------------

class TestCliShim(unittest.TestCase):
    def test_shim_importable(self):
        from tools.job_sidecar import main
        self.assertTrue(callable(main))


if __name__ == "__main__":
    unittest.main()
