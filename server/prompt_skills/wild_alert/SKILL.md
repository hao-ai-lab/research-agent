---
name: "Wild Loop — Alert"
description: "Alert handling prompt. Guides the agent to analyze and resolve experiment alerts using the server API, with awareness of queue and batch processing."
variables:
  [
    "goal",
    "step_goal",
    "iteration",
    "max_iteration",
    "run_name",
    "alert_id",
    "alert_severity",
    "alert_message",
    "alert_choices",
    "server_url",
    "auth_token",
  ]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} — Alert

## User Goal

{{goal}}

## Current Step Goal

{{step_goal}}

## ⚠️ Alert from Run "{{run_name}}"

- **Alert ID**: {{alert_id}}
- **Severity**: {{alert_severity}}
- **Message**: {{alert_message}}
- **Available Choices**: {{alert_choices}}

## Server Access

- **Base URL**: `{{server_url}}`
- **Auth Header**: `X-Auth-Token: {{auth_token}}`
- **API Docs**: `{{server_url}}/docs`

### Alert & Run Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/runs` | GET | **List all runs** — check for other failed/stopped runs |
| `/alerts` | GET | List all alerts (check for other pending alerts to batch-process) |
| `/alerts/{id}/respond` | POST | Resolve an alert with a choice (`{"choice": "..."}`) |
| `/runs/{id}/logs` | GET | Get logs for the alerting run |
| `/runs/{id}/rerun` | POST | Rerun the alerting run with fixes |
| `/runs/{id}/stop` | POST | Stop the alerting run |

### Wild Event Queue Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/wild/events/queue` | GET | View all pending events in the queue |
| `/wild/events/{id}` | GET | Peek at a specific event by ID (see its full prompt/details) |
| `/wild/events/{id}/resolve` | POST | Resolve (consume) a specific event by ID |
| `/wild/events/all` | GET | View all events including resolved (history) |
| `/wild/events/enqueue` | POST | Enqueue a new event (`{priority, title, prompt, type}`) |

## Standard Operating Procedure

### Phase 1 — Diagnose This Alert
1. Read the alert message above. Fetch run logs via `GET /runs/{id}/logs` if needed.
2. Understand what went wrong with this specific run.

### Phase 2 — Get the Global View
3. **Check all runs**: Call `GET /runs` and look for other runs that are `failed` or `stopped`.
4. **Scan the event queue**: Call `GET /wild/events/queue` and look for pending events of type `alert` or `run_event`.
5. **Peek at sibling events**: For each relevant event, call `GET /wild/events/{event_id}` to read the full details.
6. **List all alerts**: Call `GET /alerts` to see if other runs have triggered alerts.

### Phase 3 — Batch-Solve
7. **Identify root cause**: If multiple alerts/failures share the same error (e.g. same config bug, same missing dependency, same OOM), treat them as one issue.
8. **Decide on action**:
   - If one fix resolves all → apply the fix once, then batch-resolve all related alerts & events
   - If the sweep is fundamentally broken → stop all remaining runs via `POST /runs/{id}/stop` to save resources, then fix the code
   - If only this alert is isolated → handle just this one
9. **Resolve alerts**: Call `POST /alerts/{alert_id}/respond` for each alert with the appropriate choice
10. **Mark events resolved**: Call `POST /wild/events/{event_id}/resolve` for each handled event so the loop doesn't re-process them

### How to Resolve This Alert

```bash
curl -s -X POST "{{server_url}}/alerts/{{alert_id}}/respond" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: {{auth_token}}" \
  -d '{"choice": "ONE_OF_THE_CHOICES_ABOVE"}'
```

## Output Requirements

At the end of your response, output these structured tags:

1. **Summary** — a brief summary of what you did this iteration:
   ```
   <summary>Resolved OOM alert on run "lr-0.01" and 2 sibling alerts with same root cause. Stopped affected runs and marked events resolved.</summary>
   ```
2. **Signal** — exactly ONE:
   - `<promise>CONTINUE</promise>` — resolved, continue monitoring
   - `<promise>NEEDS_HUMAN</promise>` — need human input
3. **Next step** — what the next iteration should do:
   ```
   <next_step>Verify the alert resolution took effect and check run status</next_step>
   ```
4. **Next role** — which wild loop role should handle the next step:
   ```
   <next_role>monitoring</next_role>
   ```
   Valid roles: `planning`, `exploring`, `monitoring`, `analyzing`, `alert`, `job_scheduling`
