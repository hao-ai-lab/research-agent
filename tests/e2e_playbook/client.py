"""HTTP client for playbook-driven chat streaming tests."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Optional

import requests


@dataclass
class TurnStreamResult:
    assistant_text: str
    events: list[dict[str, Any]]
    first_token_latency_ms: Optional[float]
    total_latency_ms: float
    stream_reconnects: int
    tool_names: list[str]


class ChatTestClient:
    def __init__(
        self,
        base_url: str,
        *,
        auth_token: str = "",
        connect_timeout_s: float = 8.0,
        read_timeout_s: float = 240.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers: dict[str, str] = {"Content-Type": "application/json"}
        if auth_token:
            self.headers["X-Auth-Token"] = auth_token
        self.connect_timeout_s = connect_timeout_s
        self.read_timeout_s = read_timeout_s

    def healthcheck(self) -> None:
        response = requests.get(
            f"{self.base_url}/health",
            headers=self.headers,
            timeout=(self.connect_timeout_s, self.read_timeout_s),
        )
        response.raise_for_status()

    def create_session(
        self,
        *,
        title: str,
        model_provider: str | None = None,
        model_id: str | None = None,
    ) -> str:
        payload: dict[str, Any] = {"title": title}
        if model_provider:
            payload["model_provider"] = model_provider
        if model_id:
            payload["model_id"] = model_id
        response = requests.post(
            f"{self.base_url}/sessions",
            headers=self.headers,
            json=payload,
            timeout=(self.connect_timeout_s, self.read_timeout_s),
        )
        response.raise_for_status()
        session_id = response.json().get("id")
        if not session_id:
            raise RuntimeError("Session creation succeeded but no session id was returned")
        return str(session_id)

    def set_system_prompt(self, session_id: str, system_prompt: str) -> None:
        response = requests.put(
            f"{self.base_url}/sessions/{session_id}/system-prompt",
            headers=self.headers,
            json={"system_prompt": system_prompt},
            timeout=(self.connect_timeout_s, self.read_timeout_s),
        )
        response.raise_for_status()

    def send_turn(
        self,
        *,
        session_id: str,
        message: str,
        mode: str = "agent",
        prompt_override: str | None = None,
        max_stream_retries: int = 2,
    ) -> TurnStreamResult:
        payload: dict[str, Any] = {
            "session_id": session_id,
            "message": message,
            "mode": mode,
        }
        if prompt_override:
            payload["prompt_override"] = prompt_override

        started_at = time.perf_counter()
        first_token_latency_ms: Optional[float] = None
        assistant_chunks: list[str] = []
        events: list[dict[str, Any]] = []
        tool_names: list[str] = []
        max_seq_seen = 0
        reconnects = 0
        done = False

        done, max_seq_seen, first_token_latency_ms = self._consume_stream(
            method="POST",
            path="/chat",
            stream_kwargs={"json": payload},
            events=events,
            assistant_chunks=assistant_chunks,
            tool_names=tool_names,
            max_seq_seen=max_seq_seen,
            first_token_latency_ms=first_token_latency_ms,
            started_at=started_at,
            suppress_request_errors=False,
        )

        while not done and reconnects < max_stream_retries:
            reconnects += 1
            done, max_seq_seen, first_token_latency_ms = self._consume_stream(
                method="GET",
                path=f"/sessions/{session_id}/stream",
                stream_kwargs={"params": {"from_seq": max_seq_seen + 1}},
                events=events,
                assistant_chunks=assistant_chunks,
                tool_names=tool_names,
                max_seq_seen=max_seq_seen,
                first_token_latency_ms=first_token_latency_ms,
                started_at=started_at,
                suppress_request_errors=True,
            )

        if not done:
            raise RuntimeError(
                f"Stream for session `{session_id}` did not complete after {max_stream_retries} reconnects"
            )

        total_latency_ms = (time.perf_counter() - started_at) * 1000.0
        return TurnStreamResult(
            assistant_text="".join(assistant_chunks).strip(),
            events=events,
            first_token_latency_ms=first_token_latency_ms,
            total_latency_ms=total_latency_ms,
            stream_reconnects=reconnects,
            tool_names=tool_names,
        )

    def _consume_stream(
        self,
        *,
        method: str,
        path: str,
        stream_kwargs: dict[str, Any],
        events: list[dict[str, Any]],
        assistant_chunks: list[str],
        tool_names: list[str],
        max_seq_seen: int,
        first_token_latency_ms: Optional[float],
        started_at: float,
        suppress_request_errors: bool,
    ) -> tuple[bool, int, Optional[float]]:
        done = False

        try:
            with requests.request(
                method,
                f"{self.base_url}{path}",
                headers=self.headers,
                timeout=(self.connect_timeout_s, self.read_timeout_s),
                stream=True,
                **stream_kwargs,
            ) as response:
                response.raise_for_status()

                for raw_line in response.iter_lines(decode_unicode=True):
                    if not raw_line:
                        continue
                    try:
                        event = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue

                    events.append(event)

                    seq_value = event.get("seq")
                    if isinstance(seq_value, int):
                        max_seq_seen = max(max_seq_seen, seq_value)

                    event_type = event.get("type")
                    if event_type == "part_delta" and event.get("ptype") == "text":
                        delta = event.get("delta")
                        if isinstance(delta, str):
                            if first_token_latency_ms is None:
                                first_token_latency_ms = (time.perf_counter() - started_at) * 1000.0
                            assistant_chunks.append(delta)

                    if event.get("ptype") == "tool":
                        tool_name = event.get("name")
                        if isinstance(tool_name, str) and tool_name.strip():
                            tool_names.append(tool_name.strip())

                    if event_type == "session_status" and event.get("status") == "idle":
                        done = True
                        break
        except requests.exceptions.RequestException:
            if not suppress_request_errors:
                raise
            done = False

        return done, max_seq_seen, first_token_latency_ms
