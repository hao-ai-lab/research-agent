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

{{memories}}

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
