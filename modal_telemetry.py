"""
Modal Telemetry App - durable request telemetry ingest for Research Agent.

Deploy with:
    modal deploy modal_telemetry.py --name research-agent-telemetry

Then set this in the preview server environment/secret:
    RESEARCH_AGENT_TELEMETRY_URL=https://<workspace>--research-agent-telemetry-telemetry-asgi.modal.run/ingest
    RESEARCH_AGENT_TELEMETRY_TOKEN=<shared-token>

Required Modal Secret "research-agent-telemetry-secrets":
    TELEMETRY_AUTH_TOKEN  - shared token expected by /ingest
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import time
from pathlib import Path
from threading import Lock
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode

import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        return int(raw)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, str(default)).strip()
    try:
        return float(raw)
    except ValueError:
        return default


IMAGE = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi>=0.104.0",
    "pydantic>=2.0.0",
)

TELEMETRY_VOLUME = modal.Volume.from_name("research-agent-telemetry-data", create_if_missing=True)
APP = modal.App("research-agent-telemetry")

DATA_ROOT = Path(os.environ.get("TELEMETRY_DATA_DIR", "/data"))
SPOOL_DIR = DATA_ROOT / "spool"
PROCESSED_DIR = DATA_ROOT / "processed"
DB_PATH = DATA_ROOT / "telemetry.db"
FLUSH_LOCK_PATH = DATA_ROOT / "flush.lock"

TELEMETRY_AUTH_TOKEN = os.environ.get("TELEMETRY_AUTH_TOKEN", "").strip()
MAX_BATCH_EVENTS = _int_env("TELEMETRY_MAX_BATCH_EVENTS", 500)
MAX_EVENT_BYTES = _int_env("TELEMETRY_MAX_EVENT_BYTES", 32 * 1024)
RETENTION_DAYS = _int_env("TELEMETRY_RETENTION_DAYS", 14)
COMMIT_INTERVAL_SECONDS = _float_env("TELEMETRY_COMMIT_INTERVAL_SECONDS", 1.0)

_SPOOL_LOCK = Lock()
_COMMIT_LOCK = Lock()
_LAST_COMMIT_AT = 0.0
_CONTAINER_ID = (os.environ.get("MODAL_TASK_ID") or socket.gethostname() or "unknown").replace("/", "_")
_SENSITIVE_KEYS = {"authorization", "cookie", "set-cookie", "x-auth-token", "api-key", "x-api-key"}


class IngestPayload(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list)
    source: Optional[str] = None
    sent_at: Optional[float] = None


telemetry_api = FastAPI(title="Research Agent Telemetry")


def _truncate(value: Any, max_len: int = 512) -> str:
    text = str(value) if value is not None else ""
    return text if len(text) <= max_len else text[:max_len]


def _safe_int(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _redact_query_string(raw_query: str) -> str:
    if not raw_query:
        return ""
    pairs: list[tuple[str, str]] = []
    for key, value in parse_qsl(raw_query, keep_blank_values=True):
        lower = key.lower()
        if any(secret in lower for secret in ("token", "key", "secret", "password", "auth")):
            pairs.append((key, "[REDACTED]"))
        else:
            pairs.append((key, _truncate(value, max_len=256)))
    return urlencode(pairs)


def _sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    cleaned = dict(event)
    headers = cleaned.get("headers")
    if isinstance(headers, dict):
        redacted_headers: dict[str, str] = {}
        for key, value in headers.items():
            lk = str(key).lower()
            if lk in _SENSITIVE_KEYS or any(secret in lk for secret in ("token", "secret", "password", "auth")):
                redacted_headers[str(key)] = "[REDACTED]"
            else:
                redacted_headers[str(key)] = _truncate(value, max_len=256)
        cleaned["headers"] = redacted_headers

    query = cleaned.get("query")
    if isinstance(query, str):
        cleaned["query"] = _truncate(_redact_query_string(query), max_len=512)

    payload = json.dumps(cleaned, separators=(",", ":"), default=str)
    payload_bytes = payload.encode("utf-8")
    if len(payload_bytes) <= MAX_EVENT_BYTES:
        return cleaned

    preview = payload_bytes[:MAX_EVENT_BYTES].decode("utf-8", errors="ignore")
    return {
        "truncated": True,
        "ts": cleaned.get("ts", time.time()),
        "source": cleaned.get("source"),
        "method": cleaned.get("method"),
        "path": cleaned.get("path"),
        "status": cleaned.get("status"),
        "latency_ms": cleaned.get("latency_ms"),
        "preview": preview,
    }


def _append_events_to_spool(events: list[dict[str, Any]], source: str) -> tuple[int, int]:
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    accepted = 0
    dropped = 0
    minute_bucket = int(time.time() // 60)
    spool_path = SPOOL_DIR / f"{minute_bucket}-{_CONTAINER_ID}.jsonl"

    with _SPOOL_LOCK:
        with spool_path.open("a", encoding="utf-8") as fh:
            for raw_event in events:
                if not isinstance(raw_event, dict):
                    dropped += 1
                    continue
                sanitized = _sanitize_event(raw_event)
                record = {
                    "received_at": time.time(),
                    "source": _truncate(source, max_len=128),
                    "event": sanitized,
                }
                fh.write(json.dumps(record, separators=(",", ":"), default=str) + "\n")
                accepted += 1
    return accepted, dropped


def _maybe_commit_volume(force: bool = False) -> bool:
    global _LAST_COMMIT_AT
    now = time.monotonic()
    min_interval = max(0.0, COMMIT_INTERVAL_SECONDS)
    if not force and now - _LAST_COMMIT_AT < min_interval:
        return False

    with _COMMIT_LOCK:
        now = time.monotonic()
        if not force and now - _LAST_COMMIT_AT < min_interval:
            return False
        TELEMETRY_VOLUME.commit()
        _LAST_COMMIT_AT = now
        return True


def _init_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telemetry_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            received_at REAL NOT NULL,
            source TEXT,
            method TEXT,
            path TEXT,
            status INTEGER,
            latency_ms REAL,
            client_ip TEXT,
            user_agent TEXT,
            query TEXT,
            event_json TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_events(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_path ON telemetry_events(path)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_status ON telemetry_events(status)")


def _acquire_flush_lock() -> Optional[int]:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        return os.open(str(FLUSH_LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None


def _release_flush_lock(lock_fd: Optional[int]) -> None:
    if lock_fd is None:
        return
    try:
        os.close(lock_fd)
    finally:
        try:
            os.unlink(FLUSH_LOCK_PATH)
        except FileNotFoundError:
            pass


def flush_spool_to_sqlite() -> dict[str, int]:
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    lock_fd = _acquire_flush_lock()
    if lock_fd is None:
        return {
            "skipped_due_to_lock": 1,
            "files_processed": 0,
            "events_inserted": 0,
            "bad_lines": 0,
        }

    files_processed = 0
    events_inserted = 0
    bad_lines = 0

    try:
        spool_files = sorted(SPOOL_DIR.glob("*.jsonl"))
        if not spool_files:
            return {
                "skipped_due_to_lock": 0,
                "files_processed": 0,
                "events_inserted": 0,
                "bad_lines": 0,
            }

        conn = sqlite3.connect(DB_PATH, timeout=30.0)
        try:
            _init_db(conn)
            for spool_file in spool_files:
                processing_name = f"{spool_file.stem}.{int(time.time())}.processing"
                processing_path = PROCESSED_DIR / processing_name
                try:
                    os.replace(spool_file, processing_path)
                except FileNotFoundError:
                    continue

                rows: list[tuple[Any, ...]] = []
                try:
                    with processing_path.open("r", encoding="utf-8") as fh:
                        for line in fh:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                record = json.loads(line)
                            except json.JSONDecodeError:
                                bad_lines += 1
                                continue
                            event = record.get("event") if isinstance(record, dict) else None
                            if not isinstance(event, dict):
                                bad_lines += 1
                                continue
                            ts = _safe_float(event.get("ts")) or _safe_float(record.get("received_at")) or time.time()
                            received_at = _safe_float(record.get("received_at")) or time.time()
                            rows.append(
                                (
                                    ts,
                                    received_at,
                                    _truncate(record.get("source"), max_len=128),
                                    _truncate(event.get("method"), max_len=32),
                                    _truncate(event.get("path"), max_len=512),
                                    _safe_int(event.get("status")),
                                    _safe_float(event.get("latency_ms")),
                                    _truncate(event.get("client_ip"), max_len=64),
                                    _truncate(event.get("user_agent"), max_len=512),
                                    _truncate(event.get("query"), max_len=512),
                                    json.dumps(event, separators=(",", ":"), default=str),
                                )
                            )

                    if rows:
                        conn.executemany(
                            """
                            INSERT INTO telemetry_events (
                                ts, received_at, source, method, path, status, latency_ms,
                                client_ip, user_agent, query, event_json
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            rows,
                        )
                        events_inserted += len(rows)
                    conn.commit()
                    files_processed += 1

                    done_path = PROCESSED_DIR / f"{processing_path.name}.done"
                    os.replace(processing_path, done_path)
                except Exception:
                    try:
                        os.replace(processing_path, SPOOL_DIR / spool_file.name)
                    except OSError:
                        pass
                    raise

            cutoff = time.time() - max(1, RETENTION_DAYS) * 86400
            conn.execute("DELETE FROM telemetry_events WHERE ts < ?", (cutoff,))
            conn.commit()
        finally:
            conn.close()

        # Prune old processed files.
        keep_done_after = time.time() - 2 * 86400
        for processed in PROCESSED_DIR.glob("*.done"):
            if processed.stat().st_mtime < keep_done_after:
                try:
                    processed.unlink()
                except OSError:
                    pass

        return {
            "skipped_due_to_lock": 0,
            "files_processed": files_processed,
            "events_inserted": events_inserted,
            "bad_lines": bad_lines,
        }
    finally:
        _release_flush_lock(lock_fd)


