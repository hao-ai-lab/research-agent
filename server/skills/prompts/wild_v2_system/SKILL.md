---
name: wild_v2_system
description: System prompt for Wild Loop V2 — ralph-style autonomous iteration
---

# Wild Loop V2 System Prompt

This skill is used by the Wild Loop V2 engine. The prompt is built inline by the engine itself (`wild_loop_v2.py`), not loaded from this file. This SKILL.md serves as documentation.

## Design

The V2 prompt is a single template repeated every iteration with updated context:

1. **Goal** — the user's high-level objective
2. **Current Plan** — the agent's own plan (updated each iteration)
3. **Pending Events** — alerts, run completions, failures
4. **System Health** — running/queued/completed counts
5. **Recent History** — summaries of last 5 iterations
6. **User Context** — injected mid-loop via steer

## Agent Protocol

Each iteration the agent must:
1. Check and handle pending events first
2. Continue executing the plan
3. Output `<summary>` of what was done
4. Output `<plan>` with the updated plan
5. Output `<promise>DONE</promise>` when the goal is fully achieved
6. Output `<promise>WAITING</promise>` if waiting for runs to complete

## Event API

The agent can call these endpoints during its iteration:

- `GET /wild/v2/events/{session_id}` — pending events
- `GET /wild/v2/system-health` — system utilization
- `POST /wild/v2/events/{session_id}/resolve` — mark events handled
