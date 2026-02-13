"""V2 Wild Loop Prompt Builders — stateless functions for prompt construction.

All prompt-building logic is isolated here as pure functions that take a
PromptContext and return a string.  Templates are always resolved via
PromptSkillManager.render() from SKILL.md files in prompt_skills/.
No inline fallback templates — the SKILL.md files are the single source of truth.
"""

import re
from dataclasses import dataclass, field
from typing import Callable, Optional


# ---------------------------------------------------------------------------
# Signal parsers
# ---------------------------------------------------------------------------

def parse_promise(text: str) -> Optional[str]:
    """Parse <promise>...</promise> from agent output."""
    m = re.search(r"<promise>([\s\S]*?)</promise>", text)
    if m:
        return m.group(1).strip().upper()
    return None


def parse_plan(text: str) -> Optional[str]:
    """Parse <plan>...</plan> from agent output."""
    m = re.search(r"<plan>([\s\S]*?)</plan>", text)
    return m.group(1).strip() if m else None


def parse_summary(text: str) -> Optional[str]:
    """Parse <summary>...</summary> from agent output."""
    m = re.search(r"<summary>([\s\S]*?)</summary>", text)
    return m.group(1).strip() if m else None


# ---------------------------------------------------------------------------
# Prompt context — plain data, no behaviour
# ---------------------------------------------------------------------------

@dataclass
class PromptContext:
    """All the data a prompt builder needs.  Constructed per-iteration."""

    goal: str
    iteration: int
    max_iterations: int
    workdir: str              # absolute path to the user's project root
    tasks_path: str           # absolute path to tasks.md
    log_path: str             # absolute path to iteration_log.md
    server_url: str
    session_id: str
    auth_token: str = ""      # auth token for API requests

    # Dynamic state
    steer_context: str = ""
    history: list = field(default_factory=list)

    # Struggle indicators
    no_progress_streak: int = 0
    short_iteration_count: int = 0


# ---------------------------------------------------------------------------
# Computed sections (injected as template variables)
# ---------------------------------------------------------------------------

def _steer_section(ctx: PromptContext) -> str:
    if not ctx.steer_context:
        return ""
    return f"""
## 🗣️ User Context (injected mid-loop)

{ctx.steer_context}

*(Address this context in your work this iteration, then it will be cleared.)*
"""


def _struggle_section(ctx: PromptContext) -> str:
    warnings: list[str] = []

    if ctx.no_progress_streak >= 3:
        warnings.append(
            f"⚠️ No file changes for {ctx.no_progress_streak} consecutive iterations — try a different approach"
        )
    if ctx.short_iteration_count >= 3:
        warnings.append(
            f"⚠️ {ctx.short_iteration_count} very short iterations (<30s) — are you making meaningful progress?"
        )

    # Check for repeated errors in recent history
    recent_errors: list[str] = []
    for h in ctx.history[-3:]:
        recent_errors.extend(h.get("errors", []))
    if len(recent_errors) >= 3:
        seen: dict[str, int] = {}
        for e in recent_errors:
            key = e[:80]
            seen[key] = seen.get(key, 0) + 1
        repeated = [k for k, v in seen.items() if v >= 2]
        if repeated:
            warnings.append(f"⚠️ Repeated errors across iterations: {repeated[0][:60]}...")

    if warnings:
        return "\n## ⚠️ Struggle Indicators\n\n" + "\n".join(f"- {w}" for w in warnings) + "\n"
    return ""


