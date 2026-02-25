# GPU Discovery & Parallel Scheduling

## Discovery

Before launching experiment grids, detect capacity:

```bash
curl -X POST {{server_url}}/cluster/detect {{auth_header}}
curl -X GET {{server_url}}/cluster {{auth_header}}
curl -X GET {{server_url}}/wild/v2/system-health {{auth_header}}
```

Use `cluster.type`, `cluster.gpu_count`, and `system-health.running`.

## Parallelism Formula

```
g = max(1, gpu_count)           # local GPU
g = max(1, gpu_count or 4)      # Slurm (conservative default)
r = current running runs
q = ready/queued runs
max_new_runs = max(0, min(q, g - r))
```

Start up to `max_new_runs` additional runs now.

## Scheduling by Cluster Type

| Cluster | Strategy |
|---------|----------|
| **Local GPU** | Pin per GPU: `CUDA_VISIBLE_DEVICES=0`, `CUDA_VISIBLE_DEVICES=1`, ... |
| **Slurm** | Include scheduler flags (`--gres=gpu:1`, partition/account/qos). Let scheduler place jobs. |
| **CPU-only** | Low parallelism. No GPU flags. |

## Launch Pattern

1. Create sweep → 2. Create runs per config → 3. Compute `max_new_runs` → 4. Start with `auto_start=true` or `POST /runs/{id}/start` → 5. Monitor via `GET /runs`.
