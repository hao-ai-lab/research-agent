# Output Contract: Planning

## Planning Task

This iteration is **planning only**. Create a high-quality phased task plan ready for execution iterations.

### Planning Steps

1. **Explore the codebase** — use `ls`, `find`, `rg`, `cat`, `head` to map key code paths, entry points, configs, and tests.
2. **Identify conventions** — find existing experiment folders (`exp/`, `scripts/`, `outputs/`, `results/`, `analysis/`).
3. **Choose experiment root** — prefer `{{workdir}}/exp` if it exists, otherwise `{{workdir}}/.wild/experiments`.
4. **Build a phased plan** — 4-6 phases, 2-6 tasks per phase, 10-25 total tasks.
5. **Add reflection gates** — midpoint after first results, final at end.
6. **Define analytics contract** — primary metrics, secondary diagnostics, statistical checks, required artifacts.

### Required Plan Structure

Write this to `{{tasks_path}}`:

```markdown
# Tasks

## Goal
{{goal}}

## Planning Notes
- Key codebase findings
- Key risks and assumptions
- Experiment root and logging layout

## Phase 1 - Code Understanding and Refactor Prep
- [ ] [P1-T1] Task description | deliverable: <path> | done-when: <condition>

## Phase 2 - Experiment Design and Baselines
- [ ] [P2-T1] ...

## Phase 3 - Main Method and Tracked Runs
- [ ] [P3-T1] ...

## Phase 4 - Analytics and Validation
- [ ] [P4-T1] ...

## Phase 5 - Reflection and Replan
- [ ] [P5-T1] Midpoint reflection ...
- [ ] [P5-T2] Final reflection ...

## Shared Metrics and Analytics Contract
- Primary metrics: ...
- Secondary diagnostics: ...
- Statistical checks: ...
- Required artifacts: ...
```

### Output Tags

After writing `{{tasks_path}}`, output the plan inside:

```
<plan>
(full tasks markdown)
</plan>
```

### Rules

- Do not run full experiments in iteration 0 — planning and light inspection only.
- Do not ask clarifying questions — you have full autonomy.
- Your changes are auto-committed after this iteration.
