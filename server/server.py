#!/usr/bin/env python3
"""
Research Agent Server

Provides:
- Multi-session chat management with OpenCode integration
- Tmux-based job scheduling and monitoring
- Real-time log streaming

Run with: python server.py --workdir /path/to/project
"""

import argparse
import json
import os
import sys
import time
import uuid
import logging
from typing import Dict, Optional, AsyncIterator, List

import httpx
import uvicorn
import libtmux
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

# Configure logging
# logging.basicConfig(level=logging.INFO)
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("research-agent-server")

# =============================================================================
# Configuration
# =============================================================================

# OpenCode configuration
_SERVER_FILE_DIR = os.path.dirname(os.path.abspath(__file__))
OPENCODE_CONFIG = os.environ.get("OPENCODE_CONFIG", os.path.join(_SERVER_FILE_DIR, "opencode.json"))
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD")

# Model configuration - uses research-agent provider from opencode.json
# This connects to the Anthropic gateway at Modal
MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "research-agent")
MODEL_ID = os.environ.get("MODEL_ID", "claude-3-5-haiku-latest")

# User authentication token - if set, all API requests must include X-Auth-Token header
USER_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN")

# Will be set by CLI args
WORKDIR = os.getcwd()
DATA_DIR = ""
CHAT_DATA_FILE = ""
JOBS_DATA_FILE = ""
TMUX_SESSION_NAME = "research-agent"


def init_paths(workdir: str):
    """Initialize all paths based on workdir."""
    global WORKDIR, DATA_DIR, CHAT_DATA_FILE, JOBS_DATA_FILE
    WORKDIR = os.path.abspath(workdir)
    DATA_DIR = os.path.join(WORKDIR, ".agents")
    CHAT_DATA_FILE = os.path.join(DATA_DIR, "chat_data.json")
    JOBS_DATA_FILE = os.path.join(DATA_DIR, "jobs.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "runs"), exist_ok=True)
    logger.info(f"Initialized with workdir: {WORKDIR}")
    # Change the current working directory to the workdir
    os.chdir(WORKDIR)


def get_auth() -> Optional[httpx.BasicAuth]:
    """Get HTTP basic auth if password is configured."""
    return httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD) if OPENCODE_PASSWORD else None


# =============================================================================
# FastAPI App
# =============================================================================

