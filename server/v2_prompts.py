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


def parse_reflection(text: str) -> Optional[str]:
    """Parse <reflection>...</reflection> from agent output."""
    m = re.search(r"<reflection>([\s\S]*?)</reflection>", text)
    return m.group(1).strip() if m else None


def parse_continue(text: str) -> bool:
    """Parse <continue>yes|no</continue> from reflection output.

    Returns True if the agent wants to continue, False otherwise.
    Defaults to False (stop) if the tag is missing or unparseable.
    """
    m = re.search(r"<continue>([\s\S]*?)</continue>", text)
    if not m:
        return False
    return m.group(1).strip().lower() in ("yes", "true", "1")


def parse_memories(text: str) -> list:
    """Parse <memories>...</memories> from reflection output.

    Expected format inside the tag:
        - [tag] Title or lesson text
        - [tag] Another lesson

    Returns a list of dicts: [{"tag": "lesson", "title": "...", "content": "..."}]
    """
    m = re.search(r"<memories>([\s\S]*?)</memories>", text)
    if not m:
        return []
    block = m.group(1).strip()
    results = []
    for line in block.split("\n"):
        line = line.strip()
        if not line or not line.startswith("-"):
            continue
        line = line.lstrip("- ").strip()
        # Parse [tag] prefix
        tag_match = re.match(r"\[([^\]]+)\]\s*(.*)", line)
        if tag_match:
            tag = tag_match.group(1).strip().lower()
            content = tag_match.group(2).strip()
        else:
            tag = "general"
            content = line
        if content:
            results.append({
                "tag": tag,
                "title": content[:80],  # first 80 chars as title
                "content": content,
            })
    return results


# ---------------------------------------------------------------------------
# Reflection prompt (after DONE signal)
# ---------------------------------------------------------------------------

def build_reflection_prompt(
    ctx: "PromptContext",
    render_fn: Callable = None,
    summary_of_work: str = "",
) -> str:
    """Build the post-DONE reflection prompt.

    The prompt is resolved from the ``wild_v2_reflection`` SKILL.md template
    via *render_fn* (typically ``PromptSkillManager.render``).

    Falls back to a minimal inline template if render_fn is not available.
    """
    # Build user availability description
    if ctx.away_duration_minutes > 0:
        avail_str = (
            f"The user is AFK (away for ~{ctx.away_duration_minutes} minutes). "
            f"Autonomy level: {ctx.autonomy_level}. "
            "The user would appreciate you continuing autonomously."
        )
    elif ctx.autonomy_level == "full":
        avail_str = (
            "The user is present but has set autonomy to 'full'. "
            "Continue working without asking questions."
        )
    elif ctx.autonomy_level == "cautious":
        avail_str = (
            "The user is present and wants to be consulted on important decisions. "
            "If you plan to continue, only do so if you're confident."
        )
    else:
        avail_str = (
            "The user is present with balanced autonomy. "
            "Continue if there's clearly more important work; stop and ask if unsure."
        )

    variables = {
        "goal": ctx.goal,
        "iteration": str(ctx.iteration),
        "max_iterations": str(ctx.max_iterations),
        "summary_of_work": summary_of_work,
        "plan": getattr(ctx, "_plan_text", "") or "",
        "workdir": ctx.workdir,
        "user_availability": avail_str,
        "autonomy_level": ctx.autonomy_level,
        "memories": ctx.memories_text,
    }

    if render_fn:
        rendered = render_fn("wild_v2_reflection", variables)
        if rendered:
            return rendered

    # Inline fallback
    memories_section = f"\n## Active Memories\n\n{ctx.memories_text}\n" if ctx.memories_text else ""
    return (
        f"You just completed iteration {ctx.iteration} of {ctx.max_iterations} "
        f"and signaled DONE.\n\n"
        f"## Original Goal\n\n{ctx.goal}\n\n"
        f"## Work Summary\n\n{summary_of_work}\n\n"
        f"## User Availability\n\n{avail_str}\n\n"
        f"{memories_section}"
        "Reflect on what was accomplished, your progress towards the goal, "
        "whether there is meaningful remaining work, and any lessons learned.\n\n"
        "Output:\n"
        "<reflection>Your reflection</reflection>\n"
        "<continue>yes</continue> or <continue>no</continue>\n"
        "<memories>\n"
        "- [tag] Lesson or insight to remember\n"
        "</memories>\n"
    )


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

    # Evolutionary sweep mode
    evo_sweep_enabled: bool = False

    # User availability context
    autonomy_level: str = "balanced"  # "cautious" | "balanced" | "full"
    away_duration_minutes: int = 0    # 0 = user is present
    user_wants_questions: bool = True  # False when autonomy is "full" or user is AFK

    # Memory bank (active lessons from past sessions)
    memories_text: str = ""  # formatted string for prompt injection


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

### Cluster & Capacity
- `GET  {s}/cluster` — Cluster metadata and run summary
- `POST {s}/cluster/detect` — Auto-detect cluster type/capacity
- `POST {s}/cluster` — Update cluster metadata manually

### Skills (prompt templates)
- `GET  {s}/prompt-skills` — List available prompt skills
- `GET  {s}/prompt-skills/search?q=query` — Search skills by name/description
- `GET  {s}/prompt-skills/{{id}}` — Fetch one skill (includes full template text)
- `GET  {s}/prompt-skills/{{id}}/files` — List files for a skill
- `GET  {s}/prompt-skills/{{id}}/files/{{path}}` — Read a skill file

### Docs & Schema
- `GET  {s}/docs` — API docs UI (health/preflight probe)
- `GET  {s}/openapi.json` — OpenAPI schema (health/preflight probe)"""


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
        "memories": ctx.memories_text,
        "evo_sweep_enabled": "true" if ctx.evo_sweep_enabled else "false",
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
        "memories": ctx.memories_text,
        "evo_sweep_enabled": "true" if ctx.evo_sweep_enabled else "false",
    }

    rendered = render_fn("wild_v2_iteration", variables)
    if not rendered:
        raise RuntimeError(
            "Failed to render 'wild_v2_iteration' skill template. "
            "Ensure prompt_skills/wild_v2_iteration/SKILL.md exists and is valid."
        )
    return rendered
