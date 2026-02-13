"""V2 Wild Loop Prompt Builders — stateless functions for prompt construction.

All prompt-building logic is isolated here as pure functions that take a
PromptContext and return a string.  No class instances, no side effects.
"""

import re
from dataclasses import dataclass, field
from typing import Optional


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
    tasks_path: str           # absolute path to tasks.md
    log_path: str             # absolute path to iteration_log.md
    server_url: str
    session_id: str

    # Dynamic state
    pending_events: list = field(default_factory=list)
    steer_context: str = ""
    system_health: dict = field(default_factory=dict)
    history: list = field(default_factory=list)

    # Struggle indicators
    no_progress_streak: int = 0
    short_iteration_count: int = 0


# ---------------------------------------------------------------------------
# Shared sections (used by both prompts)
# ---------------------------------------------------------------------------

def _events_section(ctx: PromptContext) -> str:
    if ctx.pending_events:
        lines = "\n".join(
            f"- [{e.get('type', 'event')}] {e.get('title', 'Untitled')}: {e.get('detail', '')}"
            for e in ctx.pending_events
        )
        return lines
    return "No pending events."


def _health_section(ctx: PromptContext) -> str:
    h = ctx.system_health
    return (
        f"Running: {h.get('running', 0)}/{h.get('max_concurrent', 5)} | "
        f"Queued: {h.get('queued', 0)} | "
        f"Completed: {h.get('completed', 0)} | "
        f"Failed: {h.get('failed', 0)}"
    )


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


def _api_endpoints_section(ctx: PromptContext) -> str:
    return f"""7. **API endpoints** (use via bash/curl):
   - Events: `curl -s {ctx.server_url}/wild/v2/events/{ctx.session_id}`
   - Health: `curl -s {ctx.server_url}/wild/v2/system-health`
   - Resolve: `curl -s -X POST {ctx.server_url}/wild/v2/events/{ctx.session_id}/resolve -H 'Content-Type: application/json' -d '{{"event_ids": ["<id>"]}}'`"""


# ---------------------------------------------------------------------------
# Planning prompt (iteration 0)
# ---------------------------------------------------------------------------

def build_planning_prompt(ctx: PromptContext) -> str:
    """Build the iteration-0 planning prompt.

    The agent explores the codebase and produces a concrete task checklist
    in ``tasks.md``.  No ``<promise>`` or ``<summary>`` expected — planning
    always transitions to iteration 1.
    """
    return f"""You are an autonomous research engineer about to start a multi-iteration work session.

## 🎯 Goal

{ctx.goal}
{_steer_section(ctx)}
## 📊 System Health

{_health_section(ctx)}

## 🔔 Pending Events

{_events_section(ctx)}

---

## Your Mission This Iteration: PLANNING

This is **iteration 0** — the planning phase.  You must:

1. **Explore the codebase** — use `ls`, `find`, `cat`, `head`, `grep` to understand:
   - Directory structure and key files
   - Existing patterns and conventions
   - Dependencies and configuration
   - Test infrastructure

2. **Analyze the goal** — break it down into concrete, actionable tasks that:
   - Can each be completed in a single iteration (~5-15 min of work)
   - Are ordered by dependency (do prerequisites first)
   - Are specific enough that you could hand them to another engineer

3. **Write the task checklist** to `{ctx.tasks_path}`:

```markdown
# Tasks

## Goal
{ctx.goal}

## Analysis
(Brief summary of what you learned from codebase exploration)

## Tasks
- [ ] Task 1: Specific, actionable description
- [ ] Task 2: Specific, actionable description
...
```

4. **Output your plan** in `<plan>` tags so it can be parsed:

```
<plan>
(Copy of the task list you wrote to tasks.md)
</plan>
```

## Rules

- You have full autonomy.  Do NOT ask clarifying questions.
- Spend time exploring — good planning saves time in later iterations.
- Each task should be ONE logical unit of work (one file change, one test fix, etc.)
- Aim for 5-15 tasks; if the goal is very large, group into phases.
- Do NOT start doing actual implementation work yet — just plan.
- Your changes are auto-committed after this iteration.
"""


# ---------------------------------------------------------------------------
# Iteration prompt (iterations 1+)
# ---------------------------------------------------------------------------

def build_iteration_prompt(ctx: PromptContext) -> str:
    """Build the standard iteration prompt for iterations 1+.

    Assumes ``tasks.md`` and ``iteration_log.md`` already exist on disk.
    """
    return f"""You are an autonomous research engineer running in a loop. This is **iteration {ctx.iteration} of {ctx.max_iterations}**.

## 🎯 Goal

{ctx.goal}
{_steer_section(ctx)}{_struggle_section(ctx)}
## 📊 System Health

{_health_section(ctx)}

## 🔔 Pending Events

{_events_section(ctx)}

---

## Your Working Files

You have two critical files that persist between iterations. **Read them first, update them as you work.**

### 📋 Task File: `{ctx.tasks_path}`
This is your task checklist. Read it at the start of each iteration to know what to do.
- Mark tasks `[/]` when starting, `[x]` when complete
- Add new tasks if you discover work needed
- Focus on ONE task per iteration

### 📜 Iteration Log: `{ctx.log_path}`
This records what happened in every previous iteration — your results, errors, and lessons.
Read it to learn from your own mistakes and avoid repeating them.

---

## Iteration Protocol

1. **Read `{ctx.tasks_path}`** to see what's done and what's next
2. **Read `{ctx.log_path}`** to see previous iteration results and avoid past mistakes
3. **Check events**: Handle any pending alerts/failures before continuing
4. **Work on ONE task**: Focus on the current in-progress or next pending task
5. **Update `{ctx.tasks_path}`**: Mark completed tasks `[x]`, current task `[/]`
6. **Run tests/verification** if applicable
{_api_endpoints_section(ctx)}

## Output Format

At the end of your response, output:

```
<summary>One paragraph describing what you accomplished this iteration</summary>
```

If the goal is **fully achieved** and ALL tasks in `{ctx.tasks_path}` are `[x]`:
```
<promise>DONE</promise>
```

If you need to **wait for runs/experiments** and have nothing else to do:
```
<promise>WAITING</promise>
```

## Rules

- You have full autonomy. Do NOT ask clarifying questions.
- Check `git log` to understand what previous iterations accomplished.
- Each iteration should make concrete, measurable progress.
- If you encounter errors, fix them and note what went wrong.
- Your changes are auto-committed after each iteration.
- Do NOT commit: build outputs, __pycache__, .env, node_modules, large binaries.
"""
