"""Scheduler -- GPU-aware FIFO queue for executor agent spawns.

Sits between spawn requests and actual process creation, providing:
- A FIFO queue with file-based persistence
- Simple GPU gating (reject if required > total, queue if required > available)
- Clean abstraction for future scheduling algorithms
- Lifecycle cleanup when parent agents die

Only L3 (executor) spawns go through the scheduler. L1->L2 spawning
bypasses it entirely.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from agentsys.ipc import cls_to_path, path_to_cls

if TYPE_CHECKING:
    from agentsys.runtime import Runtime

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class RequestStatus(str, Enum):
    """Lifecycle states for a schedule request."""
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    REJECTED = "rejected"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class ScheduleRequest:
    """A single spawn request managed by the scheduler."""
    request_id: str
    agent_cls_path: str
    goal: str
    parent_id: str | None
    config: dict | None
    gpu_required: int = 0
    created_at: float = field(default_factory=time.time)
    status: RequestStatus = RequestStatus.QUEUED
    agent_id: str | None = None  # set when actually spawned
    rejection_reason: str | None = None

    def to_dict(self) -> dict:
        """Serialize to JSON-safe dict."""
        return {
            "request_id": self.request_id,
            "agent_cls_path": self.agent_cls_path,
            "goal": self.goal,
            "parent_id": self.parent_id,
            "config": self.config,
            "gpu_required": self.gpu_required,
            "created_at": self.created_at,
            "status": self.status.value,
            "agent_id": self.agent_id,
            "rejection_reason": self.rejection_reason,
        }

    @classmethod
    def from_dict(cls, d: dict) -> ScheduleRequest:
        """Reconstruct from a dict (as stored on disk)."""
        return cls(
            request_id=d["request_id"],
            agent_cls_path=d["agent_cls_path"],
            goal=d["goal"],
            parent_id=d.get("parent_id"),
            config=d.get("config"),
            gpu_required=d.get("gpu_required", 0),
            created_at=d.get("created_at", 0.0),
            status=RequestStatus(d.get("status", "queued")),
            agent_id=d.get("agent_id"),
            rejection_reason=d.get("rejection_reason"),
        )


@dataclass
class ScheduleTicket:
    """Lightweight handle returned to callers after submit().

    Callers use the request_id to query status from the scheduler.
    """
    request_id: str


# ---------------------------------------------------------------------------
# GPU tracking
# ---------------------------------------------------------------------------

def detect_total_gpus() -> int:
    """Detect number of GPUs via nvidia-smi. Returns 0 on failure."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--list-gpus"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
            return len(lines)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return 0


class GPUTracker:
    """Tracks GPU allocation across running requests."""

    def __init__(self, total_gpus: int) -> None:
        self.total_gpus = total_gpus
        self._allocated: dict[str, int] = {}  # request_id -> gpu count

    @property
    def allocated(self) -> int:
        return sum(self._allocated.values())

    @property
    def available(self) -> int:
        return self.total_gpus - self.allocated

    def can_allocate(self, n: int) -> bool:
        return n <= self.available

    def allocate(self, request_id: str, n: int) -> None:
        self._allocated[request_id] = n

    def release(self, request_id: str) -> None:
        self._allocated.pop(request_id, None)


# ---------------------------------------------------------------------------
# Scheduling policy abstraction
# ---------------------------------------------------------------------------

class SchedulingPolicy(ABC):
    """Abstract base for scheduling policies."""

    @abstractmethod
    def select_next(
        self,
        queue: list[ScheduleRequest],
        running: list[ScheduleRequest],
        gpu_tracker: GPUTracker,
    ) -> str | None:
        """Return the request_id of the next request to spawn, or None."""
        ...


class FIFOPolicy(SchedulingPolicy):
    """Simple FIFO: return first queued request that passes GPU check."""

    def select_next(
        self,
        queue: list[ScheduleRequest],
        running: list[ScheduleRequest],
        gpu_tracker: GPUTracker,
    ) -> str | None:
        for req in queue:
            if req.gpu_required == 0 or gpu_tracker.can_allocate(req.gpu_required):
                return req.request_id
        return None


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

