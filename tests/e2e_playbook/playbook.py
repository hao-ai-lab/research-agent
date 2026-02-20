"""Playbook loading and validation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


SUPPORTED_ASSERTION_TYPES = {
    "assistant_contains",
    "assistant_not_contains",
    "assistant_regex",
    "response_is_json",
    "response_json_field_equals",
    "tool_name_contains",
    "tool_name_not_contains",
    "first_token_latency_lt_ms",
    "total_latency_lt_ms",
    "event_type_seen",
    "event_type_not_seen",
}


def load_playbook(path: str | Path) -> dict[str, Any]:
    playbook_path = Path(path).expanduser().resolve()
    with playbook_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    validate_playbook(data, source=str(playbook_path))
    return data


def validate_playbook(data: dict[str, Any], *, source: str = "<memory>") -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{source}: playbook root must be an object")

    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError(f"{source}: playbook must include non-empty string `name`")

    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError(f"{source}: playbook must include non-empty list `steps`")

    assertion_ids: set[str] = set()
    for step_index, step in enumerate(steps):
        _validate_step(step, step_index=step_index, source=source, assertion_ids=assertion_ids)

    evaluation_points = data.get("evaluation_points", [])
    if evaluation_points is None:
        evaluation_points = []
    if not isinstance(evaluation_points, list):
        raise ValueError(f"{source}: `evaluation_points` must be a list if provided")

    for point in evaluation_points:
        if not isinstance(point, dict):
            raise ValueError(f"{source}: each evaluation point must be an object")
        point_id = point.get("id")
        if not isinstance(point_id, str) or not point_id.strip():
            raise ValueError(f"{source}: evaluation point missing non-empty `id`")
        assertion_refs = point.get("assertion_ids")
        if not isinstance(assertion_refs, list) or not assertion_refs:
            raise ValueError(f"{source}: evaluation point `{point_id}` needs non-empty `assertion_ids`")
        for assertion_id in assertion_refs:
            if assertion_id not in assertion_ids:
                raise ValueError(
                    f"{source}: evaluation point `{point_id}` references unknown assertion `{assertion_id}`"
                )


def _validate_step(
    step: dict[str, Any],
    *,
    step_index: int,
    source: str,
    assertion_ids: set[str],
) -> None:
    if not isinstance(step, dict):
        raise ValueError(f"{source}: step index {step_index} must be an object")

    step_id = step.get("id")
    if not isinstance(step_id, str) or not step_id.strip():
        raise ValueError(f"{source}: step index {step_index} missing non-empty `id`")

    message = step.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ValueError(f"{source}: step `{step_id}` missing non-empty `message`")

    assertions = step.get("assertions")
    if not isinstance(assertions, list) or not assertions:
        raise ValueError(f"{source}: step `{step_id}` must include non-empty list `assertions`")

    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise ValueError(f"{source}: step `{step_id}` has non-object assertion")
        assertion_id = assertion.get("id")
        if not isinstance(assertion_id, str) or not assertion_id.strip():
            raise ValueError(f"{source}: step `{step_id}` has assertion missing non-empty `id`")
        if assertion_id in assertion_ids:
            raise ValueError(f"{source}: duplicate assertion id `{assertion_id}`")
        assertion_ids.add(assertion_id)

        assertion_type = assertion.get("type")
        if assertion_type not in SUPPORTED_ASSERTION_TYPES:
            supported = ", ".join(sorted(SUPPORTED_ASSERTION_TYPES))
            raise ValueError(
                f"{source}: step `{step_id}` assertion `{assertion_id}` has unsupported type "
                f"`{assertion_type}` (supported: {supported})"
            )

