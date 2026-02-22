"""
Research Agent Server — Chat Endpoints

Extracted from server.py. Session CRUD, mode registry, chat worker,
and streaming endpoints live here.
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException, Query
from starlette.responses import StreamingResponse

from core import config
from core.config import (
    OPENCODE_URL,
    MODEL_PROVIDER,
    MODEL_ID,
    SERVER_CALLBACK_URL,
    USER_AUTH_TOKEN,
    get_auth,
    get_session_model,
    load_available_opencode_models,
)
from core.models import (
    CreateSessionRequest,
    UpdateSessionRequest,
    ChatRequest,
    SessionModelUpdate,
    SystemPromptUpdate,
)
from core.state import (
    chat_sessions,
    active_alerts,
    active_chat_tasks,
    active_chat_streams,
    session_stop_flags,
    plans,
    runs,
    sweeps,
    save_chat_state,
)

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_prompt_skill_manager = None
_get_opencode_session_for_chat = None
_fetch_opencode_session_title = None
_send_prompt_to_opencode = None
_stream_opencode_events = None
_should_stop_session = None
_append_runtime_event = None
_persist_active_stream_snapshot = None
_finalize_runtime = None
_stream_runtime_events = None
_ChatStreamRuntime = None
_recompute_all_sweep_states = None
_agent_runtime = None


def init(
    prompt_skill_manager,
    get_opencode_session_for_chat_fn,
    fetch_opencode_session_title_fn,
    send_prompt_to_opencode_fn,
    stream_opencode_events_fn,
    should_stop_session_fn,
    append_runtime_event_fn,
    persist_active_stream_snapshot_fn,
    finalize_runtime_fn,
    stream_runtime_events_fn,
    chat_stream_runtime_cls,
    recompute_all_sweep_states_fn,
    agent_runtime=None,
):
    """Wire in shared callbacks from server.py."""
    global _prompt_skill_manager
    global _get_opencode_session_for_chat, _fetch_opencode_session_title
    global _send_prompt_to_opencode, _stream_opencode_events, _should_stop_session
    global _append_runtime_event, _persist_active_stream_snapshot
    global _finalize_runtime, _stream_runtime_events, _ChatStreamRuntime
    global _recompute_all_sweep_states, _agent_runtime

    _prompt_skill_manager = prompt_skill_manager
    _get_opencode_session_for_chat = get_opencode_session_for_chat_fn
    _fetch_opencode_session_title = fetch_opencode_session_title_fn
    _send_prompt_to_opencode = send_prompt_to_opencode_fn
    _stream_opencode_events = stream_opencode_events_fn
    _should_stop_session = should_stop_session_fn
    _append_runtime_event = append_runtime_event_fn
    _persist_active_stream_snapshot = persist_active_stream_snapshot_fn
    _finalize_runtime = finalize_runtime_fn
    _stream_runtime_events = stream_runtime_events_fn
    _ChatStreamRuntime = chat_stream_runtime_cls
    _recompute_all_sweep_states = recompute_all_sweep_states_fn
    _agent_runtime = agent_runtime


# ---------------------------------------------------------------------------
# Session CRUD
# ---------------------------------------------------------------------------

@router.get("/sessions")
async def list_sessions():
    """List all chat sessions."""
    def resolve_session_status(session_id: str, session: dict[str, Any]) -> str:
        has_pending_human_input = any(
            alert.get("status") == "pending" and alert.get("session_id") == session_id
            for alert in active_alerts.values()
        )
        if has_pending_human_input:
            return "awaiting_human"

        runtime = active_chat_streams.get(session_id)
        if runtime and runtime.status == "running":
            return "running"

        raw_status = (runtime.status if runtime else None) or session.get("last_status")
        if raw_status in {"failed", "error"}:
            return "failed"
        if raw_status in {"stopped", "interrupted"}:
            return "questionable"
        if session.get("messages"):
            return "completed"
        return "idle"

    sessions = []
    for sid, session in chat_sessions.items():
        if not isinstance(session, dict):
            continue
        session_model_provider, session_model_id = get_session_model(session)
        sessions.append({
            "id": sid,
            "title": session.get("title", "New Chat"),
            "created_at": session.get("created_at"),
            "message_count": len(session.get("messages", [])),
            "model_provider": session_model_provider,
            "model_id": session_model_id,
            "status": resolve_session_status(sid, session),
        })
    sessions.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return sessions


@router.get("/models")
async def list_models():
    """List available model options from opencode config."""
    return load_available_opencode_models()


@router.post("/sessions")
async def create_session(req: Optional[CreateSessionRequest] = None):
    """Create a new chat session."""
    requested_provider = req.model_provider if req else None
    requested_model_id = req.model_id if req else None
    session_model_provider = str(requested_provider or MODEL_PROVIDER).strip() or MODEL_PROVIDER
    session_model_id = str(requested_model_id or MODEL_ID).strip() or MODEL_ID
    session_id = uuid.uuid4().hex[:12]
    title = req.title if req and req.title else "New Chat"
    chat_sessions[session_id] = {
        "title": title,
        "created_at": time.time(),
        "messages": [],
        "opencode_session_id": None,
        "system_prompt": "",
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "last_status": "idle",
    }
    save_chat_state()
    return {
        "id": session_id,
        "title": title,
        "created_at": chat_sessions[session_id]["created_at"],
        "message_count": 0,
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "status": "idle",
    }


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a chat session with all messages."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    session_model_provider, session_model_id = get_session_model(session)
    runtime = active_chat_streams.get(session_id)
    active_stream = runtime.snapshot() if runtime and runtime.status == "running" else session.get("active_stream")
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", []),
        "system_prompt": session.get("system_prompt", ""),
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "active_stream": active_stream,
    }


@router.patch("/sessions/{session_id}")
async def update_session(session_id: str, req: UpdateSessionRequest):
    """Update a chat session (e.g. rename)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    chat_sessions[session_id]["title"] = req.title
    save_chat_state()
    session = chat_sessions[session_id]
    session_model_provider, session_model_id = get_session_model(session)
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "message_count": len(session.get("messages", [])),
        "model_provider": session_model_provider,
        "model_id": session_model_id,
    }


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session and stop its L1 agent if any."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    # Stop L1 SessionAgent for this chat session (if wild mode was used)
    try:
        from agent.wild_routes import _stop_session_agent
        await _stop_session_agent(session_id)
    except Exception as e:
        logger.warning("Failed to stop L1 for deleted session %s: %s", session_id, e)
    del chat_sessions[session_id]
    save_chat_state()
    return {"message": "Session deleted"}


