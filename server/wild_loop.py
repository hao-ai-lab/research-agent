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


class WildEvent(BaseModel):
    id: str
    priority: int          # 10=user, 20=critical, 30=warning, 50=run_event, 70=analysis, 90=exploring
    title: str
    prompt: str
    type: str              # "steer"|"alert"|"run_event"|"analysis"|"exploring"
    created_at: float


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
# Wild Event Queue (Backend Priority Queue)
# =============================================================================

class WildEventQueue:
    """heapq-based priority queue for wild loop events.

    Sorted by (priority ASC, created_at ASC).  Lower priority = higher urgency.
    Deduplicates by event id.
    """

    def __init__(self):
        self._heap: list = []       # list of (priority, created_at, counter, event_dict)
        self._id_set: set = set()
        self._counter: int = 0      # tie-breaker for heapq stability

    @property
    def size(self) -> int:
        return len(self._heap)

    def enqueue(self, event: dict) -> bool:
        """Add an event. Returns False if the id is already present (dedup)."""
        eid = event.get("id", "")
        if eid in self._id_set:
            return False
        self._id_set.add(eid)
        self._counter += 1
        heapq.heappush(self._heap, (event["priority"], event["created_at"], self._counter, event))
        return True

    def dequeue(self) -> Optional[dict]:
        """Pop and return the highest-priority (lowest number) event, or None."""
        while self._heap:
            _, _, _, event = heapq.heappop(self._heap)
            eid = event.get("id", "")
            if eid in self._id_set:
                self._id_set.discard(eid)
                return event
        return None

    def peek(self) -> Optional[dict]:
        """Look at the next event without removing it."""
        for entry in self._heap:
            if entry[3].get("id", "") in self._id_set:
                return entry[3]
        return None

    def items(self) -> list:
        """Return a sorted snapshot of all live events."""
        result = []
        for _, _, _, event in sorted(self._heap):
            if event.get("id", "") in self._id_set:
                result.append(event)
        return result

    def clear(self):
        self._heap.clear()
        self._id_set.clear()
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
    "session_id": None,
    "started_at": None,
    "is_paused": False,
    "sweep_id": None,
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
    "exploring": "wild_exploring",
    "run_event": "wild_monitoring",
    "alert": "wild_alert",
    "analysis": "wild_analyzing",
}

# Hardcoded fallback builders (kept for backward compat when skill is missing)
_FALLBACK_EXPLORING = """# Wild Loop — Iteration {{iteration}} (Exploring)

## Your Goal
{{goal}}

## Status
No sweep has been created yet. You need to define one.

## What You Should Do
1. Explore the codebase and understand what experiments are needed
2. When ready, send a sweep specification to the sweep creation endpoint
3. The sweep spec should be a JSON object with the following fields:
   - `name`: Human-readable name for the sweep
   - `base_command`: Shell command template (parameters are appended as `--key=value`)
   - `parameters`: Grid definition — the system expands it into individual runs
   - `max_runs`: Maximum number of runs to create

## Rules
- Send the sweep spec directly to the endpoint — do NOT embed it in your response as XML tags
- If you need more info before creating a sweep, just explain what you need and output `<promise>CONTINUE</promise>`
- After sending the sweep spec, output `<promise>CONTINUE</promise>` to monitor results"""

_FALLBACK_RUN_EVENT = """# Wild Loop — Run Event (Monitoring)

## Your Goal
{{goal}}

## Event: Run "{{run_name}}" just {{run_status}}  {{status_emoji}}
- **ID**: {{run_id}}
- **Status**: {{run_status}}
- **Command**: `{{run_command}}`

### Log Tail (last 1000 chars)
```
{{log_tail}}
```

## Current Sweep Status
{{sweep_summary}}

## Instructions
{{run_instructions}}
- End with `<promise>CONTINUE</promise>`"""

_FALLBACK_ALERT = """# Wild Loop — Alert

## Your Goal
{{goal}}

## ⚠️ Alert from Run "{{run_name}}"
- **Alert ID**: {{alert_id}}
- **Severity**: {{alert_severity}}
- **Message**: {{alert_message}}
- **Available Choices**: {{alert_choices}}

## How to Resolve This Alert
You MUST resolve this alert by outputting a `<resolve_alert>` tag with your chosen action:

```
<resolve_alert>
{{alert_resolve_example}}
</resolve_alert>
```

## Instructions
1. Analyze the alert and decide the best course of action
2. Output the `<resolve_alert>` tag with your chosen response
3. If the issue needs a code fix, explain what you'd change
4. End with `<promise>CONTINUE</promise>`"""

