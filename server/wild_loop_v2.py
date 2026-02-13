"""Wild Loop V2 — Ralph-style event-driven autonomous loop.

Design:
  - One prompt template, repeated each iteration
  - Per-iteration fresh OpenCode session (clean agent context)
  - Events are prompt-driven (agent checks endpoints, not a queue)
  - Git commit per iteration
  - Plan persisted in .agents/wild/<session_id>/plan.md
  - <promise>DONE</promise> / <promise>WAITING</promise> signal parsing
"""

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

logger = logging.getLogger("wild_loop_v2")

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
# Session state
# ---------------------------------------------------------------------------

@dataclass
class WildV2Session:
    """In-memory state for a single wild v2 session."""

    session_id: str
    goal: str
    status: str = "running"          # running | paused | done | failed
    iteration: int = 0
    max_iterations: int = 25
    plan: str = ""
    history: list = field(default_factory=list)
    started_at: float = 0.0
    finished_at: Optional[float] = None
    pending_events: list = field(default_factory=list)
    steer_context: str = ""          # user-injected context for next iter
    chat_session_id: Optional[str] = None
    wait_seconds: float = 30.0       # sleep between iterations when WAITING

    # Per-iteration OpenCode session IDs (for debugging)
    opencode_sessions: list = field(default_factory=list)

    # Struggle detection
    no_progress_streak: int = 0      # consecutive iterations with no file changes
    short_iteration_count: int = 0   # iterations < 30s

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
            "pending_events_count": len(self.pending_events),
            "pending_events": self.pending_events,
            "steer_context": self.steer_context,
            "chat_session_id": self.chat_session_id,
            "opencode_sessions": self.opencode_sessions,
            "no_progress_streak": self.no_progress_streak,
            "short_iteration_count": self.short_iteration_count,
        }


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class WildV2Engine:
    """Ralph-style autonomous loop engine."""

    def __init__(
        self,
        *,
        opencode_url: str = "http://127.0.0.1:4096",
        model_provider: str = "opencode",
        model_id: str = "kimi-k2.5-free",
        workdir: str = ".",
        server_url: str = "http://127.0.0.1:10000",
        auth_token: Optional[str] = None,
        get_auth: Optional[Callable] = None,
        # Callbacks into server.py
        get_runs: Optional[Callable] = None,
        get_sweeps: Optional[Callable] = None,
        get_alerts: Optional[Callable] = None,
        save_chat_state: Optional[Callable] = None,
        chat_sessions: Optional[dict] = None,
        # Chat streaming callback: (chat_session_id, prompt, display_message) -> response_text
        # When provided, V2 routes iterations through the frontend's chat session
        # so responses stream live in the UI.
        send_chat_message: Optional[Callable[..., Any]] = None,
    ):
        self._opencode_url = opencode_url
        self._model_provider = model_provider
        self._model_id = model_id
        self._workdir = workdir
        self._server_url = server_url
        self._auth_token = auth_token
        self._get_auth = get_auth
        self._get_runs = get_runs
        self._get_sweeps = get_sweeps
        self._get_alerts = get_alerts
        self._save_chat_state = save_chat_state
        self._chat_sessions = chat_sessions or {}
        self._send_chat_message = send_chat_message

        self._session: Optional[WildV2Session] = None
        self._task: Optional[asyncio.Task] = None

    # -- Properties --

    @property
    def session(self) -> Optional[WildV2Session]:
        return self._session

    @property
    def is_active(self) -> bool:
        return self._session is not None and self._session.status == "running"

    # -- Lifecycle --

    def start(
        self,
        goal: str,
        chat_session_id: Optional[str] = None,
        max_iterations: int = 25,
        wait_seconds: float = 30.0,
    ) -> dict:
        """Start a new V2 wild session."""
        logger.info("[wild-v2] start() called: goal=%s chat_session=%s max_iter=%d", goal[:80], chat_session_id, max_iterations)

        if self._session and self._session.status == "running":
            logger.info("[wild-v2] Existing session running, stopping first")
            self.stop()

        sid = f"wild-{uuid.uuid4().hex[:8]}"
        self._session = WildV2Session(
            session_id=sid,
            goal=goal,
            max_iterations=max_iterations,
            started_at=time.time(),
            chat_session_id=chat_session_id,
            wait_seconds=wait_seconds,
        )

        # Create session storage dir
        session_dir = self._session_dir(sid)
        os.makedirs(session_dir, exist_ok=True)
        logger.debug("[wild-v2] Session dir: %s", session_dir)

        # Create tasks.md — the agent reads/writes this directly on disk
        tasks_path = os.path.join(session_dir, "tasks.md")
        with open(tasks_path, "w") as f:
            f.write(f"# Tasks\n\n## Goal\n{goal}\n\n## Tasks\n- [ ] (Agent will decompose the goal into tasks on iteration 1)\n")

        # Create empty iteration log
        log_path = os.path.join(session_dir, "iteration_log.md")
        with open(log_path, "w") as f:
            f.write(f"# Iteration Log\n\nGoal: {goal}\nStarted: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")

        # Save initial state
        self._save_state(sid)

        # Check if send_chat_message callback is available
        logger.info("[wild-v2] send_chat_message callback: %s", "YES" if self._send_chat_message else "NO")
        logger.info("[wild-v2] chat_session_id: %s", chat_session_id)

        # Start the async loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                self._task = loop.create_task(self._run_loop())
                logger.info("[wild-v2] Async loop task created successfully")
            else:
                logger.error("[wild-v2] Event loop is not running!")
        except RuntimeError:
            logger.error("[wild-v2] No running event loop, cannot start")

        logger.info("[wild-v2] Started session %s: goal=%s max_iter=%d", sid, goal[:80], max_iterations)
        return self._session.to_dict()

    def stop(self) -> dict:
        """Stop the active session."""
        if not self._session:
            return {"stopped": False}

        self._session.status = "done"
        self._session.finished_at = time.time()

        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None

        self._save_state(self._session.session_id)
        logger.info("[wild-v2] Stopped session %s at iteration %d", self._session.session_id, self._session.iteration)
        return self._session.to_dict()

    def pause(self) -> dict:
        if self._session:
            self._session.status = "paused"
            self._save_state(self._session.session_id)
        return self._session.to_dict() if self._session else {}

    def resume(self) -> dict:
        if self._session and self._session.status == "paused":
            self._session.status = "running"
            self._save_state(self._session.session_id)
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running() and (not self._task or self._task.done()):
                    self._task = loop.create_task(self._run_loop())
            except RuntimeError:
                pass
        return self._session.to_dict() if self._session else {}

    def steer(self, context: str) -> dict:
        """Inject user context for the next iteration."""
        if self._session:
            self._session.steer_context = context
            # Also save to file
            ctx_path = os.path.join(self._session_dir(self._session.session_id), "context.md")
            with open(ctx_path, "w") as f:
                f.write(context)
        return {"ok": True}

    def get_status(self) -> dict:
        """Return current session state for API."""
        if not self._session:
            return {"active": False}

        d = self._session.to_dict()
        d["active"] = self._session.status == "running"

        # Add system health
        d["system_health"] = self._get_system_health()

        return d

    def get_events(self) -> list:
        """Return pending events for the agent to handle."""
        if not self._session:
            return []
        return list(self._session.pending_events)

    def resolve_events(self, event_ids: list) -> dict:
        """Mark events as resolved."""
        if not self._session:
            return {"resolved": 0}
        before = len(self._session.pending_events)
        self._session.pending_events = [
            e for e in self._session.pending_events
            if e.get("id") not in set(event_ids)
        ]
        resolved = before - len(self._session.pending_events)
        return {"resolved": resolved}

    def get_plan(self) -> str:
        """Return current plan/tasks markdown from disk."""
        if not self._session:
            return ""
        tasks_path = os.path.join(
            self._session_dir(self._session.session_id), "tasks.md"
        )
        try:
            with open(tasks_path) as f:
                return f.read()
        except FileNotFoundError:
            return self._session.plan

    def get_iteration_log(self) -> str:
        """Return the iteration log from disk."""
        if not self._session:
            return ""
        log_path = os.path.join(
            self._session_dir(self._session.session_id), "iteration_log.md"
        )
        try:
            with open(log_path) as f:
                return f.read()
        except FileNotFoundError:
            return ""

    # -- Main loop --

    async def _run_loop(self):
        """The ralph-style main loop running as an async background task."""
        session = self._session
        if not session:
            logger.error("[wild-v2] _run_loop called but no session!")
            return

        logger.info("[wild-v2] _run_loop STARTED for session %s (goal=%s)", session.session_id, session.goal[:80])
        logger.info("[wild-v2] chat_session_id=%s, max_iterations=%d, has_callback=%s",
                    session.chat_session_id, session.max_iterations, bool(self._send_chat_message))

        try:
            while (
                session.status == "running"
                and session.iteration < session.max_iterations
            ):
                iter_start = time.time()
                session.iteration += 1
                logger.info(
                    "[wild-v2] ========== Iteration %d/%d START ==========",
                    session.iteration, session.max_iterations,
                )

                # Collect events from alerts/runs
                self._collect_events()

                # Snapshot files before iteration (for change detection)
                files_before = self._snapshot_files()

                # 1. Build the prompt
                prompt = self._build_prompt(session)
                display_msg = f"[Wild V2 — Iteration {session.iteration}/{session.max_iterations}]"
                logger.debug("[wild-v2] Prompt built, length=%d chars", len(prompt))
                logger.debug("[wild-v2] Display message: %s", display_msg)

                # 2. Send prompt — route through chat session if available (live streaming),
                #    otherwise fall back to direct OpenCode call
                full_text = ""
                if self._send_chat_message and session.chat_session_id:
                    logger.info("[wild-v2] Routing through chat session %s for live streaming", session.chat_session_id)
                    try:
                        full_text = await self._send_chat_message(
                            session.chat_session_id, prompt, display_msg
                        )
                        logger.info("[wild-v2] Chat message returned, response length=%d", len(full_text))
                    except Exception as chat_err:
                        logger.error("[wild-v2] Chat message failed: %s, falling back to direct OpenCode", chat_err, exc_info=True)
                        oc_session_id = await self._create_opencode_session()
                        if not oc_session_id:
                            logger.error("[wild-v2] Fallback OpenCode session creation also failed!")
                            session.status = "failed"
                            break
                        session.opencode_sessions.append(oc_session_id)
                        full_text = await self._run_opencode(oc_session_id, prompt)
                        self._append_to_chat(session, prompt, full_text, session.iteration)
                else:
                    logger.info("[wild-v2] No chat callback, using direct OpenCode")
                    oc_session_id = await self._create_opencode_session()
                    if not oc_session_id:
                        logger.error("[wild-v2] Failed to create OpenCode session, stopping")
                        session.status = "failed"
                        break
                    session.opencode_sessions.append(oc_session_id)
                    full_text = await self._run_opencode(oc_session_id, prompt)
                    self._append_to_chat(session, prompt, full_text, session.iteration)

                logger.info("[wild-v2] Response received: %d chars (preview: %s)",
                           len(full_text), full_text[:100].replace('\n', ' ') if full_text else "<empty>")

                # 3. Parse response
                promise = parse_promise(full_text)
                new_plan = parse_plan(full_text)
                summary = parse_summary(full_text) or full_text[:300]
                logger.info("[wild-v2] Parsed: promise=%s, has_plan=%s, summary=%s",
                           promise, bool(new_plan), summary[:80].replace('\n', ' '))

                # 4. Update plan in memory (tasks.md is managed by agent on disk)
                if new_plan:
                    session.plan = new_plan

                # Read tasks.md from disk (agent may have updated it)
                tasks_path = os.path.join(self._session_dir(session.session_id), "tasks.md")
                if os.path.exists(tasks_path):
                    with open(tasks_path) as f:
                        session.plan = f.read()
                    logger.debug("[wild-v2] Read tasks.md from disk: %d chars", len(session.plan))

                # 5. Compute per-iteration metrics
                iter_duration = time.time() - iter_start
                files_after = self._snapshot_files()
                files_modified = self._diff_files(files_before, files_after)
                errors = self._extract_errors(full_text)
                logger.info("[wild-v2] Iteration %d metrics: duration=%.1fs, files_modified=%d, errors=%d",
                           session.iteration, iter_duration, len(files_modified), len(errors))

                # Struggle detection
                if not files_modified:
                    session.no_progress_streak += 1
                    logger.debug("[wild-v2] No progress streak: %d", session.no_progress_streak)
                else:
                    session.no_progress_streak = 0
                if iter_duration < 30:
                    session.short_iteration_count += 1
                    logger.debug("[wild-v2] Short iteration count: %d", session.short_iteration_count)

                # 6. Record enriched iteration history
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
                    "errors": errors[:5],  # cap stored errors
                }
                session.history.append(iter_record)

                # 7. Append to iteration_log.md on disk
                self._append_iteration_log(session, iter_record)

                # 8. Git commit
                await self._git_commit(session)

                # 9. Clear steer context after consumption
                if session.steer_context:
                    session.steer_context = ""
                    ctx_path = os.path.join(self._session_dir(session.session_id), "context.md")
                    if os.path.exists(ctx_path):
                        os.remove(ctx_path)

                # 10. Save state
                self._save_state(session.session_id)

                # 11. Check promise
                logger.info("[wild-v2] ========== Iteration %d/%d END (promise=%s, duration=%.1fs) ==========",
                           session.iteration, session.max_iterations, promise, iter_duration)

                if promise == "DONE":
                    logger.info("[wild-v2] Agent signaled DONE at iteration %d", session.iteration)
                    session.status = "done"
                    session.finished_at = time.time()
                    break

                if promise == "WAITING":
                    logger.info(
                        "[wild-v2] Agent signaled WAITING, sleeping %ds",
                        int(session.wait_seconds),
                    )
                    await asyncio.sleep(session.wait_seconds)
                else:
                    # Brief pause between iterations to avoid hammering
                    logger.debug("[wild-v2] Sleeping 2s before next iteration")
                    await asyncio.sleep(2)

            # Max iterations reached
            if session.status == "running":
                logger.info("[wild-v2] Max iterations (%d) reached", session.max_iterations)
                session.status = "done"
                session.finished_at = time.time()

        except asyncio.CancelledError:
            logger.info("[wild-v2] Loop cancelled for session %s", session.session_id)
        except Exception as err:
            logger.error("[wild-v2] Loop error: %s", err, exc_info=True)
            session.status = "failed"
        finally:
            self._save_state(session.session_id)
            logger.info("[wild-v2] Loop ended for session %s (status=%s)", session.session_id, session.status)

    # -- OpenCode interaction --

    async def _create_opencode_session(self) -> Optional[str]:
        """Create a fresh OpenCode session."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._opencode_url}/session",
                    json={},
                    auth=self._get_auth() if self._get_auth else None,
                )
                resp.raise_for_status()
                oc_id = resp.json().get("id")
                logger.info("[wild-v2] Created OpenCode session: %s", oc_id)
                return oc_id
        except Exception as err:
            logger.error("[wild-v2] Failed to create OpenCode session: %s", err)
            return None

    async def _run_opencode(self, session_id: str, prompt: str) -> str:
        """Send prompt to OpenCode and stream the full response text."""
        full_text = ""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                # Send prompt
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

                # Stream events
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
                            event_data = json.loads(line[6:])
                            if "error" in event_data:
                                logger.error("[wild-v2] OpenCode error: %s", event_data["error"])
                                break

                            # Extract text from event
                            props = event_data.get("properties", {})
                            content_parts = props.get("parts", [])
                            for part in content_parts:
                                if part.get("type") == "text":
                                    full_text += part.get("content", "")

                            # Check for completion
                            if event_data.get("type") == "message.updated":
                                metadata = props.get("metadata", {})
                                if metadata.get("done"):
                                    break

                            # Simple done detection: session idle
                            if (event_data.get("type") == "session.updated"
                                and props.get("id") == session_id):
                                if props.get("busy") is False:
                                    break
                        except Exception as parse_err:
                            logger.debug("[wild-v2] Event parse error: %s", parse_err)
                            continue

        except Exception as err:
            logger.error("[wild-v2] OpenCode run failed: %s", err, exc_info=True)

        logger.info("[wild-v2] Got %d chars of response", len(full_text))
        return full_text

    # -- Prompt builder --

    def _build_prompt(self, session: WildV2Session) -> str:
        """Build the single ralph-style prompt with all context."""
        session_dir = self._session_dir(session.session_id)
        tasks_path = os.path.join(session_dir, "tasks.md")
        log_path = os.path.join(session_dir, "iteration_log.md")

        events_summary = ""
        if session.pending_events:
            events_summary = "\n".join(
                f"- [{e.get('type', 'event')}] {e.get('title', 'Untitled')}: {e.get('detail', '')}"
                for e in session.pending_events
            )
        else:
            events_summary = "No pending events."

        health = self._get_system_health()
        health_summary = (
            f"Running: {health.get('running', 0)}/{health.get('max_concurrent', 5)} | "
            f"Queued: {health.get('queued', 0)} | "
            f"Completed: {health.get('completed', 0)} | "
            f"Failed: {health.get('failed', 0)}"
        )

        steer_section = ""
        if session.steer_context:
            steer_section = f"""