@telemetry_api.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    if not TELEMETRY_AUTH_TOKEN:
        return await call_next(request)

    provided_token = (
        request.headers.get("x-telemetry-token")
        or request.headers.get("x-auth-token")
        or request.query_params.get("token")
    )
    if provided_token != TELEMETRY_AUTH_TOKEN:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


@telemetry_api.get("/health")
async def health():
    return {
        "status": "ok",
        "spool_dir": str(SPOOL_DIR),
        "db_path": str(DB_PATH),
    }


@telemetry_api.post("/ingest")
async def ingest(payload: IngestPayload):
    if not payload.events:
        return {"accepted": 0, "dropped": 0}

    events = payload.events[:MAX_BATCH_EVENTS]
    dropped_from_batch_limit = max(0, len(payload.events) - len(events))
    accepted, dropped = _append_events_to_spool(events, source=payload.source or "unknown")

    # Make newly written files visible to scheduled flusher (throttled).
    _maybe_commit_volume()

    return {
        "accepted": accepted,
        "dropped": dropped + dropped_from_batch_limit,
    }


@APP.function(
    image=IMAGE,
    volumes={"/data": TELEMETRY_VOLUME},
    secrets=[modal.Secret.from_name("research-agent-telemetry-secrets")],
    timeout=86400,
    allow_concurrent_inputs=200,
    cpu=1.0,
    memory=1024,
)
@modal.asgi_app()
def telemetry_asgi():
    return telemetry_api


@APP.function(
    image=IMAGE,
    volumes={"/data": TELEMETRY_VOLUME},
    secrets=[modal.Secret.from_name("research-agent-telemetry-secrets")],
    timeout=300,
    allow_concurrent_inputs=1,
    cpu=1.0,
    memory=512,
    schedule=modal.Period(minutes=1),
)
def flush_telemetry():
    # Load latest committed spool files from ingest containers.
    TELEMETRY_VOLUME.reload()
    summary = flush_spool_to_sqlite()
    _maybe_commit_volume(force=True)
    print(json.dumps(summary, separators=(",", ":")))
