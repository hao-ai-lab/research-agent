#!/usr/bin/env python3
"""Playground: validate OpenCode event parsing + parts accumulation behavior."""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from server.server import StreamPartsAccumulator, parse_opencode_event  # noqa: E402

TARGET_SESSION_ID = "ses_test_123"
OTHER_SESSION_ID = "ses_other_456"


def make_event(etype: str, properties: dict) -> dict:
    return {
        "payload": {
            "type": etype,
            "properties": properties,
        }
    }


def stream_components(translated: dict) -> tuple[str, str, dict | None]:
    ptype = translated.get("ptype")
    if ptype == "text":
        return translated.get("delta", ""), "", None
    if ptype == "reasoning":
        return "", translated.get("delta", ""), None
    if ptype == "tool":
        return "", "", translated
    return "", "", None


def run_demo() -> None:
    raw_events = [
        # Not our session; must be ignored.
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "foreign-1",
                    "sessionID": OTHER_SESSION_ID,
                    "type": "reasoning",
                },
                "delta": "ignore me",
            },
        ),
        # OpenCode can emit a text part update without delta (often from prompt echo).
        # This must not create an empty text part.
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "user-echo",
                    "sessionID": TARGET_SESSION_ID,
                    "type": "text",
                    "text": "[USER] run tools",
                }
            },
        ),
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "reasoning-1",
                    "sessionID": TARGET_SESSION_ID,
                    "type": "reasoning",
                },
                "delta": "Need to inspect. ",
            },
        ),
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "tool-1",
                    "sessionID": TARGET_SESSION_ID,
                    "type": "tool",
                    "tool": "bash",
                    "state": {"status": "pending", "input": {}},
                }
            },
        ),
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "tool-1",
                    "sessionID": TARGET_SESSION_ID,
                    "type": "tool",
                    "tool": "bash",
                    "state": {
                        "status": "completed",
                        "input": {"command": "pwd", "description": "Get cwd"},
                        "output": "/tmp\n",
                    },
                }
            },
        ),
        # Same reasoning ID as before tool. We should split into a new part because
        # a type transition happened and the previous reasoning segment was flushed.
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "reasoning-1",
                    "sessionID": TARGET_SESSION_ID,
                    "type": "reasoning",
                },
                "delta": "Tool finished. ",
            },
        ),
        make_event(
            "message.part.updated",
            {
                "part": {
                    "id": "text-1",
                    "sessionID": TARGET_SESSION_ID,
                    "type": "text",
                },
                "delta": "Summary ready.",
            },
        ),
        make_event(
            "session.status",
            {
                "sessionID": TARGET_SESSION_ID,
                "status": {"type": "idle"},
            },
        ),
    ]

    translated_events: list[dict] = []
    full_text = ""
    full_thinking = ""
    accumulator = StreamPartsAccumulator()

    for raw in raw_events:
        translated = parse_opencode_event(raw, TARGET_SESSION_ID)
        if translated is None:
            continue

        translated_events.append(translated)
        text_delta, thinking_delta, _tool_update = stream_components(translated)
        full_text += text_delta
        full_thinking += thinking_delta
        accumulator.consume(translated)

    parts = accumulator.finalize()

    assert full_text == "Summary ready.", full_text
    assert full_thinking == "Need to inspect. Tool finished. ", full_thinking

    assert len(parts) == 4, parts
    assert parts[0]["type"] == "thinking" and parts[0]["content"] == "Need to inspect. "
    assert parts[1]["type"] == "tool"
    assert parts[1]["tool_name"] == "bash"
    assert parts[1]["tool_state"] == "completed"
    assert parts[1]["tool_state_raw"]["status"] == "completed"
    assert parts[1]["tool_output"] == "/tmp\n"
    assert parts[2]["type"] == "thinking" and parts[2]["content"] == "Tool finished. "
    assert parts[3]["type"] == "text" and parts[3]["content"] == "Summary ready."

    assert all(not (p["type"] in ("thinking", "text") and p["content"] == "") for p in parts)

    print("Translated events:", len(translated_events))
    print("Full thinking:", full_thinking)
    print("Full text:", full_text)
    print("Parts order:", [p["type"] for p in parts])
    print("OK: parser + transition-aware accumulation behave as expected")


if __name__ == "__main__":
    run_demo()