@router.get("/sessions/{session_id}/system-prompt")
async def get_system_prompt(session_id: str):
    """Get the system prompt for a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"system_prompt": chat_sessions[session_id].get("system_prompt", "")}


@router.get("/sessions/{session_id}/model")
async def get_session_model_endpoint(session_id: str):
    """Get the provider/model configured for this session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    if not isinstance(session, dict):
        raise HTTPException(status_code=500, detail="Session data is invalid")
    provider_id, model_id = get_session_model(session)
    return {"provider_id": provider_id, "model_id": model_id}


@router.put("/sessions/{session_id}/model")
async def update_session_model(session_id: str, req: SessionModelUpdate):
    """Update provider/model for subsequent prompts in a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    provider_id = str(req.provider_id or "").strip()
    model_id = str(req.model_id or "").strip()
    if not provider_id or not model_id:
        raise HTTPException(status_code=400, detail="provider_id and model_id are required")

    session = chat_sessions[session_id]
    if not isinstance(session, dict):
        raise HTTPException(status_code=500, detail="Session data is invalid")
    session["model_provider"] = provider_id
    session["model_id"] = model_id
    save_chat_state()
    return {"provider_id": provider_id, "model_id": model_id}


@router.put("/sessions/{session_id}/system-prompt")
async def update_system_prompt(session_id: str, req: SystemPromptUpdate):
    """Update the system prompt for a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    chat_sessions[session_id]["system_prompt"] = req.system_prompt
    save_chat_state()
    return {"system_prompt": req.system_prompt}


# ---------------------------------------------------------------------------
# Mode Registry: data-driven prompt builder
# ---------------------------------------------------------------------------

@dataclass
class ModeConfig:
    """Declares how to build a mode-specific prompt preamble."""
    skill_id: str
    build_state: Callable[[str], dict]  # (message) -> template variables


