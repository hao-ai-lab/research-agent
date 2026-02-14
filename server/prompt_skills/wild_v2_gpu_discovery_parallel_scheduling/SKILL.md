---
name: wild_v2_gpu_discovery_parallel_scheduling
description: Protocol for GPU discovery and parallel run scheduling across local GPU and Slurm clusters
category: protocol
variables: []
---

# Wild V2 GPU Discovery and Parallel Scheduling Protocol

Use this protocol before launching experiment grids.

## Goals

- Discover available compute topology (local GPU vs Slurm vs CPU-only).
- Decide safe parallelism.
- Launch multiple runs in parallel when capacity exists.

## Discovery flow

1. Auto-detect cluster:

```bash
curl -X POST "$SERVER_URL/cluster/detect" -H "X-Auth-Token: $AUTH_TOKEN"
```

2. Read cluster and run summary:

```bash
curl -X GET "$SERVER_URL/cluster" -H "X-Auth-Token: $AUTH_TOKEN"
curl -X GET "$SERVER_URL/wild/v2/system-health" -H "X-Auth-Token: $AUTH_TOKEN"
```

Use:
- `cluster.type` (`local_gpu`, `slurm`, `cpu_only`, ...)
- `cluster.gpu_count`
- `run_summary` / system-health running+queued counts

## Parallel scheduling policy

### Local GPU

- If `gpu_count = N`, target at most `N` concurrently running GPU jobs, unless user explicitly wants oversubscription.
- Prefer one run per GPU.
- Encode device selection in each run command, for example:
  - `CUDA_VISIBLE_DEVICES=0 ...`
  - `CUDA_VISIBLE_DEVICES=1 ...`

### Slurm

- Use scheduler flags per run (`--gres=gpu:1`, partition/account/qos as available).
- Submit multiple runs to queue; let scheduler place them.
- Keep run commands explicit and reproducible.

### CPU-only

- Do not force GPU flags.
- Parallelize conservatively based on available cores and memory.

## Grid execution rule

For grid search, create one run per configuration using API.
Launch multiple configurations in the same iteration when capacity allows.

Do not serialize the entire grid one task at a time when idle capacity is available.

## Safety and auditability

- Every run must be created via `POST /runs` (with `sweep_id`).
- Prefer `auto_start=true` when safe parallel capacity exists.
- If capacity is constrained, create runs with `auto_start=false` and start selected runs via `POST /runs/{id}/start`.
- Never bypass API tracking with direct local experiment execution.