_FALLBACK_ANALYSIS = """# Wild Loop — Analysis (All Runs Complete)

## Your Goal
{{goal}}

## Sweep "{{sweep_name}}" Results
**{{total_runs}} total** — {{passed_runs}} passed, {{failed_runs}} failed

{{run_summaries}}

## Instructions
- Review all run results above
- Determine if the original goal has been fully achieved
- Provide a clear summary report

## Response
- If goal is FULLY achieved with evidence: `<promise>COMPLETE</promise>`
- If more experiments are needed: `<promise>CONTINUE</promise>` (will start a new exploration cycle)
- If you need human input: `<promise>NEEDS_HUMAN</promise>`"""

_FALLBACK_TEMPLATES = {
    "exploring": _FALLBACK_EXPLORING,
    "run_event": _FALLBACK_RUN_EVENT,
    "alert": _FALLBACK_ALERT,
    "analysis": _FALLBACK_ANALYSIS,
}


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
) -> dict:
    """Build a wild loop prompt and return full provenance metadata.

    skill_get_fn: function(skill_id) -> {"id", "name", "template", "variables", ...} or None
    Returns a dict matching BuildPromptResponse shape.
    """
    prompt_type = req.prompt_type
    goal = req.goal or wild_loop_state.get("goal") or "No specific goal set"
    iteration = req.iteration if req.iteration is not None else (wild_loop_state.get("iteration", 0) + 1)

    # Build variables dict based on prompt type
    max_iter = req.max_iterations or wild_loop_state.get("termination", {}).get("max_iterations")
    max_iter_display = str(max_iter) if max_iter else "∞"
    variables: Dict[str, str] = {"goal": goal, "iteration": str(iteration), "max_iteration": max_iter_display}

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

    # Fallback to hardcoded templates
    fallback = _FALLBACK_TEMPLATES.get(prompt_type, "")
    rendered = _render_simple(fallback, variables)
    return {
        "rendered": rendered,
        "user_input": goal,
        "skill_id": None,
        "skill_name": None,
        "template": fallback,
        "variables": variables,
        "prompt_type": prompt_type,
    }


