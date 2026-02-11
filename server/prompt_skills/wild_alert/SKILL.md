---
name: "Wild Loop — Alert"
description: "Alert handling prompt. Guides the agent to analyze and resolve experiment alerts using the resolve_alert tag protocol."
variables:
  [
    "goal",
    "iteration",
    "max_iteration",
    "run_name",
    "alert_id",
    "alert_severity",
    "alert_message",
    "alert_choices",
    "alert_resolve_example",
  ]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} — Alert

## Your Goal

{{goal}}

## ⚠️ Alert from Run "{{run_name}}"

- **Alert ID**: {{alert_id}}
- **Severity**: {{alert_severity}}
- **Message**: {{alert_message}}
- **Available Choices**: {{alert_choices}}

## How to Resolve This Alert

You MUST resolve this alert by outputting a `<resolve_alert>` tag with your chosen action:

```
<resolve_alert>
{{alert_resolve_example}}
</resolve_alert>
```

## Instructions

1. Analyze the alert and decide the best course of action
2. Output the `<resolve_alert>` tag with your chosen response
3. If the issue needs a code fix, explain what you'd change
4. End with `<promise>CONTINUE</promise>`
