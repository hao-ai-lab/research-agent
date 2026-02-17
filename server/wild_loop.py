"""
Wild Loop Module — Backend-Driven Engine (v5).

Contains:
- Pydantic models for wild mode / loop configuration / events
- WildEventQueue (heapq-based priority queue)
- Wild loop state management
- WildLoopEngine: backend-driven orchestrator (state machine, signal parsing,
  event polling, prompt construction, stage transitions, termination checks)
- Experiment context builder
- Wild mode prompt builder
"""

import asyncio
import copy
import heapq
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel

logger = logging.getLogger("wild_loop")


# =============================================================================
# Pydantic Models
# =============================================================================

class WildModeRequest(BaseModel):
    enabled: bool


class WildLoopConfigRequest(BaseModel):
    goal: Optional[str] = None
    session_id: Optional[str] = None
    max_iterations: Optional[int] = None
    max_time_seconds: Optional[int] = None
    max_tokens: Optional[int] = None
    custom_condition: Optional[str] = None
    autonomy_level: Optional[str] = None       # "cautious" | "balanced" | "full"
    queue_modify_enabled: Optional[bool] = None
    plan_autonomy: Optional[str] = None         # "agent" | "collaborative"


class WildEvent(BaseModel):
    id: str
    priority: int          # 10=user, 15=job_sched, 20=critical, 30=warning, 50=run_event, 70=analysis, 90=exploring
    title: str
    prompt: str
    type: str              # "steer"|"alert"|"run_event"|"analysis"|"exploring"|"job_scheduling"|"action"
    created_at: float
    handler: Optional[str] = None          # If set, resolved by engine (no LLM)
    handler_config: Optional[dict] = None  # Config passed to the handler


class EnqueueEventRequest(BaseModel):
    priority: int = 50
    title: str
    prompt: str
    type: str = "run_event"


class BuildPromptRequest(BaseModel):
    """Request to build a wild loop prompt server-side."""
    prompt_type: str                              # "exploring" | "run_event" | "alert" | "analysis"
    # Common
    goal: Optional[str] = None
    step_goal: Optional[str] = None
    iteration: Optional[int] = None
    max_iterations: Optional[int] = None
    # run_event fields
    run_id: Optional[str] = None
    run_name: Optional[str] = None
    run_status: Optional[str] = None
    run_command: Optional[str] = None
    log_tail: Optional[str] = None
    sweep_summary: Optional[str] = None
    # alert fields
    alert_id: Optional[str] = None
    alert_severity: Optional[str] = None
    alert_message: Optional[str] = None
    alert_choices: Optional[list] = None
    # analysis fields
    sweep_name: Optional[str] = None
    total_runs: Optional[int] = None
    passed_runs: Optional[int] = None
    failed_runs: Optional[int] = None
    run_summaries: Optional[str] = None


class BuildPromptResponse(BaseModel):
    """Structured response with full transparency into prompt construction."""
    rendered: str                                  # Final prompt sent to the agent
    user_input: str                                # What the user originally submitted (goal)
    skill_id: Optional[str] = None                 # Which skill template was used
    skill_name: Optional[str] = None
    template: Optional[str] = None                 # Raw template with {{placeholders}}
    variables: dict = {}                           # Key→value map applied to the template
    prompt_type: str = ""                          # Echo back the prompt type


# =============================================================================
# Action Event Infrastructure
# =============================================================================

@dataclass
class ActionResult:
    """Return type for action event handlers."""
    success: bool
    summary: str = ""
    enqueue_events: list = field(default_factory=list)   # New events to enqueue
    state_updates: dict = field(default_factory=dict)    # Updates to wild_loop_state
    resolve_event: bool = True                           # Mark event resolved?


@dataclass
class CronTask:
    """Periodic action event that fires on a timer."""
    name: str                       # Unique name
    handler: str                    # Registered handler name
    interval_seconds: float         # How often to fire
    handler_config: dict = field(default_factory=dict)
    priority: int = 25              # Default priority for cron events
    last_fired: float = 0.0         # Timestamp of last fire
    max_retries: int = 3


# Handler registry: name → async callable(event, config, context) → ActionResult
_action_handlers: Dict[str, Callable] = {}


def register_action_handler(name: str, fn: Callable):
    """Register a named handler for action events."""
    _action_handlers[name] = fn
    logger.debug("[wild-engine] Registered action handler: %s", name)


def get_action_handler(name: str) -> Optional[Callable]:
    """Look up a registered action handler by name."""
    return _action_handlers.get(name)


# ---------------------------------------------------------------------------
# Built-in handler: resource_monitor
# ---------------------------------------------------------------------------

async def resource_monitor_handler(event: dict, config: dict, context: dict) -> ActionResult:
    """Check system utilization and directly start queued runs if capacity allows.

    This is a **script-based** handler — no LLM prompt is needed.
    It checks running vs max_concurrent slots, finds queued/ready runs,
    and starts them directly via the start_sweep helper.

    Config keys:
        max_concurrent (int): max runs before system is "full" (default 5)
    """
    runs = context.get("runs", {})
    sweeps = context.get("sweeps", {})
    start_sweep_fn = context.get("start_sweep")

    running_count = sum(1 for r in runs.values() if r.get("status") == "running")
    queued_count = sum(1 for r in runs.values() if r.get("status") in ("queued", "ready"))
    max_concurrent = config.get("max_concurrent", 5)
    slots = max_concurrent - running_count

    if slots <= 0:
        return ActionResult(
            success=True,
            summary=f"System full: {running_count}/{max_concurrent} running, {queued_count} queued — no action",
        )

    if queued_count == 0:
        return ActionResult(
            success=True,
            summary=f"System OK: {running_count}/{max_concurrent} running, 0 queued — nothing to start",
        )

    # Directly start queued runs (no LLM needed)
    started: list[str] = []
    for sweep_id, sweep in sweeps.items():
        if slots <= 0:
            break
        sweep_run_ids = sweep.get("run_ids", [])
        queued_in_sweep = [
            rid for rid in sweep_run_ids
            if rid in runs and runs[rid].get("status") in ("queued", "ready")
        ]
        if queued_in_sweep and start_sweep_fn:
            batch = min(len(queued_in_sweep), slots)
            try:
                start_sweep_fn(sweep_id, batch)
                started.append(f"{sweep.get('name', sweep_id)}({batch})")
                slots -= batch
            except Exception as err:
                logger.warning("[resource-monitor] Failed to start sweep %s: %s", sweep_id, err)

    if started:
        return ActionResult(
            success=True,
            summary=f"Started runs: {', '.join(started)} ({running_count + sum(int(s.split('(')[1].rstrip(')')) for s in started)}/{max_concurrent})",
        )
    return ActionResult(
        success=True,
        summary=f"Underutilized ({running_count}/{max_concurrent} running, {queued_count} queued) but no startable sweeps",
    )

register_action_handler("resource_monitor", resource_monitor_handler)




# =============================================================================
# Wild Event Queue (Backend Priority Queue)
# =============================================================================

class WildEventQueue:
    """heapq-based priority queue for wild loop events.

    Sorted by (priority ASC, created_at ASC).  Lower priority = higher urgency.
    Deduplicates by event id.

    Events are persisted with a status field:
      - "pending" (default) — waiting to be processed
      - "resolved" — consumed/completed (kept for history)
    """

    def __init__(self):
        self._heap: list = []       # list of (priority, created_at, counter, event_dict)
        self._events: dict = {}     # id -> event_dict (all events, for lookup)
        self._counter: int = 0      # tie-breaker for heapq stability

    @property
    def size(self) -> int:
        """Count of pending (unresolved) events."""
        return sum(1 for e in self._events.values() if e.get("status") == "pending")

    def enqueue(self, event: dict) -> bool:
        """Add an event. Returns False if the id is already present (dedup)."""
        eid = event.get("id", "")
        if eid in self._events:
            return False
        event.setdefault("status", "pending")
        self._events[eid] = event
        self._counter += 1
        heapq.heappush(self._heap, (event["priority"], event["created_at"], self._counter, event))
        return True

    def dequeue(self) -> Optional[dict]:
        """Pop and return the highest-priority pending event, or None."""
        while self._heap:
            _, _, _, event = heapq.heappop(self._heap)
            eid = event.get("id", "")
            if eid in self._events and self._events[eid].get("status") == "pending":
                self._events[eid]["status"] = "resolved"
                return event
        return None

    def peek(self) -> Optional[dict]:
        """Look at the next pending event without removing it."""
        for entry in self._heap:
            ev = entry[3]
            if ev.get("id", "") in self._events and self._events[ev["id"]].get("status") == "pending":
                return ev
        return None

    def resolve(self, event_id: str) -> bool:
        """Mark an event as resolved by ID (out-of-order consumption).

        Returns True if the event was found and resolved, False otherwise.
        """
        if event_id in self._events and self._events[event_id].get("status") == "pending":
            self._events[event_id]["status"] = "resolved"
            return True
        return False

    def get_event(self, event_id: str) -> Optional[dict]:
        """Return a specific event by ID, or None."""
        return self._events.get(event_id)

    def items(self, include_resolved: bool = False) -> list:
        """Return a sorted snapshot of events.

        By default only pending events. Set include_resolved=True for all.
        """
        result = []
        for _, _, _, event in sorted(self._heap):
            eid = event.get("id", "")
            if eid not in self._events:
                continue
            if include_resolved or self._events[eid].get("status") == "pending":
                result.append(event)
        return result

    def clear(self):
        self._heap.clear()
        self._events.clear()
        self._counter = 0


