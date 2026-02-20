"""
Research Agent Server — Telemetry Integration

Server-side telemetry: FastAPI middleware for API request tracking
and lifecycle event emitters for chat/run/sweep events.

Events are batched in memory and flushed asynchronously to the
Modal telemetry-ingest endpoint.  Failures are silently swallowed.
"""

import asyncio
import hashlib
import json
import logging
import os
import time
from typing import Optional

import httpx
from fastapi import Request
from starlette.responses import Response

logger = logging.getLogger("research-agent-server")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TELEMETRY_ENDPOINT_URL = os.environ.get("TELEMETRY_ENDPOINT_URL", "")
TELEMETRY_API_KEY = ""  # Set at init() from RESEARCH_AGENT_KEY
FLUSH_INTERVAL_SECONDS = 10
MAX_BATCH_SIZE = 50

# Paths that are too noisy / not useful to track
_SKIP_PATHS = frozenset({"/health", "/", "/favicon.ico"})


# ---------------------------------------------------------------------------
# TelemetryEmitter
# ---------------------------------------------------------------------------

class TelemetryEmitter:
    """Batches telemetry events and flushes them to the Modal endpoint."""

    def __init__(self, endpoint_url: str = "", api_key: str = ""):
        self.endpoint_url = endpoint_url
        self.api_key = api_key
        self._queue: list[dict] = []
        self._lock = asyncio.Lock()
        self._flush_task: Optional[asyncio.Task] = None

    @property
    def enabled(self) -> bool:
        return bool(self.endpoint_url and self.api_key)

    def emit(self, event: dict):
        """Queue a telemetry event (non-blocking)."""
        if not self.enabled:
            return
        self._queue.append(event)
        if len(self._queue) >= MAX_BATCH_SIZE:
            self._schedule_flush()

    def _schedule_flush(self):
        """Schedule an async flush if one isn't already pending."""
        if self._flush_task and not self._flush_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
            self._flush_task = loop.create_task(self.flush())
        except RuntimeError:
            pass  # No running loop — skip

    async def flush(self):
        """Send queued events to the telemetry endpoint."""
        if not self.enabled or not self._queue:
            return

        async with self._lock:
            batch = self._queue[:MAX_BATCH_SIZE]
            self._queue = self._queue[MAX_BATCH_SIZE:]

        if not batch:
            return

        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    f"{self.endpoint_url}/v1/telemetry",
                    json=batch,
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": self.api_key,
                    },
                )
        except Exception:
            # Silently swallow — telemetry must never break the server
            pass

    async def periodic_flush(self):
        """Background task: flush every FLUSH_INTERVAL_SECONDS."""
        while True:
            await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
            try:
                await self.flush()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_emitter = TelemetryEmitter()


def init(endpoint_url: str = "", api_key: str = ""):
    """Initialize the telemetry emitter. Called once from server.py."""
    global _emitter
    _emitter.endpoint_url = endpoint_url or TELEMETRY_ENDPOINT_URL
    _emitter.api_key = api_key

    if _emitter.enabled:
        logger.info("Telemetry enabled → %s", _emitter.endpoint_url)
        # Start periodic flush background task
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_emitter.periodic_flush())
        except RuntimeError:
            pass  # Will start when event loop is available
    else:
        logger.info("Telemetry disabled (no TELEMETRY_ENDPOINT_URL or API key)")


# ---------------------------------------------------------------------------
# Identity helpers
# ---------------------------------------------------------------------------

def _hash_token(token: str) -> str:
    """SHA256 hash of auth token, truncated to 12 hex chars."""
    if not token:
        return ""
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def _token_prefix(token: str) -> str:
    """First 8 chars of the auth token for correlation."""
    if not token:
        return ""
    return token[:8]


def _extract_identity(request: Request) -> dict:
    """Extract user identity fields from a FastAPI request."""
    auth_token = request.headers.get("X-Auth-Token", "")
    return {
        "client_ip": request.client.host if request.client else None,
        "user_hash": _hash_token(auth_token),
        "auth_token_prefix": _token_prefix(auth_token),
    }


# ---------------------------------------------------------------------------
# FastAPI Middleware
# ---------------------------------------------------------------------------

async def telemetry_middleware(request: Request, call_next) -> Response:
    """Capture every API request as a telemetry event."""
    path = request.url.path

    # Skip noisy/static paths
    if path in _SKIP_PATHS or path.startswith("/_next/"):
        return await call_next(request)

    start = time.time()
    response = await call_next(request)
    duration_ms = (time.time() - start) * 1000

    identity = _extract_identity(request)

    _emitter.emit({
        "category": "api_request",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "server",
        **identity,
        "method": request.method,
        "path": path,
        "status": response.status_code,
        "duration_ms": round(duration_ms, 1),
    })

    return response


# ---------------------------------------------------------------------------
# Lifecycle event helpers
# ---------------------------------------------------------------------------

def emit_chat_event(
    kind: str,
    chat_session_id: str,
    *,
    model_provider: str = "",
    model_id: str = "",
    metadata: Optional[dict] = None,
):
    """Emit a chat lifecycle telemetry event."""
    _emitter.emit({
        "category": "chat_lifecycle",
        "event_kind": kind,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "server",
        "chat_session_id": chat_session_id,
        "model_provider": model_provider or None,
        "model_id": model_id or None,
        "metadata": metadata,
    })


def emit_run_event(
    kind: str,
    run_id: str,
    *,
    chat_session_id: str = "",
    sweep_id: str = "",
    metadata: Optional[dict] = None,
):
    """Emit a run lifecycle telemetry event."""
    _emitter.emit({
        "category": "run_lifecycle",
        "event_kind": kind,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "server",
        "run_id": run_id,
        "chat_session_id": chat_session_id or None,
        "sweep_id": sweep_id or None,
        "metadata": metadata,
    })
