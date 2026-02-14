---
name: wild_v2_execution_ops_protocol
description: Single source of truth protocol for Wild V2 preflight, sweep/run auditability, GPU discovery, and parallel scheduling
category: protocol
variables: []
---

# Wild V2 Execution Ops Protocol

This is the canonical protocol for execution operations in Wild V2.
Use this skill as the source of truth instead of duplicating long operational instructions in prompts.

## A. Preflight

Before planning or execution, verify:

```bash
curl -sf "$SERVER_URL/docs" >/dev/null
curl -sf "$SERVER_URL/openapi.json" >/dev/null
curl -sf "$SERVER_URL/prompt-skills/wild_v2_execution_ops_protocol" >/dev/null
curl -sf "$SERVER_URL/wild/v2/system-health" >/dev/null
```

If preflight fails, abort loop work immediately.

## B. Auditability Rules

- Every experiment trial must be a run created through `POST /runs`.
- Runs must be attached to a sweep (`sweep_id`) created via `POST /sweeps/wild`.
- Direct local execution without API run creation is non-compliant and not user-auditable.

## C. Grid Search Rule

- One configuration = one run.
- For grid search, create multiple runs (repeat `POST /runs`), one per config.

## D. Cluster/GPU Discovery

```bash
curl -X POST "$SERVER_URL/cluster/detect" -H "X-Auth-Token: $AUTH_TOKEN"
curl -X GET "$SERVER_URL/cluster" -H "X-Auth-Token: $AUTH_TOKEN"
curl -X GET "$SERVER_URL/wild/v2/system-health" -H "X-Auth-Token: $AUTH_TOKEN"
```

Use:
- `cluster.type`
- `cluster.gpu_count`
- `system-health.running`

## E. Recommended Parallelism Formula

Let:
- `g = max(1, cluster.gpu_count or 1)` for `local_gpu`
- `g = max(1, cluster.gpu_count or 4)` for `slurm` (conservative default if unknown)
- `g = 1` for `cpu_only` or unknown
- `r = system_health.running`
- `q = number_of_ready_or_queued_runs`

Then:

```text
target_parallel = g
max_new_runs = max(0, min(q, target_parallel - r))
```

Interpretation:
- Start up to `max_new_runs` additional runs now.
- If `max_new_runs == 0`, wait or stop low-priority runs before starting more.

## F. Scheduling Guidance

- Local multi-GPU: pin run commands per GPU (`CUDA_VISIBLE_DEVICES=i`).
- Slurm: include scheduler resource flags in command and allow queue placement.
- CPU-only: keep low parallelism unless clearly safe.

## G. Practical Launch Pattern

1. Create sweep.
2. Create run per config.
3. Compute `max_new_runs`.
4. If capacity available:
   - set `auto_start=true` for up to `max_new_runs`, or
   - create as ready and call `POST /runs/{id}/start` for selected runs.
5. Monitor via `GET /runs` and `GET /wild/v2/system-health`.
