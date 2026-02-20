"""ResearchAgent — the main autonomous research loop, as a proper Agent.

This replaces the monolithic WildV2Engine with a clean Agent subclass.
The run() method implements the same planning → execution → reflection loop,
but lifecycle management (start/stop/pause/resume/steer) comes from the
Agent base class and communication flows through the MessageBus.

The WildV2Engine class is preserved as a backward-compatible facade that
delegates to ResearchAgent, so existing server.py wiring continues to work.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import httpx

from agent.core.agent import Agent, AgentStatus
from agent.core.message import Message

try:
    from agent.v2_prompts import (
        PromptContext,
        build_iteration_prompt,
        build_planning_prompt,
        build_reflection_prompt,
        parse_continue,
        parse_memories,
        parse_plan,
        parse_promise,
        parse_reflection,
        parse_summary,
    )
except ImportError:
    from .v2_prompts import (  # type: ignore[no-redef]
        PromptContext,
        build_iteration_prompt,
        build_planning_prompt,
        build_reflection_prompt,
        parse_continue,
        parse_memories,
        parse_plan,
        parse_promise,
        parse_reflection,
        parse_summary,
    )

try:
    from runs.evo_sweep import EvoSweepController, parse_evo_sweep
except ImportError:
    try:
        from .evo_sweep import EvoSweepController, parse_evo_sweep  # type: ignore[no-redef]
    except ImportError:
        # evo_sweep is optional
        EvoSweepController = None  # type: ignore[misc, assignment]
        parse_evo_sweep = lambda text: None  # type: ignore[assignment]  # noqa: E731

logger = logging.getLogger("research_agent")


# ---------------------------------------------------------------------------
# Session state (unchanged from wild_loop_v2)
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


# Keep backward compat alias
WildV2Session = ResearchSession


# ---------------------------------------------------------------------------
# ResearchAgent — the proper Agent subclass
# ---------------------------------------------------------------------------

class ResearchAgent(Agent):
    """Autonomous research loop agent.

    Implements the planning → execution → reflection loop from WildV2Engine
    as a proper Agent subclass with lifecycle management.

    Config keys:
        opencode_url: str — OpenCode API endpoint
        model_provider: str — Model provider ID
        model_id: str — Model ID
        get_workdir: Callable — Returns the working directory path
        server_url: str — Server callback URL for agent API access
        auth_token: str — Auth token for API requests
        get_auth: Callable — Returns httpx auth tuple
        render_fn: Callable — Prompt skill template renderer
        save_chat_state: Callable — Persists chat state
        chat_sessions: dict — Reference to chat sessions dict
        send_chat_message: Callable — Routes prompts through chat UI
        memory_store: object — Memory bank for lessons/context
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)

        # Extract config with defaults
        c = self.config
        self._opencode_url = c.get("opencode_url", "http://127.0.0.1:4096")
        self._model_provider = c.get("model_provider", "opencode")
        self._model_id = c.get("model_id", "minimax-m2.5-free")
        self._get_workdir = c.get("get_workdir", lambda: ".")
        self._server_url = c.get("server_url", "http://127.0.0.1:10000")
        self._auth_token = c.get("auth_token")
        self._get_auth = c.get("get_auth")
        self._render_fn = c.get("render_fn")
        self._save_chat_state = c.get("save_chat_state")
        self._chat_sessions = c.get("chat_sessions", {})
        self._send_chat_message = c.get("send_chat_message")
        self.memory_store = c.get("memory_store")

        # Session state
        self._session: Optional[ResearchSession] = None

    @property
    def session(self) -> Optional[ResearchSession]:
        return self._session

    # ── Agent lifecycle hooks ─────────────────────────────────────────

    def _init_session(self) -> None:
        """Synchronously initialize the session (files, directories, state).

        Called by both the async on_start() and the sync WildV2Engine facade.
        """
        if self._session is not None:
            return  # Already initialized

        sid = self.id
        chat_session_id = self.config.get("chat_session_id")
        max_iterations = self.config.get("max_iterations", 25)
        wait_seconds = self.config.get("wait_seconds", 30.0)
        autonomy_level = self.config.get("autonomy_level", "balanced")
        away_duration_minutes = self.config.get("away_duration_minutes", 0)
        evo_sweep_enabled = self.config.get("evo_sweep_enabled", False)

        self._session = ResearchSession(
            session_id=sid,
            goal=self.goal,
            max_iterations=max_iterations,
            started_at=time.time(),
            chat_session_id=chat_session_id,
            wait_seconds=wait_seconds,
            autonomy_level=autonomy_level,
            away_duration_minutes=away_duration_minutes,
            evo_sweep_enabled=evo_sweep_enabled,
        )

        # Create session storage dir
        session_dir = self._session_dir(sid)
        os.makedirs(session_dir, exist_ok=True)

        # Create tasks.md
        tasks_path = os.path.join(session_dir, "tasks.md")
        with open(tasks_path, "w") as f:
            f.write(f"# Tasks\n\n## Goal\n{self.goal}\n\n## Tasks\n- [ ] (Agent will decompose the goal into tasks on iteration 1)\n")

        # Create empty iteration log
        log_path = os.path.join(session_dir, "iteration_log.md")
        with open(log_path, "w") as f:
            f.write(f"# Iteration Log\n\nGoal: {self.goal}\nStarted: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")

        self._save_state(sid)
        logger.info("[research-agent] Session %s initialized", sid)

    async def on_start(self) -> None:
        """Set up the session before run() begins."""
        self._init_session()

    async def on_stop(self) -> None:
        """Clean up when the agent stops."""
        if self._session:
            self._session.finished_at = time.time()
            if self._session.status == "running":
                self._session.status = "done"
            self._save_state(self._session.session_id)
            logger.info("[research-agent] Session %s stopped (status=%s)", self._session.session_id, self._session.status)

    # ── Main loop ─────────────────────────────────────────────────────

    async def run(self) -> None:
        """The planning → execution → reflection research loop."""
        session = self._session
        if not session:
            logger.error("[research-agent] run() called but no session!")
            return

        logger.info("[research-agent] Loop STARTED for %s (goal=%s)", session.session_id, session.goal[:80])

        # ── Phase 0: Planning ─────────────────────────────────────
        await self.send(Message.status(self.id, "planning", goal=self.goal))
        plan_start = time.time()

        ctx = self._build_context(session)
        planning_prompt = build_planning_prompt(ctx, render_fn=self._render_fn)
        display_msg = (
            "[Wild V2 — Step #0]\n"
            "Role: plan\n"
            f"Goal: {session.goal}\n"
            "Task: Create a concrete step-by-step plan."
        )

        try:
            plan_text = await self._send_prompt(session, planning_prompt, display_msg)
        except Exception as plan_err:
            logger.error("[research-agent] Planning failed: %s", plan_err, exc_info=True)
            session.status = "failed"
            await self.send(Message.error(self.id, f"Planning failed: {plan_err}"))
            return

        # Parse plan
        parsed_plan = parse_plan(plan_text)
        if parsed_plan:
            session.plan = parsed_plan
            tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
            with open(tasks_path, "w") as f:
                f.write(parsed_plan)
        else:
            tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
            if os.path.exists(tasks_path):
                with open(tasks_path) as f:
                    session.plan = f.read()

        # Record planning
        plan_record = {
            "iteration": 0,
            "summary": parse_summary(plan_text) or "Planning: explored codebase and created task list",
            "started_at": plan_start,
            "finished_at": time.time(),
            "duration_s": round(time.time() - plan_start, 1),
            "opencode_session_id": session.chat_session_id or "",
            "promise": None,
            "files_modified": [],
            "error_count": 0,
            "errors": [],
        }
        session.history.append(plan_record)
        self._append_iteration_log(session, plan_record)
        await self._git_commit(session)
        self._save_state(session.session_id)

        await self.send(Message.result(self.id, f"Plan created ({len(session.plan)} chars)", plan=session.plan))
        await asyncio.sleep(2)

        # ── Phase 1+: Execution ───────────────────────────────────
        while session.status == "running" and session.iteration < session.max_iterations:
            # Check for pause/cancel from Agent base
            await self._wait_if_paused()
            if self.is_cancelled():
                break

            # Check for steering from Agent base
            steer = self.consume_steer()
            if steer:
                session.steer_context = steer

            iter_start = time.time()
            session.iteration += 1
            self.iteration = session.iteration

            await self.send(Message.status(
                self.id, "executing",
                iteration=session.iteration,
                max_iterations=session.max_iterations,
            ))

            files_before = self._snapshot_files()

            ctx = self._build_context(session)
            prompt = build_iteration_prompt(ctx, render_fn=self._render_fn)
            step_goal = self._current_step_goal(session)
            display_msg = (
                f"[Wild V2 — Step #{session.iteration}/{session.max_iterations}]\n"
                "Role: run\n"
                f"Goal: {step_goal}"
            )

            try:
                full_text = await self._send_prompt(session, prompt, display_msg)
            except Exception:
                session.status = "failed"
                await self.send(Message.error(self.id, "Execution iteration failed"))
                break

            # Parse response
            promise = parse_promise(full_text)
            new_plan = parse_plan(full_text)
            summary = parse_summary(full_text) or full_text[:300]
            evo_sweep_config = parse_evo_sweep(full_text) if session.evo_sweep_enabled else None

            if new_plan:
                session.plan = new_plan

            # Read tasks.md from disk (agent may have updated it)
            tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
            if os.path.exists(tasks_path):
                with open(tasks_path) as f:
                    session.plan = f.read()

            # Metrics
            iter_duration = time.time() - iter_start
            files_after = self._snapshot_files()
            files_modified = self._diff_files(files_before, files_after)
            errors = self._extract_errors(full_text)

            # Struggle detection
            if not files_modified:
                session.no_progress_streak += 1
            else:
                session.no_progress_streak = 0
            if iter_duration < 30:
                session.short_iteration_count += 1

            # Record iteration
            iter_record = {
                "iteration": session.iteration,
                "summary": summary,
                "started_at": iter_start,
                "finished_at": time.time(),
                "duration_s": round(iter_duration, 1),
                "opencode_session_id": session.chat_session_id or "",
                "promise": promise,
                "files_modified": files_modified,
                "error_count": len(errors),
                "errors": errors[:5],
            }
            session.history.append(iter_record)

            # Evo sweep
            if evo_sweep_config and session.evo_sweep_enabled and EvoSweepController is not None:
                controller = EvoSweepController(
                    server_url=self._server_url,
                    auth_token=self._auth_token,
                )
                session._evo_controller = controller  # type: ignore[attr-defined]
                try:
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
                finally:
                    session._evo_controller = None  # type: ignore[attr-defined]

            self._append_iteration_log(session, iter_record)
            await self._git_commit(session)

            # Clear steer context
            if session.steer_context:
                session.steer_context = ""
                ctx_path = os.path.join(self._session_dir(session.session_id), "context.md")
                if os.path.exists(ctx_path):
                    os.remove(ctx_path)

            self._save_state(session.session_id)

            await self.send(Message.result(
                self.id,
                summary=summary[:200],
                iteration=session.iteration,
                promise=promise,
                files_modified=files_modified,
            ))

            # ── Handle promise signals ────────────────────────────
            if promise == "DONE":
                should_stop = await self._run_reflection(session, summary)
                if should_stop:
                    session.status = "done"
                    session.finished_at = time.time()
                    break
                await asyncio.sleep(2)
                continue

            if promise == "WAITING":
                await asyncio.sleep(session.wait_seconds)
            else:
                await asyncio.sleep(2)

        # Max iterations reached
        if session.status == "running":
            session.status = "done"
            session.finished_at = time.time()

        await self.send(Message.result(
            self.id,
            summary=f"Research complete: {session.iteration} iterations",
            total_iterations=session.iteration,
        ))

    # ── Reflection ────────────────────────────────────────────────────

    async def _run_reflection(self, session: ResearchSession, summary: str) -> bool:
        """Run the reflection step after a DONE signal.

        Returns True if the agent should stop, False if it should continue.
        """
        try:
            ctx = self._build_context(session)
            ctx._plan_text = session.plan  # type: ignore[attr-defined]
            reflection_prompt = build_reflection_prompt(
                ctx, render_fn=self._render_fn, summary_of_work=summary,
            )
            display_msg = (
                f"[Wild V2 — Reflection after iteration #{session.iteration}]\n"
                "Role: reflect\n"
                f"Goal: {session.goal}"
            )
            reflection_text = await self._send_prompt(session, reflection_prompt, display_msg)

            reflection_body = parse_reflection(reflection_text) or reflection_text[:500]
            should_continue = parse_continue(reflection_text)
            session.reflection = reflection_body

            # Store memories
            if self.memory_store is not None:
                try:
                    memories = parse_memories(reflection_text)
                    for mem in memories:
                        self.memory_store.add(
                            title=mem["title"],
                            content=mem["content"],
                            source="reflection",
                            tags=[mem["tag"]],
                            session_id=session.session_id,
                        )
                except Exception as mem_err:
                    logger.warning("[research-agent] Failed to store memories: %s", mem_err)

            reflection_record = {
                "iteration": session.iteration,
                "summary": f"[Reflection] {reflection_body[:200]}",
                "started_at": time.time(),
                "finished_at": time.time(),
                "duration_s": 0,
                "opencode_session_id": session.chat_session_id or "",
                "promise": "REFLECT_CONTINUE" if should_continue else "REFLECT_STOP",
                "files_modified": [],
                "error_count": 0,
                "errors": [],
            }
            session.history.append(reflection_record)
            self._append_iteration_log(session, reflection_record)
            self._save_state(session.session_id)

            return not should_continue  # True = stop

        except Exception as err:
            logger.warning("[research-agent] Reflection failed: %s", err, exc_info=True)
            return True  # Stop on reflection failure

    # ── OpenCode interaction (preserved from WildV2Engine) ────────────

    async def _send_prompt(self, session: ResearchSession, prompt: str, display_msg: str) -> str:
        """Send a prompt through chat callback or direct OpenCode."""
        if self._send_chat_message and session.chat_session_id:
            try:
                return await self._send_chat_message(
                    session.chat_session_id, prompt, display_msg
                )
            except Exception as chat_err:
                logger.error("[research-agent] Chat message failed: %s, falling back to OpenCode", chat_err)
                oc_session_id = await self._create_opencode_session()
                if not oc_session_id:
                    raise
                session.opencode_sessions.append(oc_session_id)
                full_text = await self._run_opencode(oc_session_id, prompt)
                self._append_to_chat(session, prompt, full_text, session.iteration)
                return full_text
        else:
            oc_session_id = await self._create_opencode_session()
            if not oc_session_id:
                raise RuntimeError("Failed to create OpenCode session")
            session.opencode_sessions.append(oc_session_id)
            full_text = await self._run_opencode(oc_session_id, prompt)
            self._append_to_chat(session, prompt, full_text, session.iteration)
            return full_text

    async def _create_opencode_session(self) -> Optional[str]:
        """Create a fresh OpenCode session."""
        try:
            async with httpx.AsyncClient() as client:
                workdir = os.path.abspath(self._get_workdir())
                resp = await client.post(
                    f"{self._opencode_url}/session",
                    params={"directory": workdir},
                    json={},
                    auth=self._get_auth() if self._get_auth else None,
                )
                resp.raise_for_status()
                return resp.json().get("id")
        except Exception as err:
            logger.error("[research-agent] Failed to create OpenCode session: %s", err)
            return None

    async def _run_opencode(self, session_id: str, prompt: str) -> str:
        """Send prompt to OpenCode and stream the full response text."""
        full_text = ""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                payload = {
                    "model": {"providerID": self._model_provider, "modelID": self._model_id},
                    "parts": [{"type": "text", "text": prompt}],
                }
                resp = await client.post(
                    f"{self._opencode_url}/session/{session_id}/prompt_async",
                    json=payload,
                    auth=self._get_auth() if self._get_auth else None,
                )
                resp.raise_for_status()

                url = f"{self._opencode_url}/global/event"
                headers = {"Accept": "text/event-stream"}
                async with client.stream(
                    "GET", url, headers=headers,
                    auth=self._get_auth() if self._get_auth else None,
                ) as response:
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            raw_data = json.loads(line[6:])
                            event_data = raw_data.get("payload", raw_data)

                            if "error" in event_data:
                                break

                            event_type = event_data.get("type", "")
                            props = event_data.get("properties", {})

                            for part in props.get("parts", []):
                                if part.get("type") == "text":
                                    full_text += part.get("content", "")

                            if event_type == "message.updated":
                                metadata = props.get("metadata", {})
                                if metadata.get("done"):
                                    break

                            if (event_type == "session.updated"
                                and props.get("id") == session_id
                                and props.get("busy") is False):
                                break
                        except Exception:
                            continue
        except Exception as err:
            logger.error("[research-agent] OpenCode run failed: %s", err, exc_info=True)

        return full_text

    # ── Helper methods (preserved from WildV2Engine) ──────────────────

    def _build_context(self, session: ResearchSession) -> PromptContext:
        """Create a PromptContext from current session state."""
        session_dir = self._session_dir(session.session_id)

        memories_text = ""
        if self.memory_store is not None:
            try:
                memories_text = self.memory_store.format_for_prompt()
            except Exception:
                pass

        return PromptContext(
            goal=session.goal,
            iteration=session.iteration,
            max_iterations=session.max_iterations,
            workdir=self._get_workdir(),
            tasks_path=os.path.join(session_dir, "tasks.md"),
            log_path=os.path.join(session_dir, "iteration_log.md"),
            server_url=self._server_url,
            session_id=session.session_id,
            auth_token=self._auth_token or "",
            steer_context=session.steer_context,
            history=session.history,
            no_progress_streak=session.no_progress_streak,
            short_iteration_count=session.short_iteration_count,
            autonomy_level=session.autonomy_level,
            away_duration_minutes=session.away_duration_minutes,
            user_wants_questions=session.autonomy_level != "full" and session.away_duration_minutes == 0,
            memories_text=memories_text,
            evo_sweep_enabled=session.evo_sweep_enabled,
        )

    def _current_step_goal(self, session: ResearchSession) -> str:
        """Best-effort next-step goal from tasks.md."""
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

    def _append_to_chat(self, session: ResearchSession, prompt: str, response: str, iteration: int):
        """Append iteration messages to chat UI."""
        if not session.chat_session_id or not self._chat_sessions:
            return
        chat = self._chat_sessions.get(session.chat_session_id)
        if not isinstance(chat, dict):
            return
        messages = chat.setdefault("messages", [])
        messages.append({
            "role": "user",
            "content": f"[Wild V2 — Iteration {iteration}/{session.max_iterations}]\n\n{prompt[:200]}...",
            "timestamp": time.time(),
            "wild_v2_iteration": iteration,
        })
        messages.append({
            "role": "assistant",
            "content": response,
            "timestamp": time.time(),
            "wild_v2_iteration": iteration,
        })
        if self._save_chat_state:
            self._save_chat_state()

    async def _git_commit(self, session: ResearchSession):
        """Commit tracked changes after an iteration."""
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True, text=True, cwd=self._get_workdir(), timeout=10,
            )
            if not result.stdout.strip():
                return
            subprocess.run(
                ["git", "add", "-A"],
                capture_output=True, cwd=self._get_workdir(), timeout=10,
            )
            msg = f"wild-v2: iteration {session.iteration} — {session.goal[:50]}"
            subprocess.run(
                ["git", "commit", "-m", msg, "--no-verify"],
                capture_output=True, cwd=self._get_workdir(), timeout=30,
            )
        except Exception as err:
            logger.warning("[research-agent] Git commit failed: %s", err)

    def _snapshot_files(self) -> dict:
        """Capture git-tracked file hashes for change detection."""
        snapshot = {}
        try:
            result = subprocess.run(
                ["git", "ls-files", "-s"],
                capture_output=True, text=True, cwd=self._get_workdir(), timeout=10,
            )
            for line in result.stdout.strip().split("\n"):
                if line:
                    parts = line.split("\t", 1)
                    if len(parts) == 2:
                        snapshot[parts[1]] = parts[0].split()[1]
            result2 = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True, text=True, cwd=self._get_workdir(), timeout=10,
            )
            for line in result2.stdout.strip().split("\n"):
                if line:
                    fname = line[3:].strip()
                    if fname and fname not in snapshot:
                        snapshot[fname] = "unstaged"
        except Exception:
            pass
        return snapshot

    def _diff_files(self, before: dict, after: dict) -> list:
        """Return list of files changed between two snapshots."""
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
        """Extract error patterns from agent output."""
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
        """Append a structured entry to the iteration log on disk."""
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

    def _session_dir(self, session_id: str) -> str:
        return os.path.join(self._get_workdir(), ".agents", "wild", session_id)

    def _save_state(self, session_id: str):
        path = os.path.join(self._session_dir(session_id), "state.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if self._session:
            with open(path, "w") as f:
                json.dump(self._session.to_dict(), f, indent=2)
            history_path = os.path.join(self._session_dir(session_id), "history.json")
            with open(history_path, "w") as f:
                json.dump(self._session.history, f, indent=2)

    # ── API helpers (used by routes) ──────────────────────────────────

    def get_status(self) -> dict:
        """Return current session state for API."""
        if not self._session:
            return {"active": False}

        d = self._session.to_dict()
        d["active"] = self._session.status == "running"

        sid = self._session.session_id
        session_dir = self._session_dir(sid)
        d["session_dir"] = session_dir
        d["workdir"] = self._get_workdir()
        d["opencode_pwd"] = None
        d["opencode_pwd_note"] = "OpenCode does not expose a direct cwd endpoint."

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
        """Compute system utilization stats from a runs dict."""
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

    def to_dict(self) -> dict[str, Any]:
        """Extended serialization including session state."""
        d = super().to_dict()
        if self._session:
            d.update(self._session.to_dict())
        return d


# ---------------------------------------------------------------------------
# WildV2Engine — backward-compatible facade
# ---------------------------------------------------------------------------

class WildV2Engine:
    """Backward-compatible facade over ResearchAgent.

    The server.py wiring still instantiates WildV2Engine and calls its methods.
    This facade translates those calls to AgentRuntime + ResearchAgent operations.

    For new code, use AgentRuntime.spawn(ResearchAgent, ...) directly.
    """

    def __init__(
        self,
        *,
        opencode_url: str = "http://127.0.0.1:4096",
        model_provider: str = "opencode",
        model_id: str = "minimax-m2.5-free",
        get_workdir: Optional[Callable[[], str]] = None,
        server_url: str = "http://127.0.0.1:10000",
        auth_token: Optional[str] = None,
        get_auth: Optional[Callable] = None,
        render_fn: Optional[Callable] = None,
        save_chat_state: Optional[Callable] = None,
        chat_sessions: Optional[dict] = None,
        send_chat_message: Optional[Callable[..., Any]] = None,
    ):
        self._config = {
            "opencode_url": opencode_url,
            "model_provider": model_provider,
            "model_id": model_id,
            "get_workdir": get_workdir or (lambda: "."),
            "server_url": server_url,
            "auth_token": auth_token,
            "get_auth": get_auth,
            "render_fn": render_fn,
            "save_chat_state": save_chat_state,
            "chat_sessions": chat_sessions or {},
            "send_chat_message": send_chat_message,
        }
        self._agent: Optional[ResearchAgent] = None
        self._task: Optional[asyncio.Task] = None

        # Memory store — injected after construction by server.py
        self.memory_store = None

    @property
    def session(self) -> Optional[ResearchSession]:
        return self._agent._session if self._agent else None

    @property
    def _session(self) -> Optional[ResearchSession]:
        """Backward compat for wild_routes.py accessing _session."""
        return self.session

    @property
    def is_active(self) -> bool:
        return self._agent is not None and self._agent.status == AgentStatus.RUNNING

    def start(
        self,
        goal: str,
        chat_session_id: Optional[str] = None,
        max_iterations: int = 25,
        wait_seconds: float = 30.0,
        autonomy_level: str = "balanced",
        away_duration_minutes: int = 0,
        evo_sweep_enabled: bool = False,
    ) -> dict:
        """Start a new research session."""
        if self._agent and self._agent.status == AgentStatus.RUNNING:
            self.stop()

        config = {
            **self._config,
            "chat_session_id": chat_session_id,
            "max_iterations": max_iterations,
            "wait_seconds": wait_seconds,
            "autonomy_level": autonomy_level,
            "away_duration_minutes": away_duration_minutes,
            "evo_sweep_enabled": evo_sweep_enabled,
            "memory_store": self.memory_store,
        }

        agent_id = f"wild-{uuid.uuid4().hex[:8]}"
        self._agent = ResearchAgent(
            agent_id=agent_id,
            goal=goal,
            config=config,
        )

        # Initialize session synchronously so it's available immediately
        self._agent._init_session()

        # Start the agent's async loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                self._task = loop.create_task(self._run_agent())
            else:
                logger.error("[wild-v2-facade] Event loop is not running!")
        except RuntimeError:
            logger.error("[wild-v2-facade] No running event loop")

        return self._agent._session.to_dict()

    async def _run_agent(self):
        """Run the agent lifecycle."""
        agent = self._agent
        if not agent:
            return
        try:
            await agent.on_start()
            agent.status = AgentStatus.RUNNING
            await agent.run()
            if agent.status == AgentStatus.RUNNING:
                agent.status = AgentStatus.DONE
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            agent.status = AgentStatus.FAILED
            logger.exception("[wild-v2-facade] Agent failed: %s", exc)
        finally:
            await agent.on_stop()

    def stop(self) -> dict:
        if not self._agent:
            return {"stopped": False}

        if self._agent._session:
            self._agent._session.status = "done"
            self._agent._session.finished_at = time.time()

        self._agent._cancel_event.set()
        self._agent.status = AgentStatus.DONE

        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None

        if self._agent._session:
            self._agent._save_state(self._agent._session.session_id)

        return self._agent._session.to_dict() if self._agent._session else {"stopped": True}

    def pause(self) -> dict:
        if self._agent and self._agent._session:
            self._agent._session.status = "paused"
            self._agent.status = AgentStatus.PAUSED
            self._agent._save_state(self._agent._session.session_id)
        return self._agent._session.to_dict() if self._agent and self._agent._session else {}

    def resume(self) -> dict:
        if self._agent and self._agent._session and self._agent._session.status == "paused":
            self._agent._session.status = "running"
            self._agent.status = AgentStatus.RUNNING
            self._agent._save_state(self._agent._session.session_id)
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running() and (not self._task or self._task.done()):
                    self._task = loop.create_task(self._run_agent())
            except RuntimeError:
                pass
        return self._agent._session.to_dict() if self._agent and self._agent._session else {}

    def steer(self, context: str) -> dict:
        if self._agent and self._agent._session:
            self._agent._session.steer_context = context
            self._agent._steer_context = context
            self._agent._steer_event.set()
            ctx_path = os.path.join(
                self._agent._session_dir(self._agent._session.session_id), "context.md"
            )
            with open(ctx_path, "w") as f:
                f.write(context)
        return {"ok": True}

    def get_status(self) -> dict:
        if not self._agent:
            return {"active": False}
        return self._agent.get_status()

    def get_plan(self) -> str:
        return self._agent.get_plan() if self._agent else ""

    def get_iteration_log(self) -> str:
        return self._agent.get_iteration_log() if self._agent else ""

    def _build_context(self, session):
        """Backward compat for tests."""
        if self._agent:
            return self._agent._build_context(session)
        raise RuntimeError("No active agent")

    @staticmethod
    def get_system_health_from_runs(runs_dict: dict) -> dict:
        return ResearchAgent.get_system_health_from_runs(runs_dict)