def _build_experiment_context() -> str:
    """Build a summary of current experiment state for mode prompts."""
    lines = ["\n--- Current Experiment State ---"]
    _recompute_all_sweep_states()

    active_runs = [{"id": rid, **r} for rid, r in runs.items()
                   if r.get("status") in ["running", "queued", "launching"]]
    finished_runs = [{"id": rid, **r} for rid, r in runs.items()
                     if r.get("status") == "finished"]
    failed_runs = [{"id": rid, **r} for rid, r in runs.items()
                   if r.get("status") == "failed"]

    lines.append(f"Active runs: {len(active_runs)}")
    for r in active_runs[:5]:
        lines.append(f"  - {r['id']}: {r.get('name', '?')} [{r.get('status')}] cmd={r.get('command', '')[:80]}")
    lines.append(f"Finished runs: {len(finished_runs)} | Failed runs: {len(failed_runs)}")
    for r in failed_runs[:3]:
        lines.append(f"  - FAILED {r['id']}: {r.get('name', '?')} error={r.get('error', 'unknown')[:100]}")

    active_sweeps = [{"id": sid, **s} for sid, s in sweeps.items()]
    if active_sweeps:
        lines.append(f"Sweeps: {len(active_sweeps)}")
        for s in active_sweeps[:3]:
            p = s.get("progress", {})
            lines.append(f"  - {s['id']}: {s.get('name', '?')} "
                         f"[{p.get('completed', 0)}/{p.get('total', 0)} done, {p.get('failed', 0)} failed]")

    pending_alerts = [a for a in active_alerts.values() if a.get("status") == "pending"]
    if pending_alerts:
        lines.append(f"Pending alerts: {len(pending_alerts)}")
        for a in pending_alerts[:3]:
            lines.append(f"  - {a['id']}: [{a.get('severity')}] {a.get('message', '')[:80]}")

    lines.append("--- End State ---\n")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Scoped @Reference Resolution
# ---------------------------------------------------------------------------

_REFERENCE_RE = re.compile(r"@(run|sweep|alert|chat):[A-Za-z0-9:._-]+")


def _parse_references(message: str) -> List[Tuple[str, str]]:
    """Extract deduplicated (type, id) tuples from @type:id references."""
    seen: set[str] = set()
    results: List[Tuple[str, str]] = []
    for match in _REFERENCE_RE.finditer(message):
        token = match.group(0)  # e.g. "@run:abc123"
        if token in seen:
            continue
        seen.add(token)
        ref_body = match.group(1)  # "run" from group, but we need full after @
        # Split on first colon to get type and id
        parts = token[1:].split(":", 1)  # strip leading @
        if len(parts) == 2:
            results.append((parts[0], parts[1]))
    return results


def _resolve_run_context(ref_id: str) -> str:
    """Build detailed context for a single run, including FileStore data."""
    run = runs.get(ref_id)
    if not run:
        return f"=== @run:{ref_id} — Not Found ===\n"

    lines = [f"=== @run:{ref_id} — Detailed Context ==="]
    lines.append(f"Name: {run.get('name', '?')}")
    lines.append(f"Status: {run.get('status', '?')}")
    lines.append(f"Command: {run.get('command', '?')}")
    if run.get("workdir"):
        lines.append(f"Workdir: {run['workdir']}")
    if run.get("exit_code") is not None:
        lines.append(f"Exit code: {run['exit_code']}")
    if run.get("error"):
        lines.append(f"Error: {run['error']}")
    if run.get("sweep_id"):
        lines.append(f"Sweep: {run['sweep_id']}")
    if run.get("created_at"):
        lines.append(f"Created: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(run['created_at']))}")
    agent_id = run.get("agent_id")
    if agent_id:
        lines.append(f"Agent: {agent_id}")

    # FileStore data (if agent_runtime is available)
    if _agent_runtime and agent_id:
        store = _agent_runtime.store
        try:
            from agentsys.types import EntryType

            # Results
            results = store.query(agent_id=agent_id, type=EntryType.RESULT, limit=5)
            lines.append("\n-- Agent Results --")
            if results:
                for entry in results:
                    data = entry.data or {}
                    summary = ", ".join(f"{k}: {v}" for k, v in list(data.items())[:6])
                    lines.append(f"  [{entry.type.value}] {summary[:200]}")
            else:
                lines.append("  (none)")

            # Metrics
            metrics = store.query(agent_id=agent_id, type=EntryType.METRICS, limit=10)
            lines.append("\n-- Agent Metrics --")
            if metrics:
                for entry in metrics[:5]:
                    data = entry.data or {}
                    summary = ", ".join(f"{k}: {v}" for k, v in list(data.items())[:6])
                    lines.append(f"  [{entry.type.value}] {summary[:200]}")
            else:
                lines.append("  (none)")

            # Alerts
            alerts = store.query(agent_id=agent_id, type=EntryType.ALERT, limit=5)
            lines.append("\n-- Agent Alerts --")
            if alerts:
                for entry in alerts:
                    data = entry.data or {}
                    msg = data.get("message", str(data)[:150])
                    lines.append(f"  [{entry.type.value}] {msg[:200]}")
            else:
                lines.append("  (none)")
        except Exception as e:
            lines.append(f"\n-- FileStore query error: {e} --")

    # Tail run.log if available
    run_dir = run.get("run_dir")
    if run_dir:
        log_path = os.path.join(run_dir, "run.log")
        if os.path.isfile(log_path):
            try:
                with open(log_path, "r", errors="replace") as f:
                    f.seek(0, 2)
                    size = f.tell()
                    start = max(0, size - 2000)
                    f.seek(start)
                    tail = f.read()
                lines.append("\n-- Run Log (last 2000 chars) --")
                lines.append(tail.strip())
            except Exception as e:
                lines.append(f"\n-- Could not read run.log: {e} --")

    lines.append(f"=== End @run:{ref_id} ===")
    return "\n".join(lines)


