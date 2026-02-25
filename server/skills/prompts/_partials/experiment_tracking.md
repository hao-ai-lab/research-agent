## 🚨 CRITICAL: Formal Experiment Tracking

> **NEVER run training, evaluation, or experiment scripts directly (e.g. `python train.py`, `bash run.sh`, `torchrun ...`).**
> **ALL experiments MUST be tracked through the server API.**
> **Runs not created via API are invisible to users and not auditable.**

Read and follow the mandatory execution ops protocol:
- `GET {{server_url}}/prompt-skills/wild_v2_execution_ops_protocol`

### Creating a sweep

```bash
curl -X POST {{server_url}}/sweeps/wild \
  -H "Content-Type: application/json" \
  {{auth_header}} \
  -d '{"name": "sweep-name", "goal": "what this tests", "chat_session_id": "{{session_id}}"}'
```

### Creating a run

```bash
curl -X POST {{server_url}}/runs \
  -H "Content-Type: application/json" \
  {{auth_header}} \
  -d '{"name": "trial-name", "command": "cd {{workdir}} && python train.py --lr 0.001", "sweep_id": "<sweep_id>", "chat_session_id": "{{session_id}}", "auto_start": true}'
```

### Grid search

- One configuration = one run.
- Create multiple runs via repeated `POST {{server_url}}/runs`, one per config.
- Do not wrap grid search in a local shell loop that bypasses the API.

### Parallel execution

Detect capacity before launching many runs:

```bash
curl -X POST {{server_url}}/cluster/detect {{auth_header}}
curl -X GET {{server_url}}/cluster {{auth_header}}
curl -X GET {{server_url}}/wild/v2/system-health {{auth_header}}
```

- If capacity exists, launch multiple runs in parallel in the same iteration.
- Local multi-GPU: pin run commands to different GPUs.
- Slurm: submit multiple resource-scoped runs and let scheduler place them.
- Avoid unnecessary serialization when idle GPUs are available.
- Recommended parallelism formula:
  - `g = max(1, gpu_count)` for local GPU
  - `g = max(1, gpu_count or 4)` for Slurm
  - `r = current running runs`
  - `q = ready/queued runs`
  - `max_new_runs = max(0, min(q, g - r))`
- Start up to `max_new_runs` runs now.

### Monitoring

```bash
curl -X GET {{server_url}}/runs {{auth_header}}
```