## 🗣️ User Context (injected mid-loop)

{session.steer_context}

*(Address this context in your work this iteration, then it will be cleared.)*
"""

        # Struggle warnings
        struggle_section = ""
        warnings = []
        if session.no_progress_streak >= 3:
            warnings.append(f"⚠️ No file changes for {session.no_progress_streak} consecutive iterations — try a different approach")
        if session.short_iteration_count >= 3:
            warnings.append(f"⚠️ {session.short_iteration_count} very short iterations (<30s) — are you making meaningful progress?")
        # Check for repeated errors in recent history
        recent_errors = []
        for h in session.history[-3:]:
            recent_errors.extend(h.get("errors", []))
        if len(recent_errors) >= 3:
            seen = {}
            for e in recent_errors:
                key = e[:80]
                seen[key] = seen.get(key, 0) + 1
            repeated = [k for k, v in seen.items() if v >= 2]
            if repeated:
                warnings.append(f"⚠️ Repeated errors across iterations: {repeated[0][:60]}...")
        if warnings:
            struggle_section = "\n## ⚠️ Struggle Indicators\n\n" + "\n".join(f"- {w}" for w in warnings) + "\n"

        prompt = f"""You are an autonomous research engineer running in a loop. This is **iteration {session.iteration} of {session.max_iterations}**.