def _resolve_sweep_context(ref_id: str) -> str:
    """Build detailed context for a sweep, including child runs."""
    sweep = sweeps.get(ref_id)
    if not sweep:
        return f"=== @sweep:{ref_id} — Not Found ===\n"

    lines = [f"=== @sweep:{ref_id} — Detailed Context ==="]
    lines.append(f"Name: {sweep.get('name', '?')}")
    lines.append(f"Status: {sweep.get('status', '?')}")
    if sweep.get("base_command"):
        lines.append(f"Base command: {sweep['base_command']}")
    if sweep.get("parameters"):
        lines.append(f"Parameters: {json.dumps(sweep['parameters'], default=str)[:300]}")
    progress = sweep.get("progress", {})
    if progress:
        lines.append(f"Progress: {progress.get('completed', 0)}/{progress.get('total', 0)} done, {progress.get('failed', 0)} failed")

    # Child runs
    child_run_ids = sweep.get("run_ids", [])
    child_runs = [(rid, runs.get(rid)) for rid in child_run_ids if runs.get(rid)]
    lines.append(f"\n-- Child Runs ({len(child_runs)} total, showing up to 20) --")
    for rid, r in child_runs[:20]:
        status = r.get("status", "?")
        exit_code = r.get("exit_code")
        error = r.get("error", "")
        line = f"  {rid}: {r.get('name', '?')} [{status}]"
        if exit_code is not None:
            line += f" exit={exit_code}"
        if error:
            line += f" error={error[:80]}"
        lines.append(line)

        # Brief FileStore result per child (limit=1)
        agent_id = r.get("agent_id")
        if _agent_runtime and agent_id:
            try:
                from agentsys.types import EntryType
                child_results = _agent_runtime.store.query(agent_id=agent_id, type=EntryType.RESULT, limit=1)
                if child_results:
                    data = child_results[0].data or {}
                    summary = ", ".join(f"{k}: {v}" for k, v in list(data.items())[:4])
                    lines.append(f"    result: {summary[:150]}")
            except Exception:
                pass

    # Coordinator agent results
    coordinator_agent_id = sweep.get("agent_id")
    if _agent_runtime and coordinator_agent_id:
        try:
            from agentsys.types import EntryType
            coord_results = _agent_runtime.store.query(agent_id=coordinator_agent_id, type=EntryType.RESULT, limit=5)
            if coord_results:
                lines.append("\n-- Coordinator Results --")
                for entry in coord_results:
                    data = entry.data or {}
                    summary = ", ".join(f"{k}: {v}" for k, v in list(data.items())[:6])
                    lines.append(f"  [{entry.type.value}] {summary[:200]}")
        except Exception:
            pass

    lines.append(f"=== End @sweep:{ref_id} ===")
    return "\n".join(lines)


