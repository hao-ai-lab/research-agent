---
name: "Wild Loop — Analyzing"
description: "Analysis stage prompt. Triggered when all sweep runs are complete. Guides the agent to review results, query logs/metrics via the server, and determine if the goal is achieved."
variables:
  [
    "goal",
    "step_goal",
    "iteration",
    "max_iteration",
    "sweep_name",
    "total_runs",
    "passed_runs",
    "failed_runs",
    "run_summaries",
    "server_url",
    "auth_token",
  ]
---
# Wild Loop — Iteration {{iteration}}/{{max_iteration}} — Analysis (All Runs Complete)

## User Goal

{{goal}}

## Current Step Goal

{{step_goal}}

## Sweep "{{sweep_name}}" Results

**{{total_runs}} total** — {{passed_runs}} passed, {{failed_runs}} failed

{{run_summaries}}

## Server Access

- **Base URL**: `{{server_url}}`
- **Auth Header**: `X-Auth-Token: {{auth_token}}`
- **API Docs**: `{{server_url}}/docs`

### Useful Endpoints for This Stage

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/runs` | GET | List all runs with status details |
| `/runs/{id}/logs` | GET | Get full logs for any run |
| `/sweeps` | GET | Get sweep progress and metadata |
| `/runs/{id}/rerun` | POST | Rerun a failed run with modifications |
| `/sweeps` | POST | Create a new sweep if more experiments needed |

### Standard Operating Procedure

1. **Review**: Examine the run summaries above — check pass/fail ratios
2. **Deep dive**: Fetch full logs for failed or suspicious runs via `GET /runs/{id}/logs`
3. **Compare**: Look for patterns across runs — what parameters worked best?
4. **Decide**: Is the user goal fully achieved, or are more experiments needed?
5. **Report**: Provide a clear summary with evidence

## Instructions

- Review all run results above
- Determine if the original **User Goal** has been fully achieved
- Provide a clear summary report with evidence

## Output Requirements

At the end of your response, output these structured tags:

1. **Signal** — exactly ONE:
   - `<promise>COMPLETE</promise>` — goal fully achieved with evidence
   - `<promise>CONTINUE</promise>` — more experiments needed
   - `<promise>NEEDS_HUMAN</promise>` — need human input
2. **Next step** (if continuing) — what the next iteration should do:
   ```
   <next_step>Design a follow-up sweep with refined hyperparameters based on the analysis</next_step>
   ```
3. **Next role** (if continuing) — which wild loop role should handle the next step:
   ```
   <next_role>exploring</next_role>
   ```
   Valid roles: `exploring`, `monitoring`, `analyzing`, `alert`
