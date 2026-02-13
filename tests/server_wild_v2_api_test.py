"""API-surface tests for Wild V2 status/events/human-signal/OpenEvolve handlers.

These call endpoint handler functions directly to avoid HTTP client version coupling.
"""

import asyncio
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))

import server as srv


def _reset_state():
    srv.runs.clear()
    srv.active_alerts.clear()
    srv.v2_human_signals.clear()
    srv.openevolve_jobs.clear()
    srv.v2_resolved_event_ids.clear()


def _run(coro):
    return asyncio.run(coro)


def test_wild_v2_status_includes_pending_events_system_health_and_openevolve_jobs():
    _reset_state()

    srv.runs["run-1"] = {"name": "Run 1", "status": "running", "created_at": time.time()}
    srv.active_alerts["a1"] = {
        "id": "a1",
        "run_id": "run-1",
        "timestamp": time.time(),
        "severity": "critical",
        "mode": "blocking",
        "source": "rulebased",
        "message": "Loss exploded",
        "choices": ["Ignore", "Stop Job"],
        "status": "pending",
    }
    srv.v2_human_signals["sig-1"] = {
        "id": "sig-1",
        "mode": "advisory",
        "severity": "warning",
        "title": "Something off",
        "detail": "Trying mitigation",
        "source": "wild_v2_agent",
        "session_id": "wild-session",
        "status": "pending",
        "created_at": time.time(),
        "metadata": {},
    }
    srv.openevolve_jobs["oe-1"] = {
        "id": "oe-1",
        "run_id": "run-1",
        "status": "running",
        "mode": "smoke",
        "output_dir": "/tmp/missing",
        "latest_checkpoint": None,
        "last_iteration": None,
        "best_program_id": None,
        "best_score": None,
        "updated_at": time.time(),
        "created_at": time.time(),
        "name": "OpenEvolve Smoke",
    }

    body = _run(srv.wild_v2_status())

    assert "pending_events_count" in body
    assert "pending_events" in body
    assert body["pending_events_count"] >= 2

    assert "system_health" in body
    assert body["system_health"]["running"] >= 1

    assert "openevolve_jobs" in body
    assert len(body["openevolve_jobs"]) >= 1


def test_wild_v2_events_and_resolve_support_alerts_and_signals():
    _reset_state()

    srv.active_alerts["a2"] = {
        "id": "a2",
        "run_id": "run-x",
        "timestamp": time.time(),
        "severity": "warning",
        "mode": "blocking",
        "source": "rulebased",
        "message": "Watch this",
        "choices": ["Ignore", "Stop Job"],
        "status": "pending",
    }
    srv.v2_human_signals["sig-2"] = {
        "id": "sig-2",
        "mode": "blocking",
        "severity": "critical",
        "title": "Blocked",
        "detail": "Need human",
        "source": "wild_v2_agent",
        "session_id": "wild-s2",
        "status": "pending",
        "created_at": time.time(),
        "metadata": {},
    }

    events = _run(srv.wild_v2_events("wild-s2"))
    ids = {e["id"] for e in events}
    assert "alert-a2" in ids
    assert "sig-2" in ids

    resolved = _run(
        srv.wild_v2_resolve_events(
            "wild-s2",
            srv.WildV2ResolveRequest(event_ids=["alert-a2", "sig-2"]),
        )
    )
    assert resolved["resolved"] == 2
    assert srv.active_alerts["a2"]["status"] == "resolved"
    assert srv.v2_human_signals["sig-2"]["status"] == "resolved"


def test_wild_v2_human_signal_endpoint_records_and_pauses_when_blocking():
    _reset_state()

    started = srv.wild_v2_engine.start(goal="human signal test", human_away_timeout_seconds=60)
    session_id = started["session_id"]

    body = _run(
        srv.wild_v2_human_signal(
            srv.WildV2HumanSignalRequest(
                mode="blocking",
                severity="critical",
                title="Blocked",
                detail="Cannot continue",
                source="wild_v2_agent",
                session_id=session_id,
                metadata={"case": "test"},
            )
        )
    )
    assert body["event_id"].startswith("sig-")

    assert srv.wild_v2_engine.session is not None
    assert srv.wild_v2_engine.session.status == "paused"
    assert srv.wild_v2_engine.session.blocking_reason == "Cannot continue"

    srv.wild_v2_engine.stop()


def test_wild_v2_openevolve_start_smoke_registers_job_and_reads_checkpoint():
    _reset_state()

    tmpdir = tempfile.mkdtemp(prefix="oe-bridge-test-")

    def fake_launch(run_id, run_data):
        run_data["status"] = "running"
        run_data["run_dir"] = os.path.join(tmpdir, "run", run_id)
        return "tmux-test"

    original_launch = srv.launch_run_in_tmux
    try:
        srv.launch_run_in_tmux = fake_launch
        payload = _run(
            srv.wild_v2_openevolve_start(
                srv.WildV2OpenEvolveStartRequest(
                    mode="smoke",
                    initial_program="examples/function_minimization/initial_program.py",
                    evaluation_file="examples/function_minimization/evaluator.py",
                    iterations=3,
                    output_dir=tmpdir,
                    name="Smoke Job",
                )
            )
        )
    finally:
        srv.launch_run_in_tmux = original_launch

    job_id = payload["job_id"]
    assert job_id in srv.openevolve_jobs

    checkpoint_dir = os.path.join(tmpdir, "checkpoints", "checkpoint_3")
    os.makedirs(os.path.join(checkpoint_dir, "programs"), exist_ok=True)
    with open(os.path.join(checkpoint_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump({"last_iteration": 3, "best_program_id": "p-best"}, f)
    with open(os.path.join(checkpoint_dir, "best_program_info.json"), "w", encoding="utf-8") as f:
        json.dump({"metrics": {"combined_score": 9.5}}, f)

    status = _run(srv.wild_v2_status())
    jobs = status.get("openevolve_jobs", [])
    target = next((j for j in jobs if j.get("id") == job_id), None)
    assert target is not None
    assert target.get("last_iteration") == 3
    assert target.get("best_program_id") == "p-best"
    assert target.get("best_score") == 9.5
