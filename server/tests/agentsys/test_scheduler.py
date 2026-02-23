"""Tests for Scheduler -- GPU-aware FIFO queue for executor spawns."""

import asyncio
import json
import os

import pytest

from agentsys.agent import Agent, ChildHandle, ScheduledChildHandle
from agentsys.runtime import Runtime
from agentsys.scheduler import (
    FIFOPolicy,
    GPUTracker,
    RequestStatus,
    ScheduleRequest,
    Scheduler,
)
from agentsys.types import AgentStatus


# ---------------------------------------------------------------------------
# Test agent subclasses
# ---------------------------------------------------------------------------

class QuickExecutor(Agent):
    """Fast executor for testing."""
    role = "executor"

    async def run(self):
        await asyncio.sleep(0.1)


class SlowExecutor(Agent):
    """Long-running executor for lifecycle tests."""
    role = "executor"

    async def run(self):
        while True:
            await self.check_pause()
            await asyncio.sleep(0.1)


class FailingExecutor(Agent):
    """Executor that raises."""
    role = "executor"

    async def run(self):
        raise ValueError("boom")


class OrchestratorAgent(Agent):
    """Orchestrator that spawns executors."""
    role = "orchestrator"
    allowed_child_roles = frozenset({"executor"})

    async def run(self):
        while True:
            await self.check_pause()
            await asyncio.sleep(0.1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _wait_for_request_status(scheduler, request_id, statuses, timeout=10):
    """Poll until request reaches one of the expected statuses."""
    for _ in range(int(timeout / 0.1)):
        req = scheduler.get_request(request_id)
        if req and req.status in statuses:
            return req
        await asyncio.sleep(0.1)
    return scheduler.get_request(request_id)


async def _wait_for_status(runtime, agent_id, statuses, timeout=10):
    """Poll until agent reaches one of the expected statuses."""
    for _ in range(int(timeout / 0.1)):
        info = runtime.get_agent(agent_id)
        if info and info.status in statuses:
            return info
        meta = runtime.store.read_agent_info(agent_id)
        if meta and meta.status in statuses:
            return meta
        await asyncio.sleep(0.1)
    return runtime.get_agent(agent_id)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def runtime(tmp_path):
    rt = Runtime(project="test-sched", store_root=str(tmp_path / "store"))
    yield rt
    await rt.shutdown()


@pytest.fixture
async def scheduler(runtime, tmp_path):
    from pathlib import Path
    sched_dir = tmp_path / "store" / "_scheduler"
    sched = Scheduler(runtime, sched_dir)
    runtime._scheduler = sched
    sched.start()
    yield sched
    await sched.shutdown()


# ---------------------------------------------------------------------------
# GPUTracker tests
# ---------------------------------------------------------------------------

class TestGPUTracker:

    def test_initial_state(self):
        gpu = GPUTracker(4)
        assert gpu.total_gpus == 4
        assert gpu.available == 4
        assert gpu.allocated == 0

    def test_allocate_and_release(self):
        gpu = GPUTracker(4)
        assert gpu.can_allocate(2) is True
        gpu.allocate("req-1", 2)
        assert gpu.available == 2
        assert gpu.allocated == 2

        assert gpu.can_allocate(3) is False
        assert gpu.can_allocate(2) is True

        gpu.allocate("req-2", 2)
        assert gpu.available == 0
        assert gpu.can_allocate(1) is False

        gpu.release("req-1")
        assert gpu.available == 2
        assert gpu.can_allocate(2) is True

    def test_release_nonexistent(self):
        gpu = GPUTracker(2)
        gpu.release("nonexistent")  # should not raise
        assert gpu.available == 2

    def test_zero_gpus(self):
        gpu = GPUTracker(0)
        assert gpu.can_allocate(0) is True
        assert gpu.can_allocate(1) is False


# ---------------------------------------------------------------------------
# FIFOPolicy tests
# ---------------------------------------------------------------------------

class TestFIFOPolicy:

    def test_selects_first_fitting(self):
        policy = FIFOPolicy()
        gpu = GPUTracker(2)

        queue = [
            ScheduleRequest("r1", "cls", "g1", None, None, gpu_required=3),
            ScheduleRequest("r2", "cls", "g2", None, None, gpu_required=1),
            ScheduleRequest("r3", "cls", "g3", None, None, gpu_required=0),
        ]
        result = policy.select_next(queue, [], gpu)
        assert result == "r2"  # r1 needs 3 > 2 available, r2 fits

    def test_returns_none_when_nothing_fits(self):
        policy = FIFOPolicy()
        gpu = GPUTracker(1)
        gpu.allocate("existing", 1)

        queue = [
            ScheduleRequest("r1", "cls", "g1", None, None, gpu_required=1),
        ]
        result = policy.select_next(queue, [], gpu)
        assert result is None

    def test_zero_gpu_always_passes(self):
        policy = FIFOPolicy()
        gpu = GPUTracker(0)  # no gpus at all

        queue = [
            ScheduleRequest("r1", "cls", "g1", None, None, gpu_required=0),
        ]
        result = policy.select_next(queue, [], gpu)
        assert result == "r1"

    def test_empty_queue(self):
        policy = FIFOPolicy()
        gpu = GPUTracker(4)
        result = policy.select_next([], [], gpu)
        assert result is None


# ---------------------------------------------------------------------------
# Scheduler core tests
# ---------------------------------------------------------------------------

class TestSchedulerSubmit:

    @pytest.mark.asyncio
    async def test_submit_creates_queued_request(self, scheduler):
        ticket = await scheduler.submit(
            QuickExecutor, goal="train model", parent_id=None, config=None,
        )
        assert ticket.request_id.startswith("sched-")
        req = scheduler.get_request(ticket.request_id)
        assert req is not None
        assert req.goal == "train model"
        # Should eventually transition from QUEUED -> RUNNING
        req = await _wait_for_request_status(
            scheduler, ticket.request_id,
            [RequestStatus.RUNNING, RequestStatus.DONE, RequestStatus.FAILED],
            timeout=5,
        )
        assert req.status in (RequestStatus.RUNNING, RequestStatus.DONE)

    @pytest.mark.asyncio
    async def test_submit_rejection_impossible_gpu(self, scheduler):
        """Requesting more GPUs than exist gets immediate rejection."""
        # Force GPU tracker to have a non-zero total to trigger rejection
        scheduler._gpu = GPUTracker(2)
        ticket = await scheduler.submit(
            QuickExecutor, goal="big job", parent_id=None, config=None,
            gpu_required=99,
        )
        req = scheduler.get_request(ticket.request_id)
        assert req.status == RequestStatus.REJECTED
        assert "99" in req.rejection_reason

    @pytest.mark.asyncio
    async def test_submit_zero_gpu_on_zero_system(self, scheduler):
        """0 GPU request on 0 GPU system should be fine (not rejected)."""
        scheduler._gpu = GPUTracker(0)
        ticket = await scheduler.submit(
            QuickExecutor, goal="cpu job", parent_id=None, config=None,
            gpu_required=0,
        )
        req = scheduler.get_request(ticket.request_id)
        # Should be queued (not rejected), then eventually spawn
        assert req.status in (RequestStatus.QUEUED, RequestStatus.RUNNING, RequestStatus.DONE)


class TestSchedulerCancel:

    @pytest.mark.asyncio
    async def test_cancel_queued_request(self, scheduler):
        # Make GPU scarce so request stays queued
        scheduler._gpu = GPUTracker(1)
        scheduler._gpu.allocate("blocker", 1)

        ticket = await scheduler.submit(
            SlowExecutor, goal="will cancel", parent_id=None, config=None,
            gpu_required=1,
        )
        req = scheduler.get_request(ticket.request_id)
        assert req.status == RequestStatus.QUEUED

        ok = scheduler.cancel(ticket.request_id)
        assert ok is True
        req = scheduler.get_request(ticket.request_id)
        assert req.status == RequestStatus.FAILED
        assert req.rejection_reason == "Cancelled"

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_returns_false(self, scheduler):
        ok = scheduler.cancel("nonexistent")
        assert ok is False


class TestSchedulerCleanupParent:

    @pytest.mark.asyncio
    async def test_cleanup_cancels_queued_for_parent(self, scheduler):
        scheduler._gpu = GPUTracker(0)  # block all GPU requests

        t1 = await scheduler.submit(
            SlowExecutor, goal="job1", parent_id="parent-A", config=None,
            gpu_required=1,
        )
        t2 = await scheduler.submit(
            SlowExecutor, goal="job2", parent_id="parent-A", config=None,
            gpu_required=1,
        )
        t3 = await scheduler.submit(
            SlowExecutor, goal="job3", parent_id="parent-B", config=None,
            gpu_required=1,
        )

        count = scheduler.cleanup_parent("parent-A")
        assert count == 2

        assert scheduler.get_request(t1.request_id).status == RequestStatus.FAILED
        assert scheduler.get_request(t2.request_id).status == RequestStatus.FAILED
        assert scheduler.get_request(t3.request_id).status == RequestStatus.QUEUED  # untouched


class TestSchedulerQuery:

    @pytest.mark.asyncio
    async def test_list_requests_all(self, scheduler):
        await scheduler.submit(QuickExecutor, goal="a", parent_id=None, config=None)
        await scheduler.submit(QuickExecutor, goal="b", parent_id=None, config=None)
        reqs = scheduler.list_requests()
        assert len(reqs) == 2

    @pytest.mark.asyncio
    async def test_list_requests_by_parent(self, scheduler):
        await scheduler.submit(QuickExecutor, goal="a", parent_id="p1", config=None)
        await scheduler.submit(QuickExecutor, goal="b", parent_id="p2", config=None)
        reqs = scheduler.list_requests(parent_id="p1")
        assert len(reqs) == 1
        assert reqs[0].parent_id == "p1"

    @pytest.mark.asyncio
    async def test_stats(self, scheduler):
        await scheduler.submit(QuickExecutor, goal="a", parent_id=None, config=None)
        stats = scheduler.stats()
        assert "gpu_total" in stats
        assert "queue_size" in stats
        assert stats["total_requests"] >= 1


# ---------------------------------------------------------------------------
# Persistence tests
# ---------------------------------------------------------------------------

class TestSchedulerPersistence:

    @pytest.mark.asyncio
    async def test_persist_and_reload(self, runtime, tmp_path):
        """Submit requests, shut down scheduler, create a new one, verify restored."""
        from pathlib import Path
        sched_dir = tmp_path / "sched_persist"
        sched = Scheduler(runtime, sched_dir)
        runtime._scheduler = sched

        # Don't start tick loop so requests stay QUEUED
        sched._gpu = GPUTracker(0)  # block GPU requests

        t1 = await sched.submit(
            SlowExecutor, goal="persist-me", parent_id="parent-X", config={"lr": 0.01},
            gpu_required=1,
        )
        t2 = await sched.submit(
            SlowExecutor, goal="persist-too", parent_id=None, config=None,
            gpu_required=1,
        )

        # Verify files on disk
        files = list(sched_dir.glob("*.json"))
        assert len(files) == 2

        # Create a fresh scheduler pointing at same directory
        sched2 = Scheduler(runtime, sched_dir)
        assert len(sched2._requests) == 2

        req = sched2.get_request(t1.request_id)
        assert req is not None
        assert req.goal == "persist-me"
        assert req.parent_id == "parent-X"
        assert req.config == {"lr": 0.01}

        await sched.shutdown()

    @pytest.mark.asyncio
    async def test_running_requests_marked_failed_on_reload(self, runtime, tmp_path):
        """Requests that were RUNNING when scheduler restarts are marked FAILED."""
        from pathlib import Path
        sched_dir = tmp_path / "sched_crash"
        sched_dir.mkdir(parents=True, exist_ok=True)

        # Write a fake RUNNING request directly
        fake_req = {
            "request_id": "sched-fake001",
            "agent_cls_path": "agentsys.agents.executor.ExecutorAgent",
            "goal": "was running",
            "parent_id": None,
            "config": None,
            "gpu_required": 1,
            "created_at": 1000.0,
            "status": "running",
            "agent_id": "executor-abc12345",
            "rejection_reason": None,
        }
        with open(sched_dir / "sched-fake001.json", "w") as f:
            json.dump(fake_req, f)

        sched = Scheduler(runtime, sched_dir)
        req = sched.get_request("sched-fake001")
        assert req.status == RequestStatus.FAILED
        assert "restarted" in req.rejection_reason.lower()

        await sched.shutdown()


# ---------------------------------------------------------------------------
# GPU gating tests
# ---------------------------------------------------------------------------

class TestGPUGating:

    @pytest.mark.asyncio
    async def test_gpu_gating_queues_until_available(self, scheduler):
        """With limited GPUs, excess requests queue and spawn when freed."""
        scheduler._gpu = GPUTracker(1)

        # First request should spawn (1 GPU available)
        t1 = await scheduler.submit(
            SlowExecutor, goal="job1", parent_id=None, config=None,
            gpu_required=1,
        )
        # Wait for it to actually start running
        req1 = await _wait_for_request_status(
            scheduler, t1.request_id,
            [RequestStatus.RUNNING], timeout=5,
        )
        assert req1.status == RequestStatus.RUNNING

        # Second request should stay queued (no GPUs left)
        t2 = await scheduler.submit(
            SlowExecutor, goal="job2", parent_id=None, config=None,
            gpu_required=1,
        )
        await asyncio.sleep(1.5)  # let tick run
        req2 = scheduler.get_request(t2.request_id)
        assert req2.status == RequestStatus.QUEUED

        # Simulate first agent finishing -> release GPU
        scheduler.on_agent_done(req1.agent_id, failed=False)
        assert scheduler._gpu.available == 1

        # Now second should get spawned on next tick
        req2 = await _wait_for_request_status(
            scheduler, t2.request_id,
            [RequestStatus.RUNNING, RequestStatus.DONE], timeout=5,
        )
        assert req2.status in (RequestStatus.RUNNING, RequestStatus.DONE)

        # Cleanup
        if req2.agent_id:
            await scheduler._runtime.stop(req2.agent_id)


# ---------------------------------------------------------------------------
# Agent completion callback tests
# ---------------------------------------------------------------------------

class TestOnAgentDone:

    @pytest.mark.asyncio
    async def test_on_agent_done_releases_gpu(self, scheduler):
        scheduler._gpu = GPUTracker(2)
        ticket = await scheduler.submit(
            QuickExecutor, goal="quick", parent_id=None, config=None,
            gpu_required=1,
        )
        req = await _wait_for_request_status(
            scheduler, ticket.request_id,
            [RequestStatus.RUNNING], timeout=5,
        )
        assert scheduler._gpu.allocated >= 1

        # Simulate agent done
        scheduler.on_agent_done(req.agent_id, failed=False)
        req = scheduler.get_request(ticket.request_id)
        assert req.status == RequestStatus.DONE
        assert scheduler._gpu.allocated == 0

    @pytest.mark.asyncio
    async def test_on_agent_done_failed(self, scheduler):
        scheduler._gpu = GPUTracker(2)
        ticket = await scheduler.submit(
            QuickExecutor, goal="will-fail", parent_id=None, config=None,
            gpu_required=1,
        )
        req = await _wait_for_request_status(
            scheduler, ticket.request_id,
            [RequestStatus.RUNNING], timeout=5,
        )
        scheduler.on_agent_done(req.agent_id, failed=True)
        req = scheduler.get_request(ticket.request_id)
        assert req.status == RequestStatus.FAILED


# ---------------------------------------------------------------------------
# ScheduledChildHandle tests
# ---------------------------------------------------------------------------

class TestScheduledChildHandle:

    @pytest.mark.asyncio
    async def test_handle_id_switches_after_spawn(self, scheduler):
        ticket = await scheduler.submit(
            QuickExecutor, goal="test-handle", parent_id=None, config=None,
        )
        handle = ScheduledChildHandle(ticket, scheduler)

        # Initially, id is the request_id
        assert handle.id == ticket.request_id

        # Wait for spawn
        req = await _wait_for_request_status(
            scheduler, ticket.request_id,
            [RequestStatus.RUNNING, RequestStatus.DONE], timeout=5,
        )
        if req.agent_id:
            assert handle.id == req.agent_id

    @pytest.mark.asyncio
    async def test_handle_status_mapping(self, scheduler):
        # Block GPU so request stays queued
        scheduler._gpu = GPUTracker(0)
        ticket = await scheduler.submit(
            SlowExecutor, goal="queued", parent_id=None, config=None,
            gpu_required=1,
        )
        handle = ScheduledChildHandle(ticket, scheduler)
        assert handle.status == AgentStatus.IDLE  # queued -> IDLE

        # Cancel -> FAILED
        scheduler.cancel(ticket.request_id)
        assert handle.status == AgentStatus.FAILED

    @pytest.mark.asyncio
    async def test_handle_cancel_queued(self, scheduler):
        scheduler._gpu = GPUTracker(0)
        ticket = await scheduler.submit(
            SlowExecutor, goal="cancel-me", parent_id=None, config=None,
            gpu_required=1,
        )
        handle = ScheduledChildHandle(ticket, scheduler)
        await handle.cancel()
        req = scheduler.get_request(ticket.request_id)
        assert req.status == RequestStatus.FAILED


# ---------------------------------------------------------------------------
# Integration: spawn_child routing
# ---------------------------------------------------------------------------

class TestSpawnChildRouting:

    @pytest.mark.asyncio
    async def test_executor_spawn_goes_through_scheduler(self, runtime, scheduler):
        """When scheduler is wired, executor spawns return ScheduledChildHandle."""
        # Register a local orchestrator
        orch = OrchestratorAgent()
        orch_id = runtime.register_local(orch, goal="test-orch")
        await orch.start()
        await asyncio.sleep(0.1)

        handle = await orch.spawn_child(QuickExecutor, goal="via-scheduler")
        assert isinstance(handle, ScheduledChildHandle)

        # Wait for completion
        req = await _wait_for_request_status(
            scheduler, handle._ticket.request_id,
            [RequestStatus.RUNNING, RequestStatus.DONE], timeout=10,
        )
        assert req.status in (RequestStatus.RUNNING, RequestStatus.DONE)

        await orch.stop()

    @pytest.mark.asyncio
    async def test_orchestrator_spawn_bypasses_scheduler(self, runtime, scheduler):
        """Non-executor spawns skip the scheduler and go straight to Runtime."""
        class WideOrch(Agent):
            role = "orchestrator"
            allowed_child_roles = frozenset({"orchestrator", "executor"})
            async def run(self):
                while True:
                    await self.check_pause()
                    await asyncio.sleep(0.1)

        class SubOrch(Agent):
            role = "orchestrator"
            async def run(self):
                await asyncio.sleep(0.1)

        orch = WideOrch()
        runtime.register_local(orch, goal="test-orch2")
        await orch.start()
        await asyncio.sleep(0.1)

        # Spawning another orchestrator should NOT go through scheduler
        handle = await orch.spawn_child(SubOrch, goal="sub-orch")
        assert isinstance(handle, ChildHandle)  # NOT ScheduledChildHandle

        await orch.stop()