app = FastAPI(title="Research Agent Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Validate X-Auth-Token header if USER_AUTH_TOKEN is configured."""
    # Skip auth for health check and CORS preflight
    if request.url.path == "/" or request.method == "OPTIONS":
        return await call_next(request)
    
    # If no auth token configured, allow all requests
    if not USER_AUTH_TOKEN:
        return await call_next(request)
    
    # Validate token
    provided_token = request.headers.get("X-Auth-Token")
    if provided_token != USER_AUTH_TOKEN:
        logger.warning(f"Unauthorized request to {request.url.path}")
        return JSONResponse(
            status_code=401,
            content={"detail": "Unauthorized - invalid or missing X-Auth-Token"}
        )
    
    return await call_next(request)

# =============================================================================
# Models
# =============================================================================

# Chat Models
class ChatMessage(BaseModel):
    role: str
    content: str
    thinking: Optional[str] = None
    timestamp: Optional[float] = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    wild_mode: bool = False


class CreateSessionRequest(BaseModel):
    title: Optional[str] = None


# Run Models
# Run State Machine: ready -> queued -> launching -> running -> finished/failed/stopped
# - ready: Created but not submitted for execution
# - queued: Submitted, waiting to be picked up
# - launching: Tmux window being created
# - running: Command actively executing
# - finished/failed/stopped: Terminal states

class RunCreate(BaseModel):
    name: str
    command: str
    workdir: Optional[str] = None
    sweep_id: Optional[str] = None  # If part of a sweep
    auto_start: bool = False  # If True, skip ready and go straight to queued


class RunStatusUpdate(BaseModel):
    status: str  # launching, running, finished, failed, stopped
    exit_code: Optional[int] = None
    error: Optional[str] = None
    tmux_pane: Optional[str] = None
    wandb_dir: Optional[str] = None


class SweepCreate(BaseModel):
    name: str
    base_command: str
    workdir: Optional[str] = None
    parameters: dict  # e.g., {"lr": [0.001, 0.01], "batch_size": [32, 64]}
    max_runs: int = 10
    auto_start: bool = False


# =============================================================================
# State
# =============================================================================

chat_sessions: Dict[str, dict] = {}
runs: Dict[str, dict] = {}
sweeps: Dict[str, dict] = {}


def save_chat_state():
    """Persist chat sessions to disk."""
    try:
        with open(CHAT_DATA_FILE, "w") as f:
            json.dump({"chat_sessions": chat_sessions}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving chat state: {e}")


def load_chat_state():
    """Load chat sessions from disk."""
    global chat_sessions
    if os.path.exists(CHAT_DATA_FILE):
        try:
            with open(CHAT_DATA_FILE, "r") as f:
                data = json.load(f)
                chat_sessions = data.get("chat_sessions", {})
        except Exception as e:
            logger.error(f"Error loading chat state: {e}")


def save_runs_state():
    """Persist runs and sweeps to disk."""
    try:
        with open(JOBS_DATA_FILE, "w") as f:
            json.dump({"runs": runs, "sweeps": sweeps}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving runs state: {e}")


def load_runs_state():
    """Load runs and sweeps from disk."""
    global runs, sweeps
    if os.path.exists(JOBS_DATA_FILE):
        try:
            with open(JOBS_DATA_FILE, "r") as f:
                data = json.load(f)
                runs = data.get("runs", {})
                sweeps = data.get("sweeps", {})
        except Exception as e:
            logger.error(f"Error loading runs state: {e}")


# =============================================================================
# Tmux Helpers
# =============================================================================

def get_tmux_server():
    """Get or create tmux server connection."""
    try:
        return libtmux.Server()
    except Exception as e:
        logger.error(f"Failed to connect to tmux server: {e}")
        return None


def get_or_create_session(session_name: str = TMUX_SESSION_NAME):
    """Get or create the research-agent tmux session."""
    server = get_tmux_server()
    if not server:
        return None
    
    try:
        session = server.sessions.get(session_name=session_name, default=None)
        if not session:
            logger.info(f"Creating new tmux session: {session_name}")
            session = server.new_session(session_name=session_name)
        return session
    except Exception as e:
        logger.error(f"Error getting/creating tmux session: {e}")
        return None


def launch_run_in_tmux(run_id: str, run_data: dict) -> Optional[str]:
    """Launch a run in a new tmux window with sidecar."""
    session = get_or_create_session()
    if not session:
        raise Exception("Tmux session not available. Start tmux first.")
    
    # Create window name
    run_name = run_data.get("name", run_id)[:20].replace(" ", "-")
    tmux_window_name = f"ra-{run_id[:8]}"
    
    logger.info(f"Launching run {run_id} in window {tmux_window_name}")
    
    # Create window
    window = session.new_window(window_name=tmux_window_name, attach=False)
    pane = window.active_pane
    
    # Setup run directory
    run_dir = os.path.join(DATA_DIR, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    
    # Write command to file
    command_file = os.path.join(run_dir, "command.txt")
    with open(command_file, "w") as f:
        f.write(run_data["command"])
    
    # Get sidecar path
    server_dir = os.path.dirname(os.path.abspath(__file__))
    sidecar_path = os.path.join(server_dir, "job_sidecar.py")
    
    # Build sidecar command
    server_url = "http://localhost:10000"
    run_workdir = run_data.get("workdir") or WORKDIR
    
    sidecar_cmd = (
        f'{sys.executable} "{sidecar_path}" '
        f'--job_id {run_id} '
        f'--server_url {server_url} '
        f'--command_file "{command_file}" '
        f'--agent_run_dir "{run_dir}" '
        f'--workdir "{run_workdir}"'
    )
    
    logger.info(f"Executing sidecar: {sidecar_cmd}")
    pane.send_keys(sidecar_cmd)
    
    # Update run data
    run_data["status"] = "launching"
    run_data["tmux_window"] = tmux_window_name
    run_data["run_dir"] = run_dir
    run_data["launched_at"] = time.time()
    
    return tmux_window_name


# =============================================================================
# OpenCode Integration
# =============================================================================

async def get_opencode_session_for_chat(chat_session_id: str) -> str:
    """Get or create an OpenCode session for a specific chat session."""
    if chat_session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Chat session not found")
    
    session = chat_sessions[chat_session_id]
    if session.get("opencode_session_id"):
        return session["opencode_session_id"]
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{OPENCODE_URL}/session", json={}, auth=get_auth())
        resp.raise_for_status()
        opencode_id = resp.json().get("id")
        session["opencode_session_id"] = opencode_id
        save_chat_state()
        logger.info(f"Created new OpenCode session {opencode_id} for chat {chat_session_id}")
        return opencode_id


async def send_prompt_to_opencode(client: httpx.AsyncClient, session_id: str, content: str):
    """Send a prompt to an OpenCode session."""
    prompt_payload = {
        "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
        "parts": [{"type": "text", "text": content}]
    }
    resp = await client.post(
        f"{OPENCODE_URL}/session/{session_id}/prompt_async",
        json=prompt_payload,
        auth=get_auth()
    )
    resp.raise_for_status()


def parse_opencode_event(event_data: dict, target_session_id: str) -> Optional[dict]:
    """Parse an OpenCode SSE event and translate it to our protocol."""
    payload = event_data.get("payload", {})
    etype = payload.get("type", "")
    props = payload.get("properties", {})
    part = props.get("part", {})
    
    event_sid = props.get("sessionID") or part.get("sessionID")
    if event_sid != target_session_id:
        return None
    
    if etype == "message.part.updated":
        ptype = part.get("type")
        delta = props.get("delta", "")
        
        if ptype == "text":
            return {"type": "part_delta", "id": part.get("id"), "ptype": "text", "delta": delta}
        elif ptype == "reasoning":
            return {"type": "part_delta", "id": part.get("id"), "ptype": "reasoning", "delta": delta}
        elif ptype == "tool":
            return {"type": "part_update", "id": part.get("id"), "ptype": "tool", "state": part.get("state"), "name": part.get("name")}
    
    elif etype == "session.status":
        if props.get("status", {}).get("type") == "idle":
            return {"type": "session_status", "status": "idle", "_done": True}
    
    return None


async def stream_opencode_events(client: httpx.AsyncClient, session_id: str) -> AsyncIterator[tuple]:
    """Stream events from OpenCode and yield parsed events."""
    url = f"{OPENCODE_URL}/global/event"
    headers = {"Accept": "text/event-stream"}
    
    async with client.stream("GET", url, headers=headers, auth=get_auth()) as response:
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            
            try:
                event_data = json.loads(line[6:])
                translated = parse_opencode_event(event_data, session_id)
                if translated is None:
                    continue
                
                text_delta = ""
                thinking_delta = ""
                if translated.get("ptype") == "text":
                    text_delta = translated.get("delta", "")
                elif translated.get("ptype") == "reasoning":
                    thinking_delta = translated.get("delta", "")
                
                yield translated, text_delta, thinking_delta
                
                if translated.get("_done"):
                    break
            except Exception as e:
                logger.error(f"Error parsing event line: {e}")
                continue


# =============================================================================
# Chat Endpoints
# =============================================================================

@app.get("/")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "research-agent-server", "workdir": WORKDIR}


@app.get("/sessions")
async def list_sessions():
    """List all chat sessions."""
    sessions = [
        {
            "id": sid,
            "title": session.get("title", "New Chat"),
            "created_at": session.get("created_at"),
            "message_count": len(session.get("messages", []))
        }
        for sid, session in chat_sessions.items()
    ]
    sessions.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return sessions


@app.post("/sessions")
async def create_session(req: Optional[CreateSessionRequest] = None):
    """Create a new chat session."""
    session_id = uuid.uuid4().hex[:12]
    title = req.title if req and req.title else "New Chat"
    chat_sessions[session_id] = {
        "title": title,
        "created_at": time.time(),
        "messages": [],
        "opencode_session_id": None
    }
    save_chat_state()
    return {"id": session_id, "title": title, "created_at": chat_sessions[session_id]["created_at"], "message_count": 0}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a chat session with all messages."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", [])
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del chat_sessions[session_id]
    save_chat_state()
    return {"message": "Session deleted"}


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message and receive streaming response."""
    session_id = req.session_id
    
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = chat_sessions[session_id]
    messages = session.get("messages", [])
    
    user_msg = {"role": "user", "content": req.message, "timestamp": time.time()}
    messages.append(user_msg)
    session["messages"] = messages
    
    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")
    
    save_chat_state()

    async def response_generator():
        try:
            opencode_session_id = await get_opencode_session_for_chat(session_id)
            
            wild_mode_note = ""
            if req.wild_mode:
                wild_mode_note = "[SYSTEM] Wild mode is ON. Be proactive but confirm before launching actions.\n\n"
            content = f"{wild_mode_note}[USER] {req.message}"

            async with httpx.AsyncClient(timeout=None) as client:
                logger.debug("Sending prompt to OpenCode session %s", opencode_session_id)
                logger.debug("Content: %s", content)
                await send_prompt_to_opencode(client, opencode_session_id, content)
                logger.debug("Sent prompt to OpenCode session")
                
                full_text = ""
                full_thinking = ""
                parts = []  # Track ordered parts by ID
                
                logger.debug("Start streaming events from OpenCode session")
                async for event, text_delta, thinking_delta in stream_opencode_events(client, opencode_session_id):
                    full_text += text_delta
                    full_thinking += thinking_delta
                    
                    # Track parts by ID
                    part_id = event.get("id")
                    ptype = event.get("ptype")
                    
                    if part_id and ptype:
                        # Find existing part or create new one
                        existing_part = next((p for p in parts if p["id"] == part_id), None)
                        
                        if ptype in ("text", "reasoning"):
                            part_type = "thinking" if ptype == "reasoning" else "text"
                            delta = event.get("delta", "")
                            if existing_part:
                                existing_part["content"] += delta
                            else:
                                parts.append({
                                    "id": part_id,
                                    "type": part_type,
                                    "content": delta
                                })
                        elif ptype == "tool":
                            if existing_part:
                                # Update tool state
                                existing_part["tool_state"] = event.get("state")
                                if event.get("name"):
                                    existing_part["tool_name"] = event.get("name")
                            else:
                                parts.append({
                                    "id": part_id,
                                    "type": "tool",
                                    "content": "",
                                    "tool_name": event.get("name"),
                                    "tool_state": event.get("state")
                                })
                    
                    event_to_send = {k: v for k, v in event.items() if not k.startswith("_")}
                    logger.debug("Event: %s", event_to_send)
                    yield json.dumps(event_to_send) + "\n"

                logger.debug("End streaming events from OpenCode session")
                if full_text or full_thinking or parts:
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_text.strip(),
                        "thinking": full_thinking.strip() if full_thinking else None,
                        "parts": parts if parts else None,  # NEW: store ordered parts
                        "timestamp": time.time()
                    }
                    session["messages"].append(assistant_msg)
                    save_chat_state()

        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(response_generator(), media_type="application/x-ndjson")


# =============================================================================
# Run Endpoints
# =============================================================================

@app.get("/runs")
async def list_runs(
    archived: bool = Query(False, description="Include archived runs"),
    limit: int = Query(100, description="Max runs to return")
):
    """List all runs."""
    result = []
    for run_id, run in runs.items():
        if not archived and run.get("is_archived", False):
            continue
        result.append({"id": run_id, **run})
    
    # Sort by created_at descending
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


@app.post("/runs")
async def create_run(req: RunCreate):
    """Create a new run. Starts in 'ready' state unless auto_start=True."""
    run_id = uuid.uuid4().hex[:12]
    
    initial_status = "queued" if req.auto_start else "ready"
    
    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": req.workdir or WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": req.sweep_id,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }
    
    runs[run_id] = run_data
    save_runs_state()
    
    logger.info(f"Created run {run_id}: {req.name} (status: {initial_status})")
    return {"id": run_id, **run_data}


@app.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Get run details."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"id": run_id, **runs[run_id]}


@app.post("/runs/{run_id}/queue")
async def queue_run(run_id: str):
    """Queue a ready run for execution."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Run is not ready (status: {run['status']})")
    
    run["status"] = "queued"
    run["queued_at"] = time.time()
    save_runs_state()
    
    return {"message": "Run queued", "id": run_id, **run}


@app.post("/runs/{run_id}/start")
async def start_run(run_id: str):
    """Start a queued run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] not in ["queued", "ready"]:
        raise HTTPException(status_code=400, detail=f"Run cannot be started (status: {run['status']})")
    
    # If ready, move to queued first
    if run["status"] == "ready":
        run["status"] = "queued"
        run["queued_at"] = time.time()
    
    try:
        tmux_window = launch_run_in_tmux(run_id, run)
        save_runs_state()
        return {"message": "Run started", "tmux_window": tmux_window}
    except Exception as e:
        logger.error(f"Failed to start run {run_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Stop a running job."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] not in ["launching", "running"]:
        raise HTTPException(status_code=400, detail=f"Run is not active (status: {run['status']})")
    
    # Kill tmux window
    tmux_window = run.get("tmux_window")
    if tmux_window:
        session = get_or_create_session()
        if session:
            window = session.windows.get(window_name=tmux_window, default=None)
            if window:
                window.kill()
                logger.info(f"Killed tmux window {tmux_window}")
    
    run["status"] = "stopped"
    run["stopped_at"] = time.time()
    save_runs_state()
    
    return {"message": "Run stopped"}


@app.post("/runs/{run_id}/archive")
async def archive_run(run_id: str):
    """Archive a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    runs[run_id]["is_archived"] = True
    save_runs_state()
    return {"message": "Run archived"}


@app.post("/runs/{run_id}/unarchive")
async def unarchive_run(run_id: str):
    """Unarchive a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    runs[run_id]["is_archived"] = False
    save_runs_state()
    return {"message": "Run unarchived"}


@app.post("/runs/{run_id}/status")
async def update_run_status(run_id: str, update: RunStatusUpdate):
    """Update run status (called by sidecar)."""
    logger.info(f"Status update for {run_id}: {update.status}")
    
    if run_id not in runs:
        # Create minimal entry if doesn't exist
        runs[run_id] = {"created_at": time.time()}
    
    run = runs[run_id]
    
    # Update fields
    run["status"] = update.status
    if update.exit_code is not None:
        run["exit_code"] = update.exit_code
    if update.error:
        run["error"] = update.error
    if update.tmux_pane:
        run["tmux_pane"] = update.tmux_pane
    if update.wandb_dir:
        run["wandb_dir"] = update.wandb_dir
    
    # Track timestamps
    if update.status == "running" and "started_at" not in run:
        run["started_at"] = time.time()
    elif update.status in ["finished", "failed"]:
        run["ended_at"] = time.time()
    
    save_runs_state()
    return {"message": "Status updated"}


# =============================================================================
# Sweep Endpoints
# =============================================================================

def expand_parameter_grid(parameters: dict, max_runs: int) -> list:
    """Expand parameter dict into list of parameter combinations."""
    import itertools
    
    keys = list(parameters.keys())
    values = [parameters[k] if isinstance(parameters[k], list) else [parameters[k]] for k in keys]
    
    combinations = list(itertools.product(*values))[:max_runs]
    
    return [dict(zip(keys, combo)) for combo in combinations]


def build_command_with_params(base_command: str, params: dict) -> str:
    """Insert parameters into command string."""
    # Simple approach: append as CLI args
    param_str = " ".join([f"--{k}={v}" for k, v in params.items()])
    return f"{base_command} {param_str}"


@app.get("/sweeps")
async def list_sweeps(
    limit: int = Query(50, description="Max sweeps to return")
):
    """List all sweeps."""
    result = []
    for sweep_id, sweep in sweeps.items():
        result.append({"id": sweep_id, **sweep})
    
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


@app.post("/sweeps")
async def create_sweep(req: SweepCreate):
    """Create a new sweep with associated runs."""
    sweep_id = uuid.uuid4().hex[:12]
    
    # Expand parameters into run configurations
    param_combinations = expand_parameter_grid(req.parameters, req.max_runs)
    
    # Create runs for each combination
    run_ids = []
    for i, params in enumerate(param_combinations):
        run_id = uuid.uuid4().hex[:12]
        command = build_command_with_params(req.base_command, params)
        
        run_data = {
            "name": f"{req.name} #{i+1}",
            "command": command,
            "workdir": req.workdir or WORKDIR,
            "status": "queued" if req.auto_start else "ready",
            "created_at": time.time(),
            "is_archived": False,
            "sweep_id": sweep_id,
            "sweep_params": params,
            "tmux_window": None,
            "run_dir": None,
            "exit_code": None,
            "error": None,
            "wandb_dir": None,
        }
        
        runs[run_id] = run_data
        run_ids.append(run_id)
    
    # Create sweep record
    sweep_data = {
        "name": req.name,
        "base_command": req.base_command,
        "workdir": req.workdir or WORKDIR,
        "parameters": req.parameters,
        "run_ids": run_ids,
        "status": "running" if req.auto_start else "ready",
        "created_at": time.time(),
        "progress": {
            "total": len(run_ids),
            "completed": 0,
            "failed": 0,
            "running": 0,
        },
    }
    
    sweeps[sweep_id] = sweep_data
    save_runs_state()
    
    logger.info(f"Created sweep {sweep_id}: {req.name} with {len(run_ids)} runs")
    return {"id": sweep_id, **sweep_data}


@app.get("/sweeps/{sweep_id}")
async def get_sweep(sweep_id: str):
    """Get sweep details with run status summary."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")
    
    sweep = sweeps[sweep_id]
    
    # Calculate progress from runs
    sweep_runs = [runs[rid] for rid in sweep.get("run_ids", []) if rid in runs]
    progress = {
        "total": len(sweep_runs),
        "completed": sum(1 for r in sweep_runs if r.get("status") == "finished"),
        "failed": sum(1 for r in sweep_runs if r.get("status") == "failed"),
        "running": sum(1 for r in sweep_runs if r.get("status") == "running"),
        "ready": sum(1 for r in sweep_runs if r.get("status") == "ready"),
        "queued": sum(1 for r in sweep_runs if r.get("status") == "queued"),
    }
    
    return {"id": sweep_id, **sweep, "progress": progress}


