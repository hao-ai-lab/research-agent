"""GlobalWatchdogAgent -- server-level monitor for L3 executor processes.

Scans all L3 executor agents for:
  - Dead processes (process died but status still RUNNING)
  - Orphaned L3s (parent L2 is DONE/FAILED, L3 still running)
  - Hanging L3s (no iteration progress + no memory writes for N minutes)
  - GPU leaks (scheduler request RUNNING, no live process)

Registered as an in-process agent via register_local(), shares the server
event loop.  on_monitor() fires every ~15s and performs all scanning.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from agentsys.agent import Agent
from agentsys.types import AgentStatus, EntryType

if TYPE_CHECKING:
    from agentsys.runtime import Runtime

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class WatchdogConfig:
    """Configuration for GlobalWatchdogAgent.

    All durations are in seconds.
    """
    scan_interval_seconds: float = 15.0
    hang_timeout_seconds: float = 7200.0        # 2h — training runs can be long
    memory_stale_threshold_seconds: float = 600.0  # 10min no memory writes = suspicious
    warn_before_kill: bool = True
    warn_to_kill_grace_seconds: float = 300.0    # 5min grace after warning
    orphan_grace_seconds: float = 60.0           # 1min before killing parentless L3
    llm_diagnosis_enabled: bool = True
    alert_dedup_ttl_seconds: float = 300.0       # don't re-alert within 5min
    gpu_leak_check_enabled: bool = True

    @classmethod
    def from_dict(cls, d: dict) -> WatchdogConfig:
        """Build from a plain dict (e.g. agent config), ignoring unknown keys."""
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in d.items() if k in known})


# ---------------------------------------------------------------------------
# Per-agent health tracking
# ---------------------------------------------------------------------------

@dataclass
class AgentHealthSnapshot:
    """Tracks health signals for a single L3 agent across scans."""
    agent_id: str
    first_seen: float = field(default_factory=time.time)
    last_iteration: int = 0
    last_iteration_change: float = field(default_factory=time.time)
    last_memory_write: float = 0.0
    warned_at: float = 0.0          # when hang warning was issued
    orphan_detected_at: float = 0.0  # when orphan state was first seen


# ---------------------------------------------------------------------------
# GlobalWatchdogAgent
# ---------------------------------------------------------------------------

class GlobalWatchdogAgent(Agent):
    """Server-level watchdog that monitors all L3 executor agents.

    Runs in-process (register_local), leaf node (no children).
    Real work happens in on_monitor(); run() just sleeps.
    """

    role = "watchdog"
    allowed_child_roles: frozenset[str] = frozenset()  # leaf node

    def __init__(self) -> None:
        super().__init__()
        self._snapshots: dict[str, AgentHealthSnapshot] = {}
        self._recent_actions: list[dict] = []
        self._recent_alerts: dict[str, float] = {}  # key -> timestamp for dedup
        self._cfg: WatchdogConfig = WatchdogConfig()
        self._scan_count: int = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def on_start(self) -> None:
        self._cfg = WatchdogConfig.from_dict(self.config)
        self.monitor_interval = self._cfg.scan_interval_seconds
        logger.info(
            "[watchdog] Started (id=%s, interval=%.1fs, hang_timeout=%.0fs)",
            self.id, self._cfg.scan_interval_seconds, self._cfg.hang_timeout_seconds,
        )

    async def run(self) -> None:
        """Sleep forever; on_monitor() does the actual work."""
        try:
            while self.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                await self.check_pause()
                await asyncio.sleep(60)
        except asyncio.CancelledError:
            pass

    async def on_monitor(self) -> None:
        """Periodic scan: find all active L3 executors, check health, act."""
        self._scan_count += 1
        runtime: Runtime = self._runtime  # type: ignore[assignment]
        if runtime is None:
            return

        # 1. Collect active L3 executor agents
        active_l3s = [
            a for a in runtime.list_agents()
            if a.role == "executor"
            and a.status in (AgentStatus.RUNNING, AgentStatus.PAUSED)
            and a.id != self.id  # exclude self
        ]

        # 2. Update snapshots
        self._update_snapshots(active_l3s, runtime)

        # 3. Run detection checks
        now = time.time()
        for agent_info in active_l3s:
            snap = self._snapshots.get(agent_info.id)
            if snap is None:
                continue

            # Check dead process
            if self._is_dead_process(agent_info.id, runtime):
                await self._handle_dead_process(agent_info, runtime)
                continue

            # Check orphan
            if self._is_orphan(agent_info, runtime):
                await self._handle_orphan(agent_info, snap, runtime, now)
                continue

            # Check hanging
            hang_status = self._check_hanging(agent_info, snap, now)
            if hang_status in ("hanging", "suspicious"):
                await self._handle_hanging(agent_info, snap, runtime, now, hang_status)

        # 4. GPU leak check
        if self._cfg.gpu_leak_check_enabled:
            await self._check_gpu_leaks(runtime)

        # 5. Prune stale snapshots for agents no longer active
        active_ids = {a.id for a in active_l3s}
        stale_ids = [sid for sid in self._snapshots if sid not in active_ids]
        for sid in stale_ids:
            del self._snapshots[sid]

        # 6. Prune dedup cache
        cutoff = now - self._cfg.alert_dedup_ttl_seconds
        self._recent_alerts = {
            k: v for k, v in self._recent_alerts.items() if v > cutoff
        }

    # ------------------------------------------------------------------
    # Snapshot management
    # ------------------------------------------------------------------

    def _update_snapshots(self, agents: list, runtime: Runtime) -> None:
        """Update per-agent health snapshots with latest data."""
        now = time.time()
        for a in agents:
            snap = self._snapshots.get(a.id)
            if snap is None:
                snap = AgentHealthSnapshot(agent_id=a.id, first_seen=now)
                self._snapshots[a.id] = snap

            # Track iteration progress
            current_iter = a.iteration
            if current_iter != snap.last_iteration:
                snap.last_iteration = current_iter
                snap.last_iteration_change = now

            # Track latest memory write
            latest = runtime.store.latest(agent_id=a.id)
            if latest is not None:
                snap.last_memory_write = max(snap.last_memory_write, latest.created_at)

    # ------------------------------------------------------------------
    # Detection: dead process
    # ------------------------------------------------------------------

    def _is_dead_process(self, agent_id: str, runtime: Runtime) -> bool:
        """Check if the agent's subprocess has died."""
        proc = runtime._processes.get(agent_id)
        if proc is None:
            return False  # in-process agent or no process tracked
        return not proc.is_alive()

    async def _handle_dead_process(
        self, agent_info: Any, runtime: Runtime,
    ) -> None:
        """Clean up a dead-but-still-RUNNING process."""
        agent_id = agent_info.id
        dedup_key = f"dead:{agent_id}"
        if not self._should_alert(dedup_key):
            return

        logger.warning("[watchdog] Dead process detected: %s", agent_id)

        # Mark FAILED in runtime metadata
        meta = runtime._agent_meta.get(agent_id)
        if meta is not None:
            meta["status"] = AgentStatus.FAILED.value
            runtime._agent_meta[agent_id] = meta
            runtime.store.write_meta(agent_id, meta)

        # Release GPU via scheduler
        scheduler = getattr(runtime, '_scheduler', None)
        if scheduler:
            scheduler.on_agent_done(agent_id, failed=True)

        # Write ALERT
        self._write_alert(
            event="dead_process",
            agent_id=agent_id,
            severity="critical",
            details={
                "goal": agent_info.goal,
                "last_iteration": agent_info.iteration,
            },
        )

        # Notify parent
        parent_id = agent_info.parent_id
        if parent_id:
            self._write_message(
                target_id=parent_id,
                directive="child_dead",
                child_id=agent_id,
                reason="Process died unexpectedly",
            )

        self._record_action("killed_dead_process", agent_id)

    # ------------------------------------------------------------------
    # Detection: orphan
    # ------------------------------------------------------------------

    def _is_orphan(self, agent_info: Any, runtime: Runtime) -> bool:
        """Check if the agent's parent has terminated."""
        parent_id = agent_info.parent_id
        if parent_id is None:
            return False  # root agents aren't orphans

        parent = runtime.get_agent(parent_id)
        if parent is None:
            return True  # parent removed from registry
        return parent.status in (AgentStatus.DONE, AgentStatus.FAILED)

    async def _handle_orphan(
        self, agent_info: Any, snap: AgentHealthSnapshot,
        runtime: Runtime, now: float,
    ) -> None:
        """Handle an orphaned L3 agent (parent dead)."""
        agent_id = agent_info.id

        # Start grace timer on first detection
        if snap.orphan_detected_at == 0.0:
            snap.orphan_detected_at = now
            dedup_key = f"orphan_warn:{agent_id}"
            if self._should_alert(dedup_key):
                self._write_alert(
                    event="orphan_detected",
                    agent_id=agent_id,
                    severity="warning",
                    details={
                        "parent_id": agent_info.parent_id,
                        "goal": agent_info.goal,
                        "grace_seconds": self._cfg.orphan_grace_seconds,
                    },
                )
            return

        # Check if grace period expired
        elapsed = now - snap.orphan_detected_at
        if elapsed < self._cfg.orphan_grace_seconds:
            return

        dedup_key = f"orphan_kill:{agent_id}"
        if not self._should_alert(dedup_key):
            return

        logger.warning(
            "[watchdog] Killing orphan %s (parent %s dead, grace expired)",
            agent_id, agent_info.parent_id,
        )

        self._write_alert(
            event="orphan_killed",
            agent_id=agent_id,
            severity="critical",
            details={
                "parent_id": agent_info.parent_id,
                "goal": agent_info.goal,
                "orphan_duration_seconds": elapsed,
            },
        )

        await runtime.stop(agent_id)
        self._record_action("killed_orphan", agent_id)

    # ------------------------------------------------------------------
    # Detection: hanging
    # ------------------------------------------------------------------

    def _check_hanging(
        self, agent_info: Any, snap: AgentHealthSnapshot, now: float,
    ) -> str:
        """Classify agent hang status.

        Returns:
            "healthy"    — iteration progressing or memory active
            "suspicious" — memory stale but iteration stale for less than hang_timeout
            "hanging"    — both iteration and memory stale beyond thresholds
        """
        iter_stale_duration = now - snap.last_iteration_change
        mem_stale_duration = (
            now - snap.last_memory_write if snap.last_memory_write > 0
            else now - snap.first_seen
        )

        # If iteration is progressing, healthy
        if iter_stale_duration < self._cfg.memory_stale_threshold_seconds:
            return "healthy"

        # If memory is still being written, healthy
        if mem_stale_duration < self._cfg.memory_stale_threshold_seconds:
            return "healthy"

        # Both stale — check hang_timeout
        if iter_stale_duration >= self._cfg.hang_timeout_seconds:
            return "hanging"

        return "suspicious"

    async def _handle_hanging(
        self, agent_info: Any, snap: AgentHealthSnapshot,
        runtime: Runtime, now: float, hang_status: str,
    ) -> None:
        """Handle a hanging or suspicious agent: warn → grace → kill."""
        agent_id = agent_info.id

        if hang_status == "suspicious" and snap.warned_at == 0.0:
            # First time suspicious — issue warning
            dedup_key = f"hang_warn:{agent_id}"
            if self._should_alert(dedup_key):
                snap.warned_at = now
                self._write_alert(
                    event="hang_warning",
                    agent_id=agent_id,
                    severity="warning",
                    details={
                        "goal": agent_info.goal,
                        "iteration": agent_info.iteration,
                        "stale_since_iteration": snap.last_iteration_change,
                        "stale_since_memory": snap.last_memory_write,
                        "grace_seconds": self._cfg.warn_to_kill_grace_seconds,
                    },
                )
            return

        if hang_status == "suspicious" and snap.warned_at > 0.0:
            # Check if grace period expired
            grace_elapsed = now - snap.warned_at
            if grace_elapsed < self._cfg.warn_to_kill_grace_seconds:
                return
            # Grace expired — escalate to kill
            hang_status = "hanging"

        if hang_status == "hanging":
            dedup_key = f"hang_kill:{agent_id}"
            if not self._should_alert(dedup_key):
                return

            # Optionally query LLM for ambiguous cases
            if self._cfg.llm_diagnosis_enabled and snap.last_memory_write > 0:
                diagnosis = await self._llm_diagnose(agent_id, runtime)
                if diagnosis == "working":
                    # LLM says it's fine — reset warning, don't kill
                    snap.warned_at = 0.0
                    logger.info("[watchdog] LLM says %s is working, skipping kill", agent_id)
                    return

            logger.warning(
                "[watchdog] Killing hanging agent %s (iter stale %.0fs, mem stale %.0fs)",
                agent_id,
                now - snap.last_iteration_change,
                now - snap.last_memory_write if snap.last_memory_write > 0 else now - snap.first_seen,
            )

            self._write_alert(
                event="hang_killed",
                agent_id=agent_id,
                severity="critical",
                details={
                    "goal": agent_info.goal,
                    "iteration": agent_info.iteration,
                    "iter_stale_seconds": now - snap.last_iteration_change,
                    "mem_stale_seconds": (
                        now - snap.last_memory_write if snap.last_memory_write > 0
                        else now - snap.first_seen
                    ),
                },
            )

            # Notify parent before killing
            if agent_info.parent_id:
                self._write_message(
                    target_id=agent_info.parent_id,
                    directive="child_killed",
                    child_id=agent_id,
                    reason="Exceeded hang timeout",
                )

            await runtime.stop(agent_id)
            self._record_action("killed_hanging", agent_id)

    # ------------------------------------------------------------------
    # Detection: GPU leaks
    # ------------------------------------------------------------------

    async def _check_gpu_leaks(self, runtime: Runtime) -> None:
        """Find scheduler requests marked RUNNING with no live process."""
        scheduler = getattr(runtime, '_scheduler', None)
        if scheduler is None:
            return

        from agentsys.scheduler import RequestStatus

        running_requests = scheduler.list_requests(status=RequestStatus.RUNNING)
        for req in running_requests:
            if req.agent_id is None:
                continue

            # Check if process is alive
            proc = runtime._processes.get(req.agent_id)
            if proc is not None and proc.is_alive():
                continue

            # Also check if it's a local agent still running
            local = runtime._local_agents.get(req.agent_id)
            if local is not None and local.status in (AgentStatus.RUNNING, AgentStatus.PAUSED):
                continue

            dedup_key = f"gpu_leak:{req.request_id}"
            if not self._should_alert(dedup_key):
                continue

            logger.warning(
                "[watchdog] GPU leak: request %s (agent %s) RUNNING but no live process",
                req.request_id, req.agent_id,
            )

            # Release the GPU allocation
            scheduler.on_agent_done(req.agent_id, failed=True)

            self._write_alert(
                event="gpu_leak_released",
                agent_id=req.agent_id,
                severity="warning",
                details={
                    "request_id": req.request_id,
                    "gpu_required": req.gpu_required,
                    "goal": req.goal,
                },
            )
            self._record_action("released_gpu_leak", req.agent_id)

    # ------------------------------------------------------------------
    # LLM diagnosis (optional)
    # ------------------------------------------------------------------

    async def _llm_diagnose(self, agent_id: str, runtime: Runtime) -> str:
        """Query LLM to classify whether an agent is stuck or working.

        Returns: "stuck", "working", or "unknown".
        Falls back gracefully on any error.
        """
        try:
            import httpx
            from core.config import (
                OPENCODE_URL, OPENCODE_USERNAME, OPENCODE_PASSWORD, MODEL_ID,
            )

            if not OPENCODE_URL:
                return "unknown"

            # Gather recent memory entries for context
            entries = runtime.store.query(
                agent_id=agent_id, limit=10, order="desc",
            )
            if not entries:
                return "unknown"

            context_lines = []
            for e in reversed(entries):
                tag_str = f" [{', '.join(e.tags)}]" if e.tags else ""
                context_lines.append(
                    f"[{e.type.value}]{tag_str} t={e.created_at:.0f}: {e.data}"
                )
            context = "\n".join(context_lines)

            prompt = (
                f"Agent {agent_id} appears stalled (no iteration progress, no recent memory writes). "
                f"Here are its last {len(entries)} memory entries:\n\n{context}\n\n"
                "Based on these entries, is this agent:\n"
                '1. "stuck" (deadlocked, crashed, actually hanging)\n'
                '2. "working" (legitimately slow, e.g. long training epoch)\n'
                '3. "unknown" (cannot determine)\n\n'
                "Respond with only one word: stuck, working, or unknown."
            )

            auth = None
            if OPENCODE_USERNAME and OPENCODE_PASSWORD:
                auth = (OPENCODE_USERNAME, OPENCODE_PASSWORD)

            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{OPENCODE_URL}/chat/completions",
                    json={
                        "model": MODEL_ID,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.2,
                        "max_tokens": 10,
                    },
                    auth=auth,
                    timeout=10.0,
                )
                resp.raise_for_status()
                text = resp.json()["choices"][0]["message"]["content"].strip().lower()
                if text in ("stuck", "working", "unknown"):
                    return text
                return "unknown"

        except Exception as e:
            logger.debug("[watchdog] LLM diagnosis failed: %s", e)
            return "unknown"

    # ------------------------------------------------------------------
    # Alert / message helpers
    # ------------------------------------------------------------------

    def _should_alert(self, dedup_key: str) -> bool:
        """Check dedup cache. Returns True if we should emit this alert."""
        now = time.time()
        last = self._recent_alerts.get(dedup_key, 0.0)
        if now - last < self._cfg.alert_dedup_ttl_seconds:
            return False
        self._recent_alerts[dedup_key] = now
        return True

    def _write_alert(
        self,
        event: str,
        agent_id: str,
        severity: str,
        details: dict,
    ) -> None:
        """Write an ALERT entry to the store."""
        if self.memory is None:
            return
        self.memory.write(
            {
                "event": event,
                "agent_id": agent_id,
                "severity": severity,
                **details,
                "timestamp": time.time(),
            },
            type=EntryType.ALERT,
            tags=["watchdog", event, severity],
        )

    def _write_message(
        self,
        target_id: str,
        directive: str,
        child_id: str,
        reason: str,
    ) -> None:
        """Write a MESSAGE entry directed at another agent."""
        if self.memory is None:
            return
        self.memory.write(
            {
                "directive": directive,
                "child_id": child_id,
                "reason": reason,
                "timestamp": time.time(),
            },
            type=EntryType.MESSAGE,
            target_id=target_id,
            tags=["watchdog", "critical"],
        )

    def _record_action(self, action: str, agent_id: str) -> None:
        """Record an action in the audit log (in-memory, bounded)."""
        self._recent_actions.append({
            "action": action,
            "agent_id": agent_id,
            "timestamp": time.time(),
        })
        # Keep bounded
        if len(self._recent_actions) > 200:
            self._recent_actions = self._recent_actions[-100:]

    # ------------------------------------------------------------------
    # API: introspection (called by routes)
    # ------------------------------------------------------------------

    def get_health_summary(self) -> dict:
        """Return health status of all monitored L3 agents."""
        now = time.time()
        agents = []
        for snap in self._snapshots.values():
            agents.append({
                "agent_id": snap.agent_id,
                "first_seen": snap.first_seen,
                "last_iteration": snap.last_iteration,
                "iter_stale_seconds": now - snap.last_iteration_change,
                "last_memory_write": snap.last_memory_write,
                "mem_stale_seconds": (
                    now - snap.last_memory_write if snap.last_memory_write > 0
                    else now - snap.first_seen
                ),
                "warned_at": snap.warned_at if snap.warned_at > 0 else None,
                "orphan_detected_at": (
                    snap.orphan_detected_at if snap.orphan_detected_at > 0 else None
                ),
            })
        return {
            "monitored_count": len(agents),
            "scan_count": self._scan_count,
            "agents": agents,
        }

    def get_recent_actions(self, limit: int = 50) -> dict:
        """Return recent actions taken by the watchdog."""
        return {
            "actions": self._recent_actions[-limit:],
            "total": len(self._recent_actions),
        }

    def get_status(self) -> dict:
        """Return watchdog's own operational status."""
        return {
            "id": self.id,
            "status": self.status.value,
            "scan_count": self._scan_count,
            "monitored_agents": len(self._snapshots),
            "config": {
                "scan_interval_seconds": self._cfg.scan_interval_seconds,
                "hang_timeout_seconds": self._cfg.hang_timeout_seconds,
                "memory_stale_threshold_seconds": self._cfg.memory_stale_threshold_seconds,
                "warn_to_kill_grace_seconds": self._cfg.warn_to_kill_grace_seconds,
                "orphan_grace_seconds": self._cfg.orphan_grace_seconds,
                "llm_diagnosis_enabled": self._cfg.llm_diagnosis_enabled,
                "gpu_leak_check_enabled": self._cfg.gpu_leak_check_enabled,
            },
        }

    def update_config(self, updates: dict) -> dict:
        """Hot-update configuration thresholds. Returns new config."""
        known = {f.name for f in WatchdogConfig.__dataclass_fields__.values()}
        applied = {}
        for k, v in updates.items():
            if k in known:
                setattr(self._cfg, k, v)
                applied[k] = v
        # Update monitor_interval if scan_interval changed
        if "scan_interval_seconds" in applied:
            self.monitor_interval = self._cfg.scan_interval_seconds
        return self.get_status()