class Scheduler:
    """GPU-aware FIFO scheduler for executor agent spawns.

    Singleton per server process. Manages a persistent queue of spawn
    requests, gating on GPU availability before delegating to Runtime.spawn().
    """

    def __init__(
        self,
        runtime: Runtime,
        store_dir: Path,
        policy: SchedulingPolicy | None = None,
    ) -> None:
        self._runtime = runtime
        self._store_dir = Path(store_dir)
        self._policy = policy or FIFOPolicy()
        self._gpu = GPUTracker(detect_total_gpus())
        self._requests: dict[str, ScheduleRequest] = {}  # in-memory mirror
        self._tick_task: asyncio.Task | None = None
        self._shutdown_event = asyncio.Event()

        # Ensure store directory exists
        self._store_dir.mkdir(parents=True, exist_ok=True)

        # Restore state from disk
        self._load_from_disk()

        logger.info(
            "[scheduler] Initialized: store=%s, gpus=%d, restored=%d requests",
            self._store_dir, self._gpu.total_gpus, len(self._requests),
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def submit(
        self,
        cls: type,
        goal: str,
        parent_id: str | None,
        config: dict | None,
        gpu_required: int = 0,
    ) -> ScheduleTicket:
        """Submit a spawn request to the queue.

        Returns a ScheduleTicket immediately. The request will be
        spawned when resources are available.

        If gpu_required > total_gpus, the request is immediately rejected.
        """
        request_id = f"sched-{uuid.uuid4().hex[:8]}"
        agent_cls_path = cls_to_path(cls)

        req = ScheduleRequest(
            request_id=request_id,
            agent_cls_path=agent_cls_path,
            goal=goal,
            parent_id=parent_id,
            config=config,
            gpu_required=gpu_required,
        )

        # Reject immediately if impossible to ever satisfy
        if gpu_required > self._gpu.total_gpus and self._gpu.total_gpus > 0:
            req.status = RequestStatus.REJECTED
            req.rejection_reason = (
                f"Requires {gpu_required} GPUs but only {self._gpu.total_gpus} available"
            )
            logger.warning("[scheduler] Rejected %s: %s", request_id, req.rejection_reason)

        self._requests[request_id] = req
        self._persist(req)

        logger.info(
            "[scheduler] Submitted %s (cls=%s, gpu=%d, status=%s)",
            request_id, cls.__name__, gpu_required, req.status.value,
        )
        return ScheduleTicket(request_id=request_id)

    def cancel(self, request_id: str) -> bool:
        """Cancel a queued request. Returns True if cancelled."""
        req = self._requests.get(request_id)
        if req is None:
            return False
        if req.status != RequestStatus.QUEUED:
            return False
        req.status = RequestStatus.FAILED
        req.rejection_reason = "Cancelled"
        self._persist(req)
        logger.info("[scheduler] Cancelled %s", request_id)
        return True

    def cleanup_parent(self, parent_id: str) -> int:
        """Cancel all queued requests for a dead parent. Returns count."""
        count = 0
        for req in list(self._requests.values()):
            if req.parent_id == parent_id and req.status == RequestStatus.QUEUED:
                req.status = RequestStatus.FAILED
                req.rejection_reason = "Parent agent stopped"
                self._persist(req)
                count += 1
        if count:
            logger.info("[scheduler] Cleaned up %d requests for parent %s", count, parent_id)
        return count

    def get_request(self, request_id: str) -> ScheduleRequest | None:
        """Get a request by ID."""
        return self._requests.get(request_id)

    def list_requests(
        self,
        parent_id: str | None = None,
        status: RequestStatus | None = None,
    ) -> list[ScheduleRequest]:
        """List requests, optionally filtered by parent_id and/or status."""
        result = []
        for req in self._requests.values():
            if parent_id is not None and req.parent_id != parent_id:
                continue
            if status is not None and req.status != status:
                continue
            result.append(req)
        # Sort by created_at for consistent ordering
        result.sort(key=lambda r: r.created_at)
        return result

    def stats(self) -> dict:
        """GPU availability and queue summary."""
        status_counts: dict[str, int] = {}
        for req in self._requests.values():
            status_counts[req.status.value] = status_counts.get(req.status.value, 0) + 1
        return {
            "gpu_total": self._gpu.total_gpus,
            "gpu_allocated": self._gpu.allocated,
            "gpu_available": self._gpu.available,
            "queue_size": status_counts.get("queued", 0),
            "running": status_counts.get("running", 0),
            "total_requests": len(self._requests),
            "by_status": status_counts,
        }

    # ------------------------------------------------------------------
    # Agent completion callback
    # ------------------------------------------------------------------

    def on_agent_done(self, agent_id: str, failed: bool = False) -> None:
        """Called when a spawned agent finishes. Releases GPU, updates status."""
        for req in self._requests.values():
            if req.agent_id == agent_id and req.status == RequestStatus.RUNNING:
                req.status = RequestStatus.FAILED if failed else RequestStatus.DONE
                self._gpu.release(req.request_id)
                self._persist(req)
                logger.info(
                    "[scheduler] Agent %s finished (request=%s, status=%s)",
                    agent_id, req.request_id, req.status.value,
                )
                break

    # ------------------------------------------------------------------
    # Tick loop
    # ------------------------------------------------------------------

    async def _tick(self) -> None:
        """Single scheduler tick: ask policy for next request, spawn if possible."""
        queued = [r for r in self._requests.values() if r.status == RequestStatus.QUEUED]
        if not queued:
            return

        # Sort by created_at for FIFO ordering
        queued.sort(key=lambda r: r.created_at)
        running = [r for r in self._requests.values() if r.status == RequestStatus.RUNNING]

        next_id = self._policy.select_next(queued, running, self._gpu)
        if next_id is None:
            return

        req = self._requests.get(next_id)
        if req is None:
            return

        # Spawn the agent via Runtime
        try:
            child_cls = path_to_cls(req.agent_cls_path)
            child_info = await self._runtime.spawn(
                child_cls,
                goal=req.goal,
                parent_id=req.parent_id,
                config=req.config,
            )
            req.status = RequestStatus.RUNNING
            req.agent_id = child_info.id
            if req.gpu_required > 0:
                self._gpu.allocate(req.request_id, req.gpu_required)
            self._persist(req)
            logger.info(
                "[scheduler] Spawned %s -> agent %s (gpu=%d)",
                req.request_id, child_info.id, req.gpu_required,
            )
        except Exception as e:
            req.status = RequestStatus.FAILED
            req.rejection_reason = f"Spawn failed: {e}"
            self._persist(req)
            logger.exception("[scheduler] Spawn failed for %s: %s", req.request_id, e)

    async def _tick_loop(self) -> None:
        """Periodic tick loop (~1s interval)."""
        try:
            while not self._shutdown_event.is_set():
                try:
                    await self._tick()
                except Exception as e:
                    logger.exception("[scheduler] Tick error: %s", e)
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _persist(self, req: ScheduleRequest) -> None:
        """Atomic write of a single request to disk."""
        path = self._store_dir / f"{req.request_id}.json"
        tmp_path = path.with_suffix(".tmp")
        try:
            with open(tmp_path, "w") as f:
                json.dump(req.to_dict(), f, indent=2)
            os.replace(str(tmp_path), str(path))
        except OSError as e:
            logger.error("[scheduler] Failed to persist %s: %s", req.request_id, e)

    def _load_from_disk(self) -> None:
        """Restore all requests from disk at startup."""
        if not self._store_dir.exists():
            return
        for path in self._store_dir.glob("*.json"):
            try:
                with open(path) as f:
                    data = json.load(f)
                req = ScheduleRequest.from_dict(data)
                self._requests[req.request_id] = req

                # Rebuild GPU allocations for running requests
                if req.status == RequestStatus.RUNNING and req.gpu_required > 0:
                    self._gpu.allocate(req.request_id, req.gpu_required)

                # Requests that were RUNNING when we crashed are now orphaned
                # Mark them as failed since the process is gone
                if req.status == RequestStatus.RUNNING:
                    req.status = RequestStatus.FAILED
                    req.rejection_reason = "Scheduler restarted while running"
                    self._gpu.release(req.request_id)
                    self._persist(req)

            except (json.JSONDecodeError, KeyError, ValueError) as e:
                logger.warning("[scheduler] Skipping corrupt file %s: %s", path, e)

    # ------------------------------------------------------------------
    # Start / Shutdown
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the scheduler tick loop. Must be called from async context."""
        if self._tick_task is not None and not self._tick_task.done():
            return
        self._shutdown_event.clear()
        self._tick_task = asyncio.create_task(
            self._tick_loop(), name="scheduler-tick"
        )
        logger.info("[scheduler] Started tick loop")

    async def shutdown(self) -> None:
        """Stop the tick loop and persist final state."""
        self._shutdown_event.set()
        if self._tick_task and not self._tick_task.done():
            self._tick_task.cancel()
            try:
                await self._tick_task
            except asyncio.CancelledError:
                pass
        self._tick_task = None
        logger.info("[scheduler] Shutdown complete")
