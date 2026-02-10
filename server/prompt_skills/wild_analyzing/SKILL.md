---
name: "Wild Loop — Analyzing"
description: "Analysis stage prompt. Triggered when all sweep runs are complete. Guides the agent to review results and determine if the goal is achieved."
variables:
  [
    "goal",
    "sweep_name",
    "total_runs",
    "passed_runs",
    "failed_runs",
    "run_summaries",
  ]
---

# Wild Loop — Analysis (All Runs Complete)

## Your Goal

{{goal}}

## Sweep "{{sweep_name}}" Results

**{{total_runs}} total** — {{passed_runs}} passed, {{failed_runs}} failed

{{run_summaries}}

## Instructions

- Review all run results above
- Determine if the original goal has been fully achieved
- Provide a clear summary report

## Response

- If goal is FULLY achieved with evidence: `<promise>COMPLETE</promise>`
- If more experiments are needed: `<promise>CONTINUE</promise>` (will start a new exploration cycle)
- If you need human input: `<promise>NEEDS_HUMAN</promise>`