def _resolve_alert_context(ref_id: str) -> str:
    """Build detailed context for a single alert."""
    alert = active_alerts.get(ref_id)
    if not alert:
        return f"=== @alert:{ref_id} — Not Found ===\n"

    lines = [f"=== @alert:{ref_id} — Detailed Context ==="]
    lines.append(f"Severity: {alert.get('severity', '?')}")
    lines.append(f"Message: {alert.get('message', '?')}")
    lines.append(f"Status: {alert.get('status', '?')}")
    if alert.get("choices"):
        lines.append(f"Choices: {alert['choices']}")
    if alert.get("response"):
        lines.append(f"Response: {alert['response']}")
    if alert.get("suggested_actions"):
        lines.append(f"Suggested actions: {alert['suggested_actions']}")
    if alert.get("run_id"):
        linked_run = runs.get(alert["run_id"])
        if linked_run:
            lines.append(f"Linked run: {alert['run_id']} ({linked_run.get('name', '?')}) [{linked_run.get('status', '?')}]")
    lines.append(f"=== End @alert:{ref_id} ===")
    return "\n".join(lines)


def _resolve_chat_context(ref_id: str) -> str:
    """Build context from a referenced chat session (last 10 messages)."""
    session = chat_sessions.get(ref_id)
    if not session:
        return f"=== @chat:{ref_id} — Not Found ===\n"

    lines = [f"=== @chat:{ref_id} — Chat Context ==="]
    lines.append(f"Title: {session.get('title', 'Untitled')}")
    messages = session.get("messages", [])
    recent = messages[-10:]
    for msg in recent:
        role = msg.get("role", "?")
        content = str(msg.get("content", ""))[:500]
        lines.append(f"  [{role}] {content}")
    if not recent:
        lines.append("  (no messages)")
    lines.append(f"=== End @chat:{ref_id} ===")
    return "\n".join(lines)


_REFERENCE_RESOLVERS = {
    "run": _resolve_run_context,
    "sweep": _resolve_sweep_context,
    "alert": _resolve_alert_context,
    "chat": _resolve_chat_context,
}


def _resolve_scoped_context(message: str) -> str:
    """Parse @references in message and return scoped context block.

    Returns empty string if no references found (backward compatible).
    """
    refs = _parse_references(message)
    if not refs:
        return ""

    sections: List[str] = []
    for ref_type, ref_id in refs:
        resolver = _REFERENCE_RESOLVERS.get(ref_type)
        if resolver:
            sections.append(resolver(ref_id))
        else:
            sections.append(f"=== @{ref_type}:{ref_id} — Unknown reference type ===\n")

    return (
        "\n--- Referenced Context (resolved from @mentions) ---\n\n"
        + "\n\n".join(sections)
        + "\n\n--- End Referenced Context ---\n"
    )


def _build_agent_state(message: str) -> dict:
    """Build template variables for agent (default chat) mode."""
    scoped = _resolve_scoped_context(message)
    return {
        "experiment_context": scoped + _build_experiment_context(),
        "server_url": SERVER_CALLBACK_URL,
        "auth_token": USER_AUTH_TOKEN or "",
    }


def _build_plan_state(message: str) -> dict:
    """Build template variables for plan mode."""
    scoped = _resolve_scoped_context(message)
    # Summarize existing plans for context
    existing_plans_summary = "No existing plans."
    if plans:
        lines = []
        for p in sorted(plans.values(), key=lambda x: x.get("created_at", 0), reverse=True)[:5]:
            lines.append(f"- **{p.get('title', 'Untitled')}** ({p.get('status', 'draft')}): {p.get('goal', '')[:100]}")
        existing_plans_summary = "\n".join(lines)
    return {
        "goal": message,
        "experiment_context": scoped + _build_experiment_context(),
        "existing_plans": existing_plans_summary,
        "server_url": SERVER_CALLBACK_URL,
        "auth_token": USER_AUTH_TOKEN or "",
    }


MODE_REGISTRY: Dict[str, ModeConfig] = {
    "agent": ModeConfig(skill_id="ra_mode_agent", build_state=_build_agent_state),
    "plan": ModeConfig(skill_id="ra_mode_plan", build_state=_build_plan_state),
}


