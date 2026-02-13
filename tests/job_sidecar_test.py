"""Unit tests for sidecar alert mode/timeout behavior."""

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))

import job_sidecar as js


def test_apply_alert_decision_advisory_does_not_wait():
    decision = {
        "action": "alert",
        "mode": "advisory",
        "message": "Something looks off",
        "choices": ["Ignore", "Stop Job"],
        "severity": "warning",
        "source": "alert_judge",
    }

    with patch.object(js, "trigger_alert", return_value="alert-1") as trigger_mock, patch.object(
        js, "wait_for_response", return_value="Stop Job"
    ) as wait_mock:
        should_stop = js.apply_alert_decision(
            server_url="http://localhost:10000",
            job_id="run-1",
            run_dir="/tmp",
            decision=decision,
            human_wait_timeout_seconds=5,
        )

    assert should_stop is False
    assert trigger_mock.called
    assert not wait_mock.called


def test_apply_alert_decision_blocking_stop_choice():
    decision = {
        "action": "alert",
        "mode": "blocking",
        "message": "Hard failure",
        "choices": ["Ignore", "Stop Job"],
        "severity": "critical",
        "source": "rulebased",
    }

    with patch.object(js, "trigger_alert", return_value="alert-2"), patch.object(
        js, "wait_for_response", return_value="Stop Job"
    ) as wait_mock:
        should_stop = js.apply_alert_decision(
            server_url="http://localhost:10000",
            job_id="run-2",
            run_dir="/tmp",
            decision=decision,
            human_wait_timeout_seconds=7,
        )

    assert should_stop is True
    wait_mock.assert_called_once()


def test_apply_alert_decision_blocking_timeout_safe_stop():
    decision = {
        "action": "alert",
        "mode": "blocking",
        "message": "Need human",
        "choices": ["Ignore", "Stop Job"],
        "severity": "warning",
        "source": "rulebased",
    }

    with patch.object(js, "trigger_alert", return_value="alert-3"), patch.object(
        js, "wait_for_response", return_value=None
    ):
        should_stop = js.apply_alert_decision(
            server_url="http://localhost:10000",
            job_id="run-3",
            run_dir="/tmp",
            decision=decision,
            human_wait_timeout_seconds=2,
        )

    assert should_stop is True


def test_apply_alert_decision_ignore_choice_keeps_running():
    decision = {
        "action": "alert",
        "mode": "blocking",
        "message": "Need review",
        "choices": ["Ignore", "Stop Job"],
        "severity": "warning",
        "source": "rulebased",
    }

    with patch.object(js, "trigger_alert", return_value="alert-4"), patch.object(
        js, "wait_for_response", return_value="Ignore"
    ):
        should_stop = js.apply_alert_decision(
            server_url="http://localhost:10000",
            job_id="run-4",
            run_dir="/tmp",
            decision=decision,
            human_wait_timeout_seconds=2,
        )

    assert should_stop is False