# =============================================================================
# Module-level State
# =============================================================================

wild_mode_enabled: bool = False

wild_loop_state: dict = {
    "phase": "idle",
    "stage": "exploring",     # exploring | running | analyzing
    "is_active": False,
    "iteration": 0,
    "goal": None,
    "step_goal": None,
    "session_id": None,
    "started_at": None,
    "is_paused": False,
    "sweep_id": None,
    "autonomy_level": "balanced",
    "queue_modify_enabled": True,
    "plan_autonomy": "agent",
    "created_sweep_ids": [],
    "created_run_ids": [],
    "termination": {
        "max_iterations": None,
        "max_time_seconds": None,
        "max_tokens": None,
        "custom_condition": None,
    }
}

wild_event_queue = WildEventQueue()


# =============================================================================
# State Accessors / Mutators (called by server.py endpoint handlers)
# =============================================================================

def get_wild_mode_state() -> dict:
    """Return current wild mode enabled state."""
    return {"enabled": wild_mode_enabled}


def set_wild_mode_state(enabled: bool) -> dict:
    """Set wild mode on/off.  Returns new state."""
    global wild_mode_enabled
    wild_mode_enabled = bool(enabled)
    return {"enabled": wild_mode_enabled}


def get_loop_status() -> dict:
    """Return current wild loop state."""
    return wild_loop_state


def update_loop_status(
    phase: Optional[str] = None,
    iteration: Optional[int] = None,
    goal: Optional[str] = None,
    session_id: Optional[str] = None,
    is_paused: Optional[bool] = None,
    is_active: Optional[bool] = None,
    stage: Optional[str] = None,
) -> dict:
    """Update wild loop state fields. Returns updated state."""
    if phase is not None:
        wild_loop_state["phase"] = phase
    if iteration is not None:
        wild_loop_state["iteration"] = iteration
    if goal is not None:
        wild_loop_state["goal"] = goal
    if session_id is not None:
        wild_loop_state["session_id"] = session_id
    if is_paused is not None:
        wild_loop_state["is_paused"] = is_paused
    if is_active is not None:
        wild_loop_state["is_active"] = is_active
    if stage is not None:
        wild_loop_state["stage"] = stage
    if phase == "idle":
        wild_loop_state["started_at"] = None
        wild_loop_state["is_active"] = False
    elif wild_loop_state["started_at"] is None and phase not in ["idle", "complete"]:
        wild_loop_state["started_at"] = time.time()
    return wild_loop_state


def configure_loop(req: WildLoopConfigRequest) -> dict:
    """Configure wild loop termination conditions and goal."""
    if req.goal is not None:
        wild_loop_state["goal"] = req.goal
    if req.session_id is not None:
        wild_loop_state["session_id"] = req.session_id
    termination = wild_loop_state["termination"]
    if req.max_iterations is not None:
        termination["max_iterations"] = req.max_iterations
    if req.max_time_seconds is not None:
        termination["max_time_seconds"] = req.max_time_seconds
    if req.max_tokens is not None:
        termination["max_tokens"] = req.max_tokens
    if req.custom_condition is not None:
        termination["custom_condition"] = req.custom_condition
    if req.autonomy_level is not None:
        wild_loop_state["autonomy_level"] = req.autonomy_level
    if req.queue_modify_enabled is not None:
        wild_loop_state["queue_modify_enabled"] = req.queue_modify_enabled
    if req.plan_autonomy is not None:
        wild_loop_state["plan_autonomy"] = req.plan_autonomy
    return wild_loop_state


def enqueue_event(req: EnqueueEventRequest) -> dict:
    """Create and enqueue an event. Returns result dict."""
    event_id = uuid.uuid4().hex[:12]
    event = {
        "id": event_id,
        "priority": req.priority,
        "title": req.title,
        "prompt": req.prompt,
        "type": req.type,
        "created_at": time.time(),
    }
    added = wild_event_queue.enqueue(event)
    return {"added": added, "event": event, "queue_size": wild_event_queue.size}


def dequeue_event() -> dict:
    """Pop the highest-priority event. Returns result dict."""
    event = wild_event_queue.dequeue()
    if event is None:
        return {"event": None, "queue_size": 0}
    return {"event": event, "queue_size": wild_event_queue.size}


def get_queue_state() -> dict:
    """Return queue snapshot for inspection."""
    return {
        "queue_size": wild_event_queue.size,
        "events": wild_event_queue.items(),
    }


def resolve_event(event_id: str) -> dict:
    """Resolve a specific event by ID (out-of-order consumption)."""
    event = wild_event_queue.get_event(event_id)
    if event is None:
        return {"resolved": False, "error": "Event not found", "event": None}
    if event.get("status") == "resolved":
        return {"resolved": False, "error": "Already resolved", "event": event}
    wild_event_queue.resolve(event_id)
    return {"resolved": True, "event": event, "queue_size": wild_event_queue.size}


def get_all_events() -> dict:
    """Return all events including resolved ones."""
    return {
        "queue_size": wild_event_queue.size,
        "events": wild_event_queue.items(include_resolved=True),
    }


# =============================================================================
# Entity Creation Tracking (called from server.py endpoints)
# =============================================================================

def record_created_entity(entity_type: str, entity_id: str):
    """Track a sweep or run created during the current wild session.

    entity_type: 'sweep' or 'run'
    """
    if not wild_loop_state.get("is_active"):
        return
    key = "created_sweep_ids" if entity_type == "sweep" else "created_run_ids"
    if entity_id not in wild_loop_state.get(key, []):
        wild_loop_state.setdefault(key, []).append(entity_id)
        logger.debug("[wild-engine] Tracked %s creation: %s", entity_type, entity_id)


# =============================================================================
# Auto-Enqueue Helpers (called from server.py create_alert / update_run_status)
# =============================================================================

def auto_enqueue_alert(alert_id: str, run_id: str, run_name: str, severity: str, message: str, choices: list):
    """Auto-enqueue a wild event for a new alert, if wild mode is on."""
    if not wild_mode_enabled:
        return
    severity_priority = {"critical": 20, "warning": 30, "info": 50}
    priority = severity_priority.get(severity, 30)
    wild_event_queue.enqueue({
        "id": f"alert-{alert_id}",
        "priority": priority,
        "title": f"Alert: {run_name}",
        "prompt": (
            f"Alert {alert_id} for run {run_name} ({run_id}). "
            f"Severity: {severity}. Message: {message}. "
            f"Choices: {', '.join(choices)}"
        ),
        "type": "alert",
        "created_at": time.time(),
    })
    logger.info(f"Auto-enqueued wild event for alert {alert_id} (severity={severity}, priority={priority})")


def auto_enqueue_run_terminal(run_id: str, run_name: str, status: str, exit_code=None, error=None):
    """Auto-enqueue a wild event when a run reaches a terminal state, if wild mode is on."""
    if not wild_mode_enabled:
        return
    if status not in ("finished", "failed"):
        return
    priority = 40 if status == "failed" else 50
    emoji = "❌" if status == "failed" else "✅"
    wild_event_queue.enqueue({
        "id": f"run-{run_id}-{status}",
        "priority": priority,
        "title": f"{emoji} Run: {run_name}",
        "prompt": (
            f"Run {run_name} ({run_id}) {status}. "
            f"Exit code: {exit_code}. Error: {error or 'none'}"
        ),
        "type": "run_event",
        "created_at": time.time(),
    })
    logger.info(f"Auto-enqueued wild event for run {run_id} ({status}, priority={priority})")





# =============================================================================
# Experiment Context Builder
# =============================================================================

def build_experiment_context(
    runs: Dict[str, dict],
    sweeps: Dict[str, dict],
    active_alerts: Dict[str, dict],
    recompute_fn: Callable,
) -> str:
    """Build a summary of current experiment state for the wild mode prompt.

    Accepts server-level dicts as explicit parameters to avoid circular imports.
    """
    lines = ["\n--- Current Experiment State ---"]
    recompute_fn()

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

    if wild_loop_state.get("goal"):
        lines.append(f"Goal: {wild_loop_state['goal']}")

    lines.append("--- End State ---\n")
    return "\n".join(lines)


# =============================================================================
# Wild Mode Prompt Builder
# =============================================================================