def build_wild_prompt(prompt_skill_render_fn: Callable, experiment_context: str) -> str:
    """Build the wild-mode preamble for _build_chat_prompt.

    Returns the rendered wild mode note string, or empty string if rendering fails.
    prompt_skill_render_fn should be prompt_skill_manager.render
    """
    iteration = wild_loop_state.get("iteration", 0) + 1
    goal = wild_loop_state.get("goal") or "No specific goal set"
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

    rendered = prompt_skill_render_fn("wild_system", {
        "iteration": iter_display,
        "max_iterations": str(max_iter) if max_iter else "unlimited",
        "goal": goal,
        "experiment_context": experiment_context,
        "sweep_note": sweep_note,
        "custom_condition": custom_condition_text,
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

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    def start(self, req: WildStartRequest) -> dict:
        """Start the wild loop."""
        global wild_mode_enabled
        wild_mode_enabled = True

        now = time.time()
        wild_loop_state.update({
            "phase": "exploring",
            "stage": "exploring",
            "is_active": True,
            "is_paused": False,
            "iteration": 0,
            "goal": req.goal,
            "session_id": req.session_id,
            "started_at": now,
            "sweep_id": None,
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

        # Enqueue the first exploring prompt
        self._enqueue_exploring_prompt(iteration=1)

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

        if signal == "COMPLETE":
            logger.info("[wild-engine] COMPLETE signal at iteration %d", iteration)
            self.stop()
            return wild_loop_state

        if signal == "NEEDS_HUMAN":
            logger.info("[wild-engine] NEEDS_HUMAN signal at iteration %d", iteration)
            self.pause()
            return wild_loop_state

        stage = wild_loop_state.get("stage", "exploring")

        if stage == "exploring":
            self._handle_exploring_response(response_text, iteration)
        elif stage == "running":
            self._handle_running_response(response_text)
            # running stage: don't auto-queue; polling handles next events
        elif stage == "analyzing":
            self._handle_analyzing_response(response_text, iteration)

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

        return {
            **wild_loop_state,
            "queue_size": wild_event_queue.size,
            "queue_events": wild_event_queue.items(),
            "run_stats": run_stats,
            "active_alerts": active_alerts_list,
            "has_pending_prompt": self._pending_prompt is not None,
        }

    # -----------------------------------------------------------------
    # Internal: Stage-specific response handlers
    # -----------------------------------------------------------------

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

                # Auto-start the sweep
                if self._start_sweep:
                    try:
                        self._start_sweep(sweep_id, 100)
                        logger.info("[wild-engine] Auto-started sweep %s", sweep_id)
                    except Exception as err:
                        logger.warning("[wild-engine] Failed to auto-start sweep: %s", err)
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
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type=prompt_type,
                        goal=goal,
                        iteration=iteration,
                        max_iterations=max_iter,
                    ),
                    self._skill_get_fn,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception as err:
                logger.debug("[wild-engine] Skill template failed for exploring: %s", err)

        if not prompt_text:
            prompt_text = _render_simple(_FALLBACK_EXPLORING, {
                "goal": goal,
                "iteration": str(iteration),
            })

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
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type="run_event",
                        goal=goal,
                        run_id=run_id,
                        run_name=run_name,
                        run_status=run_status,
                        run_command=run_command,
                        log_tail=log_tail,
                        sweep_summary=sweep_summary,
                    ),
                    self._skill_get_fn,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception:
                pass

        if not prompt_text:
            status_emoji = "❌" if run_status == "failed" else "✅"
            prompt_text = _render_simple(_FALLBACK_RUN_EVENT, {
                "goal": goal,
                "run_name": run_name,
                "run_id": run_id,
                "run_status": run_status,
                "run_command": run_command,
                "log_tail": (log_tail or "")[-1000:],
                "sweep_summary": sweep_summary,
                "status_emoji": status_emoji,
                "run_instructions": (
                    "- This run FAILED. Diagnose the issue from the logs above.\n"
                    "- Take corrective action: fix code, adjust parameters, or create a new run."
                ) if run_status == "failed" else (
                    "- This run SUCCEEDED. Check if the results look correct.\n"
                    "- If results are suspicious, investigate further."
                ),
            })

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
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type="alert",
                        goal=goal,
                        alert_id=alert_id,
                        alert_severity=alert.get("severity", ""),
                        alert_message=alert.get("message", ""),
                        alert_choices=alert.get("choices", []),
                        run_name=run_name,
                    ),
                    self._skill_get_fn,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception:
                pass

        if not prompt_text:
            alert_choices = ", ".join(f"`{c}`" for c in alert.get("choices", []))
            resolve_example = json.dumps({"alert_id": alert_id, "choice": "ONE_OF_THE_CHOICES_ABOVE"})
            prompt_text = _render_simple(_FALLBACK_ALERT, {
                "goal": goal,
                "run_name": run_name,
                "alert_id": alert_id,
                "alert_severity": alert.get("severity", ""),
                "alert_message": alert.get("message", ""),
                "alert_choices": alert_choices,
                "alert_resolve_example": resolve_example,
            })

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
                result = build_prompt_for_frontend(
                    BuildPromptRequest(
                        prompt_type="analysis",
                        goal=goal,
                        sweep_name=sweep_name,
                        total_runs=len(sweep_runs),
                        passed_runs=passed,
                        failed_runs=failed,
                        run_summaries=run_summaries,
                    ),
                    self._skill_get_fn,
                )
                prompt_text = result.get("rendered", "")
                provenance = result
            except Exception:
                pass

        if not prompt_text:
            prompt_text = _render_simple(_FALLBACK_ANALYSIS, {
                "goal": goal,
                "sweep_name": sweep_name,
                "total_runs": str(len(sweep_runs)),
                "passed_runs": str(passed),
                "failed_runs": str(failed),
                "run_summaries": run_summaries,
            })

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
        """Background loop: poll for run/sweep events every 5 seconds."""
        logger.debug("[wild-engine] Poll loop started")
        try:
            while wild_loop_state.get("is_active"):
                if not wild_loop_state.get("is_paused"):
                    await self._poll_events()
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            logger.debug("[wild-engine] Poll loop cancelled")
        except Exception as err:
            logger.error("[wild-engine] Poll loop error: %s", err, exc_info=True)
        finally:
            logger.debug("[wild-engine] Poll loop ended")

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

