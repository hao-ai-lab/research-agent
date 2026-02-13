"""V2 Wild Loop Prompt Builders — stateless functions for prompt construction.

All prompt-building logic is isolated here as pure functions that take a
PromptContext and return a string.  Templates are resolved via
PromptSkillManager.render() from SKILL.md files in prompt_skills/.
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
    return f"""### Sweeps (experiment groups)
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

_FALLBACK_PLANNING = """You are an autonomous research engineer about to start a multi-iteration work session.

## 🎯 Goal

{goal}
{steer_section}

---

## Project Root

**IMPORTANT:** Your working directory is `{workdir}`. Start every iteration with `cd {workdir}`.

## Your Mission This Iteration: PLANNING

This is **iteration 0** — the planning phase.  You must:

1. **Explore the codebase** — use `ls`, `find`, `cat`, `head`, `grep` to understand the project.
2. **Analyze the goal** — break it down into concrete, actionable tasks.
3. **Write the task checklist** to `{tasks_path}`.
4. **Output your plan** in `<plan>` tags so it can be parsed.

## Available API Endpoints

{api_catalog}

## Rules

- You have full autonomy.  Do NOT ask clarifying questions.
- Spend time exploring — good planning saves time in later iterations.
- Each task should be ONE logical unit of work.
- Do NOT start doing actual implementation work yet — just plan.
- Your changes are auto-committed after this iteration.
"""


def build_planning_prompt(
    ctx: PromptContext,
    render_fn: Optional[Callable] = None,
) -> str:
    """Build the iteration-0 planning prompt.

    If *render_fn* is provided (typically ``PromptSkillManager.render``),
    the prompt is resolved from the ``wild_v2_planning`` SKILL.md template.
    Otherwise a built-in fallback is used.
    """
    variables = {
        "goal": ctx.goal,
        "workdir": ctx.workdir,
        "tasks_path": ctx.tasks_path,
        "server_url": ctx.server_url,
        "session_id": ctx.session_id,
        "steer_section": _steer_section(ctx),
        "api_catalog": _api_catalog(ctx),
    }

    if render_fn:
        rendered = render_fn("wild_v2_planning", variables)
        if rendered:
            return rendered

    # Fallback: inline template
    return _FALLBACK_PLANNING.format(**variables)


# ---------------------------------------------------------------------------
# Iteration prompt (iterations 1+)
# ---------------------------------------------------------------------------

_FALLBACK_ITERATION = """You are an autonomous research engineer running in a loop. This is **iteration {iteration} of {max_iterations}**.

## 🎯 Goal

{goal}
{steer_section}{struggle_section}

---

## Project Root

**IMPORTANT:** Your working directory is `{workdir}`. Start every iteration with `cd {workdir}`.

## Your Working Files

### 📋 Task File: `{tasks_path}`
Read it at the start of each iteration. Mark tasks `[/]` when starting, `[x]` when complete.

### 📜 Iteration Log: `{log_path}`
Records what happened in every previous iteration — your results, errors, and lessons.

---

## Iteration Protocol

1. **Read `{tasks_path}`** to see what's done and what's next
2. **Read `{log_path}`** to see previous iteration results
3. **Check events**: Use the API endpoints below to check for pending alerts/failures
4. **Work on ONE task**: Focus on the current in-progress or next pending task
5. **Update `{tasks_path}`**: Mark completed tasks `[x]`, current task `[/]`
6. **Run tests/verification** if applicable

## Available API Endpoints

{api_catalog}

## Output Format

At the end of your response, output:
```
<summary>One paragraph describing what you accomplished this iteration</summary>
```

If the goal is **fully achieved** and ALL tasks are `[x]`:
```
<promise>DONE</promise>
```

If you need to **wait for runs/experiments**:
```
<promise>WAITING</promise>
```

## Rules

- You have full autonomy. Do NOT ask clarifying questions.
- Each iteration should make concrete, measurable progress.
- Your changes are auto-committed after each iteration.
"""


def build_iteration_prompt(
    ctx: PromptContext,
    render_fn: Optional[Callable] = None,
) -> str:
    """Build the standard iteration prompt for iterations 1+.

    If *render_fn* is provided, the prompt is resolved from the
    ``wild_v2_iteration`` SKILL.md template.  Otherwise a built-in
    fallback is used.
    """
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
    }

    if render_fn:
        rendered = render_fn("wild_v2_iteration", variables)
        if rendered:
            return rendered

    # Fallback: inline template
    return _FALLBACK_ITERATION.format(**variables)
