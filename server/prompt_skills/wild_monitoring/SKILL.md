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

### Endpoints for This Stage

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/runs` | GET | **List all runs** — check for other failed/stopped runs |
| `/runs/{{run_id}}/logs` | GET | Get full logs for this run |
| `/runs/{{run_id}}/rerun` | POST | Rerun this run (optionally with modified command) |
| `/runs/{{run_id}}/stop` | POST | Stop this run if still active |
| `/sweeps` | GET | Check overall sweep progress |
| `/sweeps/{id}/runs` | POST | Add a corrective run to a sweep |
| `/alerts` | GET | List all alerts — check for related failures |
| `/wild/events/queue` | GET | View all pending events in the queue |
| `/wild/events/{id}` | GET | Peek at a specific event's full details |
| `/wild/events/{id}/resolve` | POST | Resolve (consume) a specific event |

### Standard Operating Procedure

#### Phase 1 — Diagnose This Event
1. Read the log tail above. Fetch full logs via `GET /runs/{{run_id}}/logs` if needed.
2. Determine if the result is expected or if something went wrong.

#### Phase 2 — Get the Global View
3. **Check all runs**: Call `GET /runs` and look for other runs that are `failed` or `stopped`. Note their IDs.
4. **Check the event queue**: Call `GET /wild/events/queue` and look for pending `run_event` or `alert` events for other runs.
5. **Check alerts**: Call `GET /alerts` for additional pending alerts.
6. **Peek at related events**: For each relevant event, call `GET /wild/events/{event_id}` to read its details.

#### Phase 3 — Batch-Solve
7. **Identify root cause**: If multiple failed runs share the same error (e.g. same missing dependency, same config bug, same OOM), treat them as one issue.
8. **Decide on action**:
   - If one fix resolves all failures → apply the fix once, then rerun all affected runs
   - If the sweep is fundamentally broken → consider stopping all remaining runs via `POST /runs/{id}/stop` to save resources
   - If only this run is affected → handle just this one
9. **Resolve consumed events**: After handling each related event, mark it resolved via `POST /wild/events/{event_id}/resolve` so the loop doesn't process it again.

## Instructions

{{run_instructions}}

## Output Requirements

At the end of your response, output these structured tags:

1. **Summary** — a brief summary of what you did this iteration:
   ```
   <summary>Run "lr-0.01" failed with OOM. Found 2 other runs with same error. Stopped all 3 and identified GPU memory as root cause.</summary>
   ```
2. **Signal** — exactly ONE:
   - `<promise>CONTINUE</promise>` — waiting for more runs or taking action
   - `<promise>COMPLETE</promise>` — goal fully achieved
   - `<promise>NEEDS_HUMAN</promise>` — need human input
3. **Next step** — what the next iteration should focus on:
   ```
   <next_step>Analyze results from all completed runs</next_step>
   ```
4. **Next role** — which wild loop role should handle the next step:
   ```
   <next_role>analyzing</next_role>
   ```
   Valid roles: `planning`, `exploring`, `monitoring`, `analyzing`, `alert`, `job_scheduling`
