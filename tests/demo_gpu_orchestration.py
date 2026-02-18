#!/usr/bin/env python3
"""
Example script demonstrating GPU orchestration API usage.

This script shows how to:
1. Initialize the GPU cluster
2. Submit jobs to the queue
3. Monitor queue status
4. Start the orchestrator
5. Check job progress
"""

import requests
import time
import json


# Configuration
API_URL = "http://localhost:10000"
AUTH_TOKEN = None  # Set if using authentication


def make_request(method, endpoint, **kwargs):
    """Make API request with optional authentication"""
    headers = kwargs.pop("headers", {})
    if AUTH_TOKEN:
        headers["X-Auth-Token"] = AUTH_TOKEN
    
    url = f"{API_URL}{endpoint}"
    response = requests.request(method, url, headers=headers, **kwargs)
    response.raise_for_status()
    return response.json()


def main():
    print("=== GPU Orchestration API Demo ===\n")
    
    # 1. Initialize GPU cluster
    print("1. Initializing GPU cluster (2 nodes, 8 GPUs each)...")
    result = make_request("POST", "/gpu/initialize", 
                         json={"node_count": 2, "gpus_per_node": 8})
    print(f"   Cluster initialized: {result['cluster_status']['total_gpus']} total GPUs")
    print()
    
    # 2. Check initial GPU status
    print("2. Checking GPU status...")
    status = make_request("GET", "/gpu/status")
    print(f"   Total GPUs: {status['cluster_status']['total_gpus']}")
    print(f"   Available: {status['cluster_status']['available_gpus']}")
    print(f"   Allocated: {status['cluster_status']['allocated_gpus']}")
    print()
    
    # 3. Submit jobs to queue
    print("3. Submitting jobs to queue...")
    jobs = []
    
    job_configs = [
        {"name": "experiment-1", "gpus": 2, "priority": 2, "command": "python train.py --model resnet50"},
        {"name": "experiment-2", "gpus": 4, "priority": 3, "command": "python train.py --model bert-large"},
        {"name": "experiment-3", "gpus": 1, "priority": 2, "command": "python train.py --model vit-small"},
    ]
    
    for config in job_configs:
        result = make_request("POST", "/queue/submit", json={
            "run_id": config["name"],
            "user": "demo-user",
            "command": config["command"],
            "gpu_count": config["gpus"],
            "gpu_memory_gb": 0,
            "priority": config["priority"],
        })
        jobs.append(result["job_id"])
        print(f"   Submitted {config['name']}: job_id={result['job_id']}, queue_position={result['queue_position']}")
    print()
    
    # 4. Check queue state
    print("4. Checking queue state...")
    queue = make_request("GET", "/queue")
    print(f"   Queued jobs: {len(queue['queued'])}")
    for job in queue['queued']:
        print(f"     - {job['run_id']}: {job['gpu_count']} GPUs, priority={job['priority']}")
    print()
    
    # 5. Start orchestrator
    print("5. Starting orchestration agent...")
    result = make_request("POST", "/orchestrator/start")
    print(f"   Agent status: {result['status']['running']}")
    print()
    
    # 6. Monitor orchestrator status
    print("6. Monitoring orchestrator (5 seconds)...")
    for i in range(5):
        time.sleep(1)
        status = make_request("GET", "/orchestrator/status")
        print(f"   Cycle {i+1}: {status['stats']['scheduling_cycles']} cycles, " +
              f"{status['queue_summary']['running']} running, " +
              f"{status['queue_summary']['queued']} queued")
    print()
    
    # 7. Check final GPU status
    print("7. Final GPU status...")
    status = make_request("GET", "/gpu/status")
    print(f"   Total GPUs: {status['cluster_status']['total_gpus']}")
    print(f"   Available: {status['cluster_status']['available_gpus']}")
    print(f"   Allocated: {status['cluster_status']['allocated_gpus']}")
    print(f"   Utilization: {status['cluster_status']['utilization_percent']}%")
    print()
    
    # 8. Check queue statistics
    print("8. Queue statistics...")
    stats = status['queue_stats']
    print(f"   Total jobs: {stats['total_jobs']}")
    print(f"   Queued: {stats['queued']}")
    print(f"   Running: {stats['running']}")
    print(f"   Completed: {stats['completed']}")
    print()
    
    # 9. Stop orchestrator
    print("9. Stopping orchestration agent...")
    result = make_request("POST", "/orchestrator/stop")
    print(f"   Agent stopped")
    print()
    
    print("=== Demo Complete ===")


if __name__ == "__main__":
    try:
        main()
    except requests.exceptions.ConnectionError:
        print("Error: Could not connect to server. Make sure the server is running:")
        print("  cd server && python server.py --workdir /tmp/test-workdir")
        print("\nAnd enable GPU orchestration:")
        print("  export RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED=true")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
