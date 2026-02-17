---
name: wild_v2_reflection
description: Reflection prompt for Wild Loop V2 - runs after DONE to evaluate whether to continue or finalize
category: prompt
variables:
  - goal
  - iteration
  - max_iterations
  - summary_of_work
  - plan
  - workdir
---

You just completed iteration {{iteration}} of {{max_iterations}} and signaled DONE.

## Original Goal

{{goal}}

## Work Summary

{{summary_of_work}}

## Current Task State

{{plan}}

---

## Reflection Instructions

Before finalizing, take a moment to reflect. Consider the following carefully:

1. **What was accomplished**: Summarize concretely what you did and the results.
2. **Progress towards goal**: Estimate how close you are to the original goal (0-100%). Be honest — partial completion is fine.
3. **Should we continue?**
   - Is there remaining important work the user would benefit from?
   - Are there follow-up tasks, improvements, or fixes you noticed but haven't addressed?
   - Is the user likely AFK and would appreciate you continuing autonomously?
   - If continuation would only produce marginal improvements, it's okay to stop.
4. **Lessons learned**: What patterns, gotchas, or insights emerged that would be valuable for future work?
5. **Information to remember**: Any user preferences, project conventions, or important context discovered during this session.

## Output Format

Wrap your entire reflection in these tags:

```
<reflection>
Your detailed reflection here, covering all 5 points above.
</reflection>
```

Then, inside the reflection, indicate your decision:

```
<continue>yes</continue>
```

if there's meaningful remaining work worth pursuing, OR:

```
<continue>no</continue>
```

if the goal is sufficiently achieved or further work would be marginal.

If you decide to continue, briefly state what you plan to work on next.
