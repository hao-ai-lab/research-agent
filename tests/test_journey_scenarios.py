"""
Backend integration tests for Research Journey edge cases and advanced flows.

Covers:
    1. Multi-run chains with parent_run_id  (hierarchical ordering)
    2. Failed runs and error propagation     (costly path detection)
    3. Chat session -> run linking           (cross-entity provenance)
    4. Full recommendation lifecycle         (reject / modify / dismiss)

Prerequisites:
    - Server running at http://127.0.0.1:10000

Run:
    .ra-venv/bin/python tests/test_journey_scenarios.py
    .ra-venv/bin/python -m pytest tests/test_journey_scenarios.py -v
"""

import time
import requests

SERVER = "http://127.0.0.1:10000"
HEADERS = {"Content-Type": "application/json"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def api(method: str, path: str, json_body: dict | None = None) -> dict:
    url = f"{SERVER}{path}"
    resp = requests.request(method, url, json=json_body, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def create_run(name: str, **kwargs) -> dict:
    return api("POST", "/runs", {"name": name, "command": f"echo {name}", **kwargs})


def set_status(run_id: str, status: str, **kwargs) -> dict:
    return api("POST", f"/runs/{run_id}/status", {"status": status, **kwargs})


def journey_loop(**params) -> dict:
    qs = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    return api("GET", f"/journey/loop{'?' + qs if qs else ''}")


def event_kinds_for(events: list[dict]) -> set[str]:
    return {e["kind"] for e in events}


# ===================================================================
# 1. Multi-run chain with parent links
# ===================================================================

def test_multi_run_chain():
    """
    Create A -> B -> C with parent_run_id links.
    Verify the server preserves parentage and emits journey events for all.
    """
    print("\n--- test_multi_run_chain ---")

    run_a = create_run("chain-root-v1")
    set_status(run_a["id"], "running")
    time.sleep(0.05)
    set_status(run_a["id"], "finished", exit_code=0)
    print(f"  [OK] Run A: {run_a['id']} (completed)")

    run_b = create_run("chain-child-v2", parent_run_id=run_a["id"])
    set_status(run_b["id"], "running")
    time.sleep(0.05)
    set_status(run_b["id"], "finished", exit_code=0)
    print(f"  [OK] Run B: {run_b['id']} -> parent={run_a['id']} (completed)")

    run_c = create_run("chain-grandchild-v3", parent_run_id=run_b["id"])
    set_status(run_c["id"], "running")
    time.sleep(0.05)
    set_status(run_c["id"], "finished", exit_code=0)
    print(f"  [OK] Run C: {run_c['id']} -> parent={run_b['id']} (completed)")

    # Verify parent_run_id is preserved on the run objects
    fetched_b = api("GET", f"/runs/{run_b['id']}")
    fetched_c = api("GET", f"/runs/{run_c['id']}")
    assert fetched_b.get("parent_run_id") == run_a["id"], \
        f"Run B parent_run_id: expected {run_a['id']}, got {fetched_b.get('parent_run_id')}"
    assert fetched_c.get("parent_run_id") == run_b["id"], \
        f"Run C parent_run_id: expected {run_b['id']}, got {fetched_c.get('parent_run_id')}"
    print("  [OK] Parent links preserved on run objects")

    # Verify journey events exist for each run in the chain
    for label, run in [("A", run_a), ("B", run_b), ("C", run_c)]:
        loop = journey_loop(run_id=run["id"])
        kinds = event_kinds_for(loop["events"])
        assert "run_created" in kinds, f"Run {label} missing run_created event"
        assert "run_running" in kinds, f"Run {label} missing run_running event"
        assert "run_finished" in kinds, f"Run {label} missing run_finished event"
    print("  [OK] Journey events present for all 3 runs in chain")

    # Verify the chain forms a proper lineage when queried together
    all_run_ids = {run_a["id"], run_b["id"], run_c["id"]}
    loop_all = journey_loop()
    chain_events = [e for e in loop_all["events"] if e.get("run_id") in all_run_ids]
    chain_created = [e for e in chain_events if e["kind"] == "run_created"]
    assert len(chain_created) >= 3, f"Expected 3 run_created events, got {len(chain_created)}"
    print(f"  [OK] Full chain visible in global journey loop ({len(chain_events)} events)")

    print("  === test_multi_run_chain PASSED ===")


# ===================================================================
# 2. Failed runs and error propagation
# ===================================================================

def test_failed_run_journey():
    """
    Create a run, start it, then fail it with an error and non-zero exit code.
    Verify journey captures run_failed with error metadata.
    """
    print("\n--- test_failed_run_journey ---")

    run = create_run("experiment-oom-crash")
    run_id = run["id"]
    set_status(run_id, "running")
    print(f"  [OK] Run {run_id} -> running")

    time.sleep(0.1)

    set_status(run_id, "finished", exit_code=137, error="OOM killed by system")
    print(f"  [OK] Run {run_id} -> failed (exit_code=137)")

    # Server should coerce "finished" with non-zero exit to "failed"
    fetched = api("GET", f"/runs/{run_id}")
    assert fetched["status"] == "failed", f"Expected status=failed, got {fetched['status']}"
    assert fetched.get("exit_code") == 137, f"Expected exit_code=137, got {fetched.get('exit_code')}"
    assert fetched.get("error") == "OOM killed by system"
    print("  [OK] Run status correctly set to failed with error details")

    loop = journey_loop(run_id=run_id)
    events = loop["events"]
    kinds = event_kinds_for(events)

    assert "run_created" in kinds, "Missing run_created event"
    assert "run_running" in kinds, "Missing run_running event"
    assert "run_failed" in kinds, "Missing run_failed event"
    assert "run_finished" not in kinds, "Should have run_failed, not run_finished"

    failed_event = next(e for e in events if e["kind"] == "run_failed")
    meta = failed_event.get("metadata", {})
    assert meta.get("exit_code") == 137, f"Failed event missing exit_code: {meta}"
    assert meta.get("error") == "OOM killed by system", f"Failed event missing error: {meta}"
    print(f"  [OK] run_failed event has correct metadata: exit_code=137, error present")

    # Verify timestamps make sense (ended_at > started_at)
    assert fetched.get("started_at") is not None, "started_at should be set"
    assert fetched.get("ended_at") is not None, "ended_at should be set"
    assert fetched["ended_at"] >= fetched["started_at"], "ended_at should be >= started_at"
    print("  [OK] Timestamps consistent (ended_at >= started_at)")

    print("  === test_failed_run_journey PASSED ===")


# ===================================================================
# 3. Chat session -> run linking
# ===================================================================

def test_chat_session_run_link():
    """
    Create a chat session, then create a run linked to it via chat_session_id.
    Verify journey events carry the session_id and can be filtered by it.
    """
    print("\n--- test_chat_session_run_link ---")

    session = api("POST", "/sessions", {"title": "MNIST hypothesis brainstorm"})
    session_id = session["id"]
    assert session_id, "Session creation returned no id"
    print(f"  [OK] Created session: {session_id} ({session.get('title')})")

    run = create_run("mnist-from-chat", chat_session_id=session_id)
    run_id = run["id"]
    print(f"  [OK] Created run {run_id} linked to session {session_id}")

    set_status(run_id, "running")
    time.sleep(0.05)
    set_status(run_id, "finished", exit_code=0)
    print(f"  [OK] Run {run_id} -> finished")

    # Verify run carries chat_session_id
    fetched = api("GET", f"/runs/{run_id}")
    assert fetched.get("chat_session_id") == session_id, \
        f"Expected chat_session_id={session_id}, got {fetched.get('chat_session_id')}"
    print("  [OK] Run object has correct chat_session_id")

    # Filter journey by run_id -- events should also carry session_id
    loop_by_run = journey_loop(run_id=run_id)
    for event in loop_by_run["events"]:
        assert event.get("session_id") == session_id, \
            f"Event {event['kind']} missing session_id: {event.get('session_id')}"
    print(f"  [OK] All {len(loop_by_run['events'])} run events carry session_id={session_id}")

    # Filter journey by session_id -- should find the same run events
    loop_by_session = journey_loop(session_id=session_id)
    session_event_kinds = event_kinds_for(loop_by_session["events"])
    assert "run_created" in session_event_kinds, "Filtering by session_id should show run_created"
    assert "run_finished" in session_event_kinds, "Filtering by session_id should show run_finished"
    print(f"  [OK] Journey filtered by session_id returns run events ({len(loop_by_session['events'])} events)")

    # Post a recommendation linked to this session
    rec = api("POST", "/journey/recommendations", {
        "title": "Try larger hidden layer for MNIST",
        "action": "Increase hidden dim from 128 to 256 and re-run.",
        "source": "agent",
        "priority": "low",
        "session_id": session_id,
        "run_id": run_id,
    })
    loop_check = journey_loop(session_id=session_id)
    rec_ids = {r["id"] for r in loop_check["recommendations"]}
    assert rec["id"] in rec_ids, "Recommendation not found when filtering by session_id"
    print(f"  [OK] Recommendation visible under session filter")

    print("  === test_chat_session_run_link PASSED ===")


# ===================================================================
# 4. Recommendation lifecycle (reject, modify, dismiss)
# ===================================================================

def test_recommendation_lifecycle():
    """
    Create 4 recommendations, then: accept one, reject one, modify one, dismiss one.
    Verify each generates distinct event kinds and summary stats are correct.
    """
    print("\n--- test_recommendation_lifecycle ---")

    run = create_run("lifecycle-test-run")
    run_id = run["id"]

    scenarios = [
        {
            "title": "Rec A: increase learning rate",
            "action": "Set lr=0.01 instead of 0.001.",
            "respond_status": "accepted",
            "user_note": "Will try this.",
        },
        {
            "title": "Rec B: switch to SGD optimizer",
            "action": "Replace Adam with SGD + momentum.",
            "respond_status": "rejected",
            "user_note": "Adam works fine for this scale.",
        },
        {
            "title": "Rec C: add dropout regularization",
            "action": "Add dropout(0.3) after each hidden layer.",
            "respond_status": "modified",
            "user_note": "Will use dropout(0.1) instead -- 0.3 is too aggressive.",
            "modified_action": "Add dropout(0.1) after each hidden layer.",
        },
        {
            "title": "Rec D: try batch normalization",
            "action": "Add batchnorm before ReLU in each layer.",
            "respond_status": "dismissed",
            "user_note": "Out of scope for this experiment.",
        },
    ]

    rec_ids = []
    for s in scenarios:
        rec = api("POST", "/journey/recommendations", {
            "title": s["title"],
            "action": s["action"],
            "source": "agent",
            "priority": "medium",
            "run_id": run_id,
        })
        assert rec["status"] == "pending"
        rec_ids.append(rec["id"])
        print(f"  [OK] Created: {rec['id']} - {s['title']}")

    # Respond to each
    for rec_id, s in zip(rec_ids, scenarios):
        body: dict = {"status": s["respond_status"]}
        if s.get("user_note"):
            body["user_note"] = s["user_note"]
        if s.get("modified_action"):
            body["modified_action"] = s["modified_action"]

        updated = api("POST", f"/journey/recommendations/{rec_id}/respond", body)
        assert updated["status"] == s["respond_status"], \
            f"Expected status={s['respond_status']}, got {updated['status']}"
        assert updated["responded_at"] is not None
        if s.get("modified_action"):
            assert updated["modified_action"] == s["modified_action"]
        print(f"  [OK] {rec_id} -> {s['respond_status']}")

    # Verify journey events contain all the expected response kinds
    loop = journey_loop(run_id=run_id)
    kinds = event_kinds_for(loop["events"])

    expected_response_kinds = {
        "user_accepted_recommendation",
        "user_rejected_recommendation",
        "user_modified_recommendation",
        "recommendation_dismissed",
    }
    missing = expected_response_kinds - kinds
    assert not missing, f"Missing recommendation response event kinds: {missing}"
    print(f"  [OK] All 4 response event kinds present")

    # Verify summary stats
    summary = loop["summary"]
    assert summary["recommendations"] >= 4, f"Expected >=4 recs, got {summary['recommendations']}"
    assert summary["accepted_recommendations"] >= 1
    assert summary["rejected_recommendations"] >= 1
    print(f"  [OK] Summary: {summary['recommendations']} recs, "
          f"{summary['accepted_recommendations']} accepted, "
          f"{summary['rejected_recommendations']} rejected")

    # Verify the modified recommendation preserved the modified_action
    recs_list = api("GET", f"/journey/recommendations?run_id={run_id}")
    modified_recs = [r for r in recs_list if r["status"] == "modified"]
    assert len(modified_recs) >= 1, "No modified recommendation found"
    assert modified_recs[0]["modified_action"] == "Add dropout(0.1) after each hidden layer."
    print(f"  [OK] Modified recommendation has correct modified_action")

    # Verify acceptance_rate: 1 accepted out of 4 = 0.25
    # (but there may be recs from other tests, so just check it's > 0)
    assert summary.get("acceptance_rate", 0) > 0, "acceptance_rate should be > 0"
    print(f"  [OK] acceptance_rate = {summary['acceptance_rate']:.2f}")

    print("  === test_recommendation_lifecycle PASSED ===")


# ===================================================================
# Runner
# ===================================================================

ALL_TESTS = [
    test_multi_run_chain,
    test_failed_run_journey,
    test_chat_session_run_link,
    test_recommendation_lifecycle,
]


def main():
    status = api("GET", "/health")
    assert status.get("status") == "ok", f"Server not healthy: {status}"
    print(f"[OK] Server healthy at {SERVER}")

    passed, failed = 0, 0
    for test_fn in ALL_TESTS:
        try:
            test_fn()
            passed += 1
        except Exception as exc:
            failed += 1
            print(f"  !!! FAILED: {exc}")

    print(f"\n{'=' * 40}")
    print(f"Results: {passed} passed, {failed} failed out of {len(ALL_TESTS)} tests")
    if failed:
        raise SystemExit(1)
    print("=== ALL JOURNEY SCENARIO TESTS PASSED ===")


if __name__ == "__main__":
    main()
