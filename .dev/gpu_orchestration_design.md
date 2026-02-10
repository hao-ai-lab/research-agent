# GPU Orchestration Agent - Technical Design

## Overview

This document provides detailed technical specifications for implementing a GPU resource orchestration system that manages 16 H100 GPUs across 2 GMI nodes for 15+ team members.

## Architecture

### Components

#### 1. GPU Resource Manager (`server/gpu_orchestrator.py`)

**Responsibilities:**
- Track available GPU resources across cluster
- Monitor GPU utilization in real-time
- Allocate GPUs to jobs based on requirements
- Deallocate resources when jobs complete

**Key Classes:**

```python
class GPUResource:
    node_id: str
    gpu_id: int
    memory_gb: float
    utilization_percent: float
    allocated_to: Optional[str]  # job_id if allocated
    
class ResourceManager:
    def get_available_gpus(self, count: int, memory_gb: float) -> List[GPUResource]
    def allocate_gpus(self, job_id: str, gpus: List[GPUResource]) -> bool
    def release_gpus(self, job_id: str) -> None
    def get_cluster_status(self) -> ClusterStatus
```

#### 2. Job Queue Manager (`server/job_queue.py`)

**Responsibilities:**
- Queue jobs when resources unavailable
- Prioritize jobs based on policy
- Automatically launch jobs when resources free
- Track job states and history

**Job States:**
```
queued -> scheduled -> allocating -> running -> completed
                                  -> failed
                                  -> canceled
```

**Key Classes:**

```python
class QueuedJob:
    id: str
    user: str
    command: str
    gpu_count: int
    gpu_memory_gb: float
    priority: int
    submitted_at: datetime
    estimated_duration: Optional[timedelta]
    
class JobQueue:
    def enqueue(self, job: QueuedJob) -> str
    def dequeue_next(self) -> Optional[QueuedJob]
    def cancel(self, job_id: str) -> bool
    def get_queue_state(self) -> List[QueuedJob]
    def update_priority(self, job_id: str, priority: int) -> None
```

#### 3. Orchestration Agent (`server/orchestration_agent.py`)

**Responsibilities:**
- Poll for queued jobs
- Make scheduling decisions
- Launch jobs on Ray cluster
- Monitor job health
- Handle failures and retries

**Key Classes:**

```python
class OrchestrationAgent:
    def __init__(self, resource_manager, job_queue, ray_client)
    def start(self) -> None  # Start background orchestration loop
    def stop(self) -> None
    async def orchestration_loop(self) -> None
    def schedule_next_job(self) -> bool
    def handle_job_completion(self, job_id: str, status: str) -> None
```

#### 4. Ray Cluster Integration (`server/ray_integration.py`)

**Responsibilities:**
- Connect to Ray cluster
- Submit jobs to Ray
- Monitor Ray job status
- Retrieve job logs and results

**Key Classes:**

```python
class RayClusterClient:
    def connect(self, head_node: str) -> bool
    def submit_job(self, job_config: JobConfig) -> str
    def get_job_status(self, job_id: str) -> JobStatus
    def cancel_job(self, job_id: str) -> bool
    def get_cluster_resources(self) -> Dict[str, Any]
```

### Data Models

#### Extended ExperimentRun Type

```typescript
interface ExperimentRun {
  // ... existing fields ...
  
  // GPU Orchestration fields
  gpuAllocation?: {
    requestedGpus: number;
    requestedMemoryGb: number;
    allocatedGpus: Array<{
      nodeId: string;
      gpuId: number;
      memoryGb: number;
    }>;
    allocationTime?: Date;
  };
  
  queueInfo?: {
    queuedAt: Date;
    queuePosition: number;
    estimatedStartTime?: Date;
  };
  
  orchestrationMetadata?: {
    schedulingPolicy: string;
    priority: number;
    retryCount: number;
    maxRetries: number;
  };
}
```

#### Cluster State Extension

```typescript
interface ClusterState {
  // ... existing fields ...
  
  // GPU Orchestration additions
  gpuResources?: {
    totalGpus: number;
    availableGpus: number;
    allocatedGpus: number;
    nodes: Array<{
      nodeId: string;
      hostname: string;
      gpuCount: number;
      gpuType: string;
      gpus: Array<{
        id: number;
        memoryTotal: number;
        memoryUsed: number;
        utilization: number;
        temperature?: number;
        allocatedTo?: string;
      }>;
    }>;
  };
  
  rayCluster?: {
    headNode: string;
    connected: boolean;
    version: string;
    workers: number;
  };
}
```

