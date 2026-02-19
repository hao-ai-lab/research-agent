"""Agent Backend Protocol — abstraction layer for coding agent interactions.

Provides a protocol-based interface for communicating with coding agents
(OpenCode, Codex, Claude Code, etc.) and a concrete OpenCode implementation
that consolidates duplicated OpenCode interaction code from server.py and
wild_loop_v2.py.
"""

import json
import logging
from typing import Any, AsyncIterator, Callable, Optional, Protocol, runtime_checkable

import httpx

logger = logging.getLogger("agent_backend")


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

@runtime_checkable
class AgentBackend(Protocol):
    """Interface that any coding agent backend must implement.

    Wild V2 and other consumers depend only on this protocol, making it
    easy to swap backends (OpenCode → Codex → Claude Code) without
    touching loop logic.
    """

    async def create_session(self, workdir: str) -> Optional[str]:
        """Create a new agent session bound to *workdir*.

        Returns a session ID string, or None on failure.
        """
        ...

    async def send_prompt(self, session_id: str, prompt: str) -> str:
        """Send *prompt* to an existing session and return the full response text.

        Blocks until the agent is done.  For streaming, use
        ``stream_prompt`` instead.
        """
        ...

    async def abort_session(self, session_id: str) -> None:
        """Best-effort abort of an in-progress session."""
        ...


# ---------------------------------------------------------------------------
# OpenCode SSE event parsing (moved from server.py)
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


def parse_opencode_event(event_data: dict, target_session_id: str) -> Optional[dict]:
    """Parse an OpenCode SSE event and translate it to our protocol.

    Returns a translated event dict, or None if the event should be skipped.
    """
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
        delta = props.get("delta")
        if not isinstance(delta, str) or delta == "":
            return None
        field = props.get("field", "")
        part_id = props.get("partID")
        if field in ("text", "reasoning"):
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


async def stream_opencode_events(
    client: httpx.AsyncClient,
    session_id: str,
    url: str,
    get_auth: Optional[Callable] = None,
) -> AsyncIterator[tuple[dict, str, str, Optional[dict]]]:
    """Stream parsed OpenCode events with text/thinking deltas and tool updates.

    Yields (event_dict, text_delta, thinking_delta, tool_update) tuples.
    """
    headers = {"Accept": "text/event-stream"}
    auth = get_auth() if get_auth else None

    async with client.stream("GET", url, headers=headers, auth=auth) as response:
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue

            try:
                event_data = json.loads(line[6:])

                # Check for error responses from OpenCode
                if "error" in event_data:
                    error_msg = event_data.get("error", "Unknown OpenCode error")
                    logger.error("OpenCode returned error: %s", error_msg)
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
                # Re-raise OpenCode errors
                raise
            except Exception as e:
                logger.error("Error parsing event line: %s", e)
                continue


async def send_prompt_to_opencode(
    client: httpx.AsyncClient,
    url: str,
    session_id: str,
    content: str,
    model_provider: str,
    model_id: str,
    get_auth: Optional[Callable] = None,
) -> None:
    """Send a prompt to an OpenCode session using an explicit model."""
    prompt_payload = {
        "model": {"providerID": model_provider, "modelID": model_id},
        "parts": [{"type": "text", "text": content}],
    }
    auth = get_auth() if get_auth else None
    resp = await client.post(
        f"{url}/session/{session_id}/prompt_async",
        json=prompt_payload,
        auth=auth,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# OpenCode Backend
# ---------------------------------------------------------------------------

class OpenCodeBackend:
    """Concrete ``AgentBackend`` implementation for OpenCode.

    Consolidates session creation, prompt sending, and SSE streaming
    previously duplicated in ``server.py`` and ``wild_loop_v2.py``.
    """

    def __init__(
        self,
        *,
        url: str = "http://127.0.0.1:4096",
        model_provider: str = "opencode",
        model_id: str = "minimax-m2.5-free",
        get_auth: Optional[Callable] = None,
    ):
        self._url = url
        self._model_provider = model_provider
        self._model_id = model_id
        self._get_auth = get_auth

    @property
    def url(self) -> str:
        return self._url

    @property
    def model_provider(self) -> str:
        return self._model_provider

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def events_url(self) -> str:
        return f"{self._url}/global/event"

    def _auth(self) -> Optional[httpx.BasicAuth]:
        return self._get_auth() if self._get_auth else None

    # -- AgentBackend protocol methods --

    async def create_session(self, workdir: str) -> Optional[str]:
        """Create a fresh OpenCode session bound to *workdir*."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._url}/session",
                    params={"directory": workdir},
                    json={},
                    auth=self._auth(),
                )
                resp.raise_for_status()
                oc_id = resp.json().get("id")
                logger.info("Created OpenCode session: %s (workdir=%s)", oc_id, workdir)
                return oc_id
        except Exception as err:
            logger.error("Failed to create OpenCode session: %s", err)
            return None

    async def send_prompt(self, session_id: str, prompt: str) -> str:
        """Send *prompt* and block until the full response text is available.

        This is the simple text-only interface used by Wild V2.  For rich
        streaming (tools, thinking, etc.), use ``stream_prompt`` instead.
        """
        full_text = ""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                await send_prompt_to_opencode(
                    client,
                    self._url,
                    session_id,
                    prompt,
                    self._model_provider,
                    self._model_id,
                    self._get_auth,
                )

                # Stream events and collect text
                async for _event, text_delta, _thinking, _tool in stream_opencode_events(
                    client, session_id, self.events_url, self._get_auth,
                ):
                    full_text += text_delta

        except Exception as err:
            logger.error("OpenCode send_prompt failed: %s", err, exc_info=True)

        logger.info("Got %d chars of response from session %s", len(full_text), session_id)
        return full_text

    async def stream_prompt(
        self,
        session_id: str,
        prompt: str,
    ) -> AsyncIterator[tuple[dict, str, str, Optional[dict]]]:
        """Send *prompt* and yield rich streaming events.

        This is the full-fidelity interface used by the chat UI (via server.py).
        Yields ``(event_dict, text_delta, thinking_delta, tool_update)`` tuples.
        """
        async with httpx.AsyncClient(timeout=None) as client:
            await send_prompt_to_opencode(
                client,
                self._url,
                session_id,
                prompt,
                self._model_provider,
                self._model_id,
                self._get_auth,
            )

            async for item in stream_opencode_events(
                client, session_id, self.events_url, self._get_auth,
            ):
                yield item

    async def abort_session(self, session_id: str) -> None:
        """Best-effort abort of an in-progress OpenCode session."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(
                    f"{self._url}/session/{session_id}/abort",
                    auth=self._auth(),
                )
                logger.info("Aborted OpenCode session %s: %d", session_id, resp.status_code)
        except Exception as err:
            logger.warning("Failed to abort OpenCode session %s: %s", session_id, err)

    async def fetch_session_title(self, session_id: str) -> Optional[str]:
        """Fetch the auto-generated title from an OpenCode session."""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(
                    f"{self._url}/session/{session_id}",
                    auth=self._auth(),
                )
                resp.raise_for_status()
                data = resp.json()
                title = data.get("title")
                if title and isinstance(title, str) and title.strip():
                    return title.strip()
        except Exception as e:
            logger.warning("Failed to fetch OpenCode session title for %s: %s", session_id, e)
        return None
