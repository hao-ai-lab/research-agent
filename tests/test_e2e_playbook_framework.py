"""Unit tests for playbook framework components."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from e2e_playbook.assertions import evaluate_assertion
from e2e_playbook.playbook import validate_playbook
from e2e_playbook.runner import _score_evaluation_points


def test_validate_playbook_accepts_minimal_valid_shape():
    playbook = {
        "name": "minimal",
        "steps": [
            {
                "id": "s1",
                "message": "hello",
                "assertions": [
                    {"id": "a1", "type": "assistant_contains", "expected": "world"},
                ],
            }
        ],
        "evaluation_points": [
            {"id": "p1", "assertion_ids": ["a1"], "max_score": 10, "pass_threshold": 1.0}
        ],
    }

    validate_playbook(playbook)


def test_evaluate_assertion_json_field_equals():
    assertion = {
        "id": "a-json",
        "type": "response_json_field_equals",
        "field": "token",
        "expected": "ALPHA-1",
    }
    step_result = {"assistant_text": "{\"token\":\"ALPHA-1\"}"}
    result = evaluate_assertion(assertion, step_result)
    assert result["passed"] is True


def test_evaluate_assertion_regex_failure():
    assertion = {
        "id": "a-rx",
        "type": "assistant_regex",
        "pattern": "^READY$",
    }
    step_result = {"assistant_text": "READY NOW"}
    result = evaluate_assertion(assertion, step_result)
    assert result["passed"] is False


def test_score_evaluation_points_handles_partial_pass():
    playbook = {
        "evaluation_points": [
            {
                "id": "quality",
                "assertion_ids": ["a1", "a2"],
                "max_score": 100,
                "pass_threshold": 0.5,
            }
        ]
    }
    assertion_results_by_id = {
        "a1": {"id": "a1", "passed": True},
        "a2": {"id": "a2", "passed": False},
    }

    scored = _score_evaluation_points(
        playbook=playbook,
        assertion_results_by_id=assertion_results_by_id,
    )
    assert scored[0]["score"] == pytest.approx(50.0)
    assert scored[0]["passed"] is True
