from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, AsyncGenerator
import uvicorn
import asyncio
from fastapi.responses import StreamingResponse
import libtmux
import uuid
import logging
import time
import os
import subprocess
import re
import threading
import sys
import json
import httpx

# OpenCode API Constants
OPENCODE_URL = "http://localhost:4096"
MODEL_PROVIDER = "opencode"
MODEL_ID = "kimi-k2.5-free"

# Configure console-only logging initially (file logging added in init_paths)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("master-agent")

def init_paths():
    """Initialize paths and configure file logging after WORKDIR is validated."""
    log_dir = os.path.join(os.getcwd(), ".agents", "logs")
    os.makedirs(log_dir, exist_ok=True)
    
    # Add file handler to root logger
    log_file = os.path.join(log_dir, "master_agent.log")
    file_handler = logging.FileHandler(log_file)
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logging.getLogger().addHandler(file_handler)
    
    logger.info(f"Logging initialized. File log: {log_file}")

app = FastAPI(title="Master Agent API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Models
class StatusUpdate(BaseModel):
    status: str
    slurm_id: Optional[str] = None
    wandb_dir: Optional[str] = None
    exit_code: Optional[int] = None
    error: Optional[str] = None
    tmux_pane: Optional[str] = None
    slurm_final_status: Optional[str] = None
    color: Optional[str] = None

class RunCreate(BaseModel):
    name: str
    command: str
    params: Optional[Dict] = None
    workdir: Optional[str] = None
    job_type: Optional[str] = None
    expname: Optional[str] = None

class SweepCreate(BaseModel):
    name: str
    runs: List[RunCreate]
    auto_start: bool = True

class Alert(BaseModel):
    id: str
    job_id: str
    timestamp: float
    severity: str = "warning"
    message: str
    choices: List[str]
    status: str = "pending" # pending, resolved
    response: Optional[str] = None

class ChatMessage(BaseModel):
    role: str # user, assistant
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    wild_mode: bool = False

class UpdateAgentInstructionsRequest(BaseModel):
    instructions: str

# State
pwd = os.getcwd()
JOBS_FILE = os.path.join(pwd, ".agents", "jobs.json")
jobs = {}
sweeps = {}
active_alerts = {} # alert_id -> Alert
chat_history: List[ChatMessage] = []
last_log_pos: Dict[str, int] = {} # job_id -> last_read_offset
opencode_session_id: Optional[str] = None
last_metrics_pos: Dict[str, int] = {} # job_id -> last_metrics_size
last_metrics_check: Dict[str, float] = {} # job_id -> last_poll_ts
monitoring_active = True
agent_instructions = ""

def load_agent_instructions():
    global agent_instructions
    try:
        path = os.path.join(os.getcwd(), ".agents", "AGENTS.md")
        if os.path.exists(path):
            with open(path, "r") as f:
                agent_instructions = f.read()
            logger.info(f"Agent instructions loaded from {path}")
    except Exception as e:
        logger.error(f"Error loading instructions: {e}")

def save_state():
    try:
        with open(JOBS_FILE, "w") as f:
            json.dump({
                "jobs": jobs, 
                "sweeps": sweeps,
                "chat_history": [m.model_dump() for m in chat_history]
            }, f, indent=2)
    except Exception as e:
        logger.error(f"Error saving state: {e}")

def load_state():
    global jobs, sweeps
    if os.path.exists(JOBS_FILE):
        try:
            with open(JOBS_FILE, "r") as f:
                data = json.load(f)
                jobs = data.get("jobs", {})
                sweeps = data.get("sweeps", {})
                history_data = data.get("chat_history", [])
                chat_history = [ChatMessage(**m) for m in history_data]
        except Exception as e:
            logger.error(f"Error loading state: {e}")

load_state()

# Tmux Setup
def get_tmux_server():
    try:
        server = libtmux.Server()
        return server
    except Exception as e:
        logger.error(f"Failed to connect to tmux server: {e}")
        return None

def get_or_create_session(session_name="master-agent"):
    server = get_tmux_server()
    if not server: return None
    session = server.sessions.get(session_name=session_name, default=None)
    if not session:
        logger.info(f"Creating new tmux session: {session_name}")
        session = server.new_session(session_name=session_name)
    return session

async def get_opencode_session():
    global opencode_session_id
    if opencode_session_id:
        return opencode_session_id
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{OPENCODE_URL}/session", json={})
        resp.raise_for_status()
        data = resp.json()
        opencode_session_id = data.get("id")
        logger.info(f"Created new OpenCode session: {opencode_session_id}")
        return opencode_session_id

def _launch_run(job_id: str, run_data: dict):
    session = get_or_create_session()
    if not session:
        raise Exception("Tmux session not available")
    
    # Use structured window name
    tmux_window_name = run_data.get("tmux_window", f"ra-job-{job_id}")
    
    logger.info(f"Launching run {job_id} in window {tmux_window_name}")
    
    # Create window
    window = session.new_window(window_name=tmux_window_name, attach=False)
    pane = window.active_pane
    
    # Inject Sidecar
    server_url = "http://localhost:10000"
    base_command = run_data["command"]
    workdir = run_data.get("workdir", "")
    
    # Create run-specific directory in .agents/runs/<job_id>
    # Using absolute paths to ensure sidecar can find it even after a 'cd'
    agents_dir = os.path.abspath(os.path.join(workdir if workdir else ".", ".agents"))
    run_dir = os.path.join(agents_dir, "runs", job_id)
    os.makedirs(run_dir, exist_ok=True)
    
    # Write command to file inside the run directory
    command_file_path = os.path.join(run_dir, "command.txt")
    
    try:
        with open(command_file_path, "w") as f:
            f.write(base_command)
    except Exception as e:
        logger.error(f"Failed to write command file: {e}")
        return None

    sidecar_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "job_sidecar.py")
    
    # Launch sidecar with command file path and agent run dir
    full_command = f"{sys.executable} {sidecar_path} --job_id {job_id} --server_url {server_url} --command_file \"{command_file_path}\" --agent_run_dir \"{run_dir}\""
    if workdir:
        full_command += f" --workdir \"{workdir}\""
    
    logger.info(f"Executing sidecar in tmux window {tmux_window_name}: {full_command}")
    pane.send_keys(full_command)
    
    run_data["status"] = "launching"
    run_data["tmux_window"] = tmux_window_name
    run_data["agent_run_dir"] = run_dir
    jobs[job_id] = run_data
    save_state()
    # Initialize log position for new job
    last_log_pos[job_id] = 0
    return tmux_window_name

