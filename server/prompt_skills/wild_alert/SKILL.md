---
name: "Wild Loop — Alert"
description: "Alert handling prompt. Guides the agent to analyze and resolve experiment alerts using the resolve_alert tag protocol and the server API."
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
    "alert_resolve_example",
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

### Useful Endpoints for This Stage

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/alerts/{id}/respond` | POST | Resolve this alert with a choice |
| `/runs/{id}/logs` | GET | Get logs for the alerting run |
| `/runs/{id}/rerun` | POST | Rerun the alerting run with fixes |
| `/runs/{id}/stop` | POST | Stop the alerting run |

### Standard Operating Procedure

1. **Diagnose**: Read the alert message and fetch run logs if needed
2. **Decide**: Choose the best course of action from the available choices
3. **Resolve**: Either use the `<resolve_alert>` tag OR call `POST /alerts/{{alert_id}}/respond` directly
4. **Fix**: If the issue needs a code fix, explain what you'd change and optionally rerun

## How to Resolve This Alert

You MUST resolve this alert by outputting a `<resolve_alert>` tag with your chosen action:

```
<resolve_alert>
{{alert_resolve_example}}
</resolve_alert>
```

Or resolve via the API:

```bash
curl -s -X POST "{{server_url}}/alerts/{{alert_id}}/respond" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: {{auth_token}}" \
  -d '{"choice": "ONE_OF_THE_CHOICES_ABOVE"}'
```

## Output Requirements

At the end of your response, output these structured tags:

1. **Resolve** — output the `<resolve_alert>` tag with your chosen action
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
   Valid roles: `exploring`, `monitoring`, `analyzing`, `alert`
