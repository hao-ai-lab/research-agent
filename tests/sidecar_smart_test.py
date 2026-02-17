"""Unit tests for skill-driven sidecar smart analysis helpers."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import sidecar_smart as ss


def test_load_sidecar_skills_from_custom_root(tmp_path):
    skill_root = tmp_path / "skills"
    monitor_dir = skill_root / "sidecar_smart_monitoring"
    monitor_dir.mkdir(parents=True)
    (monitor_dir / "SKILL.md").write_text("monitor skill", encoding="utf-8")

    loaded = ss.load_sidecar_skills(skill_ids=["sidecar_smart_monitoring"], skill_root=str(skill_root))
    assert loaded == {"sidecar_smart_monitoring": "monitor skill"}


def test_parse_smart_agent_decision_with_jit_tasks():
    raw = json.dumps(
        {
            "action": "alert",
            "severity": "warning",
            "message": "Evaluation dropped",
            "source": "smart_agent",
            "syndrome": "eval_regression",
            "monitor_note": "eval dropped",
            "jit_tasks": [
                {
                    "task_type": "vega_lite_spec",
                    "title": "Validation trend",
                    "file_name": "val-trend.vl.json",
                    "spec": {"mark": "line", "data": {"values": [{"x": 1, "y": 2}]}, "encoding": {}},
                },
                {
                    "task_type": "markdown_note",
                    "title": "Operator note",
                    "file_name": "operator-note.md",
                    "content": "Check seed stability.",
                },
            ],
        }
    )
    parsed = ss.parse_smart_agent_decision(raw)
    assert parsed["action"] == "alert"
    assert parsed["syndrome"] == "eval_regression"
    assert len(parsed["jit_tasks"]) == 2


def test_materialize_jit_tasks_writes_artifacts(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    tasks = [
        {
            "task_type": "vega_lite_spec",
            "title": "Curve",
            "file_name": "curve.vl.json",
            "spec": {"mark": "line", "data": {"values": [{"x": 1, "y": 1}]}, "encoding": {}},
        },
        {
            "task_type": "markdown_note",
            "title": "Summary",
            "file_name": "summary.md",
            "content": "All good.",
        },
    ]

    artifacts = ss.materialize_jit_tasks(str(run_dir), tasks)
    rel_paths = [a["relative_path"] for a in artifacts]
    assert "analysis/curve.vl.json" in rel_paths
    assert "analysis/summary.md" in rel_paths


def test_should_run_smart_analysis_requires_change_and_interval(tmp_path):
    state = {}
    run_id = "run-1"
    metrics = tmp_path / "metrics.jsonl"
    logs = tmp_path / "run.log"
    metrics.write_text('{"loss": 1.0}\n', encoding="utf-8")
    logs.write_text("start\n", encoding="utf-8")

    assert ss.should_run_smart_analysis(run_id, str(metrics), str(logs), state, min_interval_seconds=0)

    # No change: should not rerun immediately.
    assert not ss.should_run_smart_analysis(run_id, str(metrics), str(logs), state, min_interval_seconds=0)

    # New data: should rerun.
    with open(logs, "a", encoding="utf-8") as f:
        f.write("new line\n")
    assert ss.should_run_smart_analysis(run_id, str(metrics), str(logs), state, min_interval_seconds=0)
