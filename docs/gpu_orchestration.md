# GPU Orchestration System - Quick Start

## Overview

The GPU Orchestration system provides automated scheduling and resource management for GPU workloads across a cluster. It eliminates manual coordination and maximizes GPU utilization.

## Key Features

- **Automated Scheduling**: Jobs are automatically scheduled when resources become available
- **Priority-Based Queueing**: High-priority jobs get resources first
- **Resource Tracking**: Real-time visibility into GPU allocation and utilization
- **Job Management**: Submit, monitor, and cancel jobs via API
- **Multi-Node Support**: Coordinate resources across multiple GPU nodes

## Quick Start

### 1. Enable GPU Orchestration

Set the environment variable to enable the feature:

```bash
export RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED=true
```

### 2. Start the Server

```bash
cd server
python server.py --workdir /path/to/your/project
```

The server will automatically initialize the GPU orchestration system with default settings (2 nodes, 8 GPUs each).

### 3. Test the System

Run the basic tests:

```bash
cd tests
python test_gpu_orchestration.py
```

### 4. Run the Demo

The demo script shows how to use the API:

```bash
python demo_gpu_orchestration.py
```

## API Overview

### GPU Status

```bash
# Get GPU resource status
curl http://localhost:10000/gpu/status

# Initialize GPU cluster (optional - done automatically on startup)
curl -X POST http://localhost:10000/gpu/initialize \
  -H "Content-Type: application/json" \
  -d '{"node_count": 2, "gpus_per_node": 8}'
```

### Job Queue

```bash
# Submit a job
curl -X POST http://localhost:10000/queue/submit \
  -H "Content-Type: application/json" \
  -d '{
    "run_id": "experiment-1",
    "user": "username",
    "command": "python train.py",
    "gpu_count": 2,
    "priority": 2
  }'

# Get queue state
curl http://localhost:10000/queue

# Cancel a job
curl -X DELETE http://localhost:10000/queue/{job_id}

# Update job priority
curl -X PATCH http://localhost:10000/queue/{job_id}/priority \
  -H "Content-Type: application/json" \
  -d '{"priority": 3}'
```

### Orchestration Agent

```bash
# Start the orchestrator
curl -X POST http://localhost:10000/orchestrator/start

# Check orchestrator status
curl http://localhost:10000/orchestrator/status

# Stop the orchestrator
curl -X POST http://localhost:10000/orchestrator/stop

# Update scheduling policy
curl -X PUT http://localhost:10000/orchestrator/policy \
  -H "Content-Type: application/json" \
  -d '{
    "max_concurrent_jobs": 10,
    "enable_auto_retry": true
  }'
```

## Configuration

### Environment Variables

- `RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED`: Enable GPU orchestration (default: false)
- `RESEARCH_AGENT_SCHEDULING_POLICY`: Scheduling algorithm (default: priority)
- `RESEARCH_AGENT_MAX_QUEUE_SIZE`: Maximum queue size (default: 100)

### Scheduling Policies

- **priority**: Priority-based scheduling (default)
- **fcfs**: First-come-first-served
- **sjf**: Shortest job first
- **fair_share**: Fair resource distribution

## Architecture

```
┌─────────────────────────────────────────────┐
│         FastAPI Server                       │
│  ┌───────────────────────────────────────┐  │
│  │   Orchestration Agent                 │  │
│  │   (Background scheduler)              │  │
│  └───────────────────────────────────────┘  │
│            │              │                  │
│  ┌─────────▼──────┐  ┌───▼──────────────┐  │
│  │ Resource Mgr   │  │  Job Queue       │  │
│  │ (GPU tracking) │  │  (Priority queue)│  │
│  └────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────┘
               │
               ▼
    ┌──────────────────────┐
    │   GPU Cluster        │
    │   16x H100 GPUs      │
    │   (2 nodes x 8 GPUs) │
    └──────────────────────┘
```

## Components

### Resource Manager
- Tracks available GPUs across cluster
- Handles GPU allocation and deallocation
- Monitors GPU utilization

### Job Queue
- Priority-based job queue
- Job lifecycle management (queued → scheduled → running → completed)
- Queue statistics and metrics

### Orchestration Agent
- Background service that runs continuously
- Automatically schedules jobs when resources available
- Handles job failures with retries
- Enforces scheduling policies

## Usage Examples

### Submit a Training Job

```python
import requests

response = requests.post("http://localhost:10000/queue/submit", json={
    "run_id": "bert-training",
    "user": "researcher1",
    "command": "python train.py --model bert-large --epochs 10",
    "gpu_count": 4,
    "gpu_memory_gb": 40,
    "priority": 3,
    "estimated_duration_seconds": 3600,
})

job_id = response.json()["job_id"]
print(f"Job submitted: {job_id}")
```

### Monitor Queue

```python
import requests

response = requests.get("http://localhost:10000/queue")
queue_state = response.json()

print(f"Queued jobs: {len(queue_state['queued'])}")
print(f"Running jobs: {len(queue_state['running'])}")
```

### Check GPU Status

```python
import requests

response = requests.get("http://localhost:10000/gpu/status")
status = response.json()

print(f"Available GPUs: {status['cluster_status']['available_gpus']}")
print(f"Utilization: {status['cluster_status']['utilization_percent']}%")
```

## Next Steps

1. **Frontend UI**: Web interface for monitoring and control
2. **Ray Integration**: Connect to Ray cluster for distributed execution
3. **Real GPU Monitoring**: Integrate nvidia-smi or DCGM for actual GPU metrics
4. **Advanced Policies**: ML-based scheduling optimization
5. **Multi-Cluster**: Support for federated GPU resources

## Troubleshooting

### Orchestrator Not Starting

Check that GPU orchestration is enabled:
```bash
echo $RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED
```

### Jobs Not Being Scheduled

1. Check orchestrator is running: `GET /orchestrator/status`
2. Check available GPUs: `GET /gpu/status`
3. Check queue state: `GET /queue`
4. Look at server logs for errors

### API Errors

If using authentication, include the auth token:
```bash
curl -H "X-Auth-Token: $RESEARCH_AGENT_USER_AUTH_TOKEN" \
  http://localhost:10000/queue
```

## Support

- Issues: `.dev/gpu_orchestration_issue.md`
- Design: `.dev/gpu_orchestration_design.md`
- Tests: `tests/test_gpu_orchestration.py`
- Demo: `tests/demo_gpu_orchestration.py`
