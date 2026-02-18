#!/usr/bin/env python3
"""
Simple test for GPU orchestration system.

Tests basic functionality of resource manager, job queue, and orchestrator.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))

from gpu_resource_manager import ResourceManager, GPUStatus
from job_queue_manager import JobQueue, JobPriority, JobState


def test_resource_manager():
    """Test GPU resource manager"""
    print("Testing Resource Manager...")
    
    rm = ResourceManager()
    rm.initialize_cluster(node_count=2, gpus_per_node=8)
    
    # Check initialization
    assert rm.get_total_gpu_count() == 16, "Should have 16 total GPUs"
    assert rm.get_available_gpu_count() == 16, "All GPUs should be available"
    assert rm.get_allocated_gpu_count() == 0, "No GPUs should be allocated"
    
    # Test allocation
    gpus = rm.get_available_gpus(count=4)
    assert len(gpus) == 4, "Should get 4 available GPUs"
    
    success = rm.allocate_gpus(job_id="test-job-1", gpus=gpus, user="test-user")
    assert success, "Allocation should succeed"
    assert rm.get_allocated_gpu_count() == 4, "4 GPUs should be allocated"
    assert rm.get_available_gpu_count() == 12, "12 GPUs should remain available"
    
    # Test release
    success = rm.release_gpus(job_id="test-job-1")
    assert success, "Release should succeed"
    assert rm.get_allocated_gpu_count() == 0, "No GPUs should be allocated"
    assert rm.get_available_gpu_count() == 16, "All GPUs should be available again"
    
    print("✓ Resource Manager tests passed")


def test_job_queue():
    """Test job queue manager"""
    print("Testing Job Queue...")
    
    jq = JobQueue(max_queue_size=100)
    
    # Test enqueue
    job_id_1 = jq.enqueue(
        run_id="run-1",
        user="user-1",
        command="python train.py",
        gpu_count=2,
        priority=JobPriority.NORMAL
    )
    assert job_id_1, "Should return job ID"
    
    job_id_2 = jq.enqueue(
        run_id="run-2",
        user="user-2",
        command="python train.py --epochs 100",
        gpu_count=4,
        priority=JobPriority.HIGH
    )
    
    # Test priority ordering
    next_job = jq.dequeue_next()
    assert next_job is not None, "Should get next job"
    assert next_job.id == job_id_2, "High priority job should come first"
    assert next_job.priority == JobPriority.HIGH, "Job should have high priority"
    
    # Test state update
    success = jq.update_job_state(job_id_2, JobState.RUNNING)
    assert success, "State update should succeed"
    
    job = jq.get_job(job_id_2)
    assert job.state == JobState.RUNNING, "Job should be running"
    
    # Test statistics
    stats = jq.get_statistics()
    assert stats["total_jobs"] == 2, "Should have 2 total jobs"
    assert stats["running"] == 1, "Should have 1 running job"
    assert stats["queued"] == 1, "Should have 1 queued job"
    
    print("✓ Job Queue tests passed")


def test_integration():
    """Test integration between components"""
    print("Testing Integration...")
    
    rm = ResourceManager()
    rm.initialize_cluster(node_count=2, gpus_per_node=8)
    
    jq = JobQueue()
    
    # Submit multiple jobs
    job_ids = []
    for i in range(5):
        job_id = jq.enqueue(
            run_id=f"run-{i}",
            user=f"user-{i}",
            command=f"python train.py --run {i}",
            gpu_count=2,
            priority=JobPriority.NORMAL
        )
        job_ids.append(job_id)
    
    # Simulate scheduling
    allocated_count = 0
    while True:
        next_job = jq.dequeue_next()
        if not next_job:
            break
        
        # Try to allocate GPUs
        gpus = rm.get_available_gpus(count=next_job.gpu_count)
        if len(gpus) < next_job.gpu_count:
            break  # Not enough resources
        
        # Allocate and mark as running
        rm.allocate_gpus(job_id=next_job.id, gpus=gpus, user=next_job.user)
        jq.update_job_state(next_job.id, JobState.RUNNING)
        allocated_count += 1
    
    # Should allocate at least some jobs
    assert allocated_count > 0, "Should allocate at least one job"
    assert rm.get_allocated_gpu_count() == allocated_count * 2, "Should have allocated GPUs"
    
    # Simulate job completion
    for job_id in job_ids[:allocated_count]:
        rm.release_gpus(job_id)
        jq.update_job_state(job_id, JobState.COMPLETED)
    
    assert rm.get_allocated_gpu_count() == 0, "All GPUs should be released"
    
    stats = jq.get_statistics()
    assert stats["completed"] == allocated_count, f"Should have {allocated_count} completed jobs"
    
    print("✓ Integration tests passed")


def main():
    """Run all tests"""
    print("\n=== GPU Orchestration System Tests ===\n")
    
    try:
        test_resource_manager()
        test_job_queue()
        test_integration()
        
        print("\n=== All Tests Passed! ===\n")
        return 0
    except AssertionError as e:
        print(f"\n✗ Test failed: {e}\n")
        return 1
    except Exception as e:
        print(f"\n✗ Unexpected error: {e}\n")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
