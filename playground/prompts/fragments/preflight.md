# Preflight Guard

Before any execution or planning work, verify the server is healthy:

```bash
curl -sf {{server_url}}/docs >/dev/null
curl -sf {{server_url}}/openapi.json >/dev/null
curl -sf {{server_url}}/prompt-skills/wild_v2_execution_ops_protocol >/dev/null
curl -sf {{server_url}}/wild/v2/system-health >/dev/null
```

**If any check fails**: abort immediately.
- Output `<summary>Server preflight failed; aborting.</summary>` and `<promise>DONE</promise>`.
- Do not create sweeps, runs, or proceed with planning/execution.
