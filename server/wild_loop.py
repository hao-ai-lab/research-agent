"""
Wild Loop Module — extracted from server.py (Step 5, Wild Loop v4).

Contains:
- Pydantic models for wild mode / loop configuration / events
- WildEventQueue (heapq-based priority queue)
- Wild loop state management
- Experiment context builder
- Wild mode prompt builder
"""

import copy
import heapq
import logging
import time
import uuid
from typing import Callable, Dict, Optional

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
    priority: int          # 10=user, 20=critical, 30=warning, 50=run_event, 60=evolution, 70=analysis, 90=exploring
    title: str
    prompt: str
    type: str              # "steer"|"alert"|"run_event"|"evolution"|"analysis"|"exploring"
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
    "iteration": 0,
    "goal": None,
    "session_id": None,
    "started_at": None,
    "is_paused": False,
    "sweep_id": None,
    "evolution_session_id": None,  # OpenEvolve session ID when in evolving stage
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
    if phase == "idle":
        wild_loop_state["started_at"] = None
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
2. When ready, output a sweep specification as a JSON block inside `<sweep>` tags
3. The system will automatically create and start the sweep for you

## How to Create a Sweep
Output exactly this format (the system will parse it and call the API for you):

```
<sweep>
{
  "name": "My Experiment Sweep",
  "base_command": "python train.py",
  "parameters": {
    "lr": [0.0001, 0.001, 0.01],
    "batch_size": [32, 64]
  },
  "max_runs": 10
}
</sweep>
```

The `parameters` field defines a grid — the system will expand it into individual runs.
The `base_command` is the shell command template. Parameters are appended as `--key=value`.

## Rules
- Do NOT run commands yourself. Output the `<sweep>` spec and the system handles execution.
- If you need more info before creating a sweep, just explain what you need and output `<promise>CONTINUE</promise>`
- Once you output a `<sweep>` tag, the system will create & start it automatically."""

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
