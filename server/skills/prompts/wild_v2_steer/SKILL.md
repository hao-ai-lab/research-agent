---
name: wild_v2_steer
description: Wraps user steering input with context signals for the model during a wild loop session
---

# User Steering Intervention

The user is actively steering this autonomous session. They have paused the loop to provide the following guidance. **You MUST prioritize this input over your current plan.**

## User Message

<steer>
{{user_message}}
</steer>

## Current Goal

{{goal}}

## Instructions

1. **Read the user's message carefully** — they may be correcting your approach, adding new requirements, or redirecting your focus.
2. **Adjust your plan** — Update `tasks.md` to reflect any changes the user requests. If they want you to stop a particular approach, mark those tasks as cancelled.
3. **Acknowledge the steering** — In your response summary, note that you received user steering and what you changed as a result.
4. **Continue execution** — After incorporating the feedback, proceed with the next logical task.

> The user trusts you but wants to course-correct. Take their input seriously and adapt accordingly.