## 🎯 Goal

{session.goal}
{steer_section}{struggle_section}
## 📊 System Health

{health_summary}

## 🔔 Pending Events

{events_summary}

---

## Your Working Files

You have two critical files that persist between iterations. **Read them first, update them as you work.**

### 📋 Task File: `{tasks_path}`
This is your task checklist. Read it at the start of each iteration to know what to do.
- Mark tasks `[/]` when starting, `[x]` when complete
- Add new tasks if you discover work needed
- Focus on ONE task per iteration

### 📜 Iteration Log: `{log_path}`
This records what happened in every previous iteration — your results, errors, and lessons.
Read it to learn from your own mistakes and avoid repeating them.

---

## Iteration Protocol

1. **Read `{tasks_path}`** to see what's done and what's next
2. **Read `{log_path}`** to see previous iteration results and avoid past mistakes
3. **Check events**: Handle any pending alerts/failures before continuing
4. **Work on ONE task**: Focus on the current in-progress or next pending task
5. **Update `{tasks_path}`**: Mark completed tasks `[x]`, current task `[/]`
6. **Run tests/verification** if applicable
7. **API endpoints** (use via bash/curl):
   - Events: `curl -s {self._server_url}/wild/v2/events/{session.session_id}`
   - Health: `curl -s {self._server_url}/wild/v2/system-health`
   - Resolve: `curl -s -X POST {self._server_url}/wild/v2/events/{session.session_id}/resolve -H 'Content-Type: application/json' -d '{{"event_ids": ["<id>"]}}'`