@app.post("/sweeps/{sweep_id}/start")
async def start_sweep(sweep_id: str, parallel: int = Query(1, description="Max parallel runs")):
    """Start all ready/queued runs in a sweep."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")
    
    sweep = sweeps[sweep_id]
    started = 0
    
    for run_id in sweep.get("run_ids", []):
        if run_id in runs:
            run = runs[run_id]
            if run["status"] in ["ready", "queued"] and started < parallel:
                try:
                    # Queue if ready
                    if run["status"] == "ready":
                        run["status"] = "queued"
                        run["queued_at"] = time.time()
                    
                    launch_run_in_tmux(run_id, run)
                    started += 1
                except Exception as e:
                    logger.error(f"Failed to start run {run_id}: {e}")
    
    sweep["status"] = "running"
    save_runs_state()
    
    return {"message": f"Started {started} runs", "sweep_id": sweep_id}


# =============================================================================
# Log Endpoints
# =============================================================================

@app.get("/runs/{run_id}/logs")
async def get_run_logs(
    run_id: str,
    offset: int = Query(-10000, description="Byte offset. Negative = from end."),
    limit: int = Query(10000, description="Max bytes to return (max 100KB)")
):
    """Get run logs with byte-offset pagination."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    
    if not run_dir:
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    
    log_file = os.path.join(run_dir, "run.log")
    if not os.path.exists(log_file):
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    
    # Cap limit at 100KB
    limit = min(limit, 100 * 1024)
    
    try:
        total_size = os.path.getsize(log_file)
        
        # Calculate actual offset
        if offset < 0:
            actual_offset = max(0, total_size + offset)
        else:
            actual_offset = min(offset, total_size)
        
        with open(log_file, "r", errors="replace") as f:
            f.seek(actual_offset)
            content = f.read(limit)
        
        bytes_read = len(content.encode('utf-8'))
        end_offset = actual_offset + bytes_read
        
        return {
            "content": content,
            "offset": actual_offset,
            "total_size": total_size,
            "has_more_before": actual_offset > 0,
            "has_more_after": end_offset < total_size
        }
    except Exception as e:
        logger.error(f"Error reading logs for {run_id}: {e}")
        return {"content": f"Error reading logs: {e}", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}


