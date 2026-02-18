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


def parse_replan(text: str) -> Optional[str]:
    """Parse <replan>...</replan> from agent output."""
    m = re.search(r"<replan>([\s\S]*?)</replan>", text)
    return m.group(1).strip() if m else None


def parse_analysis(text: str) -> Optional[str]:
    """Parse <analysis>...</analysis> from agent output."""
    m = re.search(r"<analysis>([\s\S]*?)</analysis>", text)
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

    # Reflection & analysis state
    reflections: list = field(default_factory=list)
    reflection_interval: int = 5
    analyses: list = field(default_factory=list)

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
    """Build the full API catalog the agent can use via MCP tools or curl."""
    s = ctx.server_url
    sid = ctx.session_id
    auth_header = f'-H "X-Auth-Token: {ctx.auth_token}"' if ctx.auth_token else ""
    auth_note = f"""### Authentication

**All API requests require the auth header.** Include this in every `curl` call:
```
{auth_header}
```

""" if ctx.auth_token else ""
    return f"""{auth_note}### Preferred Tool Calls (MCP)
- `mcp__research-agent__create_run` — Fixed-schema run creation (`name`, `command`, `workdir`, `sweep_id`, `launch_policy`)
- `mcp__research-agent__start_run` — Start a run by id
- Prefer MCP tools for run creation/start to avoid ad-hoc command construction.

### Sweeps (experiment groups)
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
    }

    rendered = render_fn("wild_v2_iteration", variables)
    if not rendered:
        raise RuntimeError(
            "Failed to render 'wild_v2_iteration' skill template. "
            "Ensure prompt_skills/wild_v2_iteration/SKILL.md exists and is valid."
        )
    return rendered


# ---------------------------------------------------------------------------
# Reflection prompt
# ---------------------------------------------------------------------------

def _iteration_history_section(ctx: PromptContext) -> str:
    """Format iteration history as a compact markdown table."""
    if not ctx.history:
        return "*No iteration history yet.*"
    lines = [
        "| Iter | Duration | Promise | Files Changed | Errors | Summary |",
        "|------|----------|---------|---------------|--------|---------|"]
    for h in ctx.history:
        summary = (h.get("summary", "") or "")[:80].replace("|", "/")
        files = len(h.get("files_modified", []))
        lines.append(
            f"| {h.get('iteration', '?')} "
            f"| {h.get('duration_s', '?')}s "
            f"| {h.get('promise', '-')} "
            f"| {files} "
            f"| {h.get('error_count', 0)} "
            f"| {summary} |"
        )
    return "\n".join(lines)


def build_reflection_prompt(
    ctx: PromptContext,
    render_fn: Callable,
    reflection_reason: str = "Scheduled periodic reflection",
) -> str:
    """Build the reflection prompt.

    The prompt is resolved from the ``wild_v2_reflection`` SKILL.md template.
    Raises RuntimeError if the template cannot be rendered.
    """
    auth_header_val = f'-H "X-Auth-Token: {ctx.auth_token}"' if ctx.auth_token else ""
    variables = {
        "goal": ctx.goal,
        "workdir": ctx.workdir,
        "iteration": str(ctx.iteration),
        "max_iterations": str(ctx.max_iterations),
        "tasks_path": ctx.tasks_path,
        "log_path": ctx.log_path,
        "server_url": ctx.server_url,
        "session_id": ctx.session_id,
        "auth_header": auth_header_val,
        "iteration_history": _iteration_history_section(ctx),
        "reflection_reason": reflection_reason,
        "api_catalog": _api_catalog(ctx),
    }

    rendered = render_fn("wild_v2_reflection", variables)
    if not rendered:
        raise RuntimeError(
            "Failed to render 'wild_v2_reflection' skill template. "
            "Ensure prompt_skills/wild_v2_reflection/SKILL.md exists and is valid."
        )
    return rendered


# ---------------------------------------------------------------------------
# Analysis prompt
# ---------------------------------------------------------------------------

def _metrics_section(metrics_data: dict) -> str:
    """Format collected metrics data as markdown."""
    if not metrics_data:
        return "*No metrics data collected yet. Scan for results files during analysis.*"
    lines = ["### Discovered Metrics\n"]
    for source, data in metrics_data.items():
        lines.append(f"**{source}:**")
        if isinstance(data, dict):
            for k, v in data.items():
                lines.append(f"- {k}: {v}")
        elif isinstance(data, list):
            for item in data[:20]:
                lines.append(f"- {item}")
        else:
            lines.append(f"  {data}")
        lines.append("")
    return "\n".join(lines)


def build_analysis_prompt(
    ctx: PromptContext,
    metrics_data: dict,
    render_fn: Callable,
) -> str:
    """Build the auto data analysis prompt.

    The prompt is resolved from the ``wild_v2_analysis`` SKILL.md template.
    Raises RuntimeError if the template cannot be rendered.
    """
    auth_header_val = f'-H "X-Auth-Token: {ctx.auth_token}"' if ctx.auth_token else ""
    variables = {
        "goal": ctx.goal,
        "workdir": ctx.workdir,
        "iteration": str(ctx.iteration),
        "max_iterations": str(ctx.max_iterations),
        "tasks_path": ctx.tasks_path,
        "log_path": ctx.log_path,
        "server_url": ctx.server_url,
        "session_id": ctx.session_id,
        "auth_header": auth_header_val,
        "metrics_data": _metrics_section(metrics_data),
        "api_catalog": _api_catalog(ctx),
    }

    rendered = render_fn("wild_v2_analysis", variables)
    if not rendered:
        raise RuntimeError(
            "Failed to render 'wild_v2_analysis' skill template. "
            "Ensure prompt_skills/wild_v2_analysis/SKILL.md exists and is valid."
        )
    return rendered