#### Job Queue State

```typescript
interface JobQueueState {
  queuedJobs: Array<{
    id: string;
    runId: string;
    user: string;
    priority: number;
    requestedGpus: number;
    queuedAt: Date;
    estimatedWaitTime?: number;
  }>;
  
  statistics: {
    totalQueued: number;
    averageWaitTime: number;
    queueThroughput: number;  // jobs/hour
  };
}
```

### API Endpoints

#### GPU Resource Endpoints

```
GET    /cluster/gpu-status
       Returns current GPU allocation and utilization across cluster

POST   /cluster/gpu-allocate
       Request GPU allocation for a job
       Body: { job_id, gpu_count, memory_gb }

POST   /cluster/gpu-release
       Release GPU resources for a job
       Body: { job_id }
```

#### Job Queue Endpoints

```
GET    /queue
       Get current job queue state

POST   /queue/submit
       Submit a new job to the queue
       Body: { command, gpu_count, memory_gb, priority, estimated_duration }

DELETE /queue/{job_id}
       Cancel a queued job

PATCH  /queue/{job_id}/priority
       Update job priority
       Body: { priority }

GET    /queue/statistics
       Get queue statistics and metrics
```

#### Orchestration Agent Endpoints

```
GET    /orchestrator/status
       Get orchestrator agent status

POST   /orchestrator/start
       Start the orchestration agent

POST   /orchestrator/stop
       Stop the orchestration agent

GET    /orchestrator/policies
       Get current scheduling policies

PUT    /orchestrator/policies
       Update scheduling policies
       Body: { policy_config }
```

### Scheduling Policies

#### Fair Share Policy (Default)
- Allocate GPU time proportional to user/project quotas
- Prevent resource monopolization
- Balance fairness with efficiency

#### Priority-Based Policy
- High priority jobs preempt low priority
- Priority levels: critical (4), high (3), normal (2), low (1)
- Starvation prevention for low priority jobs

#### First-Come-First-Served (FCFS)
- Simple queue ordering
- Good for homogeneous workloads

#### Shortest Job First (SJF)
- Prioritize short jobs
- Requires estimated duration
- Maximizes throughput

#### Gang Scheduling
- Allocate all required GPUs simultaneously
- Avoid partial allocations
- Better for multi-GPU jobs

### State Persistence

#### File Structure
```
.agents/
  ├── cluster_state.json      # GPU and cluster state
  ├── job_queue.json          # Queued jobs
  ├── orchestrator_state.json # Agent state and policies
  └── gpu_allocation.json     # Current allocations
```

#### Persistence Strategy
- Save state every 30 seconds
- Save immediately on state changes
- Recover state on server restart
- Transaction log for critical operations

### Monitoring & Observability

#### Metrics to Track
1. **Resource Utilization**
   - GPU utilization per device
   - Memory usage per device
   - Idle time per device

2. **Queue Metrics**
   - Queue length over time
   - Wait time distribution
   - Job throughput (jobs/hour)

3. **Job Metrics**
   - Success/failure rate
   - Average job duration
   - Resource efficiency

4. **Agent Metrics**
   - Scheduling latency
   - Decision accuracy
   - Policy effectiveness

#### Logging
```python
logger.info(f"Job {job_id} allocated GPUs: {gpu_list}")
logger.warning(f"Queue backlog exceeds threshold: {queue_length}")
logger.error(f"Failed to allocate GPUs for job {job_id}: {error}")
```

### Error Handling

#### Resource Allocation Failures
- Retry with exponential backoff
- Fall back to smaller GPU request if possible
- Notify user of allocation issues

#### Ray Cluster Failures
- Detect connection loss
- Attempt reconnection
- Queue jobs until cluster available
- Fail gracefully with user notification

#### Job Failures
- Capture exit codes and logs
- Implement retry policy
- Release resources immediately
- Update job status in database

### Security Considerations

#### Resource Isolation
- Enforce per-user quotas
- Prevent resource hogging
- Audit trail for allocations

#### Job Validation
- Validate commands before execution
- Sandbox job execution
- Resource limits per job

#### Access Control
- Authenticate API requests
- Authorize GPU allocations
- Rate limit submissions