## Output Format

At the end of your response, output:

```
<summary>One paragraph describing what you accomplished this iteration</summary>
```

If the goal is **fully achieved** and ALL tasks in `{tasks_path}` are `[x]`:
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
        return prompt

    # -- Event collection --

    def _collect_events(self):
        """Collect new events from alerts and run status changes."""
        if not self._session:
            return

        # Collect alerts
        if self._get_alerts:
            try:
                all_alerts = self._get_alerts()
                existing_ids = {e.get("id") for e in self._session.pending_events}
                for alert_id, alert in all_alerts.items():
                    if alert.get("status") == "pending" and alert_id not in existing_ids:
                        self._session.pending_events.append({
                            "id": alert_id,
                            "type": "alert",
                            "title": f"Alert: {alert.get('type', 'unknown')}",
                            "detail": alert.get("message", ""),
                            "run_id": alert.get("run_id"),
                            "created_at": alert.get("created_at", time.time()),
                        })
            except Exception as err:
                logger.debug("[wild-v2] Failed to collect alerts: %s", err)

        # Collect run completions
        if self._get_runs:
            try:
                runs = self._get_runs()
                existing_ids = {e.get("id") for e in self._session.pending_events}
                for rid, run in runs.items():
                    event_id = f"run-{rid}-{run.get('status')}"
                    if run.get("status") in ("finished", "failed") and event_id not in existing_ids:
                        self._session.pending_events.append({
                            "id": event_id,
                            "type": "run_complete",
                            "title": f"Run {run.get('status')}: {run.get('name', rid)}",
                            "detail": f"Status: {run.get('status')}",
                            "run_id": rid,
                            "created_at": time.time(),
                        })
            except Exception as err:
                logger.debug("[wild-v2] Failed to collect run events: %s", err)

    # -- System health --

    def _get_system_health(self) -> dict:
        """Get system utilization stats."""
        health = {
            "running": 0, "queued": 0, "completed": 0,
            "failed": 0, "total": 0, "max_concurrent": 5,
        }
        if self._get_runs:
            try:
                runs = self._get_runs()
                for r in runs.values():
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
            except Exception:
                pass
        return health

    # -- Chat session integration --

    def _append_to_chat(
        self, session: WildV2Session, prompt: str, response: str, iteration: int
    ):
        """Append iteration messages to the chat session so UI shows full history."""
        if not session.chat_session_id or not self._chat_sessions:
            return

        chat = self._chat_sessions.get(session.chat_session_id)
        if not isinstance(chat, dict):
            return

        messages = chat.setdefault("messages", [])

        # Add user message (the prompt, but abbreviated for display)
        messages.append({
            "role": "user",
            "content": f"[Wild V2 — Iteration {iteration}/{session.max_iterations}]\n\n{prompt[:200]}...",
            "timestamp": time.time(),
            "wild_v2_iteration": iteration,
        })

        # Add assistant response
        messages.append({
            "role": "assistant",
            "content": response,
            "timestamp": time.time(),
            "wild_v2_iteration": iteration,
        })

        if self._save_chat_state:
            self._save_chat_state()

    # -- Git commit --

    async def _git_commit(self, session: WildV2Session):
        """Commit tracked changes after an iteration."""
        try:
            # Check if there are changes
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True, text=True, cwd=self._workdir, timeout=10,
            )
            if not result.stdout.strip():
                logger.debug("[wild-v2] No changes to commit")
                return

            # Stage all changes (respecting .gitignore)
            subprocess.run(
                ["git", "add", "-A"],
                capture_output=True, cwd=self._workdir, timeout=10,
            )

            # Commit
            msg = f"wild-v2: iteration {session.iteration} — {session.goal[:50]}"
            subprocess.run(
                ["git", "commit", "-m", msg, "--no-verify"],
                capture_output=True, cwd=self._workdir, timeout=30,
            )
            logger.info("[wild-v2] Git commit: %s", msg)
        except Exception as err:
            logger.warning("[wild-v2] Git commit failed: %s", err)

    # -- File tracking (struggle detection) --

    def _snapshot_files(self) -> dict:
        """Capture git-tracked file hashes for change detection."""
        snapshot = {}
        try:
            result = subprocess.run(
                ["git", "ls-files", "-s"],
                capture_output=True, text=True, cwd=self._workdir, timeout=10,
            )
            for line in result.stdout.strip().split("\n"):
                if line:
                    parts = line.split("\t", 1)
                    if len(parts) == 2:
                        snapshot[parts[1]] = parts[0].split()[1]  # hash
            # Also include unstaged files
            result2 = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True, text=True, cwd=self._workdir, timeout=10,
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
                changed.append(fname)  # deleted
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

    # -- Iteration log --

    def _append_iteration_log(self, session: WildV2Session, record: dict):
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
        except Exception as err:
            logger.debug("[wild-v2] Failed to write iteration log: %s", err)

    # -- File storage helpers --

    def _session_dir(self, session_id: str) -> str:
        return os.path.join(self._workdir, ".agents", "wild", session_id)

    def _save_state(self, session_id: str):
        path = os.path.join(self._session_dir(session_id), "state.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if self._session:
            with open(path, "w") as f:
                json.dump(self._session.to_dict(), f, indent=2)

            # Also save history separately
            history_path = os.path.join(self._session_dir(session_id), "history.json")
            with open(history_path, "w") as f:
                json.dump(self._session.history, f, indent=2)
