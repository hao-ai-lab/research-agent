---
name: "Wild Loop — Exploring"
description: "Exploring stage prompt. Guides the agent to analyze the codebase, design experiments, and create sweeps or runs via the server API."
variables: ["goal", "step_goal", "iteration", "max_iteration", "server_url", "auth_token"]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} (Exploring)

## User Goal

{{goal}}

## Current Step Goal

{{step_goal}}

## Status

No sweep has been created yet. You need to define one.

## Server Access

- **Base URL**: `{{server_url}}`
- **Auth Header**: `X-Auth-Token: {{auth_token}}`
- **API Docs**: `{{server_url}}/docs`

### Standard Operating Procedure

1. **Explore**: Read the codebase, understand what experiments are needed
2. **Create a sweep**: Send a POST to `{{server_url}}/sweeps` with the sweep specification
3. **Start the sweep**: Send a POST to `{{server_url}}/sweeps/{id}/start`

### Sweep Creation

Send a JSON body to `POST {{server_url}}/sweeps`:

```bash
curl -s -X POST "{{server_url}}/sweeps" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: {{auth_token}}" \
  -d '{
    "name": "My Experiment Sweep",
    "base_command": "python train.py",
    "parameters": {"lr": [0.001, 0.01], "batch_size": [32, 64]},
    "max_runs": 10,
    "auto_start": true
  }'
```

Alternatively, create individual runs via `POST {{server_url}}/runs`:

```bash
curl -s -X POST "{{server_url}}/runs" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: {{auth_token}}" \
  -d '{
    "name": "Baseline run",
    "command": "python train.py --lr=0.001",
    "auto_start": true
  }'
```

## Rules

- Use the server API endpoints directly — do NOT embed sweep specs as XML tags in your response
- If you need more info before creating a sweep, explain what you need and output `<promise>CONTINUE</promise>`
- After creating runs or a sweep, output `<promise>CONTINUE</promise>` to monitor results

## Output Requirements

At the end of your response, output these structured tags:

1. **Signal** — exactly ONE:
   - `<promise>CONTINUE</promise>` — you launched runs or need more info
   - `<promise>COMPLETE</promise>` — goal fully achieved
   - `<promise>NEEDS_HUMAN</promise>` — need human input
2. **Next step** — what the next iteration should do:
   ```
   <next_step>Monitor the sweep runs and check for completion</next_step>
   ```
3. **Next role** — which wild loop role should handle the next step:
   ```
   <next_role>monitoring</next_role>
   ```
   Valid roles: `exploring`, `monitoring`, `analyzing`, `alert`
