"""Unit tests for mechanical sidecar behaviors."""

import os
import sys

# Ensure server modules are importable.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import job_sidecar as js


def test_parse_cuda_visible_devices_variants():
    assert js.parse_cuda_visible_devices("CUDA_VISIBLE_DEVICES=0,2 python train.py") == [0, 2]
    assert js.parse_cuda_visible_devices("env FOO=1 CUDA_VISIBLE_DEVICES=3 python train.py") == [3]
    assert js.parse_cuda_visible_devices("python train.py") == []


def test_rulebased_alerts_detects_non_finite_loss_once():
    state = {}
    rows = [
        {"step": 1, "loss": 0.4},
        {"step": 2, "loss": float("inf")},
    ]
    decision = js.rulebased_alerts(rows, state)
    assert decision is not None
    assert decision["source"] == "rulebased"
    assert decision["syndrome"] == "nan_inf_loss"
    assert decision["severity"] == "critical"

    # Same alert should be deduped in recent-signature window.
    deduped = js.rulebased_alerts(rows, state)
    assert deduped is None


def test_rulebased_alerts_ignores_normal_rows():
    state = {}
    rows = [
        {"step": 1, "loss": 0.8},
        {"step": 2, "loss": 0.6},
        {"step": 3, "loss": 0.5},
    ]
    assert js.rulebased_alerts(rows, state) is None


def test_read_new_log_lines_incremental(tmp_path):
    js._last_log_pos.clear()
    run_id = "r1"
    log_file = tmp_path / "run.log"

    log_file.write_text("line1\nline2\n", encoding="utf-8")
    first = js.read_new_log_lines(run_id, str(log_file))
    assert first == ["line1", "line2"]

    # No append => no new lines.
    second = js.read_new_log_lines(run_id, str(log_file))
    assert second == []

    # Append one line => only delta returned.
    with open(log_file, "a", encoding="utf-8") as f:
        f.write("line3\n")
    third = js.read_new_log_lines(run_id, str(log_file))
    assert third == ["line3"]