def _api_catalog(ctx: PromptContext) -> str:
    """Build the full API catalog the agent can use via curl."""
    s = ctx.server_url
    sid = ctx.session_id
    auth_header = f'-H "X-Auth-Token: {ctx.auth_token}"' if ctx.auth_token else ""
    auth_note = f"""### Authentication

**All API requests require the auth header.** Include this in every `curl` call:
```
{auth_header}
```

""" if ctx.auth_token else ""
    return f"""{auth_note}### Sweeps (experiment groups)
- `POST {s}/sweeps/wild` — Create a tracking sweep (body: `{{"name": "...", "goal": "..."}}`)
- `GET  {s}/sweeps` — List all sweeps
- `GET  {s}/sweeps/{{id}}` — Get sweep details & progress

### Runs (individual jobs)
- `POST {s}/runs` — Create a run (body: `{{"name": "...", "command": "...", "sweep_id": "...", "auto_start": true}}`)
- `POST {s}/runs/{{id}}/start` — Start a queued/ready run
- `POST {s}/runs/{{id}}/stop` — Stop a running job
- `GET  {s}/runs` — List all runs
- `GET  {s}/runs/{{id}}` — Get run details & status

### Alerts & Events
- `GET  {s}/wild/v2/events/{sid}` — Pending events for this session
- `POST {s}/wild/v2/events/{sid}/resolve` — Mark events handled (body: `{{"event_ids": ["<id>"]}}`)
- `GET  {s}/wild/v2/system-health` — System utilization (running/queued/completed/failed counts)

### Skills (prompt templates)
- `GET  {s}/prompt-skills` — List available prompt skills
- `GET  {s}/prompt-skills/search?q=query` — Search skills by name/description"""


# ---------------------------------------------------------------------------
# Planning prompt (iteration 0)
# ---------------------------------------------------------------------------

def build_planning_prompt(
    ctx: PromptContext,
    render_fn: Callable,
) -> str:
    """Build the iteration-0 planning prompt.

    The prompt is resolved from the ``wild_v2_planning`` SKILL.md template
    via *render_fn* (typically ``PromptSkillManager.render``).

    Raises RuntimeError if the template cannot be rendered.
    """
    auth_header_val = f'-H "X-Auth-Token: {ctx.auth_token}"' if ctx.auth_token else ""
    variables = {
        "goal": ctx.goal,
        "workdir": ctx.workdir,
        "tasks_path": ctx.tasks_path,
        "server_url": ctx.server_url,
        "session_id": ctx.session_id,
        "steer_section": _steer_section(ctx),
        "api_catalog": _api_catalog(ctx),
        "auth_header": auth_header_val,
    }

    rendered = render_fn("wild_v2_planning", variables)
    if not rendered:
        raise RuntimeError(
            "Failed to render 'wild_v2_planning' skill template. "
            "Ensure prompt_skills/wild_v2_planning/SKILL.md exists and is valid."
        )
    return rendered


# ---------------------------------------------------------------------------
# Iteration prompt (iterations 1+)
# ---------------------------------------------------------------------------

def build_iteration_prompt(
    ctx: PromptContext,
    render_fn: Callable,
) -> str:
    """Build the standard iteration prompt for iterations 1+.

    The prompt is resolved from the ``wild_v2_iteration`` SKILL.md template
    via *render_fn* (typically ``PromptSkillManager.render``).

    Raises RuntimeError if the template cannot be rendered.
    """
    auth_header_val = f'-H "X-Auth-Token: {ctx.auth_token}"' if ctx.auth_token else ""
    variables = {
        "goal": ctx.goal,
        "iteration": str(ctx.iteration),
        "max_iterations": str(ctx.max_iterations),
        "workdir": ctx.workdir,
        "tasks_path": ctx.tasks_path,
        "log_path": ctx.log_path,
        "server_url": ctx.server_url,
        "session_id": ctx.session_id,
        "steer_section": _steer_section(ctx),
        "struggle_section": _struggle_section(ctx),
        "api_catalog": _api_catalog(ctx),
        "auth_header": auth_header_val,
    }

    rendered = render_fn("wild_v2_iteration", variables)
    if not rendered:
        raise RuntimeError(
            "Failed to render 'wild_v2_iteration' skill template. "
            "Ensure prompt_skills/wild_v2_iteration/SKILL.md exists and is valid."
        )
    return rendered
