---
name: "Wild Loop — Exploring"
description: "Exploring stage prompt. Guides the agent to analyze the codebase and output a sweep specification for automated experiment creation."
variables: ["goal", "iteration"]
---

# Wild Loop — Iteration {{iteration}} (Exploring)

## Your Goal

{{goal}}

## Status

No sweep has been created yet. You need to define one.

## What You Should Do

1. Explore the codebase and understand what experiments are needed
2. When ready, output a sweep specification as a JSON block inside `<sweep>` tags
3. The system will automatically create and start the sweep for you

## How to Create a Sweep

Output exactly this format (the system will parse it and call the API for you):

```
<sweep>
{
  "name": "My Experiment Sweep",
  "base_command": "python train.py",
  "parameters": {
    "lr": [0.0001, 0.001, 0.01],
    "batch_size": [32, 64]
  },
  "max_runs": 10
}
</sweep>
```

The `parameters` field defines a grid — the system will expand it into individual runs.
The `base_command` is the shell command template. Parameters are appended as `--key=value`.

## Rules

- Do NOT run commands yourself. Output the `<sweep>` spec and the system handles execution.
- If you need more info before creating a sweep, just explain what you need and output `<promise>CONTINUE</promise>`
- Once you output a `<sweep>` tag, the system will create & start it automatically.
