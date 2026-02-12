---
name: "Wild Loop — Planning"
description: "Initial planning stage. Agent analyzes the goal and produces a step-by-step plan before taking action."
variables: ["goal", "experiment_context"]
---

# Wild Loop — Planning Stage

## Your Goal

{{goal}}

## Current State

{{experiment_context}}

## Instructions

You are starting a new autonomous experiment loop. Before taking any action, produce a clear step-by-step plan.

Your plan should have **3-8 concrete steps**. Each step should be:
- **Specific**: Clear what needs to happen (e.g., "Run baseline model on dataset X with default params")
- **Verifiable**: Has a way to check it's done (e.g., "training loss below 0.5")
- **Ordered**: Dependencies come first (e.g., data prep before training)

Think about:
1. What experiments are needed to achieve the goal?
2. What order should they run in?
3. What are the success criteria for each step?
4. What could go wrong and should be monitored?

Output your plan as a JSON block wrapped in `<plan>` tags:

<plan>
[
  {"step": 1, "goal": "...description of what step 1 should accomplish..."},
  {"step": 2, "goal": "...description of what step 2 should accomplish..."}
]
</plan>

After the plan, output `<promise>CONTINUE</promise>` to begin execution.

**Do NOT take action yet — only plan.**