## Implementation Plan

### Phase 1: Foundation (Initial PR - Day 1)

**Files to Create:**
- `.dev/gpu_orchestration_issue.md` ✓
- `.dev/gpu_orchestration_design.md` ✓
- `server/gpu_resource_manager.py`
- `server/job_queue_manager.py`
- `server/orchestration_agent.py`

**Files to Modify:**
- `server/server.py` - Add new API endpoints
- `lib/types.ts` - Add TypeScript types
- `server/requirements.txt` - Add dependencies

**Key Features:**
- Basic GPU tracking data structures
- In-memory job queue
- Manual GPU allocation API
- Cluster state extension

### Phase 2: Ray Integration (Day 2)

**Files to Create:**
- `server/ray_integration.py`
- `tests/test_ray_integration.py`

**Key Features:**
- Ray cluster connection
- Job submission to Ray
- Resource queries from Ray
- Job monitoring

### Phase 3: Orchestration Logic (Day 3)

**Key Features:**
- Background orchestration loop
- Automatic job scheduling
- Policy implementation
- State persistence

### Phase 4: Frontend UI (Day 4)

**Files to Create:**
- `components/gpu-dashboard.tsx`
- `components/job-queue-view.tsx`
- `components/cluster-monitor.tsx`

**Files to Modify:**
- `app/page.tsx` - Add GPU dashboard tab
- `lib/types.ts` - Add UI types

**Key Features:**
- Real-time GPU utilization display
- Job queue visualization
- Cluster topology view
- Resource allocation graphs

### Phase 5: AI Agent Enhancement (Day 5)

**Key Features:**
- Intelligent scheduling decisions
- Predictive resource allocation
- Anomaly detection
- Automatic optimization

## Testing Strategy

### Unit Tests
- Resource allocation logic
- Queue operations
- Policy implementations
- State persistence

### Integration Tests
- Ray cluster integration
- End-to-end job submission
- Multi-job scenarios
- Failure recovery

### Load Tests
- 100+ concurrent jobs
- Resource contention scenarios
- Queue performance
- State consistency under load

### Manual Tests
- Real GPU allocation on GMI nodes
- Multi-user scenarios
- Ray cluster with actual H100s
- UI responsiveness

## Deployment

### Prerequisites
- Ray cluster deployed on GMI nodes
- Python 3.10+ with required packages
- Network access between server and Ray head node
- GPU monitoring tools (nvidia-smi, dcgm)

### Configuration
```bash
# Environment variables
export RESEARCH_AGENT_RAY_HEAD_NODE="gmi-node-1:6379"
export RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED="true"
export RESEARCH_AGENT_SCHEDULING_POLICY="fair_share"
export RESEARCH_AGENT_MAX_QUEUE_SIZE="100"
```

### Rollout Plan
1. Deploy to staging with 2 GPUs
2. Test with small team (3-5 users)
3. Graduate to production with all 16 GPUs
4. Monitor for 1 week before full rollout
5. Migrate all users from spreadsheet coordination

## Success Criteria

### Functional Requirements
- [x] Submit jobs to queue via API
- [x] Automatic GPU allocation
- [x] Ray cluster integration
- [x] Real-time monitoring
- [x] Policy-based scheduling

### Performance Requirements
- Job submission: <100ms
- Scheduling decision: <1s
- Queue processing: >60 jobs/hour
- GPU utilization: >95% during peak

### Operational Requirements
- 99.9% uptime
- <1 minute failover time
- Complete audit trail
- Automated alerts for issues

## Future Enhancements

1. **Multi-Cluster Support**: Federate across multiple GPU clusters
2. **Cost Optimization**: Track and minimize GPU costs
3. **Advanced Policies**: ML-based scheduling optimization
4. **Spot Instance Support**: Use preemptible instances
5. **Jupyter Integration**: Direct notebook GPU allocation
6. **Slack Integration**: Queue status and notifications
7. **Resource Reservations**: Schedule future GPU allocations
8. **Checkpoint Management**: Automatic job checkpointing

## References

- Ray Documentation: https://docs.ray.io/
- NVIDIA DCGM: https://developer.nvidia.com/dcgm
- Kubernetes GPU Scheduling: https://kubernetes.io/docs/tasks/manage-gpus/
- Slurm GPU Documentation: https://slurm.schedmd.com/gres.html
