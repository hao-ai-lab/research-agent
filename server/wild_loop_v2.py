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
        if self._session and self._session.status == "running":
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

        # Save initial plan
        self._save_plan(sid, f"# Plan\n\nGoal: {goal}\n\n*(Plan will be updated by the agent after iteration 1)*\n")

        # Save initial state
        self._save_state(sid)

        # Start the async loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                self._task = loop.create_task(self._run_loop())
        except RuntimeError:
            logger.error("[wild-v2] No running event loop, cannot start")

        logger.info("[wild-v2] Started session %s: goal=%s max_iter=%d", sid, goal, max_iterations)
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
        """Return current plan markdown."""
        if not self._session:
            return ""
        return self._session.plan

    # -- Main loop --

    async def _run_loop(self):
        """The ralph-style main loop running as an async background task."""
        session = self._session
        if not session:
            return

        try:
            while (
                session.status == "running"
                and session.iteration < session.max_iterations
            ):
                iter_start = time.time()
                session.iteration += 1
                logger.info(
                    "[wild-v2] === Iteration %d/%d ===",
                    session.iteration, session.max_iterations,
                )

                # Collect events from alerts/runs
                self._collect_events()

                # 1. Create a new OpenCode session for this iteration
                oc_session_id = await self._create_opencode_session()
                if not oc_session_id:
                    logger.error("[wild-v2] Failed to create OpenCode session, stopping")
                    session.status = "failed"
                    break
                session.opencode_sessions.append(oc_session_id)

                # 2. Build the prompt
                prompt = self._build_prompt(session)

                # 3. Send to OpenCode and stream response
                full_text = await self._run_opencode(oc_session_id, prompt)

                # 4. Parse response
                promise = parse_promise(full_text)
                new_plan = parse_plan(full_text)
                summary = parse_summary(full_text) or full_text[:300]

                # 5. Update plan
                if new_plan:
                    session.plan = new_plan
                    self._save_plan(session.session_id, new_plan)

                # 6. Record iteration in history
                iter_record = {
                    "iteration": session.iteration,
                    "summary": summary,
                    "started_at": iter_start,
                    "finished_at": time.time(),
                    "opencode_session_id": oc_session_id,
                    "promise": promise,
                }
                session.history.append(iter_record)

                # 7. Append to chat session messages (UI sees full conversation)
                self._append_to_chat(session, prompt, full_text, session.iteration)

                # 8. Git commit
                await self._git_commit(session)

                # 9. Save state
                self._save_state(session.session_id)

                # 10. Check promise
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
        events_summary = ""
        if session.pending_events:
            events_summary = "\n".join(
                f"- [{e.get('type', 'event')}] {e.get('title', 'Untitled')}: {e.get('detail', '')}"
                for e in session.pending_events
            )
        else:
            events_summary = "No pending events."

        history_summary = ""
        if session.history:
            for h in session.history[-5:]:  # Last 5 iterations
                history_summary += (
                    f"- Iteration {h['iteration']}: {h.get('summary', 'N/A')[:200]}\n"
                )
        else:
            history_summary = "This is the first iteration."

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

        plan_section = session.plan if session.plan else "No plan yet. Create one as your first action."

        prompt = f"""You are an autonomous research engineer running in a loop. This is **iteration {session.iteration} of {session.max_iterations}**.

## 🎯 Goal

{session.goal}

## 📋 Current Plan

{plan_section}
{steer_section}
## 📊 System Health

{health_summary}

## 🔔 Pending Events

{events_summary}

## 📜 Recent History

{history_summary}

---

## Instructions

You are running autonomously in a ralph-style loop. Each iteration, you get a fresh session but the codebase reflects your previous work (check git log).

### Iteration Protocol

1. **Check events first**: Review all pending events above. If there are alerts or failures, diagnose and fix them before continuing the plan.
2. **Execute plan**: Continue working on the current plan step. Make meaningful progress.
3. **Update plan**: At the end of your work, output an updated plan reflecting what was done and what's next.
4. **Check events API**: To get real-time event updates, you can use the bash tool to call:
   ```bash
   curl -s {self._server_url}/wild/v2/events/{session.session_id}
   ```
5. **Check system health**: To monitor system utilization:
   ```bash
   curl -s {self._server_url}/wild/v2/system-health
   ```
6. **Resolve events**: After handling an event, mark it resolved:
   ```bash
   curl -s -X POST {self._server_url}/wild/v2/events/{session.session_id}/resolve -H 'Content-Type: application/json' -d '{{"event_ids": ["<event_id>"]}}'
   ```

### When Waiting for Runs

If you've launched experiments/runs and need to wait for results:
- Check system health to see if runs are still in progress
- If nothing to do while waiting, output `<promise>WAITING</promise>` — the loop will sleep and retry
- Do NOT block yourself. If there's other useful work (refining plan, writing docs, exploring alternatives), do that instead.

### Output Format

At the end of your response, output these tags:

```
<summary>One paragraph describing what you accomplished this iteration</summary>

<plan>
# Updated Plan
## Completed
- [x] What was done

## In Progress
- [ ] Current work

## Upcoming
- [ ] Future work
</plan>
```

If the goal is **fully achieved** and all tests pass:
```
<promise>DONE</promise>
```

If you need to **wait for runs/experiments** to complete and have nothing else to do:
```
<promise>WAITING</promise>
```

### Git Commit Rules

Your changes will be auto-committed after each iteration. Focus on making meaningful changes.
Do NOT commit: build outputs, data files, __pycache__, .env files, node_modules, or large binary files.

### Important

- You have full autonomy. Do NOT ask clarifying questions — make reasonable assumptions.
- Check git log to understand what previous iterations accomplished.
- Each iteration should make concrete, measurable progress.
- If you encounter errors, fix them. If you need to change the plan, update it.
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

    # -- File storage helpers --

    def _session_dir(self, session_id: str) -> str:
        return os.path.join(self._workdir, ".agents", "wild", session_id)

    def _save_plan(self, session_id: str, plan: str):
        path = os.path.join(self._session_dir(session_id), "plan.md")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(plan)
        if self._session:
            self._session.plan = plan

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
