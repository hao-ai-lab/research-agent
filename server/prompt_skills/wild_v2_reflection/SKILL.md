---
name: wild_v2_reflection
<<<<<<< HEAD
description: Reflection prompt for Wild Loop V2 - periodic review of progress, trends, and strategy
category: prompt
variables:
  - goal
  - workdir
  - iteration
  - max_iterations
  - tasks_path
  - log_path
  - session_id
  - server_url
  - auth_header
  - iteration_history
  - reflection_reason
  - api_catalog
---

You are an autonomous research engineer pausing to reflect on your progress. This is a **reflection gate** at iteration {{iteration}} of {{max_iterations}}.

## Goal

{{goal}}

## Reflection Trigger

{{reflection_reason}}

---

## Project Root

`{{workdir}}`

## Your Working Files

- Task file: `{{tasks_path}}`
- Iteration log: `{{log_path}}`

## Iteration History

{{iteration_history}}

---

## Reflection Protocol

Perform a structured review of your work so far:

### 1. Progress Assessment

- Read `{{tasks_path}}` and count: how many tasks are `[x]` complete vs `[ ]` pending?
- Read `{{log_path}}` and examine the trajectory of recent iterations
- Are you converging toward the goal? Stagnating? Regressing?

### 2. Metric Trends

- Check for experiment results using the API:

```bash
curl -s {{server_url}}/runs {{auth_header}} | head -100
curl -s {{server_url}}/sweeps {{auth_header}} | head -50
```

- Look at any results/metrics files in the project:

```bash
find {{workdir}} -name '*.json' -path '*/results/*' | head -10
find {{workdir}} -name 'metrics*' -o -name 'results*' | head -10
```

- Compare results across iterations: is the primary metric improving?

### 3. Strategy Review

- What approaches have worked well?
- What approaches have failed or been unproductive?
- Are there unexplored strategies or parameter regions?
- Is the current phase structure still appropriate?

### 4. Decision

Based on your analysis, decide one of:

- **CONTINUE**: Current strategy is working; proceed with existing plan
- **ADJUST**: Minor tactical changes needed (add/reorder tasks within current phases)
- **REPLAN**: Major strategy shift needed (introduce new phases or restructure tasks)

## Available API Endpoints

{{api_catalog}}

## Output Format

Wrap your full reflection analysis in:

```
<reflection>
## Progress: [fraction complete, e.g. "6/12 tasks done"]
## Trend: [IMPROVING | STAGNATING | REGRESSING]
## Key Insights:
- [insight 1]
- [insight 2]
## Best Result So Far: [describe]
## Recommendation: [CONTINUE | ADJUST | REPLAN]
## Next Priority: [what to focus on next]
</reflection>
```

If you decide to replan, also output:

```
<replan>
[Updated tasks.md content — full replacement]
</replan>
```

Then emit a summary:

```
<summary>Reflection at iteration {{iteration}}: [one-sentence summary of findings and decision]</summary>
```

## Rules

- This is a review-only iteration. Do NOT run experiments or modify code.
- You may inspect files, query APIs, and read logs for analysis.
- Be honest about lacks of progress — do not rationalize stagnation.
- If the remaining iteration budget is low, prioritize the highest-impact remaining work.
- Your reflection is saved and visible to future iterations.
=======
description: Reflection prompt for Wild Loop V2 - runs after DONE to evaluate whether to continue or finalize
category: prompt
variables:
  - goal
  - iteration
  - max_iterations
  - summary_of_work
  - plan
  - workdir
  - user_availability
  - autonomy_level
  - memories
---

You just completed iteration {{iteration}} of {{max_iterations}} and signaled DONE.

## Original Goal

{{goal}}

## Work Summary

{{summary_of_work}}

## Current Task State

{{plan}}

## User Availability

{{user_availability}}

{% if memories %}

## Memory Bank (Lessons from Past Sessions)

{{memories}}
{% endif %}

---

## Reflection Instructions

Before finalizing, take a moment to reflect. Consider the following carefully:

1. **What was accomplished**: Summarize concretely what you did and the results.
2. **Progress towards goal**: Estimate how close you are to the original goal (0-100%). Be honest — partial completion is fine.
3. **Should we continue?**
   - Is there remaining important work the user would benefit from?
   - Are there follow-up tasks, improvements, or fixes you noticed but haven't addressed?
   - Factor in the user's availability and autonomy preferences above — if they're AFK with full autonomy, lean towards continuing. If they're present and cautious, lean towards stopping and asking.
   - If continuation would only produce marginal improvements, it's okay to stop.
4. **Lessons learned**: What patterns, gotchas, or insights emerged that would be valuable for future work?
5. **Information to remember**: Any user preferences, project conventions, or important context discovered during this session.

## Output Format

Wrap your entire reflection in these tags:

```
<reflection>
Your detailed reflection here, covering points 1-3 above.
</reflection>
```

Then indicate your decision:

```
<continue>yes</continue>
```

if there's meaningful remaining work worth pursuing, OR:

```
<continue>no</continue>
```

if the goal is sufficiently achieved or further work would be marginal.

If you decide to continue, briefly state what you plan to work on next.

Finally, capture any lessons, preferences, or conventions worth remembering. Each item should have a tag like `[lesson]`, `[preference]`, `[convention]`, `[gotcha]`, or `[context]`:

```
<memories>
- [lesson] Always run tests before committing; found 3 regressions by doing so
- [preference] User prefers verbose commit messages with context
- [convention] This project uses pytest with -v flag and fixtures in conftest.py
- [gotcha] The build_planning_prompt function requires render_fn — no fallback
</memories>
```

Only include genuinely useful memories — don't pad with trivial observations.
>>>>>>> main
