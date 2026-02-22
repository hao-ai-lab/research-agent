"""ResearchAgent — multiprocess-ready autonomous research loop.

Inherits from agentsys.Agent (not the old agent.core.agent.Agent) and runs
in its own OS process via the Runtime.  All config values are serializable
(no callables).  Prompt templates are loaded from disk via a local
PromptSkillManager.  Communication with OpenCode is via direct HTTP.

Uses MemoryView for iteration entries and IPC events for real-time relay
to the server's EventRelay → frontend SSE.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from agentsys.agent import Agent
from agentsys.types import AgentStatus, EntryType, Steer

logger = logging.getLogger("research_agent")


# ---------------------------------------------------------------------------
# Serializable config dataclass (pickle-safe — no callables)
# ---------------------------------------------------------------------------

@dataclass
class ResearchAgentConfig:
    """All configuration for a ResearchAgent, fully serializable."""
    opencode_url: str = "http://127.0.0.1:4096"
    model_provider: str = "opencode"
    model_id: str = "gpt-5-nano"
    workdir: str = "."
    server_url: str = "http://127.0.0.1:10000"
    auth_token: str = ""
    opencode_username: str = ""
    opencode_password: str = ""
    skills_dir: str = ""
    max_iterations: int = 25
    wait_seconds: float = 30.0
    autonomy_level: str = "balanced"
    away_duration_minutes: int = 0
    evo_sweep_enabled: bool = False
    chat_session_id: str = ""


# ---------------------------------------------------------------------------
# Session state (unchanged wire format from old ResearchAgent)
# ---------------------------------------------------------------------------

@dataclass
class ResearchSession:
    """In-memory state for a single research session."""
    session_id: str
    goal: str
    status: str = "running"
    iteration: int = 0
    max_iterations: int = 25
    plan: str = ""
    history: list = field(default_factory=list)
    started_at: float = 0.0
    finished_at: Optional[float] = None
    steer_context: str = ""
    chat_session_id: Optional[str] = None
    wait_seconds: float = 30.0
    opencode_sessions: list = field(default_factory=list)
    reflection: str = ""
    no_progress_streak: int = 0
    short_iteration_count: int = 0
    autonomy_level: str = "balanced"
    away_duration_minutes: int = 0
    evo_sweep_enabled: bool = False

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "goal": self.goal,
            "status": self.status,
            "iteration": self.iteration,
            "max_iterations": self.max_iterations,
            "plan": self.plan,
            "history": self.history,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "steer_context": self.steer_context,
            "chat_session_id": self.chat_session_id,
            "opencode_sessions": self.opencode_sessions,
            "reflection": self.reflection,
            "no_progress_streak": self.no_progress_streak,
            "short_iteration_count": self.short_iteration_count,
            "autonomy_level": self.autonomy_level,
            "away_duration_minutes": self.away_duration_minutes,
            "evo_sweep_enabled": self.evo_sweep_enabled,
        }


# ---------------------------------------------------------------------------
# The Agent
# ---------------------------------------------------------------------------

class ResearchAgent(Agent):
    """Multiprocess-ready autonomous research loop.

    Differences from the old in-process ResearchAgent:
      - No callback-based config (all strings/dicts/numbers).
      - Own PromptSkillManager created on_start() from skills_dir path.
      - Direct OpenCode HTTP (no _send_chat_message callback).
      - IPC event emission for real-time relay.
      - Uses MemoryView for iteration entries.
    """

    role = "orchestrator"
    allowed_child_roles = frozenset({"executor", "sidecar"})

    def __init__(self) -> None:
        super().__init__()
        self._session: Optional[ResearchSession] = None
        self._render_fn = None
        self._skill_manager = None
        self._last_experiment_results: str = ""

    @property
    def session(self) -> Optional[ResearchSession]:
        return self._session

    # ── Lifecycle hooks ───────────────────────────────────────────────

    async def on_start(self) -> None:
        """Set up PromptSkillManager and session before run()."""
        # Create own PromptSkillManager from disk
        skills_dir = self.config.get("skills_dir", "")
        if skills_dir:
            try:
                from skills.manager import PromptSkillManager
                self._skill_manager = PromptSkillManager(skills_dir=skills_dir)
                self._skill_manager.load_all()
                self._render_fn = self._skill_manager.render
                logger.info("[research-agent] Loaded skills from %s", skills_dir)
            except Exception as e:
                logger.warning("[research-agent] Could not load PromptSkillManager: %s", e)

        # Fallback: read SKILL.md files directly and do {{variable}} replacement
        if self._render_fn is None and skills_dir:
            self._render_fn = self._make_fallback_render_fn(skills_dir)
            if self._render_fn:
                logger.info("[research-agent] Using fallback SKILL.md renderer from %s", skills_dir)

        if self._render_fn is None:
            raise RuntimeError(
                f"Cannot initialize ResearchAgent: no skill templates available. "
                f"skills_dir={skills_dir!r}"
            )

        self._init_session()

    async def on_stop(self) -> None:
        if self._session:
            self._session.finished_at = time.time()
            if self._session.status == "running":
                self._session.status = "done"
            self._save_state(self._session.session_id)
            self._emit_event("agent_done", {
                "session_id": self._session.session_id,
                "status": self._session.status,
                "iteration": self._session.iteration,
            })
            logger.info("[research-agent] Session %s stopped (status=%s)",
                        self._session.session_id, self._session.status)

    def _init_session(self) -> None:
        """Synchronously initialize session state, directories, files."""
        if self._session is not None:
            return

        sid = self.id
        cfg = self.config
        workdir = cfg.get("workdir", ".")

        self._session = ResearchSession(
            session_id=sid,
            goal=self.goal,
            max_iterations=cfg.get("max_iterations", 25),
            started_at=time.time(),
            chat_session_id=cfg.get("chat_session_id"),
            wait_seconds=cfg.get("wait_seconds", 30.0),
            autonomy_level=cfg.get("autonomy_level", "balanced"),
            away_duration_minutes=cfg.get("away_duration_minutes", 0),
            evo_sweep_enabled=cfg.get("evo_sweep_enabled", False),
        )

        session_dir = self._session_dir(sid)
        os.makedirs(session_dir, exist_ok=True)

        tasks_path = os.path.join(session_dir, "tasks.md")
        with open(tasks_path, "w") as f:
            f.write(f"# Tasks\n\n## Goal\n{self.goal}\n\n## Tasks\n"
                    "- [ ] (Agent will decompose the goal into tasks on iteration 1)\n")

        log_path = os.path.join(session_dir, "iteration_log.md")
        with open(log_path, "w") as f:
            f.write(f"# Iteration Log\n\nGoal: {self.goal}\n"
                    f"Started: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")

        self._save_state(sid)
        self._emit_event("agent_status", {
            "session_id": sid,
            "status": "initialized",
            "goal": self.goal,
        })
        logger.info("[research-agent] Session %s initialized", sid)

    # ── Main loop ─────────────────────────────────────────────────────

    async def run(self) -> None:
        """The planning → execution → reflection research loop."""
        session = self._session
        if not session:
            logger.error("[research-agent] run() called but no session!")
            return

        logger.info("[research-agent] Loop STARTED for %s (goal=%s)",
                     session.session_id, session.goal[:80])

        # Import prompt builders (pure functions, safe to import)
        from agent.v2_prompts import (
            PromptContext, build_planning_prompt, build_iteration_prompt,
            build_reflection_prompt, parse_promise, parse_plan, parse_summary,
            parse_reflection, parse_continue, parse_memories, parse_experiments,
        )
        try:
            from runs.evo_sweep import EvoSweepController, parse_evo_sweep
        except ImportError:
            EvoSweepController = None
            parse_evo_sweep = lambda text: None  # noqa: E731

        # ── Phase 0: Planning ─────────────────────────────────────
        self._emit_event("agent_status", {
            "session_id": session.session_id,
            "status": "planning",
        })
        plan_start = time.time()

        ctx = self._build_context(session)
        planning_prompt = build_planning_prompt(ctx, render_fn=self._render_fn)

        try:
            plan_text, plan_oc_sid = await self._run_opencode_prompt(planning_prompt)
        except Exception as plan_err:
            logger.error("[research-agent] Planning failed: %s", plan_err, exc_info=True)
            session.status = "failed"
            return

        # Debug: log the raw planning response
        logger.info("[research-agent] Planning response length: %d chars", len(plan_text))
        logger.info("[research-agent] Planning response (first 1000):\n%s", plan_text[:1000])
        logger.info("[research-agent] Planning response (last 500):\n%s", plan_text[-500:])

        # Read plan from tasks.md on disk (the LLM writes it via file tools).
        # We do NOT overwrite tasks.md from <plan> tags — the LLM's file write
        # is authoritative.  <plan> tags are only used as a fallback if the
        # LLM didn't write tasks.md at all.
        tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
        disk_plan = ""
        if os.path.exists(tasks_path):
            try:
                with open(tasks_path) as f:
                    disk_plan = f.read()
            except Exception:
                pass

        # Check if the LLM actually updated tasks.md (vs. our initial stub)
        if disk_plan and "Agent will decompose" not in disk_plan:
            session.plan = disk_plan
            logger.info("[research-agent] Read plan from disk (%d chars)", len(disk_plan))
        else:
            # Fallback: try <plan> tags from LLM response
            parsed_plan = parse_plan(plan_text)
            if parsed_plan and len(parsed_plan) > 50:
                session.plan = parsed_plan
                with open(tasks_path, "w") as f:
                    f.write(parsed_plan)
                logger.info("[research-agent] Used <plan> tag fallback (%d chars)", len(parsed_plan))
            else:
                logger.warning("[research-agent] No plan found on disk or in <plan> tags")

        plan_record = {
            "iteration": 0,
            "summary": parse_summary(plan_text) or "Planning: explored codebase and created task list",
            "started_at": plan_start,
            "finished_at": time.time(),
            "duration_s": round(time.time() - plan_start, 1),
            "opencode_session_id": plan_oc_sid,
            "promise": None,
            "files_modified": [],
            "error_count": 0,
            "errors": [],
        }
        session.history.append(plan_record)
        self._append_iteration_log(session, plan_record)
        await self._git_commit(session)
        self._save_state(session.session_id)

        # Write iteration entry to MemoryView
        if self.memory:
            self.memory.write(
                {"event": "plan_created", "plan_length": len(session.plan)},
                type=EntryType.PLAN,
                tags=["plan"],
            )

        self._emit_event("iteration", {
            "session_id": session.session_id,
            "iteration": 0,
            "summary": plan_record["summary"][:200],
        })
        await asyncio.sleep(2)

        # ── Phase 1+: Execution ───────────────────────────────────
        while session.status == "running" and session.iteration < session.max_iterations:
            await self.check_pause()
            if self.status == AgentStatus.DONE:
                break

            # Check for steering
            steer = self.consume_steer()
            if steer:
                session.steer_context = steer.context

            iter_start = time.time()
            session.iteration += 1
            self.iteration = session.iteration

            self._emit_event("agent_status", {
                "session_id": session.session_id,
                "status": "executing",
                "iteration": session.iteration,
                "max_iterations": session.max_iterations,
            })

            files_before = await self._snapshot_files()

            ctx = self._build_context(session)
            # Clear experiment results after injecting them into this iteration's context
            # so they don't leak into iteration N+2
            self._last_experiment_results = ""
            prompt = build_iteration_prompt(ctx, render_fn=self._render_fn)

            try:
                full_text, iter_oc_sid = await self._run_opencode_prompt(prompt)
            except Exception:
                session.status = "failed"
                break

            # Parse response
            promise = parse_promise(full_text)
            new_plan = parse_plan(full_text)
            summary = parse_summary(full_text) or full_text[:300]
            evo_sweep_config = parse_evo_sweep(full_text) if session.evo_sweep_enabled else None

            # Debug: log what we parsed from the LLM response
            logger.info("[research-agent] iter=%d response_len=%d promise=%s summary_len=%d experiments=%s",
                        session.iteration, len(full_text), promise,
                        len(summary), bool(parse_experiments(full_text)))
            if len(full_text) < 2000:
                logger.info("[research-agent] iter=%d full_response:\n%s", session.iteration, full_text)

            if new_plan:
                session.plan = new_plan

            tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
            if os.path.exists(tasks_path):
                with open(tasks_path) as f:
                    session.plan = f.read()

            # Parse and spawn experiments (L3 executor agents)
            experiment_specs = parse_experiments(full_text)
            if experiment_specs:
                self._emit_event("agent_status", {
                    "session_id": session.session_id,
                    "status": "running_experiments",
                    "iteration": session.iteration,
                    "experiment_count": len(experiment_specs),
                })
                try:
                    exp_results = await self._spawn_experiments(experiment_specs)
                    self._last_experiment_results = self._format_experiment_results(exp_results)
                    logger.info("[research-agent] %d experiments completed", len(exp_results))
                except Exception as exp_err:
                    logger.error("[research-agent] Experiment spawning failed: %s", exp_err, exc_info=True)
                    self._last_experiment_results = f"## Experiment Results\n\nExperiment spawning failed: {exp_err}\n"

            # Metrics
            iter_duration = time.time() - iter_start
            files_after = await self._snapshot_files()
            files_modified = self._diff_files(files_before, files_after)
            errors = self._extract_errors(full_text)

            if not files_modified:
                session.no_progress_streak += 1
            else:
                session.no_progress_streak = 0
            if iter_duration < 30:
                session.short_iteration_count += 1

            iter_record = {
                "iteration": session.iteration,
                "summary": summary,
                "started_at": iter_start,
                "finished_at": time.time(),
                "duration_s": round(iter_duration, 1),
                "opencode_session_id": iter_oc_sid,
                "promise": promise,
                "files_modified": files_modified,
                "error_count": len(errors),
                "errors": errors[:5],
            }
            session.history.append(iter_record)

            # Evo sweep — agent-backed (Phase 6) or HTTP fallback
            if evo_sweep_config and session.evo_sweep_enabled:
                try:
                    # Prefer agent-backed sweep via spawn_child (Phase 6)
                    if self._runtime is not None:
                        from agentsys.agents.sweep_coordinator import SweepCoordinatorAgent
                        sweep_handle = await self.spawn_child(
                            SweepCoordinatorAgent,
                            goal=f"evo-sweep-iter-{session.iteration}",
                            base_command=evo_sweep_config.target_script,
                            parameters=evo_sweep_config.search_space,
                            workdir=self.config.get("workdir", "."),
                            max_runs=evo_sweep_config.population_size * evo_sweep_config.generations,
                            parallel=evo_sweep_config.population_size,
                        )
                        await sweep_handle.wait(timeout=600)
                        from agentsys.types import EntryType as ET
                        results = self.query(agent_id=sweep_handle.id, type=ET.CONTEXT, tags=["sweep", "complete"])
                        if results:
                            progress = results[0].data.get("progress", {})
                            iter_record["evo_sweep"] = {
                                "agent_id": sweep_handle.id,
                                "status": "completed" if progress.get("failed", 0) == 0 else "partial",
                                "progress": progress,
                            }
                        else:
                            iter_record["evo_sweep"] = {"agent_id": sweep_handle.id, "status": sweep_handle.status.value}
                    elif EvoSweepController is not None:
                        # HTTP fallback (legacy)
                        controller = EvoSweepController(
                            server_url=self.config.get("server_url", "http://127.0.0.1:10000"),
                            auth_token=self.config.get("auth_token", ""),
                        )
                        evo_result = await controller.run(evo_sweep_config)
                        iter_record["evo_sweep"] = {
                            "sweep_id": evo_result.sweep_id,
                            "best_fitness": evo_result.best_fitness,
                            "best_config": evo_result.best_config,
                            "generations": evo_result.generations_completed,
                            "status": evo_result.status,
                        }
                except Exception as evo_err:
                    iter_record["evo_sweep"] = {"status": "failed", "error": str(evo_err)}

            self._append_iteration_log(session, iter_record)
            await self._git_commit(session)

            if session.steer_context:
                session.steer_context = ""
                ctx_path = os.path.join(self._session_dir(session.session_id), "context.md")
                if os.path.exists(ctx_path):
                    os.remove(ctx_path)

            self._save_state(session.session_id)

            # Write iteration entry to MemoryView
            if self.memory:
                self.memory.write(
                    iter_record,
                    type=EntryType.CONTEXT,
                    tags=["iteration"],
                )

            self._emit_event("iteration", {
                "session_id": session.session_id,
                "iteration": session.iteration,
                "summary": summary[:200],
                "promise": promise,
                "files_modified": files_modified[:10],
            })

            # Handle promise signals
            if promise == "DONE":
                should_stop = await self._run_reflection(session, summary)
                if should_stop:
                    session.status = "done"
                    session.finished_at = time.time()
                    break
                await asyncio.sleep(2)
                continue

            if promise == "WAITING":
                # If we just ran experiments, results are already collected —
                # skip the wait and proceed to next iteration immediately.
                if not experiment_specs:
                    await asyncio.sleep(session.wait_seconds)
                else:
                    await asyncio.sleep(2)
            else:
                await asyncio.sleep(2)

        if session.status == "running":
            session.status = "done"
            session.finished_at = time.time()

    # ── Reflection ────────────────────────────────────────────────────

    async def _run_reflection(self, session: ResearchSession, summary: str) -> bool:
        """Run reflection step. Returns True if agent should stop."""
        from agent.v2_prompts import (
            build_reflection_prompt, parse_reflection, parse_continue, parse_memories,
        )

        try:
            ctx = self._build_context(session)
            ctx._plan_text = session.plan  # type: ignore[attr-defined]
            reflection_prompt = build_reflection_prompt(
                ctx, render_fn=self._render_fn, summary_of_work=summary,
            )
            reflection_text, _refl_oc_sid = await self._run_opencode_prompt(reflection_prompt)

            reflection_body = parse_reflection(reflection_text) or reflection_text[:500]
            should_continue = parse_continue(reflection_text)
            session.reflection = reflection_body

            # Store memories via MemoryView
            if self.memory:
                try:
                    memories = parse_memories(reflection_text)
                    for mem in memories:
                        title = mem.get("title", "")
                        content = mem.get("content", "")
                        tag = mem.get("tag", "general")
                        if not title or not content:
                            logger.debug("[research-agent] Skipping malformed memory entry: %s", mem)
                            continue
                        self.memory.write(
                            {
                                "title": title,
                                "content": content,
                                "source": "reflection",
                                "tags": [tag],
                                "session_id": session.session_id,
                                "is_active": True,
                            },
                            type=EntryType.REFLECTION,
                            tags=[tag],
                        )
                except Exception as mem_err:
                    logger.warning("[research-agent] Failed to store memories: %s", mem_err)

            reflection_record = {
                "iteration": session.iteration,
                "summary": f"[Reflection] {reflection_body[:200]}",
                "started_at": time.time(),
                "finished_at": time.time(),
                "duration_s": 0,
                "opencode_session_id": _refl_oc_sid,
                "promise": "REFLECT_CONTINUE" if should_continue else "REFLECT_STOP",
                "files_modified": [],
                "error_count": 0,
                "errors": [],
            }
            session.history.append(reflection_record)
            self._append_iteration_log(session, reflection_record)
            self._save_state(session.session_id)

            self._emit_event("reflection", {
                "session_id": session.session_id,
                "reflection": reflection_body[:300],
                "should_continue": should_continue,
            })

            return not should_continue

        except Exception as err:
            logger.warning("[research-agent] Reflection failed: %s", err, exc_info=True)
            return True

    # ── OpenCode interaction (direct HTTP, no callbacks) ──────────────

    async def _run_opencode_prompt(self, prompt: str) -> tuple[str, str]:
        """Create a session and send a prompt to OpenCode.

        Returns (full_response_text, opencode_session_id).
        """
        oc_session_id = await self._create_opencode_session()
        if not oc_session_id:
            raise RuntimeError("Failed to create OpenCode session")
        text = await self._run_opencode(oc_session_id, prompt)
        if not text or not text.strip():
            logger.error("[research-agent] OpenCode returned empty response (session=%s)", oc_session_id)
            raise RuntimeError(f"OpenCode returned empty response (session={oc_session_id})")
        # Track session ID in session state
        if self._session:
            self._session.opencode_sessions.append(oc_session_id)
        return text, oc_session_id

    async def _create_opencode_session(self) -> Optional[str]:
        """Create a fresh OpenCode session."""
        cfg = self.config
        opencode_url = cfg.get("opencode_url", "http://127.0.0.1:4096")
        workdir = os.path.abspath(cfg.get("workdir", "."))
        auth = self._get_opencode_auth()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{opencode_url}/session",
                    params={"directory": workdir},
                    json={},
                    auth=auth,
                )
                resp.raise_for_status()
                return resp.json().get("id")
        except Exception as err:
            logger.error("[research-agent] Failed to create OpenCode session: %s", err)
            return None

    async def _run_opencode(self, oc_session_id: str, prompt: str) -> str:
        """Send prompt to OpenCode and stream the full response.

        Follows the event protocol from test.py:
        1. Connect SSE *before* sending the prompt (so no events are missed).
        2. Filter events by sessionID (from props or part dict).
        3. Collect text from ``message.part.updated`` (type="text") and
           ``message.part.delta`` (field="text").
        4. Stop on ``session.status`` with ``status.type == "idle"``.
        5. Timeout after TTFT_TIMEOUT if no text received, or TOTAL_TIMEOUT overall.
        """
        cfg = self.config
        opencode_url = cfg.get("opencode_url", "http://127.0.0.1:4096")
        model_provider = cfg.get("model_provider", "opencode")
        model_id = cfg.get("model_id", "gpt-5-nano")
        auth = self._get_opencode_auth()

        TTFT_TIMEOUT = 180   # 3 min max for first token
        TOTAL_TIMEOUT = 600  # 10 min max total

        # Track text parts by part ID so final snapshots win over deltas.
        # Only parts with type="text" are collected (not reasoning/tool parts).
        text_part_ids: set[str] = set()   # IDs confirmed as type="text"
        text_parts: dict[str, str] = {}   # partID -> accumulated text
        full_text = ""
        first_text_at: float = 0
        start_time = time.time()

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                # 1. Connect SSE FIRST (before sending prompt)
                url = f"{opencode_url}/global/event"
                headers = {"Accept": "text/event-stream"}
                async with client.stream(
                    "GET", url, headers=headers, auth=auth,
                ) as sse:
                    # 2. Now send the prompt
                    payload = {
                        "model": {"providerID": model_provider, "modelID": model_id},
                        "parts": [{"type": "text", "text": prompt}],
                    }
                    resp = await client.post(
                        f"{opencode_url}/session/{oc_session_id}/prompt_async",
                        json=payload,
                        auth=auth,
                    )
                    resp.raise_for_status()

                    # 3. Stream events with timeout
                    async for line in sse.aiter_lines():
                        elapsed = time.time() - start_time

                        # Total timeout
                        if elapsed > TOTAL_TIMEOUT:
                            logger.error("[research-agent] SSE total timeout after %.0fs (session=%s)",
                                         elapsed, oc_session_id)
                            break

                        # TTFT timeout (no text received yet)
                        if not first_text_at and elapsed > TTFT_TIMEOUT:
                            logger.error("[research-agent] SSE TTFT timeout after %.0fs — model may be down or rate-limited (session=%s)",
                                         elapsed, oc_session_id)
                            break

                        if not line.startswith("data: "):
                            continue
                        try:
                            raw_data = json.loads(line[6:])
                            event_data = raw_data.get("payload", raw_data)
                            event_type = event_data.get("type", "")
                            props = event_data.get("properties", {})

                            # Get part dict (for message.part.* events)
                            part = props.get("part", {})
                            if not isinstance(part, dict):
                                part = {}

                            # Session filter — match test.py logic
                            event_sid = (props.get("sessionID")
                                         or part.get("sessionID", ""))
                            if event_sid and event_sid != oc_session_id:
                                continue

                            # --- Error detection ---
                            if event_type in ("session.error", "message.error"):
                                error_msg = props.get("error", props.get("message", "unknown error"))
                                logger.error("[research-agent] OpenCode error event: %s (session=%s)",
                                             error_msg, oc_session_id)
                                break

                            # --- Text extraction ---
                            # message.part.updated carries a full snapshot
                            # with a "type" field we can check
                            if event_type == "message.part.updated":
                                if part.get("type") == "text":
                                    part_id = part.get("id", "")
                                    text_part_ids.add(part_id)
                                    text_parts[part_id] = part.get("text", "")
                                    if not first_text_at:
                                        first_text_at = time.time()

                            # message.part.delta only for known text parts
                            elif event_type == "message.part.delta":
                                if props.get("field") == "text":
                                    part_id = props.get("partID", "")
                                    if part_id in text_part_ids:
                                        text_parts[part_id] = (
                                            text_parts.get(part_id, "")
                                            + props.get("delta", "")
                                        )
                                        if not first_text_at:
                                            first_text_at = time.time()

                            # --- Done detection ---
                            if event_type == "session.status":
                                status = props.get("status", {})
                                if isinstance(status, dict):
                                    stype = status.get("type", "")
                                    if stype == "idle":
                                        break
                                    elif stype == "error":
                                        error_msg = status.get("error", "session error")
                                        logger.error("[research-agent] Session error: %s (session=%s)",
                                                     error_msg, oc_session_id)
                                        break

                        except Exception:
                            continue
        except Exception as err:
            logger.error("[research-agent] OpenCode run failed: %s", err, exc_info=True)

        elapsed = time.time() - start_time
        logger.info("[research-agent] SSE completed in %.1fs, %d text parts (session=%s)",
                    elapsed, len(text_parts), oc_session_id)

        # Assemble full text from tracked parts
        if text_parts:
            full_text = "\n".join(
                text_parts[k] for k in sorted(text_parts.keys())
                if text_parts[k]
            )

        return full_text

    def _get_opencode_auth(self):
        """Build httpx auth tuple from config, or None."""
        username = self.config.get("opencode_username", "")
        password = self.config.get("opencode_password", "")
        if username and password:
            return (username, password)
        return None

    # ── Helper methods ────────────────────────────────────────────────

    # ── Experiment spawning (L3 executor agents) ────────────────────

    async def _spawn_experiments(self, specs: list[dict]) -> list[dict]:
        """Spawn L3 ExecutorAgents for experiment specs and wait for results.

        Args:
            specs: List of experiment spec dicts from parse_experiments().
                   Each has: goal, command, workdir (optional), parameters (optional).

        Returns:
            List of result dicts with: goal, command, status, output.
        """
        from agentsys.agents.executor import ExecutorAgent

        handles: list[tuple[dict, Any]] = []
        for spec in specs:
            command = spec.get("command", "")
            if not command:
                logger.warning("[research-agent] Skipping experiment with no command: %s", spec)
                continue
            workdir = spec.get("workdir", self.config.get("workdir", "."))
            goal = spec.get("goal", command[:80])
            params = spec.get("parameters")

            executor_config: dict[str, Any] = {
                "backend": "subprocess",
                "command": command,
                "workdir": workdir,
            }
            if params and isinstance(params, dict):
                executor_config["params"] = params

            logger.info("[research-agent] Spawning executor for: %s", goal[:80])
            handle = await self.spawn_child(
                ExecutorAgent,
                goal=goal,
                **executor_config,
            )
            handles.append((spec, handle))

        if not handles:
            return []

        # Wait for all executors to complete (poll with timeout)
        timeout = 300  # 5 minutes per experiment max
        results: list[dict] = []

        for spec, handle in handles:
            start_wait = time.time()
            while time.time() - start_wait < timeout:
                status = handle.status
                if status in (AgentStatus.DONE, AgentStatus.FAILED):
                    break
                await asyncio.sleep(5.0)

            # Read output from executor's run.log
            run_dir = os.path.join(
                self.config.get("workdir", "."),
                ".agents", "runs", handle.id,
            )
            log_path = os.path.join(run_dir, "run.log")
            output = ""
            if os.path.exists(log_path):
                try:
                    with open(log_path) as f:
                        output = f.read()
                except Exception:
                    pass

            final_status = handle.status
            results.append({
                "goal": spec.get("goal", ""),
                "command": spec.get("command", ""),
                "status": final_status.value,
                "output": output[-8000:] if len(output) > 8000 else output,
            })
            logger.info("[research-agent] Experiment '%s' finished: %s",
                        spec.get("goal", "")[:60], final_status.value)

        return results

    @staticmethod
    def _format_experiment_results(results: list[dict]) -> str:
        """Format experiment results as markdown for injection into next iteration's context."""
        if not results:
            return ""

        lines = ["## Results from Previous Experiments\n"]
        for i, r in enumerate(results, 1):
            status_label = "PASSED" if r["status"] == "done" else "FAILED"
            lines.append(f"### Experiment {i}: {r['goal']}")
            lines.append(f"- **Command:** `{r['command']}`")
            lines.append(f"- **Status:** {status_label}")
            output = r.get("output", "").strip()
            if output:
                lines.append(f"- **Output:**\n```\n{output}\n```")
            else:
                lines.append("- **Output:** (no output captured)")
            lines.append("")

        return "\n".join(lines)

    def _build_context(self, session: ResearchSession):
        """Create a PromptContext from current session state."""
        from agent.v2_prompts import PromptContext

        cfg = self.config
        workdir = cfg.get("workdir", ".")
        session_dir = self._session_dir(session.session_id)

        # Try to get memories from MemoryView
        memories_text = ""
        if self.memory:
            try:
                # Query reflection entries from ALL agents in the project
                entries = self.memory.store.query(
                    project=self.memory.scope["project"],
                    type=EntryType.REFLECTION,
                    order="desc",
                    limit=30,
                )
                if entries:
                    lines = ["## Memory Bank (Lessons & Context from Past Sessions)\n"]
                    for i, e in enumerate(entries[:20], 1):
                        d = e.data
                        if d.get("is_active", True):
                            tag_str = ", ".join(d.get("tags", [])) or "general"
                            lines.append(f"{i}. **[{tag_str}]** {d.get('title', '')}")
                            content = d.get("content", "")
                            if content and content != d.get("title", ""):
                                for cl in content.split("\n"):
                                    lines.append(f"   {cl}")
                    memories_text = "\n".join(lines)
            except Exception:
                pass

        return PromptContext(
            goal=session.goal,
            iteration=session.iteration,
            max_iterations=session.max_iterations,
            workdir=workdir,
            tasks_path=os.path.join(session_dir, "tasks.md"),
            log_path=os.path.join(session_dir, "iteration_log.md"),
            server_url=cfg.get("server_url", "http://127.0.0.1:10000"),
            session_id=session.session_id,
            auth_token=cfg.get("auth_token", ""),
            steer_context=session.steer_context,
            history=session.history,
            no_progress_streak=session.no_progress_streak,
            short_iteration_count=session.short_iteration_count,
            autonomy_level=session.autonomy_level,
            away_duration_minutes=session.away_duration_minutes,
            user_wants_questions=(
                session.autonomy_level != "full" and session.away_duration_minutes == 0
            ),
            memories_text=memories_text,
            evo_sweep_enabled=session.evo_sweep_enabled,
            experiment_results=self._last_experiment_results,
        )

    def _current_step_goal(self, session: ResearchSession) -> str:
        tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
        lines: list[str] = []
        if os.path.exists(tasks_path):
            try:
                with open(tasks_path) as f:
                    lines = f.read().splitlines()
            except Exception:
                pass

        for line in lines:
            m = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\[(/)]\s+(.*)$", line)
            if m and m.group(2).strip():
                return m.group(2).strip()

        for line in lines:
            m = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\[( )]\s+(.*)$", line)
            if m and m.group(2).strip():
                return m.group(2).strip()

        return "Make measurable progress toward the session goal and update tasks.md + iteration_log.md."

    async def _git_commit(self, session: ResearchSession):
        workdir = self.config.get("workdir", ".")
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "status", "--porcelain",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            if not stdout.decode().strip():
                return

            proc = await asyncio.create_subprocess_exec(
                "git", "add", "-A",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
            await asyncio.wait_for(proc.communicate(), timeout=10)

            msg = f"wild-v2: iteration {session.iteration} — {session.goal[:50]}"
            proc = await asyncio.create_subprocess_exec(
                "git", "commit", "-m", msg, "--no-verify",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
            await asyncio.wait_for(proc.communicate(), timeout=30)
        except Exception as err:
            logger.warning("[research-agent] Git commit failed: %s", err)

    async def _snapshot_files(self) -> dict:
        workdir = self.config.get("workdir", ".")
        snapshot = {}
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "ls-files", "-s",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            for line in stdout.decode().strip().split("\n"):
                if line:
                    parts = line.split("\t", 1)
                    if len(parts) == 2:
                        snapshot[parts[1]] = parts[0].split()[1]

            proc2 = await asyncio.create_subprocess_exec(
                "git", "status", "--porcelain",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
            stdout2, _ = await asyncio.wait_for(proc2.communicate(), timeout=10)
            for line in stdout2.decode().strip().split("\n"):
                if line:
                    fname = line[3:].strip()
                    if fname and fname not in snapshot:
                        snapshot[fname] = "unstaged"
        except Exception:
            pass
        return snapshot

    @staticmethod
    def _diff_files(before: dict, after: dict) -> list:
        changed = []
        for fname, hash_val in after.items():
            if before.get(fname) != hash_val:
                changed.append(fname)
        for fname in before:
            if fname not in after:
                changed.append(fname)
        return changed

    @staticmethod
    def _extract_errors(text: str) -> list:
        errors = []
        for line in text.split("\n"):
            lower = line.lower()
            if any(kw in lower for kw in (
                "error:", "failed:", "exception:", "traceback",
                "typeerror", "syntaxerror", "referenceerror",
                "assertionerror", "importerror", "modulenotfounderror",
            )):
                cleaned = line.strip()[:200]
                if cleaned and cleaned not in errors:
                    errors.append(cleaned)
        return errors[:10]

    def _append_iteration_log(self, session: ResearchSession, record: dict):
        log_path = os.path.join(self._session_dir(session.session_id), "iteration_log.md")
        try:
            files_str = ", ".join(record.get("files_modified", [])[:10]) or "none"
            errors_str = ""
            if record.get("errors"):
                errors_str = "\n  Errors:\n" + "\n".join(
                    f"  - {e[:120]}" for e in record["errors"][:5]
                )
            entry = (
                f"## Iteration {record['iteration']}\n"
                f"- Duration: {record.get('duration_s', '?')}s\n"
                f"- Promise: {record.get('promise', 'none')}\n"
                f"- Files modified: {files_str}\n"
                f"- Summary: {record.get('summary', 'N/A')[:300]}\n"
                f"{errors_str}\n\n---\n\n"
            )
            with open(log_path, "a") as f:
                f.write(entry)
        except Exception:
            pass

    @staticmethod
    def _make_fallback_render_fn(skills_dir: str):
        """Create a simple fallback render function that reads SKILL.md from disk.

        Returns a callable(skill_id, variables) -> str, or None if no templates
        found on disk.
        """
        import re as _re

        def _render(skill_id: str, variables: dict) -> str:
            skill_path = os.path.join(skills_dir, skill_id, "SKILL.md")
            if not os.path.exists(skill_path):
                return ""
            try:
                with open(skill_path) as f:
                    content = f.read()
            except OSError:
                return ""

            # Strip YAML frontmatter (--- ... ---)
            if content.startswith("---"):
                end = content.find("---", 3)
                if end != -1:
                    content = content[end + 3:].lstrip("\n")

            # Replace {{variable}} placeholders
            def _replace_var(match):
                var_name = match.group(1).strip()
                return str(variables.get(var_name, match.group(0)))

            return _re.sub(r"\{\{(\s*\w+\s*)\}\}", _replace_var, content)

        # Verify at least one key template exists
        for name in ("wild_v2_planning", "wild_v2_iteration"):
            test_path = os.path.join(skills_dir, name, "SKILL.md")
            if os.path.exists(test_path):
                return _render
        return None

    def _session_dir(self, session_id: str) -> str:
        workdir = self.config.get("workdir", ".")
        return os.path.join(workdir, ".agents", "wild", session_id)

    def _save_state(self, session_id: str):
        session_dir = self._session_dir(session_id)
        os.makedirs(session_dir, exist_ok=True)
        if self._session:
            # Atomic write: tmp file + rename to avoid corruption on crash
            state_path = os.path.join(session_dir, "state.json")
            tmp_path = state_path + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump(self._session.to_dict(), f, indent=2)
            os.replace(tmp_path, state_path)

            history_path = os.path.join(session_dir, "history.json")
            tmp_path = history_path + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump(self._session.history, f, indent=2)
            os.replace(tmp_path, history_path)

    # ── API helpers (used by routes via FileStore/.meta.json) ─────────

    def get_status(self) -> dict:
        if not self._session:
            return {"active": False}
        d = self._session.to_dict()
        d["active"] = self._session.status == "running"
        sid = self._session.session_id
        session_dir = self._session_dir(sid)
        d["session_dir"] = session_dir
        d["workdir"] = self.config.get("workdir", ".")

        log_path = os.path.join(session_dir, "iteration_log.md")
        if os.path.exists(log_path):
            try:
                with open(log_path) as f:
                    d["iteration_log"] = f.read()
            except Exception:
                d["iteration_log"] = ""

        tasks_path = os.path.join(session_dir, "tasks.md")
        if os.path.exists(tasks_path):
            try:
                with open(tasks_path) as f:
                    d["plan"] = f.read()
            except Exception:
                pass

        return d

    def get_plan(self) -> str:
        if not self._session:
            return ""
        tasks_path = os.path.join(self._session_dir(self._session.session_id), "tasks.md")
        try:
            with open(tasks_path) as f:
                return f.read()
        except FileNotFoundError:
            return self._session.plan

    def get_iteration_log(self) -> str:
        if not self._session:
            return ""
        log_path = os.path.join(self._session_dir(self._session.session_id), "iteration_log.md")
        try:
            with open(log_path) as f:
                return f.read()
        except FileNotFoundError:
            return ""

    @staticmethod
    def get_system_health_from_runs(runs_dict: dict) -> dict:
        health = {
            "running": 0, "queued": 0, "completed": 0,
            "failed": 0, "total": 0, "max_concurrent": 5,
        }
        for r in runs_dict.values():
            status = r.get("status", "")
            health["total"] += 1
            if status == "running":
                health["running"] += 1
            elif status in ("queued", "ready"):
                health["queued"] += 1
            elif status == "finished":
                health["completed"] += 1
            elif status == "failed":
                health["failed"] += 1
        return health