@app.get("/runs/{run_id}/logs/stream")
async def stream_run_logs(run_id: str):
    """Stream run logs via SSE."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    
    async def log_generator():
        if not run_dir:
            yield f"data: {json.dumps({'error': 'No run directory'})}\n\n"
            return
        
        log_file = os.path.join(run_dir, "run.log")
        last_size = 0
        
        # Send initial content
        if os.path.exists(log_file):
            with open(log_file, "r", errors="replace") as f:
                content = f.read()
                last_size = len(content.encode('utf-8'))
                yield f"data: {json.dumps({'type': 'initial', 'content': content})}\n\n"
        
        # Stream updates
        while True:
            await asyncio.sleep(0.5)
            
            # Check if run is still active
            current_run = runs.get(run_id, {})
            if current_run.get("status") in ["finished", "failed", "stopped"]:
                # Send final content and close
                if os.path.exists(log_file):
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        if new_content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'status': current_run.get('status')})}\n\n"
                break
            
            # Check for new content
            if os.path.exists(log_file):
                current_size = os.path.getsize(log_file)
                if current_size > last_size:
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        last_size = current_size
                        yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
    
    return StreamingResponse(log_generator(), media_type="text/event-stream")


# =============================================================================
# Artifact Endpoints
# =============================================================================

@app.get("/runs/{run_id}/artifacts")
async def list_artifacts(run_id: str):
    """List artifacts for a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    artifacts = []
    
    if run_dir:
        artifacts_dir = os.path.join(run_dir, "artifacts")
        if os.path.exists(artifacts_dir):
            for name in os.listdir(artifacts_dir):
                path = os.path.join(artifacts_dir, name)
                # Resolve symlinks to get actual path
                actual_path = os.path.realpath(path) if os.path.islink(path) else path
                artifacts.append({
                    "name": name,
                    "path": actual_path,
                    "type": "other"  # TODO: detect type
                })
    
    # Add wandb_dir if present
    if run.get("wandb_dir"):
        artifacts.append({
            "name": "wandb",
            "path": run["wandb_dir"],
            "type": "wandb"
        })
    
    return artifacts


