---
name: wild_v2_sweep_run_audit_protocol
description: Mandatory protocol for creating auditable experiments via sweep/run endpoints in Wild V2
category: protocol
variables: []
---

# Wild V2 Sweep/Run Audit Protocol

This protocol is mandatory for experiment execution in Wild V2.

## Why this exists

Only runs created through server sweep/run endpoints are visible to users in the UI and audit logs.

If you execute experiments directly in shell (for example `python train.py ...`, `bash run.sh`, `torchrun ...`) without creating runs through the API:
- users cannot see progress in the run dashboard
- metadata is missing from experiment tracking
- results are not reliably auditable

Treat local direct execution as non-compliant.

## Required behavior

1. Create or reuse a sweep as a user-visible container for related runs.
2. Create every experiment trial as a run attached to that sweep.
3. Monitor run status via API endpoints.
4. Keep commands reproducible (fixed script paths, seeds, log/output paths).
5. Include `chat_session_id` in all sweep/run creation request bodies.

## Canonical flow

### Step 1: create sweep

```bash
curl -X POST "$SERVER_URL/sweeps/wild" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: $AUTH_TOKEN" \
  -d '{
    "name": "mnist-mlp-cpu-grid",
    "goal": "one-layer MLP grid search on MNIST CPU",
    "chat_session_id": "$CHAT_SESSION_ID"
  }'
```

Extract `id` from response as `SWEEP_ID`.

### Step 2: create runs

```bash
curl -X POST "$SERVER_URL/runs" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: $AUTH_TOKEN" \
  -d "{
    \"name\": \"mnist-mlp-lr1e-2-bs128-seed1\",
    \"command\": \"cd /path/to/workdir && python scripts/train_mnist_mlp.py --lr 1e-2 --batch-size 128 --seed 1 --device cpu --log-dir exp/logs --out-dir exp/outputs\",
    \"sweep_id\": \"${SWEEP_ID}\",
    \"chat_session_id\": \"$CHAT_SESSION_ID\",
    \"auto_start\": true
  }"
```

Repeat once per grid combination.

### Step 3: monitor

```bash
curl -X GET "$SERVER_URL/runs" -H "X-Auth-Token: $AUTH_TOKEN"
curl -X GET "$SERVER_URL/sweeps/$SWEEP_ID" -H "X-Auth-Token: $AUTH_TOKEN"
curl -X GET "$SERVER_URL/wild/v2/system-health" -H "X-Auth-Token: $AUTH_TOKEN"
```

## Compliance rule

If a task requires experiment execution, do not proceed until the task plan includes explicit sweep/run API calls.

If you discover an existing run command that executes locally without API registration, convert it into a run creation call instead.
