"""
Job Queue Manager

Manages job submission, queueing, and scheduling.
Maintains priority queue and tracks job lifecycle.
"""

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from enum import Enum

logger = logging.getLogger("job-queue-manager")


class JobState(str, Enum):
    """Job lifecycle states"""
    QUEUED = "queued"
    SCHEDULED = "scheduled"
    ALLOCATING = "allocating"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


class JobPriority(int, Enum):
    """Job priority levels"""
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4


@dataclass
class QueuedJob:
    """Represents a job in the queue"""
    id: str
    run_id: str
    user: str
    command: str
    gpu_count: int
    gpu_memory_gb: float
    priority: int = JobPriority.NORMAL
    state: JobState = JobState.QUEUED
    submitted_at: float = field(default_factory=time.time)
    scheduled_at: Optional[float] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    estimated_duration_seconds: Optional[int] = None
    retry_count: int = 0
    max_retries: int = 3
    error_message: Optional[str] = None
    allocated_gpus: Optional[List[str]] = None  # List of "node_id:gpu_id"
    
    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization"""
        return {
            "id": self.id,
            "run_id": self.run_id,
            "user": self.user,
            "command": self.command,
            "gpu_count": self.gpu_count,
            "gpu_memory_gb": self.gpu_memory_gb,
            "priority": self.priority,
            "state": self.state.value,
            "submitted_at": self.submitted_at,
            "scheduled_at": self.scheduled_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "estimated_duration_seconds": self.estimated_duration_seconds,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "error_message": self.error_message,
            "allocated_gpus": self.allocated_gpus,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "QueuedJob":
        """Create from dictionary"""
        return cls(
            id=data["id"],
            run_id=data["run_id"],
            user=data["user"],
            command=data["command"],
            gpu_count=data["gpu_count"],
            gpu_memory_gb=data["gpu_memory_gb"],
            priority=data.get("priority", JobPriority.NORMAL),
            state=JobState(data.get("state", "queued")),
            submitted_at=data["submitted_at"],
            scheduled_at=data.get("scheduled_at"),
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
            estimated_duration_seconds=data.get("estimated_duration_seconds"),
            retry_count=data.get("retry_count", 0),
            max_retries=data.get("max_retries", 3),
            error_message=data.get("error_message"),
            allocated_gpus=data.get("allocated_gpus"),
        )


class JobQueue:
    """
    Manages job queue with priority-based scheduling.
    
    Responsibilities:
    - Accept job submissions
    - Maintain priority queue
    - Track job states
    - Provide queue statistics
    """
    
    def __init__(self, max_queue_size: int = 100):
        self.max_queue_size = max_queue_size
        self.jobs: Dict[str, QueuedJob] = {}  # All jobs by ID
        self.active_queue: List[str] = []  # IDs of queued/scheduled jobs
        
    def enqueue(self, run_id: str, user: str, command: str, 
                gpu_count: int, gpu_memory_gb: float = 0,
                priority: int = JobPriority.NORMAL,
                estimated_duration_seconds: Optional[int] = None) -> str:
        """
        Add a job to the queue.
        
        Args:
            run_id: Associated experiment run ID
            user: User submitting the job
            command: Command to execute
            gpu_count: Number of GPUs required
            gpu_memory_gb: Memory required per GPU
            priority: Job priority
            estimated_duration_seconds: Estimated runtime
            
        Returns:
            Job ID
            
        Raises:
            ValueError: If queue is full
        """
        if len(self.active_queue) >= self.max_queue_size:
            raise ValueError(f"Queue is full (max {self.max_queue_size} jobs)")
        
        job_id = str(uuid.uuid4())
        
        job = QueuedJob(
            id=job_id,
            run_id=run_id,
            user=user,
            command=command,
            gpu_count=gpu_count,
            gpu_memory_gb=gpu_memory_gb,
            priority=priority,
            estimated_duration_seconds=estimated_duration_seconds,
        )
        
        self.jobs[job_id] = job
        self._insert_by_priority(job_id)
        
        logger.info(f"Job {job_id} enqueued (run={run_id}, user={user}, gpus={gpu_count}, priority={priority})")
        
        return job_id
    
    def _insert_by_priority(self, job_id: str) -> None:
        """Insert job ID into active queue sorted by priority"""
        job = self.jobs[job_id]
        
        # Find insertion point using binary search by priority
        # Higher priority comes first
        left, right = 0, len(self.active_queue)
        
        while left < right:
            mid = (left + right) // 2
            mid_job = self.jobs[self.active_queue[mid]]
            
            if mid_job.priority > job.priority:
                left = mid + 1
            elif mid_job.priority < job.priority:
                right = mid
            else:
                # Same priority, use FIFO (compare submission time)
                if mid_job.submitted_at <= job.submitted_at:
                    left = mid + 1
                else:
                    right = mid
        
        self.active_queue.insert(left, job_id)
    
    def dequeue_next(self) -> Optional[QueuedJob]:
        """
        Get the next job to schedule (highest priority, not yet scheduled).
        
        Returns:
            Next job or None if queue is empty
        """
        for job_id in self.active_queue:
            job = self.jobs[job_id]
            if job.state == JobState.QUEUED:
                return job
        
        return None
    
    def peek_next(self, count: int = 1) -> List[QueuedJob]:
        """
        Peek at next N jobs without removing them.
        
        Args:
            count: Number of jobs to peek
            
        Returns:
            List of next jobs (up to count)
        """
        result = []
        for job_id in self.active_queue:
            job = self.jobs[job_id]
            if job.state == JobState.QUEUED:
                result.append(job)
                if len(result) >= count:
                    break
        
        return result
    
    def update_job_state(self, job_id: str, state: JobState, 
                        error_message: Optional[str] = None) -> bool:
        """
        Update job state.
        
        Args:
            job_id: Job identifier
            state: New state
            error_message: Error message if failed
            
        Returns:
            True if update successful, False if job not found
        """
        if job_id not in self.jobs:
            logger.warning(f"Cannot update state: job {job_id} not found")
            return False
        
        job = self.jobs[job_id]
        old_state = job.state
        job.state = state
        
        now = time.time()
        
        if state == JobState.SCHEDULED:
            job.scheduled_at = now
        elif state == JobState.RUNNING:
            job.started_at = now
        elif state in (JobState.COMPLETED, JobState.FAILED, JobState.CANCELED):
            job.completed_at = now
            # Remove from active queue
            if job_id in self.active_queue:
                self.active_queue.remove(job_id)
        
        if error_message:
            job.error_message = error_message
        
        logger.info(f"Job {job_id} state: {old_state.value} -> {state.value}")
        
        return True
    
    def cancel_job(self, job_id: str) -> bool:
        """
        Cancel a queued or scheduled job.
        
        Args:
            job_id: Job identifier
            
        Returns:
            True if canceled, False if not found or already running
        """
        if job_id not in self.jobs:
            logger.warning(f"Cannot cancel: job {job_id} not found")
            return False
        
        job = self.jobs[job_id]
        
        if job.state not in (JobState.QUEUED, JobState.SCHEDULED, JobState.ALLOCATING):
            logger.warning(f"Cannot cancel job {job_id} in state {job.state.value}")
            return False
        
        return self.update_job_state(job_id, JobState.CANCELED)
    
    def update_priority(self, job_id: str, priority: int) -> bool:
        """
        Update job priority and re-sort queue.
        
        Args:
            job_id: Job identifier
            priority: New priority
            
        Returns:
            True if update successful
        """
        if job_id not in self.jobs:
            logger.warning(f"Cannot update priority: job {job_id} not found")
            return False
        
        job = self.jobs[job_id]
        
        if job.state != JobState.QUEUED:
            logger.warning(f"Cannot update priority: job {job_id} is {job.state.value}")
            return False
        
        old_priority = job.priority
        job.priority = priority
        
        # Remove and re-insert to maintain sort order
        if job_id in self.active_queue:
            self.active_queue.remove(job_id)
            self._insert_by_priority(job_id)
        
        logger.info(f"Job {job_id} priority updated: {old_priority} -> {priority}")
        
        return True
    
    def get_job(self, job_id: str) -> Optional[QueuedJob]:
        """Get job by ID"""
        return self.jobs.get(job_id)
    
    def get_job_by_run_id(self, run_id: str) -> Optional[QueuedJob]:
        """Get job by run ID"""
        for job in self.jobs.values():
            if job.run_id == run_id:
                return job
        return None
    
    def get_queue_state(self) -> List[QueuedJob]:
        """Get all queued and scheduled jobs in priority order"""
        return [self.jobs[job_id] for job_id in self.active_queue 
                if self.jobs[job_id].state in (JobState.QUEUED, JobState.SCHEDULED)]
    
    def get_running_jobs(self) -> List[QueuedJob]:
        """Get all running jobs"""
        return [job for job in self.jobs.values() if job.state == JobState.RUNNING]
    
    def get_statistics(self) -> dict:
        """
        Get queue statistics.
        
        Returns:
            Dictionary with queue metrics
        """
        queued = [j for j in self.jobs.values() if j.state == JobState.QUEUED]
        scheduled = [j for j in self.jobs.values() if j.state == JobState.SCHEDULED]
        running = [j for j in self.jobs.values() if j.state == JobState.RUNNING]
        completed = [j for j in self.jobs.values() if j.state == JobState.COMPLETED]
        failed = [j for j in self.jobs.values() if j.state == JobState.FAILED]
        
        # Calculate average wait time for completed jobs
        wait_times = []
        for job in completed:
            if job.submitted_at and job.started_at:
                wait_times.append(job.started_at - job.submitted_at)
        
        avg_wait_time = sum(wait_times) / len(wait_times) if wait_times else 0
        
        # Calculate throughput (jobs completed in last hour)
        now = time.time()
        one_hour_ago = now - 3600
        recent_completions = [j for j in completed if j.completed_at and j.completed_at >= one_hour_ago]
        
        return {
            "total_jobs": len(self.jobs),
            "queued": len(queued),
            "scheduled": len(scheduled),
            "running": len(running),
            "completed": len(completed),
            "failed": len(failed),
            "average_wait_time_seconds": round(avg_wait_time, 1),
            "jobs_per_hour": len(recent_completions),
            "queue_capacity": self.max_queue_size,
            "queue_utilization_percent": round(len(self.active_queue) / self.max_queue_size * 100, 1),
        }
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization"""
        return {
            "max_queue_size": self.max_queue_size,
            "jobs": {job_id: job.to_dict() for job_id, job in self.jobs.items()},
            "active_queue": self.active_queue,
        }
    
    def from_dict(self, data: dict) -> None:
        """Load state from dictionary"""
        self.max_queue_size = data.get("max_queue_size", 100)
        
        # Restore jobs
        jobs_data = data.get("jobs", {})
        self.jobs = {job_id: QueuedJob.from_dict(job_data) 
                    for job_id, job_data in jobs_data.items()}
        
        # Restore active queue
        self.active_queue = data.get("active_queue", [])
        
        logger.info(f"Loaded {len(self.jobs)} jobs, {len(self.active_queue)} in active queue")


# Global instance
job_queue = JobQueue()
