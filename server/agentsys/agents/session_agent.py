"""SessionAgent — Level 1 in-process agent that manages research sessions.

The SessionAgent is the single user-facing agent in the system.  It runs
in the server's own event loop (not a subprocess) and acts as the root of
the agent hierarchy:

    SessionAgent (Level 1, in-process)
        └── ResearchAgent (Level 2, subprocess)  — one per experiment
                └── workers / sidecars (Level 3, subprocess)  — future

Responsibilities:
  - Receives experiment goals from HTTP handlers (direct method calls).
  - Spawns Level 2 experiment managers (ResearchAgent) via Runtime.
  - Monitors child experiments, tracks their lifecycle.
  - Routes user steers to the active experiment.
  - Aggregates results and emits events for the frontend.

Because it's in-process, HTTP handlers hold a direct reference to this
agent and call its public methods (``start_experiment``,
``get_active_experiment_id``, etc.).  The ``run()`` loop handles
background housekeeping: steer routing, child monitoring, etc.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from agentsys.agent import Agent, ChildHandle
from agentsys.types import AgentStatus, EntryType

logger = logging.getLogger("session_agent")


class SessionAgent(Agent):
    """Level 1 session agent — user-facing, in-process.

    Inherits from Agent ABC so it gets the full agent contract: lifecycle,
    memory, communication, spawning.  Runs in the server process via
    ``Runtime.register_local()`` + ``await agent.start()``.
    """

    role = "orchestrator"
    allowed_child_roles = frozenset({"orchestrator", "executor", "sidecar"})
    monitor_interval = 5.0  # check children every 5 seconds

    def __init__(self) -> None:
        super().__init__()
        self._experiments: dict[str, ChildHandle] = {}
        self._active_experiment_ids: set[str] = set()  # supports concurrent L2s
        # Tracks ALL active children (L2s and L3 runs) for reactive monitoring
        self._active_children: dict[str, dict] = {}  # agent_id -> {handle, type, goal, ...}
        # Chat session ID this agent is bound to (set by wild_routes on creation)
        self.chat_session_id: str | None = None
        # Callback to trigger a synthetic chat turn when a child finishes.
        # Signature: async callback(session_id: str, system_message: str, mode: str)
        self._on_child_complete_callback: Any = None
        # Prevent duplicate callbacks for already-reported children
        self._reported_children: set[str] = set()

    # ── Agent ABC hooks ───────────────────────────────────────────────

    async def on_start(self) -> None:
        logger.info("[session-agent] Started (id=%s)", self.id)

    async def on_stop(self) -> None:
        logger.info("[session-agent] Stopped (id=%s)", self.id)

    async def run(self) -> None:
        """Background monitoring loop.  Runs until server shutdown.

        Heavy lifting (starting experiments, getting status) happens via
        the public methods below, called directly by HTTP handlers.
        This loop handles housekeeping only.
        """
        while self.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
            await self.check_pause()

            # Route any pending steers to all active experiments
            steer = self.consume_steer()
            if steer and self._active_experiment_ids:
                for eid in list(self._active_experiment_ids):
                    try:
                        await self._runtime.steer(eid, steer.context, steer.urgency)
                    except Exception as e:
                        logger.warning("[session-agent] Failed to route steer to %s: %s", eid, e)

            await asyncio.sleep(1.0)

    async def on_monitor(self) -> None:
        """Periodically check child status and trigger reactive callbacks.

        When a child (L2 research or L3 run) finishes or fails, this method:
        1. Reads the child's results (run.log for L3, iteration summary for L2)
        2. Emits an SSE event to the frontend
        3. Triggers a synthetic chat turn so L1 can interpret results and respond
        """
        if not self._active_children and not self._active_experiment_ids:
            return

        newly_finished: list[dict] = []

        # Check _active_children (L2s and L3 runs spawned via handle_llm_response)
        for cid in list(self._active_children.keys()):
            if cid in self._reported_children:
                continue
            child_info = self._active_children[cid]
            handle = child_info.get("handle")
            if handle is None:
                self._reported_children.add(cid)
                continue
            status = handle.status
            if status in (AgentStatus.DONE, AgentStatus.FAILED):
                result = self._read_child_result(cid, child_info)
                newly_finished.append(result)
                self._reported_children.add(cid)
                self._active_experiment_ids.discard(cid)
                logger.info("[session-agent] Child %s finished (type=%s, status=%s)",
                            cid, child_info.get("type", "?"), status.value)

        # Also check _experiments for L2s started via start_experiment() directly
        for eid in list(self._active_experiment_ids):
            if eid in self._reported_children:
                continue
            handle = self._experiments.get(eid)
            if handle is None:
                self._active_experiment_ids.discard(eid)
                continue
            status = handle.status
            if status in (AgentStatus.DONE, AgentStatus.FAILED):
                child_info = self._active_children.get(eid, {
                    "handle": handle, "type": "research", "goal": "",
                })
                result = self._read_child_result(eid, child_info)
                newly_finished.append(result)
                self._reported_children.add(eid)
                self._active_experiment_ids.discard(eid)
                logger.info("[session-agent] Experiment %s finished (status=%s)",
                            eid, status.value)

        if not newly_finished:
            return

        # Emit SSE events for each finished child
        for result in newly_finished:
            self._emit_event("experiment_complete", {
                "experiment_id": result["id"],
                "status": result["status"],
                "type": result["type"],
                "goal": result.get("goal", ""),
            })

        # Trigger reactive callback: wake L1 to process results
        if self._on_child_complete_callback and self.chat_session_id:
            system_message = self._build_child_results_message(newly_finished)
            try:
                await self._on_child_complete_callback(
                    self.chat_session_id,
                    system_message,
                )
                logger.info("[session-agent] Triggered reactive callback for %d finished children",
                            len(newly_finished))
            except Exception as e:
                logger.error("[session-agent] Reactive callback failed: %s", e, exc_info=True)

    # ── Child result helpers ────────────────────────────────────────────

    def _read_child_result(self, child_id: str, child_info: dict) -> dict:
        """Read a finished child's results from disk.

        For L3 runs: reads run.log from .agents/runs/{child_id}/
        For L2 research: reads state.json and iteration_log from .agents/wild/{child_id}/
        """
        import os

        workdir = self.config.get("workdir", ".")
        child_type = child_info.get("type", "unknown")
        handle = child_info.get("handle")
        status = handle.status.value if handle else "unknown"
        goal = child_info.get("goal", "")

        # Try to get goal from runtime if not in child_info
        if not goal and self._runtime:
            info = self._runtime.get_agent(child_id)
            if info:
                goal = info.goal or ""

        output = ""
        if child_type == "run":
            # L3 executor: read run.log
            log_path = os.path.join(workdir, ".agents", "runs", child_id, "run.log")
            if os.path.exists(log_path):
                try:
                    with open(log_path) as f:
                        output = f.read()
                    if len(output) > 8000:
                        output = output[-8000:]
                except Exception:
                    pass
        elif child_type == "research":
            # L2 research: read state.json summary + last iteration log snippet
            state_path = os.path.join(workdir, ".agents", "wild", child_id, "state.json")
            log_path = os.path.join(workdir, ".agents", "wild", child_id, "iteration_log.md")
            import json as _json
            if os.path.exists(state_path):
                try:
                    with open(state_path) as f:
                        state = _json.load(f)
                    output = f"Iterations completed: {state.get('iteration', '?')}\n"
                    output += f"Final status: {state.get('status', '?')}\n"
                except Exception:
                    pass
            if os.path.exists(log_path):
                try:
                    with open(log_path) as f:
                        log_text = f.read()
                    # Take last 4000 chars of iteration log
                    if len(log_text) > 4000:
                        log_text = log_text[-4000:]
                    output += f"\n--- Iteration Log (tail) ---\n{log_text}"
                except Exception:
                    pass

        return {
            "id": child_id,
            "type": child_type,
            "goal": goal,
            "status": status,
            "output": output.strip(),
        }

    @staticmethod
    def _build_child_results_message(results: list[dict]) -> str:
        """Build a system message summarizing finished child results.

        This message is injected into a synthetic chat turn so L1 can
        interpret the results and respond to the user.
        """
        lines = ["[SYSTEM] The following experiments/commands have completed:\n"]
        for r in results:
            status_label = "COMPLETED" if r["status"] == "done" else "FAILED"
            type_label = "Research experiment" if r["type"] == "research" else "Command"
            lines.append(f"### {type_label}: {r['goal']}")
            lines.append(f"- **ID:** {r['id']}")
            lines.append(f"- **Status:** {status_label}")
            output = r.get("output", "").strip()
            if output:
                lines.append(f"- **Output:**\n```\n{output}\n```")
            else:
                lines.append("- **Output:** (no output captured)")
            lines.append("")

        lines.append("Summarize these results for the user. If something failed, explain what went wrong and suggest next steps.")
        return "\n".join(lines)

    # ── Public API (called by HTTP handlers) ──────────────────────────

    async def start_experiment(
        self,
        goal: str,
        config: dict[str, Any] | None = None,
    ) -> str:
        """Spawn a Level 2 experiment manager (ResearchAgent).

        Supports concurrent L2 agents — new experiments run alongside
        existing ones without killing them.

        Args:
            goal:   The experiment goal string.
            config: Serializable config dict for ResearchAgent.

        Returns:
            The experiment agent_id.
        """
        from agentsys.agents.research_agent import ResearchAgent

        # Spawn Level 2 agent in a subprocess via Runtime
        handle = await self.spawn_child(
            ResearchAgent,
            goal=goal,
            **(config or {}),
        )

        self._experiments[handle.id] = handle
        self._active_experiment_ids.add(handle.id)
        self._active_children[handle.id] = {
            "handle": handle, "type": "research", "goal": goal,
        }

        if self.memory:
            self.memory.write(
                {"event": "experiment_started", "experiment_id": handle.id, "goal": goal},
                type=EntryType.CONTEXT,
                tags=["experiment"],
            )

        self._emit_event("experiment_started", {
            "experiment_id": handle.id,
            "goal": goal,
        })

        logger.info("[session-agent] Started experiment %s (goal=%s)", handle.id, goal[:80])
        return handle.id

    def get_active_experiment_id(self) -> str | None:
        """Return the agent_id of the first active experiment, or None.

        For backward compatibility with code that expects a single active
        experiment. Use get_active_experiment_ids() for multi-L2 support.
        """
        for eid in list(self._active_experiment_ids):
            handle = self._experiments.get(eid)
            if handle and handle.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                return eid
            # Stale — experiment finished between checks
            self._active_experiment_ids.discard(eid)
        return None

    def get_active_experiment_ids(self) -> list[str]:
        """Return agent_ids of all currently running experiments."""
        active = []
        stale = []
        for eid in list(self._active_experiment_ids):
            handle = self._experiments.get(eid)
            if handle and handle.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                active.append(eid)
            else:
                stale.append(eid)
        for eid in stale:
            self._active_experiment_ids.discard(eid)
        return active

    def list_experiments(self) -> list[dict]:
        """Return metadata for all experiments (active and completed)."""
        results = []
        for eid, handle in self._experiments.items():
            results.append({
                "id": eid,
                "status": handle.status.value,
                "active": eid in self._active_experiment_ids,
            })
        return results

    # ── LLM Brain (wild-mode chat) ─────────────────────────────────────

    async def build_wild_prompt(
        self,
        message: str,
        chat_session_id: str,
        prompt_skill_manager,
        *,
        skill_id: str = "l1_wild_session",
    ) -> tuple[str, dict | None]:
        """Build L1 prompt with children status, memory, capabilities.

        Assembles the full prompt by rendering the specified skill template
        with dynamic context (children status, memory, conversation history).

        Args:
            message: User's chat message.
            chat_session_id: Chat session ID for conversation context.
            prompt_skill_manager: PromptSkillManager instance for template rendering.
            skill_id: Which skill template to use. "l1_wild_session" for wild mode
                      (forced research), "l1_auto_session" for auto mode (agent decides).

        Returns:
            (content, provenance) tuple for the chat worker.
        """
        from core.state import chat_sessions, runs, sweeps, active_alerts
        from core.config import SERVER_CALLBACK_URL, USER_AUTH_TOKEN

        # Build children status
        children_status = self.build_children_status()

        # Build memory text
        memories = ""
        if self.memory:
            try:
                from memory.adapter import MemoryStoreAdapter
                # Use the memory view's store to get formatted memories
                entries = self.memory.store.query(
                    type=EntryType.REFLECTION,
                    order="desc",
                    limit=20,
                )
                if entries:
                    lines = []
                    for i, e in enumerate(entries, 1):
                        d = e.data
                        tag_str = ", ".join(d.get("tags", [])) or "general"
                        title = d.get("title", "")
                        lines.append(f"{i}. **[{tag_str}]** {title}")
                        content = d.get("content", "")
                        if content and content != title:
                            for cl in content.split("\n")[:3]:
                                lines.append(f"   {cl}")
                    memories = "\n".join(lines)
            except Exception as e:
                logger.warning("[session-agent] Failed to load memories: %s", e)

        # Build experiment context (runs/sweeps/alerts summary)
        experiment_context = self._build_experiment_context_summary(runs, sweeps, active_alerts)

        # Build conversation history (last 10 messages from chat session)
        conversation_history = ""
        session = chat_sessions.get(chat_session_id)
        if session and isinstance(session, dict):
            recent_msgs = session.get("messages", [])[-10:]
            if recent_msgs:
                lines = []
                for msg in recent_msgs:
                    role = msg.get("role", "?")
                    content = str(msg.get("content", ""))[:500]
                    lines.append(f"**{role}**: {content}")
                conversation_history = "\n\n".join(lines)

        workdir = self.config.get("workdir", ".")

        variables = {
            "children_status": children_status or "(No active children)",
            "memories": memories or "(No memories yet)",
            "experiment_context": experiment_context,
            "workdir": workdir,
            "conversation_history": conversation_history or "(No prior messages)",
        }

        rendered = prompt_skill_manager.render(skill_id, variables)
        if rendered:
            content = f"{rendered}\n\n[USER] {message}"
            # Extract skill name from the rendered template metadata
            skill_meta = prompt_skill_manager.get(skill_id)
            skill_name = skill_meta.get("name", skill_id) if skill_meta else skill_id
            provenance = {
                "rendered": content,
                "user_input": message,
                "skill_id": skill_id,
                "skill_name": skill_name,
                "template": None,
                "variables": variables,
                "prompt_type": "wild" if skill_id == "l1_wild_session" else "auto",
            }
        else:
            # Fallback: raw message with minimal context
            logger.warning("[session-agent] %s skill not found, using raw prompt", skill_id)
            content = f"[CONTEXT]\n{children_status}\n\n[USER] {message}"
            provenance = {
                "rendered": content,
                "user_input": message,
                "skill_id": None,
                "skill_name": None,
                "template": None,
                "variables": {},
                "prompt_type": "wild",
            }

        return content, provenance

    def build_children_status(self) -> str:
        """Format active/completed children as markdown for prompt context."""
        if not self._experiments:
            return ""

        lines = []
        active = []
        completed = []

        for eid, handle in self._experiments.items():
            status = handle.status
            if status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                active.append((eid, handle, status))
            else:
                completed.append((eid, handle, status))

        if active:
            lines.append("### Active Children")
            for eid, handle, status in active:
                goal = ""
                if self._runtime:
                    info = self._runtime.get_agent(eid)
                    if info:
                        goal = info.goal or ""
                lines.append(f"- **{eid}** [{status.value}]: {goal[:100]}")

        if completed:
            lines.append("### Recently Completed")
            for eid, handle, status in completed[-5:]:  # last 5 completed
                goal = ""
                if self._runtime:
                    info = self._runtime.get_agent(eid)
                    if info:
                        goal = info.goal or ""
                lines.append(f"- **{eid}** [{status.value}]: {goal[:100]}")

        return "\n".join(lines)

    async def handle_llm_response(self, full_text: str) -> list[dict]:
        """Parse LLM output for spawn/steer/stop actions and execute them.

        Scans the full LLM response for:
        - <spawn_research> → start_experiment()
        - <spawn_command> → start_run()
        - <steer_child> → runtime.steer()
        - <stop_child> → runtime.stop()

        Args:
            full_text: The complete LLM response text.

        Returns:
            List of action dicts describing what was executed.
        """
        from agent.v2_prompts import (
            parse_spawn_research,
            parse_spawn_command,
            parse_steer_child,
            parse_stop_child,
        )
        from agentsys.types import SteerUrgency

        actions = []
        workdir = self.config.get("workdir", ".")

        # Build research config from server's config builder if available
        # This ensures L2 gets skills_dir, opencode_url, etc.
        try:
            from server import _build_research_agent_config
            base_research_cfg = _build_research_agent_config()
        except Exception:
            base_research_cfg = {"workdir": workdir}

        # Parse and execute spawn_research actions
        for spec in parse_spawn_research(full_text):
            try:
                cfg = {**base_research_cfg}
                if "max_iterations" in spec:
                    cfg["max_iterations"] = spec["max_iterations"]
                agent_id = await self.start_experiment(
                    goal=spec["goal"],
                    config=cfg,
                )
                actions.append({
                    "action": "spawn_research",
                    "goal": spec["goal"],
                    "agent_id": agent_id,
                })
                logger.info("[session-agent] L1 spawned L2 research: %s (id=%s)", spec["goal"][:60], agent_id)
            except Exception as e:
                logger.error("[session-agent] Failed to spawn research: %s", e)
                actions.append({"action": "spawn_research", "goal": spec["goal"], "error": str(e)})

        # Parse and execute spawn_command actions
        for spec in parse_spawn_command(full_text):
            try:
                agent_id = await self.start_run(
                    command=spec["command"],
                    name=spec["goal"],
                    workdir=spec.get("workdir", workdir),
                )
                actions.append({
                    "action": "spawn_command",
                    "goal": spec["goal"],
                    "command": spec["command"],
                    "agent_id": agent_id,
                })
                logger.info("[session-agent] L1 spawned L3 command: %s (id=%s)", spec["goal"][:60], agent_id)
            except Exception as e:
                logger.error("[session-agent] Failed to spawn command: %s", e)
                actions.append({"action": "spawn_command", "goal": spec["goal"], "error": str(e)})

        # Parse and execute steer_child actions
        for spec in parse_steer_child(full_text):
            try:
                if self._runtime:
                    await self._runtime.steer(spec["experiment_id"], spec["context"], SteerUrgency.PRIORITY)
                actions.append({
                    "action": "steer_child",
                    "experiment_id": spec["experiment_id"],
                    "context": spec["context"][:200],
                })
                logger.info("[session-agent] L1 steered child %s", spec["experiment_id"])
            except Exception as e:
                logger.error("[session-agent] Failed to steer child %s: %s", spec["experiment_id"], e)
                actions.append({"action": "steer_child", "experiment_id": spec["experiment_id"], "error": str(e)})

        # Parse and execute stop_child actions
        for spec in parse_stop_child(full_text):
            try:
                if self._runtime:
                    await self._runtime.stop(spec["experiment_id"])
                actions.append({
                    "action": "stop_child",
                    "experiment_id": spec["experiment_id"],
                })
                logger.info("[session-agent] L1 stopped child %s", spec["experiment_id"])
            except Exception as e:
                logger.error("[session-agent] Failed to stop child %s: %s", spec["experiment_id"], e)
                actions.append({"action": "stop_child", "experiment_id": spec["experiment_id"], "error": str(e)})

        return actions

    @staticmethod
    def _build_experiment_context_summary(runs: dict, sweeps: dict, active_alerts: dict) -> str:
        """Build a summary of current experiment state for the L1 prompt."""
        lines = []

        active_runs = [{"id": rid, **r} for rid, r in runs.items()
                       if r.get("status") in ("running", "queued", "launching")]
        finished_runs = [r for r in runs.values() if r.get("status") == "finished"]
        failed_runs = [{"id": rid, **r} for rid, r in runs.items()
                       if r.get("status") == "failed"]

        if active_runs:
            lines.append(f"**Active runs:** {len(active_runs)}")
            for r in active_runs[:5]:
                lines.append(f"  - {r['id']}: {r.get('name', '?')} [{r.get('status')}]")

        if finished_runs or failed_runs:
            lines.append(f"**Finished:** {len(finished_runs)} | **Failed:** {len(failed_runs)}")

        if failed_runs:
            for r in failed_runs[:3]:
                lines.append(f"  - FAILED {r['id']}: {r.get('name', '?')} error={r.get('error', 'unknown')[:100]}")

        pending_alerts = [a for a in active_alerts.values() if a.get("status") == "pending"]
        if pending_alerts:
            lines.append(f"**Pending alerts:** {len(pending_alerts)}")

        return "\n".join(lines) if lines else "(No active experiments)"

    # ── Run / Sweep management (Phase 3 — agent-backed) ──────────────

    async def start_run(
        self,
        command: str,
        name: str,
        workdir: str,
        **config,
    ) -> str:
        """Spawn a Level 3 ExecutorAgent for a standalone run.

        Args:
            command: Shell command to execute.
            name:    Human-readable run name.
            workdir: Working directory for the run.
            **config: Additional config (gpuwrap_config, params, etc.)

        Returns:
            The agent_id of the spawned executor.
        """
        from agentsys.agents.executor import ExecutorAgent

        executor_config = {
            "backend": "subprocess",
            "command": command,
            "workdir": workdir,
            **config,
        }

        handle = await self.spawn_child(
            ExecutorAgent,
            goal=name,
            **executor_config,
        )

        self._active_children[handle.id] = {
            "handle": handle, "type": "run", "goal": name, "command": command,
        }

        if self.memory:
            self.memory.write(
                {"event": "run_started", "agent_id": handle.id,
                 "name": name, "command": command},
                type=EntryType.CONTEXT,
                tags=["run"],
            )

        self._emit_event("run_started", {
            "agent_id": handle.id,
            "name": name,
        })

        logger.info("[session-agent] Started run %s (name=%s)", handle.id, name)
        return handle.id

    async def start_sweep(
        self,
        name: str,
        base_command: str,
        parameters: dict,
        workdir: str,
        **config,
    ) -> str:
        """Spawn a Level 2 SweepCoordinatorAgent.

        Args:
            name:         Human-readable sweep name.
            base_command: Command template.
            parameters:   Dict of param_name → list of values.
            workdir:      Working directory for all runs.
            **config:     Additional config (parallel, max_runs, gpuwrap_config, etc.)

        Returns:
            The agent_id of the spawned coordinator.
        """
        from agentsys.agents.sweep_coordinator import SweepCoordinatorAgent

        coordinator_config = {
            "base_command": base_command,
            "workdir": workdir,
            "parameters": parameters,
            "sweep_name": name,
            **config,
        }

        handle = await self.spawn_child(
            SweepCoordinatorAgent,
            goal=name,
            **coordinator_config,
        )

        if self.memory:
            self.memory.write(
                {"event": "sweep_started", "agent_id": handle.id,
                 "name": name, "base_command": base_command,
                 "parameters": parameters},
                type=EntryType.CONTEXT,
                tags=["sweep"],
            )

        self._emit_event("sweep_started", {
            "agent_id": handle.id,
            "name": name,
        })

        logger.info("[session-agent] Started sweep %s (name=%s)", handle.id, name)
        return handle.id