def _build_chat_prompt(session: dict, message: str, mode: str = "agent", session_id: Optional[str] = None) -> tuple:
    """Build the full prompt for a chat turn, prepending mode-specific preamble.

    Returns (content: str, provenance: dict | None).
    provenance follows the PromptProvenance shape used by the frontend.
    """
    mode_note = ""
    provenance = None

    config = MODE_REGISTRY.get(mode)
    if config:
        variables = config.build_state(message)
        skill = _prompt_skill_manager.get(config.skill_id)
        rendered = _prompt_skill_manager.render(config.skill_id, variables)
        if rendered:
            mode_note = rendered + "\n\n"
            provenance = {
                "rendered": rendered,
                "user_input": message,
                "skill_id": config.skill_id,
                "skill_name": skill.get("name", config.skill_id) if skill else config.skill_id,
                "template": skill.get("template") if skill else None,
                "variables": variables,
                "prompt_type": mode,
            }
        else:
            logger.warning(f"{config.skill_id} prompt skill not found — sending raw message")

    # For agent mode (no config / no skill), build a simple provenance
    if provenance is None and mode != "wild":
        provenance = {
            "rendered": message,
            "user_input": message,
            "skill_id": None,
            "skill_name": None,
            "template": None,
            "variables": {},
            "prompt_type": mode,
        }

    chat_linking_note = ""
    if session_id:
        chat_linking_note = (
            "[CHAT LINKAGE]\n"
            "For experiment API creations (`POST /runs`, `POST /sweeps`, "
            "`POST /sweeps/wild`, `POST /sweeps/{id}/runs`), include "
            f"`\"chat_session_id\": \"{session_id}\"` in JSON bodies.\n"
            "Use `null` only when intentionally creating entities not tied to this chat.\n"
            "[/CHAT LINKAGE]\n\n"
        )

    content = f"{chat_linking_note}{mode_note}[USER] {message}"
    session_system_prompt = str(session.get("system_prompt", "")).strip()
    if session_system_prompt:
        content = f"[SYSTEM INSTRUCTIONS]\n{session_system_prompt}\n[/SYSTEM INSTRUCTIONS]\n\n{content}"
    if provenance is not None:
        provenance["rendered"] = content
    return content, provenance


# ---------------------------------------------------------------------------
# Chat Worker
# ---------------------------------------------------------------------------

def _log_background_chat_task(task: asyncio.Task) -> None:
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("Failed to inspect background chat task")
        return

    if exc:
        logger.error("Background chat worker failed: %s", exc, exc_info=(type(exc), exc, exc.__traceback__))