# =============================================================================
# Main
# =============================================================================

import asyncio
import subprocess

def start_opencode_server_subprocess(args):
    # Start OpenCode server subprocess
    opencode_process = subprocess.Popen(
        ["opencode", "serve"],
        cwd=args.workdir,
        # TODO: Open up logging
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    logger.info(f"Started OpenCode server (PID: {opencode_process.pid}) in {args.workdir}")
    return

def main():
    parser = argparse.ArgumentParser(description="Research Agent Server")
    parser.add_argument("--workdir", default=os.getcwd(), help="Working directory for runs and data")
    parser.add_argument("--port", type=int, default=10000, help="Server port")
    parser.add_argument("--host", default="0.0.0.0", help="Server host")
    args = parser.parse_args()
    
    # Initialize paths
    init_paths(args.workdir)
    
    # Check required environment variables
    if not os.environ.get("RESEARCH_AGENT_KEY"):
        logger.warning("⚠️  RESEARCH_AGENT_KEY environment variable is not set!")
        logger.warning("   The Anthropic gateway requires this for authentication.")
        logger.warning("   Set it with: export RESEARCH_AGENT_KEY=your-gateway-token")
    
    if not USER_AUTH_TOKEN:
        logger.warning("⚠️  RESEARCH_AGENT_USER_AUTH_TOKEN is not set!")
        logger.warning("   Your server has NO authentication - anyone can access it.")
        logger.warning("   For secure remote access, generate a token with:")
        logger.warning("     ./generate_auth_token.sh")
        logger.warning("   Then set: export RESEARCH_AGENT_USER_AUTH_TOKEN=<token>")
    
    # Start OpenCode server subprocess
    # start_opencode_server_subprocess(args)
    
    # Load state
    load_chat_state()
    load_runs_state()
    
    logger.info(f"Starting Research Agent Server on {args.host}:{args.port}")
    logger.info(f"Working directory: {WORKDIR}")
    
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
