"""
GPU Orchestration Agent

Coordinates job scheduling, GPU allocation, and job execution.
Runs as a background service to automatically manage resources.
"""

import asyncio
import logging
import time
from typing import Optional, Callable
from dataclasses import dataclass

from gpu_resource_manager import ResourceManager, GPUResource
from job_queue_manager import JobQueue, QueuedJob, JobState

logger = logging.getLogger("orchestration-agent")


@dataclass
class OrchestrationPolicy:
    """Configuration for orchestration policies"""
    scheduling_algorithm: str = "priority"  # priority, fcfs, sjf, fair_share
    enable_preemption: bool = False
    max_concurrent_jobs: int = 10
    allocation_timeout_seconds: int = 300
    job_check_interval_seconds: float = 5.0
    enable_auto_retry: bool = True


class OrchestrationAgent:
    """
    Main orchestration agent that coordinates GPU scheduling.
    
    Responsibilities:
    - Poll job queue for pending jobs
    - Allocate GPUs based on availability
    - Launch jobs when resources are ready
    - Monitor job health and handle failures
    - Release resources when jobs complete
    """
    
    def __init__(
        self,
        resource_manager: ResourceManager,
        job_queue: JobQueue,
        policy: Optional[OrchestrationPolicy] = None,
        job_launcher: Optional[Callable] = None,
    ):
        """
        Initialize orchestration agent.
        
        Args:
            resource_manager: GPU resource manager
            job_queue: Job queue manager
            policy: Orchestration policy configuration
            job_launcher: Callback to launch jobs (for integration with existing job system)
        """
        self.resource_manager = resource_manager
        self.job_queue = job_queue
        self.policy = policy or OrchestrationPolicy()
        self.job_launcher = job_launcher
        
        self.running = False
        self.task: Optional[asyncio.Task] = None
        
        self.stats = {
            "jobs_scheduled": 0,
            "jobs_failed": 0,
            "jobs_completed": 0,
            "scheduling_cycles": 0,
            "last_cycle_time": 0.0,
        }
    
    async def start(self) -> None:
        """Start the orchestration agent background loop"""
        if self.running:
            logger.warning("Orchestration agent already running")
            return
        
        self.running = True
        self.task = asyncio.create_task(self._orchestration_loop())
        logger.info("Orchestration agent started")
    
    async def stop(self) -> None:
        """Stop the orchestration agent"""
        if not self.running:
            return
        
        self.running = False
        
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        
        logger.info("Orchestration agent stopped")
    
    async def _orchestration_loop(self) -> None:
        """Main orchestration loop that runs continuously"""
        logger.info("Starting orchestration loop")
        
        while self.running:
            try:
                cycle_start = time.time()
                
                # Try to schedule pending jobs
                scheduled_count = await self._schedule_pending_jobs()
                
                # Monitor running jobs
                await self._monitor_running_jobs()
                
                self.stats["scheduling_cycles"] += 1
                cycle_time = time.time() - cycle_start
                self.stats["last_cycle_time"] = cycle_time
                
                if scheduled_count > 0:
                    logger.info(f"Orchestration cycle: scheduled {scheduled_count} jobs in {cycle_time:.2f}s")
                
                # Wait before next cycle
                await asyncio.sleep(self.policy.job_check_interval_seconds)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in orchestration loop: {e}", exc_info=True)
                await asyncio.sleep(self.policy.job_check_interval_seconds)
        
        logger.info("Orchestration loop stopped")
    
    async def _schedule_pending_jobs(self) -> int:
        """
        Try to schedule pending jobs from the queue.
        
        Returns:
            Number of jobs scheduled
        """
        scheduled_count = 0
        
        # Check if we've hit max concurrent jobs
        running_jobs = self.job_queue.get_running_jobs()
        if len(running_jobs) >= self.policy.max_concurrent_jobs:
            return 0
        
        # Get next job(s) to schedule
        max_to_schedule = self.policy.max_concurrent_jobs - len(running_jobs)
        pending_jobs = self.job_queue.peek_next(count=max_to_schedule)
        
        for job in pending_jobs:
            try:
                if await self._try_schedule_job(job):
                    scheduled_count += 1
                    self.stats["jobs_scheduled"] += 1
            except Exception as e:
                logger.error(f"Error scheduling job {job.id}: {e}", exc_info=True)
                self._handle_job_failure(job, str(e))
        
        return scheduled_count
    
    async def _try_schedule_job(self, job: QueuedJob) -> bool:
        """
        Try to schedule a single job.
        
        Args:
            job: Job to schedule
            
        Returns:
            True if scheduled successfully
        """
        # Check for available GPUs
        available_gpus = self.resource_manager.get_available_gpus(
            count=job.gpu_count,
            memory_gb=job.gpu_memory_gb
        )
        
        if len(available_gpus) < job.gpu_count:
            # Not enough resources available
            return False
        
        # Update job state to allocating
        self.job_queue.update_job_state(job.id, JobState.ALLOCATING)
        
        # Allocate GPUs
        success = self.resource_manager.allocate_gpus(
            job_id=job.id,
            gpus=available_gpus,
            user=job.user
        )
        
        if not success:
            logger.error(f"Failed to allocate GPUs for job {job.id}")
            self.job_queue.update_job_state(job.id, JobState.QUEUED)
            return False
        
        # Record allocated GPUs
        job.allocated_gpus = [f"{gpu.node_id}:{gpu.gpu_id}" for gpu in available_gpus]
        
        # Update state to scheduled
        self.job_queue.update_job_state(job.id, JobState.SCHEDULED)
        
        # Launch the job
        if self.job_launcher:
            try:
                await self._launch_job(job, available_gpus)
                self.job_queue.update_job_state(job.id, JobState.RUNNING)
                logger.info(f"Successfully launched job {job.id} with {len(available_gpus)} GPUs")
            except Exception as e:
                logger.error(f"Failed to launch job {job.id}: {e}")
                self._handle_job_failure(job, f"Launch failed: {e}")
                return False
        else:
            # No launcher configured, just mark as running
            # (for testing or when using external launcher)
            self.job_queue.update_job_state(job.id, JobState.RUNNING)
        
        return True
    
    async def _launch_job(self, job: QueuedJob, gpus: list[GPUResource]) -> None:
        """
        Launch a job with allocated GPUs.
        
        Args:
            job: Job to launch
            gpus: Allocated GPU resources
        """
        if not self.job_launcher:
            logger.warning(f"No job launcher configured for job {job.id}")
            return
        
        # Build GPU environment variables
        gpu_device_ids = ",".join(str(gpu.gpu_id) for gpu in gpus)
        node_id = gpus[0].node_id if gpus else "unknown"
        
        # Call the launcher callback
        # The launcher should handle actually executing the job
        await self.job_launcher(
            job_id=job.id,
            run_id=job.run_id,
            command=job.command,
            gpu_device_ids=gpu_device_ids,
            node_id=node_id,
        )
    
    async def _monitor_running_jobs(self) -> None:
        """Monitor running jobs and handle completions/failures"""
        # This is a placeholder - in production, would integrate with
        # actual job monitoring system (tmux, Ray, etc.)
        pass
    
    def handle_job_completion(self, job_id: str, success: bool, error_message: Optional[str] = None) -> None:
        """
        Handle job completion (called externally when job finishes).
        
        Args:
            job_id: Job identifier
            success: Whether job completed successfully
            error_message: Error message if failed
        """
        job = self.job_queue.get_job(job_id)
        if not job:
            logger.warning(f"Cannot handle completion: job {job_id} not found")
            return
        
        # Release GPU resources
        self.resource_manager.release_gpus(job_id)
        
        if success:
            self.job_queue.update_job_state(job_id, JobState.COMPLETED)
            self.stats["jobs_completed"] += 1
            logger.info(f"Job {job_id} completed successfully")
        else:
            self._handle_job_failure(job, error_message)
    
    def _handle_job_failure(self, job: QueuedJob, error_message: Optional[str]) -> None:
        """
        Handle job failure with optional retry.
        
        Args:
            job: Failed job
            error_message: Error description
        """
        # Release any allocated GPUs
        self.resource_manager.release_gpus(job.id)
        
        # Check if we should retry
        if self.policy.enable_auto_retry and job.retry_count < job.max_retries:
            job.retry_count += 1
            self.job_queue.update_job_state(job.id, JobState.QUEUED)
            logger.warning(f"Job {job.id} failed, retrying ({job.retry_count}/{job.max_retries}): {error_message}")
        else:
            self.job_queue.update_job_state(job.id, JobState.FAILED, error_message=error_message)
            self.stats["jobs_failed"] += 1
            logger.error(f"Job {job.id} failed: {error_message}")
    
    def get_status(self) -> dict:
        """
        Get orchestration agent status.
        
        Returns:
            Status dictionary
        """
        return {
            "running": self.running,
            "policy": {
                "scheduling_algorithm": self.policy.scheduling_algorithm,
                "max_concurrent_jobs": self.policy.max_concurrent_jobs,
                "enable_auto_retry": self.policy.enable_auto_retry,
            },
            "stats": self.stats.copy(),
            "resource_summary": {
                "total_gpus": self.resource_manager.get_total_gpu_count(),
                "available_gpus": self.resource_manager.get_available_gpu_count(),
                "allocated_gpus": self.resource_manager.get_allocated_gpu_count(),
            },
            "queue_summary": self.job_queue.get_statistics(),
        }
    
    def update_policy(self, **kwargs) -> None:
        """Update orchestration policy"""
        for key, value in kwargs.items():
            if hasattr(self.policy, key):
                setattr(self.policy, key, value)
                logger.info(f"Updated policy: {key} = {value}")


# Global instance (initialized in server.py)
orchestration_agent: Optional[OrchestrationAgent] = None
