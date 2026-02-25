"""Assertion evaluation for playbook steps."""

from __future__ import annotations

import json
import re
from typing import Any


def evaluate_assertion(assertion: dict[str, Any], step_result: dict[str, Any]) -> dict[str, Any]:
    assertion_id = assertion["id"]
    assertion_type = assertion["type"]
    expected = assertion.get("expected")

    evaluator = ASSERTION_EVALUATORS.get(assertion_type)
    if evaluator is None:
        return {
            "id": assertion_id,
            "type": assertion_type,
            "passed": False,
            "error": f"Unsupported assertion type `{assertion_type}`",
            "expected": expected,
            "actual": None,
        }

    passed, actual, error = evaluator(assertion, step_result)
    return {
        "id": assertion_id,
        "type": assertion_type,
        "passed": passed,
        "expected": expected,
        "actual": actual,
        "error": error,
        "message": assertion.get("message"),
    }


def _assistant_text(step_result: dict[str, Any]) -> str:
    value = step_result.get("assistant_text", "")
    return value if isinstance(value, str) else ""


def _tool_names(step_result: dict[str, Any]) -> list[str]:
    value = step_result.get("tool_names", [])
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def _events(step_result: dict[str, Any]) -> list[dict[str, Any]]:
    value = step_result.get("events", [])
    if isinstance(value, list):
        return [event for event in value if isinstance(event, dict)]
    return []


def _parse_json_from_response(text: str) -> tuple[dict[str, Any] | None, str | None]:
    stripped = text.strip()
    if not stripped:
        return None, "Assistant response is empty"

    for candidate in _json_candidates(stripped):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed, None

    return None, "Unable to parse a JSON object from assistant response"


def _json_candidates(text: str) -> list[str]:
    candidates = [text]

    fenced_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text, flags=re.IGNORECASE)
    if fenced_match:
        candidates.append(fenced_match.group(1))

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidates.append(text[start : end + 1])

    return candidates


def _json_get_field(data: dict[str, Any], path: str) -> Any:
    current: Any = data
    for segment in path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return None
        current = current[segment]
    return current


def _assert_assistant_contains(assertion: dict[str, Any], step_result: dict[str, Any]) -> tuple[bool, Any, str | None]:
    expected = str(assertion.get("expected", ""))
    text = _assistant_text(step_result)
    return expected in text, text, None


def _assert_assistant_not_contains(
    assertion: dict[str, Any],
    step_result: dict[str, Any],
) -> tuple[bool, Any, str | None]:
    expected = str(assertion.get("expected", ""))
    text = _assistant_text(step_result)
    return expected not in text, text, None


def _assert_assistant_regex(assertion: dict[str, Any], step_result: dict[str, Any]) -> tuple[bool, Any, str | None]:
    pattern = assertion.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        return False, None, "Missing required `pattern`"

    flags = 0
    for flag in str(assertion.get("flags", "")):
        if flag == "i":
            flags |= re.IGNORECASE
        elif flag == "m":
            flags |= re.MULTILINE
        elif flag == "s":
            flags |= re.DOTALL

    text = _assistant_text(step_result)
    matched = re.search(pattern, text, flags=flags) is not None
    should_match = bool(assertion.get("should_match", True))
    return matched is should_match, text, None


def _assert_response_is_json(assertion: dict[str, Any], step_result: dict[str, Any]) -> tuple[bool, Any, str | None]:
    parsed, error = _parse_json_from_response(_assistant_text(step_result))
    if parsed is None:
        return False, None, error

    required_fields = assertion.get("required_fields", [])
    if isinstance(required_fields, list):
        for field in required_fields:
            if _json_get_field(parsed, str(field)) is None:
                return False, parsed, f"Missing required field `{field}`"

    return True, parsed, None


def _assert_response_json_field_equals(
    assertion: dict[str, Any],
    step_result: dict[str, Any],
) -> tuple[bool, Any, str | None]:
    field = assertion.get("field")
    if not isinstance(field, str) or not field:
        return False, None, "Missing required `field`"

    parsed, error = _parse_json_from_response(_assistant_text(step_result))
    if parsed is None:
        return False, None, error

    actual_value = _json_get_field(parsed, field)
    return actual_value == assertion.get("expected"), actual_value, None


def _assert_tool_name_contains(assertion: dict[str, Any], step_result: dict[str, Any]) -> tuple[bool, Any, str | None]:
    expected = str(assertion.get("expected", ""))
    tools = _tool_names(step_result)
    return any(expected in tool for tool in tools), tools, None


def _assert_tool_name_not_contains(
    assertion: dict[str, Any],
    step_result: dict[str, Any],
) -> tuple[bool, Any, str | None]:
    expected = str(assertion.get("expected", ""))
    tools = _tool_names(step_result)
    return all(expected not in tool for tool in tools), tools, None


def _assert_first_token_latency(
    assertion: dict[str, Any],
    step_result: dict[str, Any],
) -> tuple[bool, Any, str | None]:
    max_ms = assertion.get("expected")
    if not isinstance(max_ms, (int, float)):
        return False, None, "`expected` must be numeric milliseconds"

    latency_ms = step_result.get("first_token_latency_ms")
    if not isinstance(latency_ms, (int, float)):
        return False, latency_ms, "No first token latency recorded"

    return latency_ms < float(max_ms), latency_ms, None


def _assert_total_latency(assertion: dict[str, Any], step_result: dict[str, Any]) -> tuple[bool, Any, str | None]:
    max_ms = assertion.get("expected")
    if not isinstance(max_ms, (int, float)):
        return False, None, "`expected` must be numeric milliseconds"

    latency_ms = step_result.get("total_latency_ms")
    if not isinstance(latency_ms, (int, float)):
        return False, latency_ms, "No total latency recorded"

    return latency_ms < float(max_ms), latency_ms, None


def _assert_event_type_seen(assertion: dict[str, Any], step_result: dict[str, Any]) -> tuple[bool, Any, str | None]:
    expected = str(assertion.get("expected", "")).strip()
    if not expected:
        return False, None, "Missing required `expected` event type"
    events = _events(step_result)
    seen = any(event.get("type") == expected for event in events)
    return seen, [event.get("type") for event in events], None


def _assert_event_type_not_seen(
    assertion: dict[str, Any],
    step_result: dict[str, Any],
) -> tuple[bool, Any, str | None]:
    expected = str(assertion.get("expected", "")).strip()
    if not expected:
        return False, None, "Missing required `expected` event type"
    events = _events(step_result)
    seen = any(event.get("type") == expected for event in events)
    return not seen, [event.get("type") for event in events], None


ASSERTION_EVALUATORS = {
    "assistant_contains": _assert_assistant_contains,
    "assistant_not_contains": _assert_assistant_not_contains,
    "assistant_regex": _assert_assistant_regex,
    "response_is_json": _assert_response_is_json,
    "response_json_field_equals": _assert_response_json_field_equals,
    "tool_name_contains": _assert_tool_name_contains,
    "tool_name_not_contains": _assert_tool_name_not_contains,
    "first_token_latency_lt_ms": _assert_first_token_latency,
    "total_latency_lt_ms": _assert_total_latency,
    "event_type_seen": _assert_event_type_seen,
    "event_type_not_seen": _assert_event_type_not_seen,
}