async def _chat_worker(session_id: str, content: str, runtime, *, mode: str = "agent") -> None:
    """Run the OpenCode stream for a chat session independent of HTTP clients."""
    session_stop_flags.pop(session_id, None)
    logger.debug("Starting background chat worker for session %s run %s (mode=%s)", session_id, runtime.run_id, mode)

    try:
        session = chat_sessions.get(session_id)
        session_model_provider = MODEL_PROVIDER
        session_model_id = MODEL_ID
        if isinstance(session, dict):
            session_model_provider, session_model_id = get_session_model(session)

        opencode_session_id = await _get_opencode_session_for_chat(session_id)
        async with httpx.AsyncClient(timeout=None) as client:
            logger.debug("Sending prompt to OpenCode session %s", opencode_session_id)
            logger.debug("Content: %s", content)
            await _send_prompt_to_opencode(
                client,
                opencode_session_id,
                content,
                session_model_provider,
                session_model_id,
            )
            logger.debug("Sent prompt to OpenCode session %s", opencode_session_id)

            async for event, _text_delta, _thinking_delta, _tool_update in _stream_opencode_events(client, opencode_session_id):
                if _should_stop_session(session_id):
                    runtime.status = "stopped"
                    break

                await _append_runtime_event(runtime, event)
                _persist_active_stream_snapshot(session_id, runtime)

        if _should_stop_session(session_id):
            runtime.status = "stopped"
    except asyncio.CancelledError:
        runtime.status = "stopped"
        logger.info("Background chat worker cancelled for session %s", session_id)
    except Exception as e:
        runtime.status = "failed"
        runtime.error = str(e)
        logger.error("Chat worker failed for session %s: %s", session_id, e, exc_info=True)
        await _append_runtime_event(runtime, {"type": "error", "message": str(e)})
    finally:
        parts = runtime.parts_accumulator.finalize()
        if runtime.full_text or runtime.full_thinking or parts:
            session = chat_sessions.get(session_id)
            if isinstance(session, dict):
                # Keep ALL parts (including text) to preserve the interleaved
                # order of text, thinking, and tool outputs.  The 'content'
                # and 'thinking' fields are convenience aggregates.
                assistant_msg = {
                    "role": "assistant",
                    "content": runtime.full_text.strip(),
                    "thinking": runtime.full_thinking.strip() if runtime.full_thinking else None,
                    "parts": parts if parts else None,
                    "timestamp": time.time(),
                }
                session.setdefault("messages", []).append(assistant_msg)


        # L1 post-processing: parse spawn/steer/stop actions from wild/auto mode responses
        if mode in ("wild", "auto") and runtime.full_text:
            try:
                from agent.wild_routes import _get_session_agent
                agent = _get_session_agent(session_id)
                if agent:
                    actions = await agent.handle_llm_response(runtime.full_text)
                    for action in actions:
                        await _append_runtime_event(runtime, {"type": "l1_action", **action})
                    if actions:
                        logger.info("[chat-worker] L1 executed %d actions for session %s", len(actions), session_id)
            except Exception as e:
                logger.error("[chat-worker] L1 post-processing failed for session %s: %s", session_id, e, exc_info=True)

        # Auto-name: fetch title from OpenCode only once (after the first exchange)
        session = chat_sessions.get(session_id)
        if isinstance(session, dict) and not session.get("title"):
            opencode_sid = session.get("opencode_session_id")
            if opencode_sid:
                oc_title = await _fetch_opencode_session_title(opencode_sid)
                if oc_title:
                    session["title"] = oc_title
                    logger.info("Auto-named chat %s from OpenCode: %s", session_id, oc_title)

        session = chat_sessions.get(session_id)
        if isinstance(session, dict):
            session["last_status"] = runtime.status
            session["last_error"] = runtime.error
            session.pop("active_stream", None)
        save_chat_state()

        await _append_runtime_event(runtime, {"type": "session_status", "status": "idle"})
        await _finalize_runtime(session_id, runtime)

        active_chat_tasks.pop(session_id, None)
        session_stop_flags.pop(session_id, None)
        logger.debug("Background chat worker finished for session %s run %s", session_id, runtime.run_id)


async def _start_chat_worker(session_id: str, content: str, mode: str = "agent"):
    existing = active_chat_streams.get(session_id)
    if existing and existing.status == "running":
        raise HTTPException(status_code=409, detail="Session already has an active response")
    if existing:
        await _finalize_runtime(session_id, existing, retain=False)

    runtime = _ChatStreamRuntime(session_id)
    active_chat_streams[session_id] = runtime
    _persist_active_stream_snapshot(session_id, runtime, force=True)

    task = asyncio.create_task(_chat_worker(session_id, content, runtime, mode=mode))
    active_chat_tasks[session_id] = task
    task.add_done_callback(_log_background_chat_task)
    return runtime


async def trigger_synthetic_chat_turn(
    session_id: str,
    system_message: str,
    *,
    mode: str = "auto",
) -> None:
    """Trigger a synthetic chat turn from the system (not user-initiated).

    Used by L1's reactive callback when a child (L2/L3) finishes.
    Builds an L1 prompt with the system message injected, runs it through
    OpenCode, and streams the response. The frontend picks it up via SSE.

    Args:
        session_id: Chat session ID.
        system_message: System-generated message with child results.
        mode: Chat mode for prompt selection (auto/wild).
    """
    session = chat_sessions.get(session_id)
    if not session or not isinstance(session, dict):
        logger.warning("[synthetic-turn] Session %s not found, skipping", session_id)
        return

    # Check if there's already an active stream — if so, skip to avoid conflict
    existing = active_chat_streams.get(session_id)
    if existing and existing.status == "running":
        logger.info("[synthetic-turn] Session %s has active stream, deferring", session_id)
        return

    # Build the L1 prompt with the system message
    from agent.wild_routes import _get_session_agent
    agent = _get_session_agent(session_id)
    if not agent:
        logger.warning("[synthetic-turn] No L1 agent for session %s", session_id)
        return

    skill_id = "l1_wild_session" if mode == "wild" else "l1_auto_session"
    content, provenance = await agent.build_wild_prompt(
        system_message, session_id, _prompt_skill_manager, skill_id=skill_id
    )

    # Record the system message in session history
    session.setdefault("messages", []).append({
        "role": "system",
        "content": system_message,
        "timestamp": time.time(),
        "synthetic": True,
    })

    # Start background chat worker (same as user-initiated)
    try:
        runtime = await _start_chat_worker(session_id, content, mode=mode)
        if provenance:
            await _append_runtime_event(runtime, {"type": "provenance", "synthetic": True, **provenance})
        logger.info("[synthetic-turn] Started synthetic chat turn for session %s", session_id)
    except Exception as e:
        logger.error("[synthetic-turn] Failed to start synthetic turn for %s: %s", session_id, e)