# Skill ID mapping per prompt_type
_PROMPT_TYPE_SKILL_MAP = {
    "planning": "wild_planning",
    "exploring": "wild_exploring",
    "run_event": "wild_monitoring",
    "alert": "wild_alert",
    "analysis": "wild_analyzing",
    "job_scheduling": "wild_job_scheduling",
}



def _format_duration(seconds: Optional[int]) -> str:
    """Format a duration in seconds to a human-readable string."""
    if seconds is None:
        return "unlimited"
    hours = seconds / 3600
    if hours == int(hours):
        h = int(hours)
        return f"{h} hour{'s' if h != 1 else ''}"
    return f"{hours:.1f} hours"


def _render_simple(template: str, variables: Dict[str, str]) -> str:
    """Render a template by replacing {{key}} placeholders."""
    import re as _re
    result = template
    for key, value in variables.items():
        result = result.replace("{{" + key + "}}", str(value))
    result = _re.sub(r"\{\{[a-zA-Z_]+\}\}", "", result)
    return result


def build_prompt_for_frontend(
    req: BuildPromptRequest,
    skill_get_fn: Callable,
    server_url: str = "",
    auth_token: str = "",
) -> dict:
    """Build a wild loop prompt and return full provenance metadata.

    skill_get_fn: function(skill_id) -> {"id", "name", "template", "variables", ...} or None
    Returns a dict matching BuildPromptResponse shape.
    """
    prompt_type = req.prompt_type
    goal = req.goal or wild_loop_state.get("goal") or "No specific goal set"
    step_goal = req.step_goal or wild_loop_state.get("step_goal") or "Work towards the user goal — assess the situation and take the most productive next action."
    iteration = req.iteration if req.iteration is not None else (wild_loop_state.get("iteration", 0) + 1)

    # Build variables dict based on prompt type
    max_iter = req.max_iterations or wild_loop_state.get("termination", {}).get("max_iterations")
    max_iter_display = str(max_iter) if max_iter else "∞"
    autonomy = wild_loop_state.get("autonomy_level", "balanced")
    queue_edit = "Yes" if wild_loop_state.get("queue_modify_enabled", True) else "No"
    max_time = wild_loop_state.get("termination", {}).get("max_time_seconds")
    plan_autonomy = wild_loop_state.get("plan_autonomy", "agent")
    plan_autonomy_instruction = (
        "You have full autonomy over planning. Decide the best approach based on the goal and available context. Do NOT ask clarifying questions \u2014 make reasonable assumptions and proceed."
        if plan_autonomy == "agent"
        else "Before executing, ask **up to 3 clarifying questions** if the goal is ambiguous. Wait for answers before committing to an approach. Prefer collaborative planning over independent assumptions."
    )
    variables: Dict[str, str] = {
        "goal": goal, "step_goal": step_goal,
        "iteration": str(iteration), "max_iteration": max_iter_display,
        "autonomy_level": autonomy, "queue_modify_enabled": queue_edit,
        "away_duration": _format_duration(max_time),
        "server_url": server_url, "auth_token": auth_token,
        "plan_autonomy": plan_autonomy,
        "plan_autonomy_instruction": plan_autonomy_instruction,
    }

    if prompt_type == "run_event":
        status_emoji = "❌" if req.run_status == "failed" else "✅"
        run_instructions = (
            "- This run FAILED. Diagnose the issue from the logs above.\n"
            "- Take corrective action: fix code, adjust parameters, or create a new run.\n"
            "- You can rerun this specific run after fixing the issue."
        ) if req.run_status == "failed" else (
            "- This run SUCCEEDED. Check if the results look correct.\n"
            "- If results are suspicious, investigate further."
        )
        variables.update({
            "run_name": req.run_name or "",
            "run_id": req.run_id or "",
            "run_status": req.run_status or "",
            "run_command": req.run_command or "",
            "log_tail": (req.log_tail or "")[-1000:],
            "sweep_summary": req.sweep_summary or "",
            "status_emoji": status_emoji,
            "run_instructions": run_instructions,
        })
    elif prompt_type == "alert":
        alert_choices = ", ".join(f"`{c}`" for c in (req.alert_choices or []))
        resolve_example = '{"alert_id": "' + (req.alert_id or "") + '", "choice": "ONE_OF_THE_CHOICES_ABOVE"}'
        variables.update({
            "run_name": req.run_name or "",
            "alert_id": req.alert_id or "",
            "alert_severity": req.alert_severity or "",
            "alert_message": req.alert_message or "",
            "alert_choices": alert_choices,
            "alert_resolve_example": resolve_example,
        })
    elif prompt_type == "analysis":
        variables.update({
            "sweep_name": req.sweep_name or "",
            "total_runs": str(req.total_runs or 0),
            "passed_runs": str(req.passed_runs or 0),
            "failed_runs": str(req.failed_runs or 0),
            "run_summaries": req.run_summaries or "",
        })

    # Try to use the prompt skill template
    skill_id = _PROMPT_TYPE_SKILL_MAP.get(prompt_type)
    skill = skill_get_fn(skill_id) if skill_id else None

    if skill:
        template_raw = skill["template"]
        rendered = _render_simple(template_raw, variables)
        return {
            "rendered": rendered,
            "user_input": goal,
            "skill_id": skill["id"],
            "skill_name": skill.get("name", skill["id"]),
            "template": template_raw,
            "variables": variables,
            "prompt_type": prompt_type,
        }

    # No skill found — return empty
    logger.warning("[wild-engine] No skill template found for prompt_type=%s", prompt_type)
    return {
        "rendered": "",
        "user_input": goal,
        "skill_id": None,
        "skill_name": None,
        "template": None,
        "variables": variables,
        "prompt_type": prompt_type,
    }


def build_wild_prompt(
    prompt_skill_render_fn: Callable,
    experiment_context: str,
    server_url: str = "",
    auth_token: str = "",
) -> str:
    """Build the wild-mode preamble for _build_chat_prompt.

    Returns the rendered wild mode note string, or empty string if rendering fails.
    prompt_skill_render_fn should be prompt_skill_manager.render
    """
    iteration = wild_loop_state.get("iteration", 0) + 1
    goal = wild_loop_state.get("goal") or "No specific goal set"
    step_goal = wild_loop_state.get("step_goal") or "Work towards the user goal — assess the situation and take the most productive next action."
    max_iter = wild_loop_state.get("termination", {}).get("max_iterations")
    custom_cond = wild_loop_state.get("termination", {}).get("custom_condition")

    iter_display = f"{iteration}"
    if max_iter:
        iter_display += f" / {max_iter}"
    else:
        iter_display += " (unlimited)"

    sweep_id = wild_loop_state.get("sweep_id")
    sweep_note = ""
    if sweep_id:
        sweep_note = (
            f"\n## Active Wild Sweep\n"
            f"Sweep ID: `{sweep_id}` — When creating new runs, use `sweep_id=\"{sweep_id}\"` "
            f"so they are tracked as part of this wild loop session.\n"
        )

    custom_condition_text = ""
    if custom_cond:
        custom_condition_text = f"- Custom stop condition: {custom_cond}"

    autonomy = wild_loop_state.get("autonomy_level", "balanced")
    queue_edit = "Yes" if wild_loop_state.get("queue_modify_enabled", True) else "No"
    max_time = wild_loop_state.get("termination", {}).get("max_time_seconds")

    plan_autonomy = wild_loop_state.get("plan_autonomy", "agent")
    plan_autonomy_instruction = (
        "You have full autonomy over planning. Decide the best approach based on the goal and available context. Do NOT ask clarifying questions \u2014 make reasonable assumptions and proceed."
        if plan_autonomy == "agent"
        else "Before executing, ask **up to 3 clarifying questions** if the goal is ambiguous. Wait for answers before committing to an approach. Prefer collaborative planning over independent assumptions."
    )

    rendered = prompt_skill_render_fn("wild_system", {
        "iteration": iter_display,
        "max_iterations": str(max_iter) if max_iter else "unlimited",
        "goal": goal,
        "step_goal": step_goal,
        "experiment_context": experiment_context,
        "sweep_note": sweep_note,
        "custom_condition": custom_condition_text,
        "autonomy_level": autonomy,
        "queue_modify_enabled": queue_edit,
        "away_duration": _format_duration(max_time),
        "server_url": server_url,
        "auth_token": auth_token,
        "plan_autonomy": plan_autonomy,
        "plan_autonomy_instruction": plan_autonomy_instruction,
    })
    if rendered:
        return rendered + "\n\n"

    logger.warning("wild_system prompt skill not found — sending raw message")
    return ""


# =============================================================================
# Serialization helpers (for save/load settings)
# =============================================================================

def get_serializable_state() -> dict:
    """Return state dict suitable for JSON serialization (deep copied)."""
    return {
        "wild_mode": wild_mode_enabled,
        "wild_loop": copy.deepcopy(wild_loop_state),
    }


