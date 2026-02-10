#!/bin/bash
#
# GPU Orchestration Demo Workflow
#
# This script demonstrates the complete workflow for using GPU orchestration:
# 1. Initialize the cluster
# 2. Submit multiple jobs
# 3. Start the orchestrator
# 4. Monitor progress
# 5. Check results
#
# Prerequisites:
# - Server running on localhost:10000
# - RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED=true
#

set -e

API_URL="http://localhost:10000"
AUTH_TOKEN="${RESEARCH_AGENT_USER_AUTH_TOKEN:-}"

# Helper function for API calls
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    
    local headers="-H 'Content-Type: application/json'"
    if [ -n "$AUTH_TOKEN" ]; then
        headers="$headers -H 'X-Auth-Token: $AUTH_TOKEN'"
    fi
    
    if [ -n "$data" ]; then
        curl -s -X "$method" "$API_URL$endpoint" $headers -d "$data"
    else
        curl -s -X "$method" "$API_URL$endpoint" $headers
    fi
}

echo "===================================================="
echo "GPU Orchestration Demo Workflow"
echo "===================================================="
echo ""

# Check if server is running
echo "→ Checking server connection..."
if ! curl -s "$API_URL/health" > /dev/null 2>&1; then
    echo "✗ Server not responding at $API_URL"
    echo "  Please start the server first:"
    echo "  export RESEARCH_AGENT_GPU_ORCHESTRATION_ENABLED=true"
    echo "  cd server && python server.py --workdir /tmp/test-workdir"
    exit 1
fi
echo "✓ Server is running"
echo ""

# Initialize GPU cluster
echo "→ Initializing GPU cluster..."
result=$(api_call POST "/gpu/initialize" '{"node_count": 2, "gpus_per_node": 8}')
total_gpus=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['cluster_status']['total_gpus'])")
echo "✓ Cluster initialized with $total_gpus GPUs"
echo ""

# Submit jobs
echo "→ Submitting experiment jobs..."

jobs=(
    "experiment-1:python train.py --model resnet50:2:3"
    "experiment-2:python train.py --model bert-base:4:2"
    "experiment-3:python train.py --model vit-small:1:2"
    "experiment-4:python train.py --model gpt2-medium:8:3"
)

job_ids=()
for job_spec in "${jobs[@]}"; do
    IFS=':' read -r name command gpus priority <<< "$job_spec"
    
    result=$(api_call POST "/queue/submit" "{
        \"run_id\": \"$name\",
        \"user\": \"demo-user\",
        \"command\": \"$command\",
        \"gpu_count\": $gpus,
        \"priority\": $priority
    }")
    
    job_id=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['job_id'])")
    job_ids+=("$job_id")
    
    echo "  ✓ $name submitted (job_id: ${job_id:0:8}..., $gpus GPUs, priority: $priority)"
done
echo ""

# Check queue state
echo "→ Current queue state..."
result=$(api_call GET "/queue")
queued=$(echo "$result" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['queued']))")
echo "  Queued jobs: $queued"
echo ""

# Start orchestrator
echo "→ Starting orchestration agent..."
api_call POST "/orchestrator/start" > /dev/null
echo "✓ Orchestrator started"
echo ""

# Monitor progress
echo "→ Monitoring orchestration (10 seconds)..."
for i in {1..10}; do
    result=$(api_call GET "/orchestrator/status")
    running=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['queue_summary']['running'])")
    queued=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['queue_summary']['queued'])")
    cycles=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['stats']['scheduling_cycles'])")
    
    echo "  [${i}/10] Cycles: $cycles | Running: $running | Queued: $queued"
    sleep 1
done
echo ""

# Check GPU status
echo "→ Final GPU status..."
result=$(api_call GET "/gpu/status")
available=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['cluster_status']['available_gpus'])")
allocated=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['cluster_status']['allocated_gpus'])")
utilization=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['cluster_status']['utilization_percent'])")

echo "  Total GPUs: $total_gpus"
echo "  Available: $available"
echo "  Allocated: $allocated"
echo "  Utilization: $utilization%"
echo ""

# Show queue statistics
echo "→ Queue statistics..."
stats=$(echo "$result" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['queue_stats'], indent=2))")
echo "$stats" | grep -E '"(total_jobs|queued|running|completed)"' | sed 's/^/  /'
echo ""

# Stop orchestrator
echo "→ Stopping orchestration agent..."
api_call POST "/orchestrator/stop" > /dev/null
echo "✓ Orchestrator stopped"
echo ""

echo "===================================================="
echo "Demo Complete!"
echo "===================================================="
echo ""
echo "Next steps:"
echo "  - Check queue details: curl $API_URL/queue"
echo "  - Monitor GPU status: curl $API_URL/gpu/status"
echo "  - View orchestrator status: curl $API_URL/orchestrator/status"
echo ""