# ---------------------------------------------------------------------------
# Chat Streaming Endpoints
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}/stream")
async def stream_session(session_id: str, from_seq: int = Query(1, ge=1), run_id: Optional[str] = Query(None)):
    """Attach/re-attach to an in-flight chat stream with catch-up replay."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _stream_runtime_events(session_id, from_seq=from_seq, run_id=run_id),
        media_type="application/x-ndjson",
    )


@router.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message, start background generation, and attach to the stream."""
    session_id = req.session_id

    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    existing_runtime = active_chat_streams.get(session_id)
    if existing_runtime and existing_runtime.status == "running":
        raise HTTPException(status_code=409, detail="Session already has an active response")

    session = chat_sessions[session_id]
    messages = session.get("messages", [])

    user_msg = {"role": "user", "content": req.message, "timestamp": time.time()}
    messages.append(user_msg)
    session["messages"] = messages

    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")

    save_chat_state()

    # Resolve mode: prefer explicit mode field, fall back to legacy booleans
    effective_mode = req.mode
    if effective_mode == "agent":
        if req.wild_mode:
            effective_mode = "wild"
        elif req.plan_mode:
            effective_mode = "plan"
    llm_input = req.prompt_override if req.prompt_override else req.message

    if effective_mode in ("wild", "auto"):
        # Route through L1 SessionAgent — per-session registry
        from agent.wild_routes import _get_or_create_session_agent
        agent = _get_or_create_session_agent(session_id)
        # wild = forced research (l1_wild_session), auto = agent decides (l1_auto_session)
        skill_id = "l1_wild_session" if effective_mode == "wild" else "l1_auto_session"
        content, provenance = await agent.build_wild_prompt(
            llm_input, session_id, _prompt_skill_manager, skill_id=skill_id
        )
    else:
        content, provenance = _build_chat_prompt(session, llm_input, effective_mode, session_id=session_id)
    runtime = await _start_chat_worker(session_id, content, mode=effective_mode)

    # Emit provenance as the first SSE event so the frontend can attach it
    if provenance:
        await _append_runtime_event(runtime, {"type": "provenance", **provenance})

    return StreamingResponse(
        _stream_runtime_events(session_id, from_seq=1, run_id=runtime.run_id),
        media_type="application/x-ndjson",
    )


@router.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    """Stop streaming for a session (including auto-alert tasks)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session_stop_flags[session_id] = True
    runtime = active_chat_streams.get(session_id)
    if runtime and runtime.status == "running":
        runtime.status = "stopped"
        _persist_active_stream_snapshot(session_id, runtime, force=True)

    task = active_chat_tasks.get(session_id)
    # For legacy/auto-alert tasks we still cancel directly. Chat workers stop via flag + abort call below.
    if task and not task.done() and runtime is None:
        task.cancel()

    # Also abort the OpenCode session so the model actually stops generating
    opencode_session_id = chat_sessions[session_id].get("opencode_session_id")
    if opencode_session_id:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(
                    f"{OPENCODE_URL}/session/{opencode_session_id}/abort",
                    auth=get_auth()
                )
                logger.info(f"Aborted OpenCode session {opencode_session_id}: {resp.status_code}")
        except Exception as e:
            logger.warning(f"Failed to abort OpenCode session {opencode_session_id}: {e}")

    return {"message": "Stop signal sent"}