def load_from_saved(data: dict):
    """Restore state from a previously saved dict."""
    global wild_mode_enabled
    wild_mode_enabled = bool(data.get("wild_mode", False))
    saved_loop = data.get("wild_loop")
    if saved_loop and isinstance(saved_loop, dict):
        wild_loop_state.update(saved_loop)


# =============================================================================
# New Pydantic Models for Backend-Driven Endpoints
# =============================================================================

class WildStartRequest(BaseModel):
    """Request to start the wild loop."""
    goal: str
    session_id: str
    max_iterations: Optional[int] = None
    max_time_seconds: Optional[int] = None
    max_tokens: Optional[int] = None
    custom_condition: Optional[str] = None


class WildResponseCompleteRequest(BaseModel):
    """Frontend tells backend that the agent finished responding."""
    response_text: str


class WildSteerRequest(BaseModel):
    """User inserts a steer message into the queue."""
    message: str
    priority: int = 10


class WildNextPrompt(BaseModel):
    """Response from GET /wild/next-prompt."""
    has_prompt: bool = False
    event_id: Optional[str] = None
    prompt: Optional[str] = None
    display_message: Optional[str] = None
    title: Optional[str] = None
    event_type: Optional[str] = None
    priority: Optional[int] = None
    provenance: Optional[dict] = None


# =============================================================================
# Signal Parsing (moved from frontend use-wild-loop.ts)
# =============================================================================

def parse_signal(text: str) -> Optional[str]:
    """Parse a <promise>SIGNAL</promise> or <signal>SIGNAL</signal> tag.

    Returns the signal type string ('CONTINUE', 'COMPLETE', 'NEEDS_HUMAN')
    or None if no signal found.
    """
    m = re.search(r"<promise>(CONTINUE|COMPLETE|NEEDS_HUMAN)</promise>", text)
    if m:
        return m.group(1)
    m = re.search(r"<signal>(CONTINUE|COMPLETE|NEEDS_HUMAN)</signal>", text)
    if m:
        return m.group(1)
    return None


def parse_sweep_spec(text: str) -> Optional[dict]:
    """Parse a <sweep>{json}</sweep> tag from the agent's response.

    Returns a dict with keys: name, base_command, parameters, max_runs, workdir
    or None if no valid sweep spec found.
    """
    m = re.search(r"<sweep>([\s\S]*?)</sweep>", text)
    if not m:
        return None
    try:
        spec = json.loads(m.group(1).strip())
        if not spec.get("name") or not spec.get("base_command") or not spec.get("parameters"):
            logger.warning("Sweep spec missing required fields: %s", spec)
            return None
        return {
            "name": spec["name"],
            "base_command": spec["base_command"],
            "workdir": spec.get("workdir"),
            "parameters": spec["parameters"],
            "max_runs": spec.get("max_runs"),
            "auto_start": False,
        }
    except (json.JSONDecodeError, TypeError) as err:
        logger.warning("Failed to parse sweep spec: %s", err)
        return None


def parse_alert_resolution(text: str) -> Optional[dict]:
    """Parse a <resolve_alert>{json}</resolve_alert> tag.

    Returns dict with keys: alert_id, choice, or None.
    """
    m = re.search(r"<resolve_alert>([\s\S]*?)</resolve_alert>", text)
    if not m:
        return None
    try:
        spec = json.loads(m.group(1).strip())
        if not spec.get("alert_id") or not spec.get("choice"):
            return None
        return {"alert_id": spec["alert_id"], "choice": spec["choice"]}
    except (json.JSONDecodeError, TypeError):
        return None


def parse_next_step(text: str) -> Optional[str]:
    """Parse a <next_step>...</next_step> tag from the agent's response.

    Returns the next step goal string, or None if no tag found.
    """
    m = re.search(r"<next_step>([\s\S]*?)</next_step>", text)
    if m:
        step = m.group(1).strip()
        return step if step else None
    return None


_VALID_ROLES = {"planning", "exploring", "monitoring", "analyzing", "alert", "job_scheduling"}

def parse_next_role(text: str) -> Optional[str]:
    """Parse a <next_role>...</next_role> tag from the agent's response.

    Valid roles: exploring, monitoring, analyzing, alert.
    Returns the role string if valid, or None.
    """
    m = re.search(r"<next_role>([\s\S]*?)</next_role>", text)
    if m:
        role = m.group(1).strip().lower()
        if role in _VALID_ROLES:
            return role
        logger.warning("[wild-engine] Invalid next_role '%s', ignoring", role)
    return None


def parse_summary(text: str) -> Optional[str]:
    """Parse a <summary>...</summary> tag from the agent's response.

    Returns the summary string, or None if no tag found.
    """
    m = re.search(r"<summary>([\s\S]*?)</summary>", text)
    if m:
        s = m.group(1).strip()
        return s if s else None
    return None


# =============================================================================
# WildLoopEngine — Backend-Driven Orchestrator
# =============================================================================

