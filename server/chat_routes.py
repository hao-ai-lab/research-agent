"""
Research Agent Server — Chat Endpoints

Extracted from server.py. Session CRUD, mode registry, chat worker,
and streaming endpoints live here.
"""

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from starlette.responses import StreamingResponse

import config
from config import (
    OPENCODE_URL,
    MODEL_PROVIDER,
    MODEL_ID,
    SERVER_CALLBACK_URL,
    USER_AUTH_TOKEN,
    get_auth,
    get_session_model,
    load_available_opencode_models,
)
from models import (
    CreateSessionRequest,
    UpdateSessionRequest,
    ChatRequest,
    SessionModelUpdate,
    SystemPromptUpdate,
)
from state import (
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
_wild_v2_engine = None


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
    wild_v2_engine,
):
    """Wire in shared callbacks from server.py."""
    global _prompt_skill_manager
    global _get_opencode_session_for_chat, _fetch_opencode_session_title
    global _send_prompt_to_opencode, _stream_opencode_events, _should_stop_session
    global _append_runtime_event, _persist_active_stream_snapshot
    global _finalize_runtime, _stream_runtime_events, _ChatStreamRuntime
    global _recompute_all_sweep_states, _wild_v2_engine

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
    _wild_v2_engine = wild_v2_engine


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
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
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


def _build_agent_state(_message: str) -> dict:
    """Build template variables for agent (default chat) mode."""
    return {
        "experiment_context": _build_experiment_context(),
        "server_url": SERVER_CALLBACK_URL,
        "auth_token": USER_AUTH_TOKEN or "",
    }


def _build_plan_state(message: str) -> dict:
    """Build template variables for plan mode."""
    # Summarize existing plans for context
    existing_plans_summary = "No existing plans."
    if plans:
        lines = []
        for p in sorted(plans.values(), key=lambda x: x.get("created_at", 0), reverse=True)[:5]:
            lines.append(f"- **{p.get('title', 'Untitled')}** ({p.get('status', 'draft')}): {p.get('goal', '')[:100]}")
        existing_plans_summary = "\n".join(lines)
    return {
        "goal": message,
        "experiment_context": _build_experiment_context(),
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


async def _send_chat_for_v2(chat_session_id: str, prompt: str, display_message: str) -> str:
    """Route a V2 iteration through the frontend's chat session for live streaming.

    1. Adds a user message to the chat session (so the frontend shows the iteration)
    2. Starts the chat worker (which streams the response via SSE)
    3. Waits for completion
    4. Returns the full response text

    This is the callback passed to WildV2Engine.send_chat_message.
    """
    logger.info("[wild-v2-chat] _send_chat_for_v2 called: session=%s, prompt_len=%d, display=%s",
                chat_session_id, len(prompt), display_message)

    if chat_session_id not in chat_sessions:
        logger.error("[wild-v2-chat] Chat session %s not found!", chat_session_id)
        raise ValueError(f"Chat session {chat_session_id} not found")

    session = chat_sessions[chat_session_id]

    # Check if there's already an active stream on this session
    existing_runtime = active_chat_streams.get(chat_session_id)
    if existing_runtime and existing_runtime.status == "running":
        logger.warning("[wild-v2-chat] Session %s already has an active stream (run=%s), waiting for it to finish...",
                       chat_session_id, existing_runtime.run_id)
        # Wait for the existing task to complete before starting a new one
        existing_task = active_chat_tasks.get(chat_session_id)
        if existing_task:
            try:
                await existing_task
                logger.info("[wild-v2-chat] Previous task finished, proceeding")
            except Exception:
                logger.warning("[wild-v2-chat] Previous task failed, proceeding anyway")

    # Add user message showing the iteration context
    user_msg = {
        "role": "user",
        "content": display_message,
        "timestamp": time.time(),
        "wild_v2": True,
    }
    session.setdefault("messages", []).append(user_msg)
    save_chat_state()
    logger.debug("[wild-v2-chat] Added user message to chat session")

    # Start the chat worker — this sends the full prompt to OpenCode and streams
    # the response via SSE, so the frontend picks it up live
    logger.info("[wild-v2-chat] Starting chat worker for session %s", chat_session_id)
    runtime = await _start_chat_worker(chat_session_id, prompt, mode="agent")
    logger.info("[wild-v2-chat] Chat worker started: run_id=%s", runtime.run_id)

    # Wait for the background task to finish
    task = active_chat_tasks.get(chat_session_id)
    if task:
        logger.info("[wild-v2-chat] Waiting for chat worker task to complete...")
        try:
            await task
            logger.info("[wild-v2-chat] Chat worker task completed successfully")
        except Exception as err:
            logger.error("[wild-v2-chat] Chat worker task failed: %s", err, exc_info=True)
    else:
        logger.warning("[wild-v2-chat] No task found in active_chat_tasks for session %s", chat_session_id)

    full_text = runtime.full_text or ""
    logger.info("[wild-v2-chat] Got %d chars from chat session %s (status=%s)",
                len(full_text), chat_session_id, runtime.status)
    return full_text


def wire_v2_engine():
    """Wire the chat streaming callback into the V2 engine. Called after init()."""
    if _wild_v2_engine:
        _wild_v2_engine._send_chat_message = _send_chat_for_v2


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
