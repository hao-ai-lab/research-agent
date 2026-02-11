---
name: "Wild Loop — Monitoring (Run Event)"
description: "Run event monitoring prompt. Triggered when a run finishes or fails, providing log tails and sweep status for the agent to analyze."
variables:
  [
    "goal",
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
  ]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} — Run Event (Monitoring)

## Your Goal

{{goal}}

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

## Instructions

{{run_instructions}}

- End with `<promise>CONTINUE</promise>`