class WildLoopEngine:
    """Backend-driven wild loop orchestrator.

    Owns all state, event queue, signal parsing, termination checks, stage
    transitions, and prompt construction. The frontend becomes a thin client
    that polls for state and calls lifecycle endpoints.

    Dependencies are injected via set_callbacks() to avoid circular imports
    with server.py.
    """

    def __init__(self):
        # ---- Injected callbacks (set by server.py at startup) ----
        self._get_runs: Optional[Callable[[], Dict]] = None
        self._get_sweeps: Optional[Callable[[], Dict]] = None
        self._get_alerts: Optional[Callable[[], Dict]] = None
        self._get_run_logs: Optional[Callable[[str], str]] = None
        self._create_sweep: Optional[Callable[[dict], Any]] = None
        self._start_sweep: Optional[Callable[[str, int], Any]] = None
        self._respond_to_alert: Optional[Callable[[str, str], Any]] = None
        self._recompute_sweep_state: Optional[Callable[[str], None]] = None
        self._skill_get_fn: Optional[Callable[[str], Optional[dict]]] = None
        self._save_settings: Optional[Callable[[], None]] = None
        self._record_step: Optional[Callable[[dict], None]] = None

        # ---- Server access info (set by set_callbacks) ----
        self._server_url: str = ""
        self._auth_token: str = ""

        # ---- Internal state ----
        self._poll_task: Optional[asyncio.Task] = None
        self._paused_at: Optional[float] = None
        self._paused_duration: float = 0.0
        # Track which run statuses we've already seen (to detect transitions)
        self._seen_run_statuses: Dict[str, str] = {}
        self._processed_alert_ids: set = set()
        self._analysis_queued: bool = False
        # The prompt that is currently "pending" for the frontend to pick up
        self._pending_prompt: Optional[dict] = None  # WildNextPrompt-shaped dict

        # ---- Action event / cron infrastructure ----
        self._cron_tasks: List[CronTask] = []
        self._action_timeout: float = 10.0  # seconds
        self._action_log: List[dict] = []    # Recent action results (visible to frontend)
        self._action_log_max: int = 50       # Cap log size

    def set_callbacks(
        self,
        get_runs: Callable,
        get_sweeps: Callable,
        get_alerts: Callable,
        get_run_logs: Callable,
        create_sweep: Callable,
        start_sweep: Callable,
        respond_to_alert: Callable,
        recompute_sweep_state: Callable,
        skill_get_fn: Callable,
        save_settings: Callable,
        record_step: Optional[Callable] = None,
        server_url: str = "",
        auth_token: str = "",
    ):
        """Inject server.py callbacks to avoid circular imports."""
        self._get_runs = get_runs
        self._get_sweeps = get_sweeps
        self._get_alerts = get_alerts
        self._get_run_logs = get_run_logs
        self._create_sweep = create_sweep
        self._start_sweep = start_sweep
        self._respond_to_alert = respond_to_alert
        self._recompute_sweep_state = recompute_sweep_state
        self._skill_get_fn = skill_get_fn
        self._save_settings = save_settings
        self._record_step = record_step
        self._server_url = server_url
        self._auth_token = auth_token

    def set_server_url(self, server_url: str) -> None:
        """Update the server base URL used in generated prompts."""
        if server_url:
            self._server_url = server_url

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    def start(self, req: WildStartRequest) -> dict:
        """Start the wild loop."""
        global wild_mode_enabled
        wild_mode_enabled = True

        now = time.time()
        wild_loop_state.update({
            "phase": "planning",
            "stage": "planning",
            "is_active": True,
            "is_paused": False,
            "iteration": 0,
            "goal": req.goal,
            "step_goal": None,
            "session_id": req.session_id,
            "started_at": now,
            "sweep_id": None,
            "created_sweep_ids": [],
            "created_run_ids": [],
            "termination": {
                "max_iterations": req.max_iterations,
                "max_time_seconds": req.max_time_seconds,
                "max_tokens": req.max_tokens,
                "custom_condition": req.custom_condition,
            },
        })

        # Clear internal tracking state
        wild_event_queue.clear()
        self._seen_run_statuses.clear()
        self._processed_alert_ids.clear()
        self._analysis_queued = False
        self._paused_at = None
        self._paused_duration = 0.0
        self._pending_prompt = None

        self._enqueue_planning_prompt(iteration=0)

        # Register default cron tasks
        self._cron_tasks = [
            CronTask(
                name="resource_monitor",
                handler="resource_monitor",
                interval_seconds=5.0,
                handler_config={"max_concurrent": 1},
                priority=25,
            ),
        ]

        # Start the background polling task
        self._start_poll_task()

        if self._save_settings:
            self._save_settings()

        logger.info("[wild-engine] Started: goal=%s session=%s", req.goal, req.session_id)
        return wild_loop_state

    def stop(self) -> dict:
        """Stop the wild loop entirely."""
        global wild_mode_enabled
        wild_mode_enabled = False

        self._stop_poll_task()
        wild_event_queue.clear()
        self._pending_prompt = None
        self._analysis_queued = False
        self._cron_tasks.clear()

        wild_loop_state.update({
            "phase": "idle",
            "stage": "exploring",
            "is_active": False,
            "is_paused": False,
            "iteration": 0,
            "goal": None,
            "session_id": None,
            "started_at": None,
            "sweep_id": None,
        })

        if self._save_settings:
            self._save_settings()

        logger.info("[wild-engine] Stopped")
        return wild_loop_state

    def pause(self) -> dict:
        """Pause the wild loop. Events stay in queue for resume."""
        wild_loop_state["is_paused"] = True
        wild_loop_state["phase"] = "paused"
        self._paused_at = time.time()

        if self._save_settings:
            self._save_settings()

        logger.info("[wild-engine] Paused at iteration %d", wild_loop_state["iteration"])
        return wild_loop_state

    def resume(self) -> dict:
        """Resume the wild loop."""
        wild_loop_state["is_paused"] = False

        # Accumulate paused time
        if self._paused_at is not None:
            self._paused_duration += time.time() - self._paused_at
            self._paused_at = None

        stage = wild_loop_state.get("stage", "exploring")
        phase = "monitoring" if stage == "running" else "exploring"
        wild_loop_state["phase"] = phase

        # If exploring and queue is empty, enqueue a new exploring prompt
        if stage == "exploring" and wild_event_queue.size == 0 and self._pending_prompt is None:
            iteration = wild_loop_state.get("iteration", 0) + 1
            self._enqueue_exploring_prompt(iteration)

        # Restart polling if not running
        self._start_poll_task()

        if self._save_settings:
            self._save_settings()

        logger.info("[wild-engine] Resumed, stage=%s", stage)
        return wild_loop_state

    # -----------------------------------------------------------------
    # Response Processing (called by POST /wild/response-complete)
    # -----------------------------------------------------------------

    def on_response_complete(self, response_text: str) -> dict:
        """Process the agent's response: parse signals, transition stages, enqueue next.

        Returns the updated wild_loop_state.
        """
        if not wild_loop_state.get("is_active") or wild_loop_state.get("is_paused"):
            return wild_loop_state

        # Increment iteration
        iteration = wild_loop_state.get("iteration", 0) + 1
        wild_loop_state["iteration"] = iteration

        # Record step history
        if self._record_step:
            try:
                self._record_step({
                    "iteration": iteration,
                    "stage": wild_loop_state.get("stage", "exploring"),
                    "response_text_preview": response_text[:200] if response_text else "",
                    "timestamp": time.time(),
                })
            except Exception:
                pass

        # Check termination first
        if self._check_termination():
            logger.info("[wild-engine] Termination condition met at iteration %d", iteration)
            self.stop()
            return wild_loop_state

        # Parse signals from agent response
        signal = parse_signal(response_text)

        # Parse next step goal from agent response
        next_step = parse_next_step(response_text)
        if next_step:
            wild_loop_state["step_goal"] = next_step
            logger.info("[wild-engine] Next step goal: %s", next_step[:100])

        # Parse next role from agent response
        next_role = parse_next_role(response_text)
        if next_role:
            wild_loop_state["next_step_role"] = next_role
            logger.info("[wild-engine] Next step role: %s", next_role)

        # Parse summary from agent response
        summary = parse_summary(response_text)
        if summary:
            wild_loop_state["last_summary"] = summary
            logger.info("[wild-engine] Step summary: %s", summary[:200])

        if signal == "COMPLETE":
            logger.info("[wild-engine] COMPLETE signal at iteration %d", iteration)
            self.stop()
            return wild_loop_state

        if signal == "NEEDS_HUMAN":
            logger.info("[wild-engine] NEEDS_HUMAN signal at iteration %d", iteration)
            self.pause()
            return wild_loop_state

        stage = wild_loop_state.get("stage", "exploring")

        if stage == "planning":
            self._handle_planning_response(response_text, iteration)
        elif stage == "exploring":
            self._handle_exploring_response(response_text, iteration)
        elif stage == "running":
            self._handle_running_response(response_text)
            # running stage: don't auto-queue; polling handles next events
        elif stage == "analyzing":
            self._handle_analyzing_response(response_text, iteration)
        # job_scheduling is now handled entirely by action handlers (no LLM).
        # If somehow the stage is still "job_scheduling", treat it like exploring.
        elif stage == "job_scheduling":
            self._handle_exploring_response(response_text, iteration)

        if self._save_settings:
            self._save_settings()

        return wild_loop_state

    # -----------------------------------------------------------------
    # Next Prompt Delivery (polled by frontend)
    # -----------------------------------------------------------------

    def get_next_prompt(self) -> dict:
        """Return the next prompt for the frontend to display/send.

        If there's a pending prompt already set, return it.
        Otherwise, try to dequeue from the event queue and build a prompt.
        """
        if self._pending_prompt is not None:
            return self._pending_prompt

        if not wild_loop_state.get("is_active") or wild_loop_state.get("is_paused"):
            return {"has_prompt": False}

        event = wild_event_queue.peek()
        if event is None:
            return {"has_prompt": False}

        # Skip action events — they are resolved by the engine, not the frontend
        if event.get("handler"):
            return {"has_prompt": False}

        # Build the prompt with provenance
        prompt_text = event.get("prompt", "")
        provenance = event.get("provenance")

        # If no provenance yet, try to build one via skill templates
        if provenance is None and self._skill_get_fn:
            prompt_type = event.get("type", "exploring")
            try:
                provenance_result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type=prompt_type,
                        goal=wild_loop_state.get("goal", ""),
                        iteration=wild_loop_state.get("iteration", 0),
                    ),
                    self._skill_get_fn,
                )
                if provenance_result.get("rendered"):
                    prompt_text = provenance_result["rendered"]
                    provenance = provenance_result
            except Exception as err:
                logger.debug("[wild-engine] Failed to build provenance: %s", err)

        self._pending_prompt = {
            "has_prompt": True,
            "event_id": event.get("id"),
            "prompt": prompt_text,
            "display_message": event.get("display_message"),
            "title": event.get("title"),
            "event_type": event.get("type"),
            "priority": event.get("priority"),
            "provenance": provenance,
        }
        return self._pending_prompt

    def consume_prompt(self) -> dict:
        """Mark the current pending prompt as consumed (sent to chat)."""
        self._pending_prompt = None
        wild_event_queue.dequeue()
        return {"consumed": True, "queue_size": wild_event_queue.size}

    # -----------------------------------------------------------------
    # Steer (user inserts a message)
    # -----------------------------------------------------------------

    def steer(self, req: WildSteerRequest) -> dict:
        """Insert a user steer message at high priority."""
        event = {
            "id": f"steer-{uuid.uuid4().hex[:8]}",
            "priority": req.priority,
            "title": req.message[:50] + ("..." if len(req.message) > 50 else ""),
            "prompt": req.message,
            "type": "steer",
            "created_at": time.time(),
        }
        added = wild_event_queue.enqueue(event)
        # Clear pending prompt so next poll picks up the steer (if higher priority)
        if added:
            self._pending_prompt = None
        logger.info("[wild-engine] Steer message added: %s (priority=%d)", event["title"], req.priority)
        return {"added": added, "event": event, "queue_size": wild_event_queue.size}

    # -----------------------------------------------------------------
    # Full Status (for GET /wild/status)
    # -----------------------------------------------------------------

    def get_full_status(self) -> dict:
        """Return complete status including queue info and run stats."""
        runs_dict = self._get_runs() if self._get_runs else {}
        sweep_id = wild_loop_state.get("sweep_id")
        sweeps_dict = self._get_sweeps() if self._get_sweeps else {}

        # Compute run stats for the tracked sweep
        run_stats = {"total": 0, "running": 0, "completed": 0, "failed": 0, "queued": 0}
        active_alerts_list: List[dict] = []

        if sweep_id and sweep_id in sweeps_dict:
            sweep = sweeps_dict[sweep_id]
            sweep_run_ids = set(sweep.get("run_ids", []))
            sweep_runs = [r for rid, r in runs_dict.items() if rid in sweep_run_ids]
            run_stats = {
                "total": len(sweep_runs),
                "running": sum(1 for r in sweep_runs if r.get("status") == "running"),
                "completed": sum(1 for r in sweep_runs if r.get("status") == "finished"),
                "failed": sum(1 for r in sweep_runs if r.get("status") == "failed"),
                "queued": sum(1 for r in sweep_runs if r.get("status") in ("queued", "ready")),
            }

            # Active alerts for this sweep's runs
            if self._get_alerts:
                all_alerts = self._get_alerts()
                active_alerts_list = [
                    a for a in all_alerts.values()
                    if a.get("run_id") in sweep_run_ids and a.get("status") == "pending"
                ]

        # Enrich created entity summaries for the debug panel
        created_sweeps_detail = []
        for sid in wild_loop_state.get("created_sweep_ids", []):
            if sid in sweeps_dict:
                s = sweeps_dict[sid]
                created_sweeps_detail.append({
                    "id": sid,
                    "name": s.get("name", sid),
                    "status": s.get("status", "unknown"),
                    "run_count": len(s.get("run_ids", [])),
                })

        created_runs_detail = []
        for rid in wild_loop_state.get("created_run_ids", []):
            if rid in runs_dict:
                r = runs_dict[rid]
                created_runs_detail.append({
                    "id": rid,
                    "name": r.get("name", rid),
                    "status": r.get("status", "unknown"),
                })

        return {
            **wild_loop_state,
            "queue_size": wild_event_queue.size,
            "queue_events": wild_event_queue.items(),
            "run_stats": run_stats,
            "active_alerts": active_alerts_list,
            "has_pending_prompt": self._pending_prompt is not None,
            "pending_event_id": self._pending_prompt.get("event_id") if self._pending_prompt else None,
            "created_sweeps": created_sweeps_detail,
            "created_runs": created_runs_detail,
        }

    # -----------------------------------------------------------------
    # Internal: Stage-specific response handlers
    # -----------------------------------------------------------------

    def _enqueue_planning_prompt(self, iteration: int):
        """Build and enqueue a planning prompt."""
        goal = wild_loop_state.get("goal", "Continue working")
        prompt_type = "planning"

        provenance = None
        prompt_text = None
        if self._skill_get_fn:
            try:
                max_iter = wild_loop_state.get("termination", {}).get("max_iterations")
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type=prompt_type,
                        goal=goal,
                        step_goal=None,
                        iteration=iteration,
                        max_iterations=max_iter,
                    ),
                    self._skill_get_fn,
                    server_url=self._server_url,
                    auth_token=self._auth_token,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception as err:
                logger.debug("[wild-engine] Skill template failed for planning: %s", err)

        if not prompt_text:
            logger.warning("[wild-engine] No prompt rendered for planning iteration %d", iteration)
            prompt_text = f"Wild Loop planning — Goal: {goal}. Create a step-by-step plan."

        event = {
            "id": f"plan-{iteration}-{uuid.uuid4().hex[:6]}",
            "priority": 85,
            "title": f"Planning (iteration {iteration})",
            "prompt": prompt_text,
            "display_message": None,
            "type": "planning",
            "created_at": time.time(),
            "provenance": provenance,
        }
        wild_event_queue.enqueue(event)
        self._pending_prompt = None
        logger.debug("[wild-engine] Enqueued planning prompt iter=%d", iteration)

    def _handle_planning_response(self, response_text: str, iteration: int):
        """Handle response while in planning stage.

        After planning, transition to exploring stage automatically
        and enqueue the first exploring prompt.
        """
        # The plan's next_step and summary are already parsed in on_response_complete
        wild_loop_state["stage"] = "exploring"
        wild_loop_state["phase"] = "exploring"
        logger.info("[wild-engine] Planning complete, transitioning to exploring")
        self._enqueue_exploring_prompt(iteration + 1)

    # NOTE: _enqueue_job_scheduling_prompt and _handle_job_scheduling_response
    # have been removed.  Job scheduling is now handled entirely by the
    # script-based `job_scheduling_action` action handler (no LLM call).
    # See auto_enqueue_job_scheduling() and job_scheduling_action_handler().


    def _handle_exploring_response(self, response_text: str, iteration: int):
        """Handle response while in exploring stage."""
        # Check if agent output a <sweep> spec
        sweep_spec = parse_sweep_spec(response_text)
        if sweep_spec and self._create_sweep:
            logger.info("[wild-engine] Parsed sweep spec: %s", sweep_spec.get("name"))
            try:
                sweep_result = self._create_sweep(sweep_spec)
                sweep_id = sweep_result.get("id") if isinstance(sweep_result, dict) else str(sweep_result)
                wild_loop_state["sweep_id"] = sweep_id
                wild_loop_state["stage"] = "running"
                wild_loop_state["phase"] = "monitoring"
                logger.info("[wild-engine] Created sweep %s, transitioning to running", sweep_id)
                # Cron-based resource_monitor will start queued runs
                return
            except Exception as err:
                logger.error("[wild-engine] Failed to create sweep: %s", err)
                # Fall through to re-enqueue exploring prompt

        # No sweep spec → enqueue next exploring prompt
        goal = wild_loop_state.get("goal", "Continue working")
        self._enqueue_exploring_prompt(iteration + 1)

    def _handle_running_response(self, response_text: str):
        """Handle response while in running stage (monitoring runs)."""
        resolution = parse_alert_resolution(response_text)
        if resolution and self._respond_to_alert:
            logger.info("[wild-engine] Resolving alert: %s → %s",
                        resolution["alert_id"], resolution["choice"])
            try:
                self._respond_to_alert(resolution["alert_id"], resolution["choice"])
            except Exception as err:
                logger.warning("[wild-engine] Failed to resolve alert: %s", err)
        # Running stage is event-driven: polling will trigger the next prompt

    def _handle_analyzing_response(self, response_text: str, iteration: int):
        """Handle response while in analyzing stage."""
        # COMPLETE and NEEDS_HUMAN already handled in on_response_complete().
        # CONTINUE or no signal: cycle back to exploring.
        self._analysis_queued = False
        logger.info("[wild-engine] Analysis says more work needed, cycling back to exploring")

        wild_loop_state["stage"] = "exploring"
        wild_loop_state["phase"] = "exploring"
        wild_loop_state["sweep_id"] = None

        # Reset tracking for new cycle
        self._seen_run_statuses.clear()
        self._processed_alert_ids.clear()

        goal = wild_loop_state.get("goal", "Continue working")
        self._enqueue_exploring_prompt(iteration + 1)

    # -----------------------------------------------------------------
    # Internal: Prompt Construction & Enqueueing
    # -----------------------------------------------------------------

    def _enqueue_exploring_prompt(self, iteration: int):
        """Build and enqueue an exploring prompt."""
        goal = wild_loop_state.get("goal", "Continue working")
        prompt_type = "exploring"

        # Try to build via skill templates
        provenance = None
        prompt_text = None
        if self._skill_get_fn:
            try:
                max_iter = wild_loop_state.get("termination", {}).get("max_iterations")
                step_goal = wild_loop_state.get("step_goal")
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type=prompt_type,
                        goal=goal,
                        step_goal=step_goal,
                        iteration=iteration,
                        max_iterations=max_iter,
                    ),
                    self._skill_get_fn,
                    server_url=self._server_url,
                    auth_token=self._auth_token,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception as err:
                logger.debug("[wild-engine] Skill template failed for exploring: %s", err)

        if not prompt_text:
            logger.warning("[wild-engine] No prompt rendered for exploring iteration %d", iteration)
            prompt_text = f"Wild Loop iteration {iteration} — Goal: {goal}"

        event = {
            "id": f"explore-{iteration}-{uuid.uuid4().hex[:6]}",
            "priority": 90,
            "title": f"Exploring (iteration {iteration})",
            "prompt": prompt_text,
            "display_message": None,
            "type": "exploring",
            "created_at": time.time(),
            "provenance": provenance,
        }
        wild_event_queue.enqueue(event)
        # Clear pending so next get_next_prompt picks up the new event
        self._pending_prompt = None
        logger.debug("[wild-engine] Enqueued exploring prompt iter=%d", iteration)

    def _enqueue_run_event_prompt(self, run: dict, run_id: str, log_tail: str,
                                  sweep_summary: str):
        """Build and enqueue a run event prompt."""
        goal = wild_loop_state.get("goal", "")
        run_name = run.get("name", run_id)
        run_status = run.get("status", "unknown")
        run_command = run.get("command", "")

        provenance = None
        prompt_text = None
        if self._skill_get_fn:
            try:
                step_goal = wild_loop_state.get("step_goal")
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type="run_event",
                        goal=goal,
                        step_goal=step_goal,
                        run_id=run_id,
                        run_name=run_name,
                        run_status=run_status,
                        run_command=run_command,
                        log_tail=log_tail,
                        sweep_summary=sweep_summary,
                    ),
                    self._skill_get_fn,
                    server_url=self._server_url,
                    auth_token=self._auth_token,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception:
                pass

        if not prompt_text:
            logger.warning("[wild-engine] No prompt rendered for run_event %s", run_id)
            prompt_text = f"Run '{run_name}' {run_status} — Goal: {goal}"

        display_msg = f"@run:{run_name} {run_status}"
        event = {
            "id": f"run-{run_id}-{run_status}",
            "priority": 40 if run_status == "failed" else 50,
            "title": f"{'❌' if run_status == 'failed' else '✅'} Run: {run_name}",
            "prompt": prompt_text,
            "display_message": display_msg,
            "type": "run_event",
            "created_at": time.time(),
            "provenance": provenance,
        }
        wild_event_queue.enqueue(event)
        self._pending_prompt = None

    def _enqueue_alert_prompt(self, alert: dict, run_name: str):
        """Build and enqueue an alert prompt."""
        goal = wild_loop_state.get("goal", "")
        alert_id = alert.get("id", "")

        provenance = None
        prompt_text = None
        if self._skill_get_fn:
            try:
                step_goal = wild_loop_state.get("step_goal")
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type="alert",
                        goal=goal,
                        step_goal=step_goal,
                        alert_id=alert_id,
                        alert_severity=alert.get("severity", ""),
                        alert_message=alert.get("message", ""),
                        alert_choices=alert.get("choices", []),
                        run_name=run_name,
                    ),
                    self._skill_get_fn,
                    server_url=self._server_url,
                    auth_token=self._auth_token,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception:
                pass

        if not prompt_text:
            logger.warning("[wild-engine] No prompt rendered for alert %s", alert_id)
            prompt_text = f"Alert from '{run_name}': {alert.get('message', '')} — Goal: {goal}"

        display_msg = f"@alert:{run_name} [{alert.get('severity', '')}] {alert.get('message', '')}"
        event = {
            "id": f"alert-{alert_id}",
            "priority": 20,
            "title": f"Alert: {run_name}",
            "prompt": prompt_text,
            "display_message": display_msg,
            "type": "alert",
            "created_at": time.time(),
            "provenance": provenance,
        }
        wild_event_queue.enqueue(event)
        self._pending_prompt = None

    def _enqueue_analysis_prompt(self, sweep_runs: list, sweep_name: str):
        """Build and enqueue an analysis prompt."""
        goal = wild_loop_state.get("goal", "")
        run_summaries = "\n".join(
            f"- **{r.get('name', r.get('id', '?'))}**: {r.get('status', '?')}"
            f"{'❌' if r.get('status') == 'failed' else ' ✅'}"
            for r in sweep_runs
        )
        passed = sum(1 for r in sweep_runs if r.get("status") == "finished")
        failed = sum(1 for r in sweep_runs if r.get("status") == "failed")

        provenance = None
        prompt_text = None
        if self._skill_get_fn:
            try:
                step_goal = wild_loop_state.get("step_goal")
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type="analysis",
                        goal=goal,
                        step_goal=step_goal,
                        sweep_name=sweep_name,
                        total_runs=len(sweep_runs),
                        passed_runs=passed,
                        failed_runs=failed,
                        run_summaries=run_summaries,
                    ),
                    self._skill_get_fn,
                    server_url=self._server_url,
                    auth_token=self._auth_token,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception:
                pass

        if not prompt_text:
            logger.warning("[wild-engine] No prompt rendered for analysis of sweep %s", sweep_name)
            prompt_text = f"Analysis: {sweep_name} — {len(sweep_runs)} runs ({passed} passed, {failed} failed) — Goal: {goal}"

        sweep_id = wild_loop_state.get("sweep_id", "")
        event = {
            "id": f"analysis-{sweep_id}-{uuid.uuid4().hex[:6]}",
            "priority": 70,
            "title": f"Analysis: {sweep_name}",
            "prompt": prompt_text,
            "type": "analysis",
            "created_at": time.time(),
            "provenance": provenance,
        }
        wild_event_queue.enqueue(event)
        self._pending_prompt = None

    # -----------------------------------------------------------------
    # Internal: Termination Check
    # -----------------------------------------------------------------

    def _check_termination(self) -> bool:
        """Check if any termination condition is met."""
        termination = wild_loop_state.get("termination", {})
        iteration = wild_loop_state.get("iteration", 0)

        max_iter = termination.get("max_iterations")
        if max_iter and iteration >= max_iter:
            return True

        started_at = wild_loop_state.get("started_at")
        max_time = termination.get("max_time_seconds")
        if max_time and started_at:
            elapsed = time.time() - started_at - self._paused_duration
            if elapsed >= max_time:
                return True

        return False

    # -----------------------------------------------------------------
    # Internal: Background Polling Task
    # -----------------------------------------------------------------
    #
    # ARCHITECTURE NOTES — Poll Loop
    # ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    #
    # The poll loop is the heartbeat of the wild loop engine.  It runs as
    # a single asyncio.Task, waking every 5 seconds, and executes three
    # phases sequentially:
    #
    #   ┌─────────────────────────────────────────────────────────────┐
    #   │  _poll_loop (every 5s)                                     │
    #   │                                                            │
    #   │  ① _process_action_events()                                │
    #   │     Peek the event queue.  If the head event has a         │
    #   │     `handler` field, resolve it inline via the handler     │
    #   │     registry (no LLM).  Repeats until the head is a       │
    #   │     prompt event or the queue is empty.                    │
    #   │                                                            │
    #   │  ② _process_cron_tasks()                                   │
    #   │     For each CronTask, check if `now - last_fired >=       │
    #   │     interval_seconds`.  If so, execute the handler inline  │
    #   │     (NOT via the queue) and apply its ActionResult          │
    #   │     immediately (state_updates, enqueue_events).           │
    #   │                                                            │
    #   │  ③ _poll_events()                                          │
    #   │     Poll runs/sweeps/alerts for status transitions.        │
    #   │     Enqueue prompt events for the LLM to handle.           │
    #   └─────────────────────────────────────────────────────────────┘
    #
    # EVENT RESOLUTION PATHS:
    #
    #   Prompt events (handler=None):
    #     queue → get_next_prompt() → frontend → LLM → on_response_complete
    #
    #   Action events (handler="name"):
    #     queue → _process_action_events() → _run_action_handler() → done
    #     (processed in the poll loop, never sent to frontend)
    #
    #   Cron tasks:
    #     timer fires → _process_cron_tasks() → _run_action_handler() → done
    #     (never enter the queue at all; execute inline)
    #
    # HANDLER EXECUTION:
    #   All handlers share _run_action_handler() which provides:
    #   - asyncio.wait_for() timeout (default 10s)
    #   - try/except crash isolation
    #   - Logging results to _action_log for frontend visibility
    #
    # KNOWN LIMITATIONS (candidates for future redesign):
    #
    #   1. SINGLE-THREADED SEQUENTIAL: All three phases run in one
    #      asyncio Task.  A slow action handler or poll blocks the
    #      entire loop.  Future: consider asyncio.TaskGroup or a
    #      dedicated worker pool for handlers.
    #
    #   2. NO BACKPRESSURE: If action handlers enqueue faster than
    #      they drain, the queue grows unbounded (only soft-capped at
    #      10 action events per cycle).  Future: add queue size limits
    #      and handler throttling.
    #
    #   3. CRON IMPRECISION: Cron tasks fire "at most once per poll
    #      cycle" (5s).  A task with interval_seconds=1 still fires
    #      at most every 5s.  Future: separate high-frequency timer.
    #
    #   4. NO PRIORITY INVERSION PREVENTION: A burst of low-priority
    #      action events can delay processing of higher-priority
    #      prompt events since action events are resolved first.
    #      Future: interleave action and prompt processing, or
    #      separate the action queue from the prompt queue.
    #
    #   5. FRONTEND VISIBILITY: Action events are invisible to the
    #      frontend (get_next_prompt skips them).  Only _action_log
    #      preserves their history.  Future: expose _action_log via
    #      an API endpoint and show in debug panel.
    #

    def _start_poll_task(self):
        """Start the background event polling loop."""
        if self._poll_task and not self._poll_task.done():
            return  # Already running

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                self._poll_task = loop.create_task(self._poll_loop())
        except RuntimeError:
            logger.debug("[wild-engine] No running event loop, polling task not started")

    def _stop_poll_task(self):
        """Cancel the background polling task."""
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            self._poll_task = None

    async def _poll_loop(self):
        """Background loop: process action events, cron tasks, and poll for run/sweep events."""
        logger.debug("[wild-engine] Poll loop started")
        try:
            while wild_loop_state.get("is_active"):
                if not wild_loop_state.get("is_paused"):
                    await self._process_action_events()
                    await self._process_cron_tasks()
                    await self._poll_events()
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            logger.debug("[wild-engine] Poll loop cancelled")
        except Exception as err:
            logger.error("[wild-engine] Poll loop error: %s", err, exc_info=True)
        finally:
            logger.debug("[wild-engine] Poll loop ended")

    async def _process_action_events(self):
        """Resolve action events (events with a handler) without LLM.

        Processes all pending action events in priority order. Each handler
        runs with a timeout and crash isolation.  Results are appended to
        _action_log for frontend visibility.
        """
        processed = 0
        while True:
            # Peek at next event — if it's an action event, process it
            event = wild_event_queue.peek()
            if event is None or not event.get("handler"):
                break

            result = await self._run_action_handler(event)

            # Process result
            if result.resolve_event:
                wild_event_queue.dequeue()

            if result.state_updates:
                wild_loop_state.update(result.state_updates)

            for new_event in result.enqueue_events:
                if "created_at" not in new_event:
                    new_event["created_at"] = time.time()
                if "id" not in new_event:
                    new_event["id"] = f"action-{uuid.uuid4().hex[:6]}"
                wild_event_queue.enqueue(new_event)

            processed += 1
            if processed >= 10:  # Safety: don't process more than 10 per poll cycle
                break

    async def _process_cron_tasks(self):
        """Fire periodic cron tasks whose interval has elapsed.

        Cron tasks execute their handler directly (inline) — no queue
        indirection.  This is the simplest model: check timer → run function
        → record result.  The handler output (enqueue_events, state_updates)
        is applied immediately.
        """
        now = time.time()
        for task in self._cron_tasks:
            if now - task.last_fired < task.interval_seconds:
                continue

            # Cron tasks are script-only (no LLM), so they always run
            # regardless of pending prompts or LLM state.

            task.last_fired = now
            handler = get_action_handler(task.handler)
            if handler is None:
                logger.warning("[wild-engine] Cron '%s': no handler '%s' registered", task.name, task.handler)
                continue

            # Build a synthetic event dict for the handler signature
            event = {
                "id": f"cron-{task.name}-{uuid.uuid4().hex[:4]}",
                "type": "cron",
                "handler": task.handler,
                "handler_config": task.handler_config,
                "title": f"\u23f0 Cron: {task.name}",
                "priority": task.priority,
                "created_at": now,
            }

            result = await self._run_action_handler(event)

            # Apply result directly (no queue hop)
            if result.state_updates:
                wild_loop_state.update(result.state_updates)

            for new_event in result.enqueue_events:
                # Singleton: skip if a job_scheduling event already exists in queue
                if new_event.get("type") == "job_scheduling":
                    already_queued = any(
                        ev.get("type") == "job_scheduling"
                        for ev in wild_event_queue.items()
                    )
                    if already_queued:
                        logger.debug("[wild-engine] Cron '%s': job_scheduling already in queue, skipping", task.name)
                        continue
                if "created_at" not in new_event:
                    new_event["created_at"] = time.time()
                if "id" not in new_event:
                    new_event["id"] = f"cron-evt-{uuid.uuid4().hex[:6]}"
                wild_event_queue.enqueue(new_event)

            logger.debug("[wild-engine] Cron '%s' fired: %s", task.name, result.summary[:120])

    async def _run_action_handler(self, event: dict) -> ActionResult:
        """Execute an action handler with timeout + crash isolation.

        Records the result to _action_log for frontend visibility.
        """
        handler_name = event.get("handler", "")
        handler = get_action_handler(handler_name)
        if handler is None:
            logger.warning("[wild-engine] No handler '%s', skipping", handler_name)
            return ActionResult(success=False, summary=f"No handler: {handler_name}")

        config = event.get("handler_config") or {}
        context = {
            "wild_loop_state": wild_loop_state,
            "runs": self._get_runs() if self._get_runs else {},
            "sweeps": self._get_sweeps() if self._get_sweeps else {},
            "start_sweep": self._start_sweep,
            "queue_size": wild_event_queue.size,
        }

        try:
            result = await asyncio.wait_for(
                handler(event, config, context),
                timeout=self._action_timeout,
            )
        except asyncio.TimeoutError:
            result = ActionResult(success=False, summary=f"Timeout ({self._action_timeout:.0f}s)")
            logger.warning("[wild-engine] Handler '%s' timed out", handler_name)
        except Exception as err:
            result = ActionResult(success=False, summary=f"Error: {err}")
            logger.error("[wild-engine] Handler '%s' failed: %s", handler_name, err, exc_info=True)

        # Record to action log for frontend visibility
        self._action_log.append({
            "handler": handler_name,
            "event_id": event.get("id"),
            "success": result.success,
            "summary": result.summary,
            "timestamp": time.time(),
            "enqueued": len(result.enqueue_events),
        })
        # Cap log size
        if len(self._action_log) > self._action_log_max:
            self._action_log = self._action_log[-self._action_log_max:]

        logger.info("[wild-engine] Action '%s' [%s]: %s",
                    handler_name, 'OK' if result.success else 'FAIL', result.summary[:200])
        return result

    async def _poll_events(self):
        """Poll runs/sweeps/alerts and enqueue events for status transitions."""
        stage = wild_loop_state.get("stage")
        sweep_id = wild_loop_state.get("sweep_id")

        if stage != "running" or not sweep_id:
            return

        if not self._get_runs or not self._get_sweeps:
            return

        try:
            runs_dict = self._get_runs()
            sweeps_dict = self._get_sweeps()
            sweep = sweeps_dict.get(sweep_id)
            if not sweep:
                return

            sweep_run_ids = set(sweep.get("run_ids", []))
            sweep_runs = [
                {"id": rid, **runs_dict[rid]}
                for rid in sweep_run_ids if rid in runs_dict
            ]

            # Check for alerts
            if self._get_alerts:
                all_alerts = self._get_alerts()
                pending_alerts = [
                    a for a in all_alerts.values()
                    if a.get("run_id") in sweep_run_ids and a.get("status") == "pending"
                ]

                for alert in pending_alerts:
                    alert_id = alert.get("id", "")
                    if alert_id not in self._processed_alert_ids:
                        self._processed_alert_ids.add(alert_id)
                        run = next((r for r in sweep_runs if r.get("id") == alert.get("run_id")), None)
                        run_name = run.get("name", alert.get("run_id", "")) if run else alert.get("run_id", "")
                        self._enqueue_alert_prompt(alert, run_name)
                        logger.info("[wild-engine] Enqueued alert event: %s", alert_id)
            else:
                pending_alerts = []

            # Check for run status transitions
            for run in sweep_runs:
                rid = run.get("id", "")
                status = run.get("status", "")
                prev = self._seen_run_statuses.get(rid)
                if prev != status and status in ("finished", "failed"):
                    self._seen_run_statuses[rid] = status

                    # Fetch log tail
                    log_tail = "No logs available"
                    if self._get_run_logs:
                        try:
                            log_tail = self._get_run_logs(rid) or "Empty"
                        except Exception:
                            pass

                    # Build sweep summary
                    running = sum(1 for r in sweep_runs if r.get("status") == "running")
                    finished = sum(1 for r in sweep_runs if r.get("status") == "finished")
                    failed = sum(1 for r in sweep_runs if r.get("status") == "failed")
                    queued = sum(1 for r in sweep_runs if r.get("status") in ("queued", "ready"))
                    sweep_summary = f"Running: {running} | Completed: {finished} | Failed: {failed} | Queued: {queued}"

                    self._enqueue_run_event_prompt(run, rid, log_tail, sweep_summary)
                    logger.info("[wild-engine] Enqueued run event: %s %s", rid, status)

                self._seen_run_statuses[rid] = status

            # Check if ALL runs are terminal → transition to analyzing
            all_terminal = (
                len(sweep_runs) > 0
                and all(r.get("status") in ("finished", "failed", "stopped") for r in sweep_runs)
            )
            has_unprocessed_alerts = any(
                a.get("id") not in self._processed_alert_ids
                for a in pending_alerts
            )
            if (all_terminal and not has_unprocessed_alerts
                    and len(pending_alerts) == 0
                    and not self._analysis_queued):
                self._analysis_queued = True
                wild_loop_state["stage"] = "analyzing"
                wild_loop_state["phase"] = "analyzing"
                logger.info("[wild-engine] All runs terminal → transitioning to analyzing")

                sweep_name = sweep.get("name", sweep_id)
                self._enqueue_analysis_prompt(sweep_runs, sweep_name)

        except Exception as err:
            logger.warning("[wild-engine] Poll events error: %s", err, exc_info=True)


# =============================================================================
# Module-level Engine Singleton
# =============================================================================

engine = WildLoopEngine()
