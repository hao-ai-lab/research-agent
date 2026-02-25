# Output Contract: Reflection

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

Consider the following carefully:

1. **What was accomplished**: Summarize concretely what you did and the results.
2. **Progress towards goal**: Estimate 0-100% completion. Be honest — partial completion is fine.
3. **Should we continue?**
   - Is there remaining important work the user would benefit from?
   - Are there follow-up tasks, improvements, or fixes you noticed?
   - Factor in user availability: AFK + full autonomy → lean continue. Present + cautious → lean stop.
   - If continuation would only produce marginal improvements, stop.
4. **Lessons learned**: Patterns, gotchas, or insights valuable for future work.
5. **Information to remember**: User preferences, project conventions, important context.

## Output Tags

```
<reflection>
Your detailed reflection covering points 1-3.
</reflection>
```

Decision:
```
<continue>yes</continue>
```
or:
```
<continue>no</continue>
```

If continuing, briefly state what you plan to work on next.

Capture genuinely useful memories:
```
<memories>
- [lesson] Always run tests before committing; found 3 regressions
- [preference] User prefers verbose commit messages
- [convention] This project uses pytest with -v flag
- [gotcha] build_planning_prompt requires render_fn — no fallback
</memories>
```

Only include genuinely useful memories — don't pad with trivial observations.
