"""Unit tests for sidecar monitoring playbook behavior."""

import os
import sys

# Ensure server modules are importable.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import job_sidecar as js


def _rows(key: str, values: list[float]) -> list[dict]:
    return [{key: value, "step": idx} for idx, value in enumerate(values)]


def test_parse_cuda_visible_devices_variants():
    assert js.parse_cuda_visible_devices("CUDA_VISIBLE_DEVICES=0,2 python train.py") == [0, 2]
    assert js.parse_cuda_visible_devices("env FOO=1 CUDA_VISIBLE_DEVICES=3 python train.py") == [3]
    assert js.parse_cuda_visible_devices("python train.py") == []


def test_command_fingerprint_masks_gpu_assignment():
    a = js.command_fingerprint("CUDA_VISIBLE_DEVICES=0 python train.py --lr 1e-3")
    b = js.command_fingerprint("CUDA_VISIBLE_DEVICES=7 python train.py --lr 1e-3")
    assert a == b


def test_detect_log_syndrome_alert_cuda_oom(tmp_path):
    js._last_log_pos.clear()
    state = {}
    log_file = tmp_path / "run.log"
    log_file.write_text("RuntimeError: CUDA out of memory. Tried to allocate 2.4 GB\n", encoding="utf-8")

    decision = js.detect_log_syndrome_alert("run-log-1", str(log_file), state)
    assert decision is not None
    assert decision["source"] == "logwatch"
    assert decision["syndrome"] == "cuda_oom"
    assert decision["severity"] == "critical"

    # Same signature should dedupe within TTL.
    log_file.write_text(
        "RuntimeError: CUDA out of memory. Tried to allocate 2.4 GB\n"
        "RuntimeError: CUDA out of memory. Tried to allocate 2.4 GB\n",
        encoding="utf-8",
    )
    deduped = js.detect_log_syndrome_alert("run-log-1", str(log_file), state)
    assert deduped is None


def test_detect_supervised_metric_alert_validation_drop():
    state = {}
    rows = _rows("val/accuracy", [0.71, 0.74, 0.79, 0.84, 0.85, 0.69, 0.67])
    decision = js.detect_supervised_metric_alert(rows, state)
    assert decision is not None
    assert decision["source"] == "playbook"
    assert decision["syndrome"] == "validation_drop"


def test_detect_rl_metric_alert_reward_hacking():
    state = {}
    rows = []
    rewards = [10.0, 12.0, 13.0, 14.0, 15.0, 24.0]
    success = [0.80, 0.82, 0.81, 0.79, 0.78, 0.45]
    for idx in range(len(rewards)):
        rows.append({"step": idx, "episode_reward": rewards[idx], "success_rate": success[idx]})

    decision = js.detect_rl_metric_alert(rows, state)
    assert decision is not None
    assert decision["source"] == "playbook"
    assert decision["syndrome"] == "reward_hacking_suspected"
    assert decision["severity"] == "critical"


def test_detect_baseline_drift_alert_throughput_regression():
    state = {}
    summary = {
        "recent_throughput_mean": 20.0,
        "best_val_accuracy": 0.83,
    }
    baseline = {
        "recent_throughput_mean": 50.0,
        "best_val_accuracy": 0.84,
        "sample_size": 3,
    }

    decision = js.detect_baseline_drift_alert(summary, baseline, state)
    assert decision is not None
    assert decision["source"] == "baseline"
    assert decision["syndrome"] == "throughput_regression"


def test_baseline_reference_from_history_prefers_profile_match():
    history = [
        {
            "command_fingerprint": "abc",
            "status": "finished",
            "profile": "supervised",
            "summary": {"recent_throughput_mean": 40.0, "best_val_accuracy": 0.90},
        },
        {
            "command_fingerprint": "abc",
            "status": "finished",
            "profile": "reinforcement_learning",
            "summary": {"recent_throughput_mean": 15.0, "best_val_accuracy": 0.10},
        },
    ]

    baseline = js.baseline_reference_from_history(history, fingerprint="abc", profile="supervised")
    assert baseline is not None
    assert baseline["recent_throughput_mean"] == 40.0
    assert baseline["best_val_accuracy"] == 0.90
