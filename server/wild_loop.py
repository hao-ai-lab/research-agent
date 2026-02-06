import asyncio
import logging
import time
import re
import json
import httpx
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

logger = logging.getLogger("wild-loop")

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TerminationCondition(BaseModel):
    maxIterations: Optional[int] = None
    timeLimitMs: Optional[int] = None
    tokenBudget: Optional[int] = None
    customCondition: Optional[str] = None

class WildLoopConfig(BaseModel):
    goal: str
    conditions: TerminationCondition

class WildLoopState(BaseModel):
    phase: str  # idle, planning, reacting, monitoring, waiting
    goal: str
    iteration: int
    startedAt: int
    conditions: TerminationCondition
    estimatedTokens: int
    isPaused: bool
    logs: List[str] = []

# ---------------------------------------------------------------------------
# Prompt Templates (Ported from use-wild-loop.ts)
# ---------------------------------------------------------------------------

def build_initial_prompt(
    goal: str,
    conditions: TerminationCondition,
    runs: List[Dict],
    alerts: List[Dict],
) -> str:
    running = [r for r in runs if r.get('status') == 'running']
    failed = [r for r in runs if r.get('status') == 'failed']
    completed = [r for r in runs if r.get('status') == 'completed']
    pending_alerts = [a for a in alerts if a.get('status') == 'pending']

    conditions_text = []
    if conditions.maxIterations: conditions_text.append(f"- Max iterations: {conditions.maxIterations}")
    if conditions.timeLimitMs: conditions_text.append(f"- Time limit: {round(conditions.timeLimitMs / 60000)} minutes")
    if conditions.tokenBudget: conditions_text.append(f"- Token budget: ~{conditions.tokenBudget} tokens")
    if conditions.customCondition: conditions_text.append(f"- Stop when: {conditions.customCondition}")

    running_names = ", ".join([r.get('name', 'unknown') for r in running])

    prompt_parts = [
        f"# Ralph Loop — Autonomous Experiment Agent",
        "",
        f"You are in an autonomous iterative loop. You will keep working until the goal is achieved or termination conditions are hit. **Do NOT ask the human for help.** Make your own decisions. If you are uncertain, pick the most reasonable option and proceed.",
        "",
        f"## Your Goal",
        f"{goal}",
        "",
        f"## Termination Conditions",
         "\n".join(conditions_text),
        "",
        f"## Current State",
        f"- Total runs: {len(runs)} ({len(running)} running, {len(completed)} completed, {len(failed)} failed)",
        f"- Pending alerts: {len(pending_alerts)}" if pending_alerts else "- No pending alerts",
        f"- Running: {running_names}" if running else "",
        "",
        f"## Instructions",
        f"1. Analyze the current state of experiments",
        f"2. Design and launch experiments toward the goal (use tools to create runs / sweeps)",
        f"3. When runs complete or fail, analyze results and iterate",
        f"4. If an alert appears with choices, decide the best response yourself",
        f"5. If stuck, try a different approach — do NOT ask the human",
        "",
        f"## Signals",
        f"When your work for this iteration is done, output exactly ONE of:",
        f"- `<signal>CONTINUE</signal>` — you have more work to do (default)",
        f"- `<signal>COMPLETE</signal>` — the goal is genuinely achieved, stop the loop",
        f"- `<signal>NEEDS_HUMAN</signal>` — a truly critical decision that ONLY a human can make (use extremely rarely)",
        "",
        f"## Critical Rules",
        f"- ONLY output `<signal>COMPLETE</signal>` when the goal is truly achieved",
        f"- ONLY output `<signal>NEEDS_HUMAN</signal>` for irreversible decisions with major cost/risk (e.g. deleting data, spending >$100, changing production systems)",
        f"- For everything else: make the decision yourself and `<signal>CONTINUE</signal>`",
        f"- Do NOT ask questions. Do NOT wait for human input. Act autonomously.",
        f"- The loop will keep running until you signal COMPLETE or conditions are hit.",
        "",
        f"## Iteration: 1",
        "",
        f"Begin by analyzing the current state and proposing your first experiment. Good luck!",
    ]
    return "\n".join(filter(None, prompt_parts))

def build_continuation_prompt(
    goal: str,
    iteration: int,
    maxIterations: Optional[int],
    runs: List[Dict],
    alerts: List[Dict],
    changes: List[str],
) -> str:
    running = [r for r in runs if r.get('status') == 'running']
    failed = [r for r in runs if r.get('status') == 'failed']
    completed = [r for r in runs if r.get('status') == 'completed']
    pending_alerts = [a for a in alerts if a.get('status') == 'pending']

    sections = [
        f"# Ralph Loop — Iteration {iteration}" + (f" / {maxIterations}" if maxIterations else ""),
        "",
        f"## Goal",
        f"{goal}",
        "",
        f"## Current State",
        f"- Total runs: {len(runs)} ({len(running)} running, {len(completed)} completed, {len(failed)} failed)",
        f"- Pending alerts: {len(pending_alerts)}" if pending_alerts else "- No pending alerts",
    ]

    if running:
        sections.append(f"- Running: " + ", ".join([f'"{r.get("name")}"' for r in running]))

    if changes:
        sections.append("")
        sections.append("## Events Since Last Iteration")
        for c in changes:
            sections.append(f"- {c}")

    if pending_alerts:
        sections.append("")
        sections.append("## Pending Alerts (decide yourself)")
        for alert in pending_alerts:
            run_id = alert.get('run_id')
            run = next((r for r in runs if r.get('id') == run_id), None)
            sections.append(f"- [{alert.get('severity')}] \"{run.get('name') if run else run_id}\": {alert.get('message')}")
            if alert.get('choices'):
                sections.append(f"  Choices: {', '.join(alert.get('choices'))}")

    sections.extend([
        "",
        "## Instructions",
        "Continue working toward the goal. Review what happened, decide next actions, and execute them.",
        "If there are pending alerts with choices, respond to them yourself (pick the safest option).",
        "Do NOT ask the human for help. Make your own decisions.",
        "",
        "End your response with one signal: `<signal>CONTINUE</signal>`, `<signal>COMPLETE</signal>`, or `<signal>NEEDS_HUMAN</signal>`"
    ])

    return "\n".join(sections)

# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------

class WildLoopManager:
    def __init__(self, opencode_url: str, model_provider: str, model_id: str):
        self.opencode_url = opencode_url
        self.model_provider = model_provider
        self.model_id = model_id
        
        self.state: Optional[WildLoopState] = None
        self.background_task: Optional[asyncio.Task] = None
        
        # Tracking
        self.prev_run_snapshot: List[Dict] = [] # Snapshot of run statuses
        self.processed_alert_ids: set = set()
        self.last_response_text: str = ""
        
        # Dependencies (to be injected or fetched from server global state)
        # For simplicity, we will pass them into the `step` function or fetching them dynamically
        self.get_latest_state_scaffold = None # Function to get current runs/alerts
        self.send_chat_msg_scaffold = None    # Function to append to chat history
        self.get_session_id_scaffold = None   # Function to get opencode session id

    def is_active(self):
        return self.state is not None and self.state.phase != 'idle' and not self.state.isPaused

    async def start(self, config: WildLoopConfig, get_state_fn, send_msg_fn, get_sess_fn, stream_events_fn):
        if self.background_task and not self.background_task.done():
            logger.warning("Wild Loop already running, stopping first.")
            self.stop()
        
        self.get_latest_state_scaffold = get_state_fn
        self.send_chat_msg_scaffold = send_msg_fn
        self.get_session_id_scaffold = get_sess_fn
        self.stream_events_scaffold = stream_events_fn
        
        self.state = WildLoopState(
            phase="planning",
            goal=config.goal,
            iteration=1,
            startedAt=int(time.time() * 1000),
            conditions=config.conditions,
            estimatedTokens=0,
            isPaused=False
        )
        
        # Initialize snapshots
        runs, alerts = await self.get_latest_state_scaffold()
        self.prev_run_snapshot = [{"id": r.get("id"), "status": r.get("status")} for r in runs.values()]
        self.processed_alert_ids = set()
        
        self.background_task = asyncio.create_task(self._loop())
        logger.info(f"Wild Loop started: {config.goal}")

    # ... (stop, pause, resume omitted as they don't change, but _loop calls _call_model)

    async def _call_model(self, prompt: str) -> str:
        session_id = await self.get_session_id_scaffold()
        
        async with httpx.AsyncClient(timeout=300) as client: 
            payload = {
                "model": {"providerID": self.model_provider, "modelID": self.model_id},
                "parts": [{"type": "text", "text": prompt}]
            }
            try:
                logger.info(f"Sending prompt to OpenCode session {session_id} URL: {self.opencode_url}/session/{session_id}/prompt_async")
                resp = await client.post(f"{self.opencode_url}/session/{session_id}/prompt_async", json=payload)
                
                logger.info(f"Prompt Async Response Status: {resp.status_code}")
                try:
                    logger.debug(f"Response Body Preview: {resp.text[:200]}")
                except:
                    pass

                # Check for errors in the initial request
                if resp.status_code != 200:
                    logger.error(f"Prompt Async failed: {resp.status_code} - {resp.text}")
                    return ""
                
                try:
                    resp.json() 
                except Exception as e:
                    logger.error(f"Prompt Async returned invalid JSON: {e}")
                    logger.error(f"Raw Response: {resp.text}")
                    return ""

                logger.info("Starting to stream events...")
                
                full_text = ""
                
                # Use the injected streaming scaffold
                # The scaffold signature in server.py is matching stream_opencode_events(client, session_id)
                async for event, text_delta, thinking_delta in self.stream_events_scaffold(client, session_id):
                     
                     # Check termination
                     if self.state is None or self.state.isPaused:
                         break
                         
                     # We accumulate text. 
                     # Note: The stream scaffold in server.py yields (event, text_delta, thinking_delta)
                     
                     full_text += text_delta
                     
                     # We can also handle tools here if we want to log them or show them
                     ptype = event.get("ptype")
                     if ptype == "tool" and event.get("type") == "part_update":
                         # Tool update - maybe log occasional updates?
                         pass
                     
                     # We should inject the streaming content into chat history?
                     # The server execution will append the final message, but we want real-time feedback?
                     # For now, let's just accumulate and return the full text for logic processing.
                     # We rely on the fact that we might want to send the FINAL text to the history
                     # OR we assume the server.py logic handles adding it to history?
                     # wait, server.py `chat_endpoint` handles adding it.
                     # Here WE are the driver.
                     
                     # We already sent the User prompt to history in `_loop`.
                     # We should probably send chunks to history? 
                     # `send_chat_msg_scaffold` appends a whole message. 
                     # It's not designed for streaming updates to the SAME message.
                     # So we'll just wait for the end and append the assistant message.
                
                return full_text
                
            except Exception as e:
                logger.error(f"Model call failed: {e}", exc_info=True)
                return ""
