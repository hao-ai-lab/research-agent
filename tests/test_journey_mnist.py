"""
End-to-end test for the Research Journey feature.

Simulates MNIST training on CPU (mock metrics, no torch required), posts
metrics to the server, then exercises the full journey loop: events,
recommendations, decisions.

Prerequisites:
    - Server running at http://127.0.0.1:10000

Run:
    .ra-venv/bin/python tests/test_journey_mnist.py      # standalone
    .ra-venv/bin/python -m pytest tests/test_journey_mnist.py -v
"""

import math
import random
import time
import requests
import pytest

SERVER = "http://127.0.0.1:10000"
HEADERS = {"Content-Type": "application/json"}
EPOCHS = 3


def _server_available() -> bool:
    try:
        requests.get(f"{SERVER}/health", timeout=2)
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _server_available(),
    reason=f"Integration test requires server running at {SERVER}",
)


# ---------------------------------------------------------------------------
# Mock MNIST training (no torch needed)
# ---------------------------------------------------------------------------

def mock_mnist_training(epochs: int = EPOCHS) -> list[dict]:
    """Simulate a small MLP on MNIST. Returns realistic per-epoch metrics."""
    random.seed(42)
    train_loss = 0.45
    val_loss = 0.42
    train_acc = 0.87
    val_acc = 0.88

    all_metrics: list[dict] = []
    for epoch in range(1, epochs + 1):
        noise = random.gauss(0, 0.005)
        decay = math.exp(-0.35 * epoch)

        train_loss = max(0.01, train_loss * (0.55 + 0.1 * decay) + noise)
        val_loss = max(0.01, val_loss * (0.58 + 0.1 * decay) + noise * 1.2)
        train_acc = min(1.0, train_acc + (1 - train_acc) * 0.4 + noise * 0.5)
        val_acc = min(1.0, val_acc + (1 - val_acc) * 0.35 + noise * 0.5)

        metrics = {
            "step": epoch,
            "epoch": epoch,
            "train/loss": round(train_loss, 5),
            "train/acc": round(train_acc, 5),
            "val/loss": round(val_loss, 5),
            "val/acc": round(val_acc, 5),
        }
        all_metrics.append(metrics)
        time.sleep(0.2)
        print(f"  [mock] Epoch {epoch}/{epochs}  train_loss={train_loss:.4f}  val_acc={val_acc:.4f}")

    return all_metrics


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def api(method: str, path: str, json_body: dict | None = None) -> dict:
    url = f"{SERVER}{path}"
    resp = requests.request(method, url, json=json_body, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Main test
# ---------------------------------------------------------------------------

def test_journey_mnist_loop():
    # -- 1. Health check --
    status = api("GET", "/health")
    assert status.get("status") == "ok", f"Server not healthy: {status}"
    print("[OK] Server is healthy")

    # -- 2. Create a run --
    run = api("POST", "/runs", {
        "name": "MNIST Journey Test",
        "command": "python tests/test_journey_mnist.py",
    })
    run_id = run["id"]
    assert run_id, "Run creation returned no id"
    print(f"[OK] Created run {run_id}")

    # -- 3. Mark running --
    api("POST", f"/runs/{run_id}/status", {"status": "running"})
    print("[OK] Run status -> running")

    # -- 4. Train (mock) and post metrics --
    print("[..] Simulating MNIST training (CPU mock, 3 epochs)...")
    epoch_metrics = mock_mnist_training(EPOCHS)

    api("POST", f"/runs/{run_id}/metrics", {"rows": epoch_metrics})
    print(f"[OK] Posted {len(epoch_metrics)} metric rows")

    # -- 5. Mark completed --
    api("POST", f"/runs/{run_id}/status", {"status": "finished", "exit_code": 0})
    print("[OK] Run status -> finished")

    # -- 6. Post a journey observation event --
    final = epoch_metrics[-1]
    event = api("POST", "/journey/events", {
        "kind": "user_observation",
        "actor": "human",
        "run_id": run_id,
        "note": f"Val accuracy reached {final['val/acc']:.2%} after {EPOCHS} epochs",
        "metadata": {"val_acc": final["val/acc"], "val_loss": final["val/loss"]},
    })
    assert event.get("id"), "Journey event creation returned no id"
    print(f"[OK] Journey event: {event['id']}")

    # -- 7. Create a recommendation --
    rec = api("POST", "/journey/recommendations", {
        "title": "Try data augmentation to improve generalization",
        "action": "Add random rotation and horizontal flip to the MNIST training pipeline, then re-run for 5 epochs.",
        "rationale": f"Val accuracy ({final['val/acc']:.2%}) is close to train accuracy, but augmentation may push it higher.",
        "source": "agent",
        "priority": "medium",
        "confidence": 0.75,
        "run_id": run_id,
        "evidence_refs": [run_id],
    })
    rec_id = rec["id"]
    assert rec_id, "Recommendation creation returned no id"
    assert rec["status"] == "pending"
    print(f"[OK] Recommendation: {rec_id} (status=pending)")

    # -- 8. Accept the recommendation --
    updated_rec = api("POST", f"/journey/recommendations/{rec_id}/respond", {
        "status": "accepted",
        "user_note": "Good idea, will try augmentation next.",
    })
    assert updated_rec["status"] == "accepted"
    assert updated_rec["responded_at"] is not None
    print("[OK] Recommendation accepted")

    # -- 9. Record a decision --
    decision = api("POST", "/journey/decisions", {
        "title": "Add data augmentation to MNIST pipeline",
        "chosen_action": "Implement random rotation and re-train for 5 epochs on CPU.",
        "rationale": "Agent recommendation accepted; augmentation is low-cost and may improve robustness.",
        "status": "recorded",
        "recommendation_id": rec_id,
        "run_id": run_id,
    })
    dec_id = decision["id"]
    assert dec_id, "Decision creation returned no id"
    print(f"[OK] Decision: {dec_id}")

    # -- 10. Verify the journey loop --
    loop = api("GET", f"/journey/loop?run_id={run_id}")

    events = loop.get("events", [])
    recs = loop.get("recommendations", [])
    decisions = loop.get("decisions", [])
    summary = loop.get("summary", {})

    # Auto events: run_created, run_running, run_finished (3)
    # Manual events: user_observation, agent_recommendation_issued,
    #                user_accepted_recommendation, decision_recorded (4)
    # Total >= 7
    assert len(events) >= 7, f"Expected >=7 events, got {len(events)}: {[e['kind'] for e in events]}"
    assert len(recs) >= 1, f"Expected >=1 recommendation, got {len(recs)}"
    assert len(decisions) >= 1, f"Expected >=1 decision, got {len(decisions)}"
    assert summary.get("accepted_recommendations", 0) >= 1

    event_kinds = {e["kind"] for e in events}
    expected_kinds = {
        "run_created", "run_running", "run_finished",
        "user_observation", "agent_recommendation_issued",
        "user_accepted_recommendation", "decision_recorded",
    }
    missing = expected_kinds - event_kinds
    assert not missing, f"Missing event kinds: {missing}"

    print(f"[OK] Journey loop verified: {len(events)} events, {len(recs)} recs, {len(decisions)} decisions")
    print(f"     Event kinds: {sorted(event_kinds)}")
    print(f"     Summary: {summary}")

    # -- 11. Verify metrics were stored --
    metrics = api("GET", f"/runs/{run_id}/metrics")
    assert metrics, f"No metrics returned for run {run_id}"
    print(f"[OK] Metrics stored for run {run_id}")

    print("\n=== ALL CHECKS PASSED ===")


if __name__ == "__main__":
    test_journey_mnist_loop()
