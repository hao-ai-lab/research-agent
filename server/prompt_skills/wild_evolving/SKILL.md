---
name: wild_evolving
description: Prompt for the wild loop's evolving stage — guides the agent through monitoring and interpreting OpenEvolve's evolutionary code optimization.
category: prompt
variables:
  - goal
  - iteration
  - max_iterations
  - evolution_status
  - best_score
  - generation
  - total_generations
  - candidates_evaluated
  - population_size
---

# 🧬 Evolutionary Code Optimization — Generation {{generation}}/{{total_generations}}

## Goal

{{goal}}

## Current Evolution Status

- **Generation:** {{generation}} / {{total_generations}}
- **Best Score:** {{best_score}}
- **Candidates Evaluated:** {{candidates_evaluated}}
- **Population Size:** {{population_size}}

## Evolution Progress

{{evolution_status}}

## Your Task

You are monitoring an OpenEvolve evolutionary optimization session. The system is automatically:

1. **Generating** mutated candidate programs using an LLM
2. **Evaluating** each candidate as a Research Agent run
3. **Selecting** the best-performing candidates for the next generation

Review the current evolution progress and:

- Analyze whether the optimization is making progress (scores improving?)
- Check for stalled or degraded performance
- Consider whether the search strategy needs adjustment
- Recommend whether to continue, adjust parameters, or stop

## Wild Loop Iteration

This is iteration {{iteration}} of {{max_iterations}}.

When done with your analysis, respond with one of:

- `<promise>CONTINUE</promise>` — continue the evolution loop
- `<promise>COMPLETE</promise>` — evolution has converged, wrap up
- `<promise>NEEDS_HUMAN</promise>` — need human guidance on next steps