# Endpoints
@app.get("/")
async def root():
    return {"message": "Master Agent Server is running"}

@app.post("/runs/{job_id}/status")
async def update_job_status(job_id: str, update: StatusUpdate):
    logger.info(f"Status update for {job_id}: {update.status}")
    if job_id not in jobs:
        jobs[job_id] = update.model_dump(exclude_none=True)
        jobs[job_id]["timestamp"] = time.time()
        return {"message": "Job initialized from status update"}
    
    # Partial update: only update fields that are provided
    update_data = update.model_dump(exclude_none=True)
    jobs[job_id].update(update_data)
    # If job just became running, ensure log pos is initialized
    if update.status == "running" and job_id not in last_log_pos:
        last_log_pos[job_id] = 0
    save_state()
    return {"message": "Status updated"}

@app.get("/runs/{job_id}/metrics")
async def get_run_metrics(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[job_id]
    wandb_dir = job.get("wandb_dir")
    
    if not wandb_dir:
        return {"metrics_history": []}
    
    metrics_path = os.path.join(wandb_dir, "metrics.jsonl")
    if not os.path.exists(metrics_path):
        return {"metrics_history": []}
    
    try:
        import json
        metrics_history = []
        with open(metrics_path, "r") as f:
            for line in f:
                if line.strip():
                    metrics_history.append(json.loads(line))
        return {"metrics_history": metrics_history}
    except Exception as e:
        logger.error(f"Error reading metrics for {job_id}: {e}")
        return {"metrics_history": [], "error": str(e)}

@app.get("/runs/{job_id}/logs")
async def get_job_logs(job_id: str, tail: int = 100):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[job_id]
    window_name = job.get("tmux_window")
    
    # 1. Try to capture from tmux for real-time output
    if window_name:
        try:
            session = get_or_create_session()
            if session:
                window = session.windows.get(window_name=window_name, default=None)
                if window:
                    pane_id = job.get("tmux_pane")
                    pane = None
                    if pane_id:
                        # Find the correct pane by ID
                        for p in window.panes:
                            if p.pane_id == pane_id:
                                pane = p
                                break
                    if not pane:
                        pane = window.active_pane
                    
                    logs = pane.capture_pane()
                    if logs:
                        return {"logs": "\n".join(logs[-tail:])}
        except Exception as e:
            logger.error(f"Error capturing tmux for {job_id}: {e}")
            
    # 2. Try Agent Run Log (Preferred)
    agent_run_dir = job.get("agent_run_dir")
    if agent_run_dir:
        agent_log = os.path.join(agent_run_dir, "run.log")
        if os.path.exists(agent_log):
             try:
                with open(agent_log, 'r') as f:
                    # TODO: optimize for large files (seek)
                    lines = f.readlines()
                    return {"logs": "".join(lines[-tail:])}
             except Exception as e:
                  logger.error(f"Error reading agent log {agent_log}: {e}")
    
    # Legacy/Fallback: Recalculate from workdir
    workdir = job.get("workdir")
    if workdir:
        agent_log = os.path.join(workdir, ".agents", "runs", job_id, "run.log")
        if os.path.exists(agent_log):
             try:
                with open(agent_log, 'r') as f:
                    lines = f.readlines()
                    return {"logs": "".join(lines[-tail:])}
             except: pass

    # 2. Try unique log file
    workdir = job.get("workdir")
    if workdir:
        unique_log = os.path.join(workdir, "outputs", job_id, "train.log")
        if os.path.exists(unique_log):
            try:
                with open(unique_log, 'r') as f:
                    lines = f.readlines()
                    return {"logs": "".join(lines[-tail:])}
            except: pass

        # 3. Fallback to shared log file (might be stale)
        shared_log = os.path.join(workdir, "outputs", "train.log")
        if os.path.exists(shared_log):
            try:
                with open(shared_log, 'r') as f:
                    lines = f.readlines()
                    return {"logs": "".join(lines[-tail:]) + "\n(Warning: Showing shared log file)"}
            except: pass

    return {"logs": "Logs not yet available."}

@app.get("/runs")
async def list_runs():
    session = get_or_create_session()
    if session:
        active_windows = [w.name for w in session.windows]
        for job_id, job in jobs.items():
            if job.get("status") == "running" and job.get("tmux_window") not in active_windows:
                job["status"] = "finished" # Or disappeared
    return jobs

@app.get("/sweeps")
async def list_sweeps():
    return sweeps



@app.post("/sweeps")
async def create_sweep(sweep: SweepCreate):
    sweep_id = uuid.uuid4().hex[:8]
    run_ids = []
    current_time = time.time()
    for i, run in enumerate(sweep.runs, 1):
        job_id = f"{sweep_id}-{i}"
        run_data = run.model_dump()
        run_data["expname"] = sweep.name
        run_data["tmux_window"] = f"ra-{sweep.name}-{sweep_id}-{i}"
        run_data["status"] = "pending"
        run_data["timestamp"] = current_time
        jobs[job_id] = run_data
        run_ids.append(job_id)
        if sweep.auto_start:
            _launch_run(job_id, run_data)
    
    sweeps[sweep_id] = {"name": sweep.name, "run_ids": run_ids, "timestamp": current_time}
    save_state()
    return {"sweep_id": sweep_id, "run_ids": run_ids}

@app.post("/runs/{job_id}/start")
async def start_run(job_id: str):
    if job_id not in jobs: raise HTTPException(status_code=404)
    run_data = jobs[job_id]
    _launch_run(job_id, run_data)
    return {"message": "Started"}

@app.delete("/runs/{job_id}")
async def kill_run(job_id: str):
    if job_id not in jobs: raise HTTPException(status_code=404)
    run_data = jobs[job_id]
    session = get_or_create_session()
    if session:
        window = session.windows.get(window_name=run_data["tmux_window"], default=None)
        if window:
            window.kill()
            run_data["status"] = "killed"
            save_state()
            return {"message": "Killed"}
    return {"message": "Window not found"}

@app.post("/admin/clear-runs")
async def clear_all_runs():
    global jobs, sweeps
    logger.info("ADMIN: Clearing all runs")
    
    # 1. Kill all tmux windows
    session = get_or_create_session()
    if session:
        for job_id, job in jobs.items():
            win_name = job.get("tmux_window")
            if win_name:
                window = session.windows.get(window_name=win_name, default=None)
                if window:
                    window.kill()
    
    # 2. Reset state
    jobs = {}
    sweeps = {}
    save_state()
    
    # 3. Clean up runs directory
    runs_dir = os.path.join(os.getcwd(), ".agents", "runs")
    if os.path.exists(runs_dir):
        logger.info(f"Cleaning runs directory: {runs_dir}")
        try:
            import shutil
            shutil.rmtree(runs_dir)
            os.makedirs(runs_dir, exist_ok=True)
        except Exception as e:
            logger.error(f"Failed to clean runs dir: {e}")
            
    return {"message": "All runs cleared"}

class CreateAlertRequest(BaseModel):
    message: str
    choices: List[str]
    severity: str = "warning"

@app.post("/runs/{job_id}/alerts")
async def create_alert(job_id: str, req: CreateAlertRequest):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    alert_id = uuid.uuid4().hex
    alert = Alert(
        id=alert_id,
        job_id=job_id,
        timestamp=time.time(),
        message=req.message,
        choices=req.choices,
        severity=req.severity,
        status="pending"
    )
    active_alerts[alert_id] = alert
    logger.info(f"New alert created for job {job_id}: {req.message}")
    # Ideally persist alerts too, but staying in memory for now/simplicity
    return {"alert_id": alert_id}

@app.get("/alerts")
async def get_alerts():
    return list(active_alerts.values())

class RespondAlertRequest(BaseModel):
    choice: str

@app.post("/alerts/{alert_id}/respond")
async def respond_alert(alert_id: str, req: RespondAlertRequest):
    if alert_id not in active_alerts:
        raise HTTPException(status_code=404, detail="Alert not found")
    
    alert = active_alerts[alert_id]
    if req.choice not in alert.choices:
        raise HTTPException(status_code=400, detail="Invalid choice")
    
    alert.status = "resolved"
    alert.response = req.choice
    
    # Write response to file system so sidecar can pick it up
    job_id = alert.job_id
    job = jobs.get(job_id)
    if job:
        workdir = job.get("workdir", "")
        agents_dir = os.path.join(workdir if workdir else ".", ".agents")
        run_dir = os.path.join(agents_dir, "runs", job_id)
        alerts_dir = os.path.join(run_dir, "alerts")
        os.makedirs(alerts_dir, exist_ok=True)
        
        response_file = os.path.join(alerts_dir, f"{alert_id}.response")
        try:
            with open(response_file, "w") as f:
                f.write(req.choice)
            logger.info(f"Written response '{req.choice}' for alert {alert_id} to {response_file}")
        except Exception as e:
            logger.error(f"Failed to write response file: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to write response: {e}")
            
    return {"message": "Response recorded"}

@app.get("/chat")
async def get_chat_history():
    return chat_history

@app.get("/configs")
async def list_configs():
    # Security: Normalize path to prevent traversal
    workdir = os.getcwd()
    config_dir = os.path.join(workdir, ".agents", "configs")
    logger.info(f"Loading configs from: {config_dir}")
    if not os.path.exists(config_dir):
        return []
    logger.info(f"Configs found: {os.listdir(config_dir)}")
    configs = [f for f in os.listdir(config_dir) if f.endswith(".json")]
    logger.info(f"Configs found: {configs}")
    configs.sort(reverse=True) # Newest first usually
    return configs

@app.post("/agent/instructions")
async def update_agent_instructions(req: UpdateAgentInstructionsRequest):
    try:
        path = os.path.join(os.getcwd(), ".agents", "AGENTS.md")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(req.instructions)
        load_agent_instructions()
        return {"message": "Agent instructions updated"}
    except Exception as e:
        logger.error(f"Error updating agent instructions: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/files")
async def list_files(path: str = "."):
    workdir = os.getcwd()
    target_path = os.path.join(workdir, path)
    
    # Simple security check
    if not os.path.abspath(target_path).startswith(workdir):
        raise HTTPException(status_code=403, detail="Access denied")
        
    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="Path not found")
        
    if not os.path.isdir(target_path):
         raise HTTPException(status_code=400, detail="Not a directory")

    items = []
    try:
        with os.scandir(target_path) as it:
            for entry in it:
                # Filter out specific implementation details if needed
                if entry.name in [".", ".."]: continue 
                
                item_type = "directory" if entry.is_dir() else "file"
                item = {
                    "name": entry.name,
                    "type": item_type,
                    "path": os.path.relpath(entry.path, workdir),
                    "size": entry.stat().st_size if item_type == "file" else 0
                }
                items.append(item)
    except Exception as e:
        logger.error(f"Error listing directory {target_path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    # Sort: Directories first, then files
    items.sort(key=lambda x: (x["type"] != "directory", x["name"].lower()))
    return items

@app.get("/files/content")
async def get_file_content(path: str):
    workdir = os.getcwd()
    target_path = os.path.join(workdir, path)
    
    # Simple security check
    if not os.path.abspath(target_path).startswith(workdir):
        raise HTTPException(status_code=403, detail="Access denied")
        
    if not os.path.exists(target_path) or not os.path.isfile(target_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        # Check size if too large? 
        if os.path.getsize(target_path) > 1024 * 1024: # 1MB limit for preview
             return {"content": "(File too large to preview)"}

        with open(target_path, "r") as f:
            content = f.read()
        return {"content": content, "filename": os.path.basename(path)}
    except Exception as e: # Likely binary
        return {"content": "(Binary or unreadable file)"}

@app.get("/configs/{filename}")
async def get_config_content(filename: str):
    workdir = os.getcwd()
    # Security: Normalize path to prevent traversal
    config_dir = os.path.join(workdir, ".agents", "configs")
    file_path = os.path.join(config_dir, filename)

    
    
    # Simple check to ensure we stay within config_dir
    if not os.path.abspath(file_path).startswith(os.path.abspath(config_dir)):
         raise HTTPException(status_code=403, detail="Invalid path")
         
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Config not found")
        
    try:
        with open(file_path, "r") as f:
            content = f.read()
        return {"filename": filename, "content": content}
    except Exception as e:
         raise HTTPException(status_code=500, detail=str(e))

@app.delete("/chat")
async def clear_chat():
    global chat_history, opencode_session_id
    chat_history = []
    opencode_session_id = None
    save_state()
    return {"message": "Chat history cleared"}

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    if not req.messages:
        raise HTTPException(status_code=400, detail="No messages provided")
    
    user_msg = req.messages[-1]
    is_new_session = len(chat_history) == 0
    chat_history.append(user_msg)
    save_state()

    async def response_generator():
        try:
            session_id = await get_opencode_session()
            wild_mode_note = ""
            if req.wild_mode:
                wild_mode_note = (
                    "[SYSTEM] Wild mode is ON. When experiments finish or die, help continue the sweep: "
                    "suggest follow-up runs, restart failed jobs, or extend sweeps. "
                    "Be proactive but confirm before launching.\n\n"
                )

            content = f"{wild_mode_note}[USER] {user_msg.content}"
            if is_new_session and agent_instructions:
                content = f"[SYSTEM] Agent Protocol:\n{agent_instructions}\n\n{wild_mode_note}[USER] {user_msg.content}"

            async with httpx.AsyncClient(timeout=None) as client:
                # Send the prompt
                prompt_payload = {
                    "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
                    "parts": [{"type": "text", "text": content}]
                }
                logger.info(f"Sending prompt to OpenCode session {session_id}")
                prompt_resp = await client.post(f"{OPENCODE_URL}/session/{session_id}/prompt_async", json=prompt_payload)
                prompt_resp.raise_for_status()

                # Stream from the global event endpoint
                full_assistant_response = ""
                async with client.stream("GET", f"{OPENCODE_URL}/global/event", headers={"Accept": "text/event-stream"}) as response:
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        
                        try:
                            event_data = json.loads(line[6:])
                            payload = event_data.get("payload", {})
                            etype = payload.get("type", "")
                            props = payload.get("properties", {})
                            
                            part = props.get("part", {})
                            event_sid = props.get("sessionID") or part.get("sessionID")
                            
                            if event_sid != session_id:
                                continue

                            # --- Protocol Translation ---
                            if etype == "message.part.updated":
                                ptype = part.get("type")
                                delta = props.get("delta", "")
                                if ptype in ["text", "reasoning"]:
                                    if ptype == "text": full_assistant_response += delta
                                    yield json.dumps({
                                        "type": "part_delta",
                                        "id": part.get("id"),
                                        "ptype": ptype,
                                        "delta": delta
                                    }) + "\n"
                                elif ptype == "tool":
                                    yield json.dumps({
                                        "type": "part_update",
                                        "id": part.get("id"),
                                        "ptype": "tool",
                                        "state": part.get("state")
                                    }) + "\n"

                            elif etype == "session.status":
                                if props.get("status", {}).get("type") == "idle":
                                    yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
                                    break
                        except Exception as e:
                            logger.error(f"Error parsing event line: {e}")
                            continue

                # Save assistant response to history
                if full_assistant_response:
                    assistant_msg = ChatMessage(role="assistant", content=full_assistant_response.strip())
                    chat_history.append(assistant_msg)
                    save_state()

        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(response_generator(), media_type="application/x-ndjson")

async def monitor_tasks_loop():
    """
    Background loop to monitor running tasks and proactively report issues via chat.
    """
    logger.info("Starting proactive monitoring loop...")
    while monitoring_active:
        try:
            # Check active alerts
            for alert_id, alert in list(active_alerts.items()):
                if alert.status == "pending":
                    # Potentially check if we already reported this in chat
                    # For now, let's look at the logs for this job
                    job_id = alert.job_id
                    job = jobs.get(job_id)
                    if job:
                        await analyze_job_anomaly(job_id, job, f"Alert triggered: {alert.message}")

        except Exception as e:
            logger.error(f"Error in monitor loop: {e}")
            
        await asyncio.sleep(10) # Poll every 10s

async def analyze_job_anomaly(job_id: str, job: dict, context: str):
    """
    Use opencode to analyze a potential problem and report to chat.
    """
    try:
        session_id = await get_opencode_session()
        prompt = f"[SERVER] PROACTIVE MONITORING. Analyze the following context from job '{job_id}' and report if there is an issue that requires user attention. If it's a minor or expected log message, say NOTHING. If it's an error, explain it briefly and ask the user what to do. Context:\n{context}"
        
        async with httpx.AsyncClient() as client:
            prompt_payload = {
                "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
                "parts": [{"type": "text", "text": prompt}]
            }
            logger.info(f"Proactive analysis for {job_id}...")
            # We use prompt (sync) for proactive analysis as we don't need token-streaming for background thinking
            resp = await client.post(f"{OPENCODE_URL}/session/{session_id}/prompt", json=prompt_payload)
            resp.raise_for_status()
            
            data = resp.json()
            # Find the first text part in the assistant message
            response_text = ""
            for msg in data.get("messages", []):
                if msg.get("role") == "assistant":
                    # Check if this is the response to our prompt (last message)
                    # Actually, OpenCode returns the full session or the response. 
                    # Let's just find any 'text' parts in the assistant role.
                    for part in msg.get("parts", []):
                        if part.get("type") == "text":
                            response_text += part.get("text", "")
            
            response = response_text.strip()
            if response and "NOTHING" not in response:
                logger.info(f"Proactive agent report for {job_id}: {response}")
                msg = ChatMessage(role="assistant", content=f"[PROACTIVE: {job_id}] {response}")
                chat_history.append(msg)
                save_state()
    except Exception as e:
        logger.error(f"Failed to run proactive opencode for {job_id}: {e}")

@app.on_event("startup")
async def startup_event():
    load_agent_instructions()
    # Start monitor loop in background
    asyncio.create_task(monitor_tasks_loop())

@app.on_event("shutdown")
async def shutdown_event():
    global monitoring_active
    monitoring_active = False

if __name__ == "__main__":
    # Pre-check: Ensure .agents/AGENTS.md exists
    if not os.path.exists(".agents/AGENTS.md"):
        print("CRITICAL ERROR: .agents/AGENTS.md not found in the working directory.")
        print("The Master Agent requires being run from a directory with a valid .agents/ configuration.")
        sys.exit(1)

    # Initialize paths and file logging after WORKDIR validation
    init_paths()

    # Custom uvicorn logging config to include timestamps in access logs
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["formatters"]["access"]["fmt"] = "%(asctime)s - %(levelprefix)s %(client_addr)s - \"%(request_line)s\" %(status_code)s"
    log_config["formatters"]["default"]["fmt"] = "%(asctime)s - %(levelprefix)s %(message)s"

    logger.info("Starting Master Agent Server on port 10000...")
    uvicorn.run(app, host="0.0.0.0", port=10000, log_config=log_config)
