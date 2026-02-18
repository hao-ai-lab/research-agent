"""OpenCode streaming helpers extracted from server.py."""

import asyncio
import json
import time
import uuid
import logging
from typing import Any, AsyncIterator, Dict, Optional

logger = logging.getLogger("research-agent-server")


# ---------------------------------------------------------------------------
# Tool helpers
# ---------------------------------------------------------------------------

def _extract_tool_name(part: dict) -> Optional[str]:
    """Best-effort extraction for tool part names across OpenCode versions."""
    state = part.get("state") if isinstance(part, dict) else {}
    if not isinstance(state, dict):
        state = {}
    state_input = state.get("input")
    if not isinstance(state_input, dict):
        state_input = {}

    for candidate in (
        part.get("name"),
        part.get("tool"),
        state.get("title"),
        state_input.get("description"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _coerce_tool_text(value: Any) -> Optional[str]:
    """Convert tool input/output payloads to readable text."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


def _extract_tool_data(part: dict) -> dict[str, Any]:
    """Extract normalized tool fields used for streaming and persistence."""
    state = part.get("state")
    if not isinstance(state, dict):
        state = {}

    state_input = state.get("input")
    if not isinstance(state_input, dict):
        state_input = {}

    metadata = state.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    time_data = state.get("time")
    if not isinstance(time_data, dict):
        time_data = {}

    status = state.get("status")
    if not isinstance(status, str):
        status = None

    tool_input = _coerce_tool_text(state_input) if state_input else None
    output_value = state.get("output")
    if output_value is None:
        output_value = metadata.get("output")
    tool_output = _coerce_tool_text(output_value)

    started_at = time_data.get("start") if isinstance(time_data.get("start"), (int, float)) else None
    ended_at = time_data.get("end") if isinstance(time_data.get("end"), (int, float)) else None
    duration_ms = None
    if isinstance(started_at, (int, float)) and isinstance(ended_at, (int, float)) and ended_at >= started_at:
        duration_ms = int(ended_at - started_at)

    return {
        "tool_status": status,
        "tool_input": tool_input,
        "tool_output": tool_output,
        "tool_started_at": started_at,
        "tool_ended_at": ended_at,
        "tool_duration_ms": duration_ms,
    }


# ---------------------------------------------------------------------------
# StreamPartsAccumulator
# ---------------------------------------------------------------------------

class StreamPartsAccumulator:
    """
    Collect ordered message parts while preserving type transitions.

    Text/reasoning are buffered and flushed whenever we switch type/part ID or
    encounter a tool event. Tool parts are keyed by ID so state updates amend
    the original tool part.
    """

    def __init__(self):
        self._parts: list[dict[str, Any]] = []
        self._text_buffer: Optional[dict[str, Any]] = None
        self._tool_index_by_id: dict[str, int] = {}
        self._text_segment_counts: dict[str, int] = {}

    def consume(self, event: dict):
        ptype = event.get("ptype")
        if ptype in ("text", "reasoning"):
            self._consume_text_or_reasoning(event)
            return
        if ptype == "tool":
            self._flush_text_buffer()
            self._consume_tool_update(event)
            return
        if event.get("type") == "session_status":
            self._flush_text_buffer()

    def snapshot(self) -> list[dict[str, Any]]:
        parts = list(self._parts)
        if self._text_buffer and self._text_buffer.get("content"):
            parts.append({k: v for k, v in self._text_buffer.items() if k != "source_id"})
        return parts

    def finalize(self) -> list[dict[str, Any]]:
        self._flush_text_buffer()
        return list(self._parts)

    def _consume_text_or_reasoning(self, event: dict):
        delta = event.get("delta")
        if not isinstance(delta, str) or delta == "":
            return

        part_id = event.get("id")
        part_type = "thinking" if event.get("ptype") == "reasoning" else "text"
        if self._text_buffer and self._text_buffer.get("source_id") == part_id and self._text_buffer.get("type") == part_type:
            self._text_buffer["content"] += delta
            return

        self._flush_text_buffer()
        base_id = part_id if isinstance(part_id, str) and part_id else f"part_{uuid.uuid4().hex[:12]}"
        segment_index = self._text_segment_counts.get(base_id, 0)
        self._text_segment_counts[base_id] = segment_index + 1
        stored_id = base_id if segment_index == 0 else f"{base_id}#{segment_index}"
        self._text_buffer = {
            "id": stored_id,
            "source_id": base_id,
            "type": part_type,
            "content": delta,
        }

    def _consume_tool_update(self, event: dict):
        part_id = event.get("id")
        if not isinstance(part_id, str) or not part_id:
            return

        existing_index = self._tool_index_by_id.get(part_id)
        tool_name = event.get("name")
        if existing_index is None:
            self._parts.append(
                {
                    "id": part_id,
                    "type": "tool",
                    "content": "",
                    "tool_name": tool_name,
                    "tool_state": event.get("tool_status"),
                    "tool_state_raw": event.get("state"),
                    "tool_input": event.get("tool_input"),
                    "tool_output": event.get("tool_output"),
                    "tool_started_at": event.get("tool_started_at"),
                    "tool_ended_at": event.get("tool_ended_at"),
                    "tool_duration_ms": event.get("tool_duration_ms"),
                }
            )
            self._tool_index_by_id[part_id] = len(self._parts) - 1
            return

        existing_part = self._parts[existing_index]
        existing_part["tool_state"] = event.get("tool_status")
        existing_part["tool_state_raw"] = event.get("state")
        existing_part["tool_input"] = event.get("tool_input")
        existing_part["tool_output"] = event.get("tool_output")
        existing_part["tool_started_at"] = event.get("tool_started_at")
        existing_part["tool_ended_at"] = event.get("tool_ended_at")
        existing_part["tool_duration_ms"] = event.get("tool_duration_ms")
        if tool_name:
            existing_part["tool_name"] = tool_name

    def _flush_text_buffer(self):
        if not self._text_buffer:
            return
        if self._text_buffer.get("content"):
            flushed_part = {k: v for k, v in self._text_buffer.items() if k != "source_id"}
            self._parts.append(flushed_part)
        self._text_buffer = None


# ---------------------------------------------------------------------------
# ChatStreamRuntime
# ---------------------------------------------------------------------------

class ChatStreamRuntime:
    """In-memory runtime state for a single in-flight assistant response."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.run_id = uuid.uuid4().hex[:12]
        self.status = "running"
        self.error: Optional[str] = None
        self.started_at = time.time()
        self.updated_at = self.started_at
        self.full_text = ""
        self.full_thinking = ""
        self.parts_accumulator = StreamPartsAccumulator()
        self.events: list[dict[str, Any]] = []
        self.next_sequence = 1
        self.last_persist_at = 0.0
        self.last_persist_sequence = 0
        self.subscribers: set[asyncio.Queue] = set()
        self.lock = asyncio.Lock()
        self.cleanup_task: Optional[asyncio.Task] = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "sequence": max(0, self.next_sequence - 1),
            "text": self.full_text,
            "thinking": self.full_thinking,
            "parts": self.parts_accumulator.snapshot(),
            "error": self.error,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


# ---------------------------------------------------------------------------
# Stream management helpers
# ---------------------------------------------------------------------------

def _public_stream_event(event: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in event.items() if not str(k).startswith("_")}


def _persist_active_stream_snapshot(
    session_id: str,
    runtime: ChatStreamRuntime,
    chat_sessions: Dict[str, dict],
    save_chat_state_fn,
    snapshot_save_interval_events: int,
    snapshot_save_interval_seconds: float,
    *,
    force: bool = False,
) -> None:
    session = chat_sessions.get(session_id)
    if not isinstance(session, dict):
        return

    now = time.time()
    current_sequence = max(0, runtime.next_sequence - 1)
    if not force:
        if current_sequence == runtime.last_persist_sequence:
            return
        if (
            current_sequence - runtime.last_persist_sequence < snapshot_save_interval_events
            and now - runtime.last_persist_at < snapshot_save_interval_seconds
        ):
            return

    session["active_stream"] = runtime.snapshot()
    save_chat_state_fn()
    runtime.last_persist_at = now
    runtime.last_persist_sequence = current_sequence


async def _append_runtime_event(runtime: ChatStreamRuntime, event: dict[str, Any]) -> dict[str, Any]:
    public_event = _public_stream_event(event)
    runtime.parts_accumulator.consume(public_event)

    if public_event.get("type") == "part_delta":
        delta = public_event.get("delta")
        if isinstance(delta, str):
            if public_event.get("ptype") == "text":
                runtime.full_text += delta
            elif public_event.get("ptype") == "reasoning":
                runtime.full_thinking += delta
    elif public_event.get("type") == "error":
        runtime.error = public_event.get("message") or "Unknown chat stream error"
        runtime.status = "failed"
    elif public_event.get("type") == "session_status" and public_event.get("status") == "idle":
        if runtime.status == "running":
            runtime.status = "completed"

    runtime.updated_at = time.time()
    async with runtime.lock:
        seq_event = {"seq": runtime.next_sequence, **public_event}
        runtime.next_sequence += 1
        runtime.events.append(seq_event)
        subscribers = list(runtime.subscribers)

    for queue in subscribers:
        try:
            queue.put_nowait(seq_event)
        except asyncio.QueueFull:
            logger.warning("Dropping chat stream event for session %s due to full subscriber queue", runtime.session_id)

    return seq_event


async def _close_runtime_subscribers(runtime: ChatStreamRuntime) -> None:
    async with runtime.lock:
        subscribers = list(runtime.subscribers)
        runtime.subscribers.clear()

    for queue in subscribers:
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


async def _expire_runtime_after(
    session_id: str,
    runtime: ChatStreamRuntime,
    delay_seconds: float,
    active_chat_streams: Dict[str, ChatStreamRuntime],
) -> None:
    try:
        await asyncio.sleep(delay_seconds)
    except asyncio.CancelledError:
        return

    if active_chat_streams.get(session_id) is runtime:
        active_chat_streams.pop(session_id, None)


async def _finalize_runtime(
    session_id: str,
    runtime: ChatStreamRuntime,
    active_chat_streams: Dict[str, ChatStreamRuntime],
    retention_seconds: float,
    *,
    retain: bool = True,
) -> None:
    await _close_runtime_subscribers(runtime)
    if runtime.cleanup_task and not runtime.cleanup_task.done():
        runtime.cleanup_task.cancel()
        runtime.cleanup_task = None

    if not retain:
        if active_chat_streams.get(session_id) is runtime:
            active_chat_streams.pop(session_id, None)
        return

    runtime.cleanup_task = asyncio.create_task(
        _expire_runtime_after(session_id, runtime, retention_seconds, active_chat_streams)
    )


async def _stream_runtime_events(
    session_id: str,
    active_chat_streams: Dict[str, ChatStreamRuntime],
    *,
    from_seq: int = 1,
    run_id: Optional[str] = None,
) -> AsyncIterator[str]:
    runtime = active_chat_streams.get(session_id)
    if runtime is None:
        yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
        return

    if run_id and runtime.run_id != run_id:
        yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
        return

    from_seq = max(1, from_seq)
    queue: asyncio.Queue = asyncio.Queue()
    subscribed = False

    async with runtime.lock:
        backlog = [event for event in runtime.events if int(event.get("seq", 0)) >= from_seq]
        done = runtime.status != "running"
        if not done:
            runtime.subscribers.add(queue)
            subscribed = True

    try:
        for event in backlog:
            yield json.dumps(event) + "\n"
            if event.get("type") == "session_status" and event.get("status") == "idle":
                return

        if done:
            return

        while True:
            item = await queue.get()
            if item is None:
                break
            if int(item.get("seq", 0)) < from_seq:
                continue
            yield json.dumps(item) + "\n"
            if item.get("type") == "session_status" and item.get("status") == "idle":
                break
    finally:
        if subscribed:
            async with runtime.lock:
                runtime.subscribers.discard(queue)


# ---------------------------------------------------------------------------
# parse_opencode_event
# ---------------------------------------------------------------------------

def parse_opencode_event(event_data: dict, target_session_id: str) -> Optional[dict]:
    """Parse an OpenCode SSE event and translate it to our protocol."""
    payload = event_data.get("payload", {})
    if not isinstance(payload, dict):
        return None

    etype = payload.get("type", "")
    props = payload.get("properties", {})
    if not isinstance(props, dict):
        return None
    part = props.get("part", {})
    if not isinstance(part, dict):
        part = {}

    session_props = props.get("session")
    if not isinstance(session_props, dict):
        session_props = {}

    event_sid = props.get("sessionID") or part.get("sessionID") or session_props.get("id")
    if event_sid != target_session_id:
        return None

    if etype == "message.part.delta":
        field = props.get("field")
        if field not in ("text", "reasoning"):
            return None
        delta = props.get("delta")
        if not isinstance(delta, str) or delta == "":
            return None
        part_id = props.get("partID")
        return {"type": "part_delta", "id": part_id, "ptype": field, "delta": delta}

    elif etype == "message.part.updated":
        ptype = part.get("type")
        part_id = part.get("id")

        if ptype == "text":
            delta = props.get("delta")
            if not isinstance(delta, str) or delta == "":
                return None
            return {"type": "part_delta", "id": part_id, "ptype": "text", "delta": delta}
        elif ptype == "reasoning":
            delta = props.get("delta")
            if not isinstance(delta, str) or delta == "":
                return None
            return {"type": "part_delta", "id": part_id, "ptype": "reasoning", "delta": delta}
        elif ptype == "tool":
            tool_data = _extract_tool_data(part)
            return {
                "type": "part_update",
                "id": part_id,
                "ptype": "tool",
                "state": part.get("state"),
                "name": _extract_tool_name(part),
                **tool_data,
            }

    elif etype == "session.status":
        if props.get("status", {}).get("type") == "idle":
            return {"type": "session_status", "status": "idle", "_done": True}

    return None


# ---------------------------------------------------------------------------
# stream_opencode_events
# ---------------------------------------------------------------------------

async def stream_opencode_events(
    client, session_id: str, opencode_url: str, get_auth
) -> AsyncIterator[tuple[dict, str, str, Optional[dict]]]:
    """Stream parsed OpenCode events with text/thinking deltas and tool updates."""
    url = f"{opencode_url}/global/event"
    headers = {"Accept": "text/event-stream"}

    async with client.stream("GET", url, headers=headers, auth=get_auth()) as response:
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue

            try:
                event_data = json.loads(line[6:])

                if "error" in event_data:
                    error_msg = event_data.get("error", "Unknown OpenCode error")
                    logger.error(f"OpenCode returned error: {error_msg}")
                    raise RuntimeError(f"OpenCode error: {error_msg}")

                translated = parse_opencode_event(event_data, session_id)
                if translated is None:
                    continue

                text_delta = ""
                thinking_delta = ""
                tool_update = None
                ptype = translated.get("ptype")
                if ptype == "text":
                    text_delta = translated.get("delta", "")
                elif ptype == "reasoning":
                    thinking_delta = translated.get("delta", "")
                elif ptype == "tool":
                    tool_update = translated

                yield translated, text_delta, thinking_delta, tool_update

                if translated.get("_done"):
                    break
            except RuntimeError:
                raise
            except Exception as e:
                logger.error(f"Error parsing event line: {e}")
                continue
