---
name: "Wild Loop — Exploring"
description: "Exploring stage prompt. Guides the agent to analyze the codebase and send a sweep specification, focused on the current step goal."
variables: ["goal", "step_goal", "iteration", "max_iteration"]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} (Exploring)

## Overall Goal

{{goal}}

## Current Step Focus

{{step_goal}}

## Status

No sweep has been created yet. You need to define one.

## What You Should Do

1. Focus on the **Current Step** above — not the entire goal at once
2. Explore the codebase and understand what experiments are needed for this step
3. When ready, send a sweep specification to the sweep creation endpoint
4. The sweep spec should be a JSON object with the following fields:
   - `name`: Human-readable name for the sweep
   - `base_command`: Shell command template (parameters are appended as `--key=value`)
   - `parameters`: Grid definition — the system expands it into individual runs
   - `max_runs`: Maximum number of runs to create

## Rules

- Send the sweep spec directly to the endpoint — do NOT embed it in your response as XML tags
- If you need more info before creating a sweep, just explain what you need and output `<promise>CONTINUE</promise>`
- After sending the sweep spec, output `<promise>CONTINUE</promise>` to monitor results

## Step Completion

When you finish this step's work, propose what to focus on next:

<next_step>Brief description of what the next iteration should do</next_step>
