---
name: "Wild Loop — Monitoring (Run Event)"
description: "Run event monitoring prompt. Triggered when a run finishes or fails. Provides log tails, sweep status, and server access for diagnosis and corrective action."
variables:
  [
    "goal",
    "step_goal",
    "iteration",
    "max_iteration",
    "run_name",
    "run_id",
    "run_status",
    "run_command",
    "log_tail",
    "sweep_summary",
    "status_emoji",
    "run_instructions",
    "server_url",
    "auth_token",
  ]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} — Run Event (Monitoring)

## User Goal

{{goal}}

## Current Step Goal

{{step_goal}}

## Event: Run "{{run_name}}" just {{run_status}} {{status_emoji}}

- **ID**: {{run_id}}
- **Status**: {{run_status}}
- **Command**: `{{run_command}}`

### Log Tail (last 1000 chars)

```
{{log_tail}}
```

## Current Sweep Status

{{sweep_summary}}

## Server Access

- **Base URL**: `{{server_url}}`
- **Auth Header**: `X-Auth-Token: {{auth_token}}`
- **API Docs**: `{{server_url}}/docs`

### Useful Endpoints for This Stage

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/runs/{{run_id}}/logs` | GET | Get full logs for this run |
| `/runs/{{run_id}}/rerun` | POST | Rerun this run (optionally with modified command) |
| `/runs` | POST | Create a new corrective run |
| `/runs/{{run_id}}/stop` | POST | Stop this run if still active |
| `/sweeps` | GET | Check overall sweep progress |

### Standard Operating Procedure

1. **Diagnose**: Read the log tail above, fetch full logs if needed via `GET /runs/{{run_id}}/logs`
2. **Decide**: Determine if the result is expected or if corrective action is needed
3. **Act**: If the run failed, consider rerunning with fixes via `POST /runs/{{run_id}}/rerun`
4. **Report**: Summarize findings and next steps

## Instructions

{{run_instructions}}

## Output Requirements

At the end of your response, output these structured tags:

1. **Signal** — exactly ONE:
   - `<promise>CONTINUE</promise>` — waiting for more runs or taking action
   - `<promise>COMPLETE</promise>` — goal fully achieved
   - `<promise>NEEDS_HUMAN</promise>` — need human input
2. **Next step** — what the next iteration should focus on:
   ```
   <next_step>Analyze results from all completed runs</next_step>
   ```
3. **Next role** — which wild loop role should handle the next step:
   ```
   <next_role>analyzing</next_role>
   ```
   Valid roles: `exploring`, `monitoring`, `analyzing`, `alert`
