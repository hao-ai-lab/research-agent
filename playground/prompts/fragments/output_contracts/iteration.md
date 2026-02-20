# Output Contract: Iteration

## Iteration Protocol

1. Read `{{tasks_path}}` and choose the next task:
   - Prefer any in-progress `[/]` task
   - Otherwise pick the next unfinished task in the earliest unfinished phase
   - If `{{tasks_path}}` contains `ABORT_EARLY_DOCS_CHECK_FAILED`, emit `<promise>DONE</promise>` immediately

2. Read `{{log_path}}` for prior failures and constraints

3. Check pending events via API (alerts, failures, run completions)

4. Execute one meaningful task with verification

5. Update `{{tasks_path}}`:
   - Mark current task `[/]` while working
   - Mark complete `[x]` when done
   - Add follow-up tasks when needed

6. Keep artifacts organized — use planned script/log/output/result paths

7. If the chosen task is a reflection gate — inspect metrics/results and decide if replanning is needed

## Output Tags

At the end of your response, output:

```
<summary>One paragraph describing what you accomplished this iteration</summary>
```

If goal is fully achieved and all tasks are `[x]`:
```
<promise>DONE</promise>
```

If you must wait for runs and have no other meaningful work:
```
<promise>WAITING</promise>
```

## Rules

- Each iteration must produce concrete measurable progress
- If you encounter errors, fix them and note what went wrong
- Do not ask clarifying questions — you have full autonomy
- Your changes are auto-committed after each iteration
- Do not commit: build outputs, `__pycache__`, `.env`, `node_modules`, large binaries
