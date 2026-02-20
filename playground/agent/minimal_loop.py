"""Minimal Agent Loop — demonstrates how PromptComposer replaces v2_prompts.py builders.

This is NOT a functional agent. It's a structural demonstration showing how the
composable prompt system integrates with an agent loop. Compare this to the
monolithic build_planning_prompt / build_iteration_prompt / build_reflection_prompt
in server/agent/v2_prompts.py.
"""

from dataclasses import dataclass, field
from typing import Optional

from .composer import PromptComposer


# ---------------------------------------------------------------------------
# Session state (same shape as PromptContext, simplified)
# ---------------------------------------------------------------------------

@dataclass
class LoopContext:
    """All the data a prompt needs. Simplified from v2_prompts.PromptContext."""

    goal: str
    iteration: int = 0
    max_iterations: int = 25
    workdir: str = "."
    tasks_path: str = ""
    log_path: str = ""
    server_url: str = "http://127.0.0.1:10000"
    session_id: str = ""
    auth_token: str = ""

    # Dynamic state
    steer_context: str = ""
    struggle_section: str = ""
    memories: str = ""

    # Evo sweep
    evo_sweep_enabled: bool = False
    evo_sweep_section: str = ""

    def to_variables(self) -> dict:
        """Convert context into template variables for the composer."""
        auth_header = f'-H "X-Auth-Token: {self.auth_token}"' if self.auth_token else ""
        steer_section = ""
        if self.steer_context:
            steer_section = (
                f"\n## 🗣️ User Context (injected mid-loop)\n\n"
                f"{self.steer_context}\n\n"
                f"*(Address this context in your work this iteration, then it will be cleared.)*\n"
            )

        return {
            "goal": self.goal,
            "iteration": str(self.iteration),
            "max_iterations": str(self.max_iterations),
            "workdir": self.workdir,
            "tasks_path": self.tasks_path,
            "log_path": self.log_path,
            "server_url": self.server_url,
            "session_id": self.session_id,
            "auth_header": auth_header,
            "steer_section": steer_section,
            "struggle_section": self.struggle_section,
            "memories": self.memories,
            "evo_sweep_section": self.evo_sweep_section if self.evo_sweep_enabled else "",
            # API catalog is built separately in production — here we use a placeholder
            "api_catalog": _build_api_catalog(self.server_url, self.session_id, auth_header),
        }


def _build_api_catalog(server_url: str, session_id: str, auth_header: str) -> str:
    """Build the API catalog string. In production this comes from v2_prompts._api_catalog()."""
    s = server_url
    sid = session_id
    return f"""### Preferred Tool Calls (MCP)
- `mcp__research-agent__create_run` — Fixed-schema run creation
- `mcp__research-agent__start_run` — Start a run by id

### Sweeps
- `POST {s}/sweeps/wild` — Create tracking sweep
- `GET  {s}/sweeps` — List all sweeps
- `GET  {s}/sweeps/{{id}}` — Get sweep details

### Runs
- `POST {s}/runs` — Create a run (include `chat_session_id: "{sid}"`)
- `POST {s}/runs/{{id}}/start` — Start a queued run
- `POST {s}/runs/{{id}}/stop` — Stop a running job
- `GET  {s}/runs` — List all runs
- `GET  {s}/runs/{{id}}` — Get run details

### System
- `GET  {s}/wild/v2/events/{sid}` — Pending events
- `GET  {s}/wild/v2/system-health` — System utilization
- `GET  {s}/cluster` — Cluster metadata
- `POST {s}/cluster/detect` — Auto-detect cluster"""


# ---------------------------------------------------------------------------
# The minimal loop — structural demonstration
# ---------------------------------------------------------------------------

class MinimalAgentLoop:
    """Demonstrates the composer-based prompt flow.

    Compare to WildV2Engine._run_loop() in server/agent/wild_loop_v2.py
    which uses build_planning_prompt, build_iteration_prompt, build_reflection_prompt.

    This replaces those 3 monolithic functions with a single composer.compose() call.
    """

    def __init__(self, prompts_dir: Optional[str] = None):
        self.composer = PromptComposer(prompts_dir)

    def build_planning_prompt(self, ctx: LoopContext) -> str:
        """Replaces v2_prompts.build_planning_prompt()

        Original: 33-line function in v2_prompts.py that calls render_fn("wild_v2_planning", ...)
        which renders a 282-line monolithic SKILL.md template.

        New: composer.compose("planning", variables) which assembles 10 small fragments.
        """
        variables = ctx.to_variables()
        return self.composer.compose("planning", variables)

    def build_iteration_prompt(self, ctx: LoopContext) -> str:
        """Replaces v2_prompts.build_iteration_prompt()

        Original: 37-line function in v2_prompts.py that calls render_fn("wild_v2_iteration", ...)
        which renders a 190-line monolithic SKILL.md template.

        New: composer.compose("iteration", variables) which assembles 10 small fragments.
        """
        variables = ctx.to_variables()
        return self.composer.compose("iteration", variables)

    def build_reflection_prompt(self, ctx: LoopContext, summary_of_work: str = "") -> str:
        """Replaces v2_prompts.build_reflection_prompt()

        Original: 70-line function with inline fallback template + render_fn call.
        New: composer.compose("reflection", variables).
        """
        variables = ctx.to_variables()
        variables["summary_of_work"] = summary_of_work
        variables["plan"] = ""  # Would come from tasks.md in production
        variables["user_availability"] = "The user is present with balanced autonomy."
        return self.composer.compose("reflection", variables)

    def run_demo(self) -> dict:
        """Demonstrate the full planning → iteration → reflection flow.

        Returns a dict with the three assembled prompts for inspection.
        """
        ctx = LoopContext(
            goal="Train a simple MNIST classifier and report accuracy",
            workdir="/home/user/project",
            tasks_path="/home/user/project/.agents/wild/tasks.md",
            log_path="/home/user/project/.agents/wild/iteration_log.md",
            server_url="http://127.0.0.1:10000",
            session_id="wild-abc123",
            auth_token="demo-token",
        )

        planning = self.build_planning_prompt(ctx)

        # Simulate moving to iteration 1
        ctx.iteration = 1
        iteration = self.build_iteration_prompt(ctx)

        # Simulate reflection
        reflection = self.build_reflection_prompt(ctx, summary_of_work="Trained MNIST to 98% accuracy")

        return {
            "planning": {
                "prompt": planning,
                "length": len(planning),
                "fragments": self.composer.list_fragments("planning"),
            },
            "iteration": {
                "prompt": iteration,
                "length": len(iteration),
                "fragments": self.composer.list_fragments("iteration"),
            },
            "reflection": {
                "prompt": reflection,
                "length": len(reflection),
                "fragments": self.composer.list_fragments("reflection"),
            },
        }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import json

    loop = MinimalAgentLoop()
    result = loop.run_demo()

    for mode, data in result.items():
        print(f"\n{'='*60}")
        print(f"  {mode.upper()} PROMPT")
        print(f"  Length: {data['length']} chars")
        print(f"  Fragments: {len(data['fragments'])}")
        for f in data['fragments']:
            print(f"    - {f}")
        print(f"{'='*60}")
        print(data['prompt'][:500])
        print("...")
