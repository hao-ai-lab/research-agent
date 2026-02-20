# Archived: `<sweep>` Tag Protocol

> **Status**: ARCHIVED — This protocol has been removed from the active skills.
> The agent should now send sweep specs directly to the sweep creation endpoint
> instead of outputting `<sweep>` XML tags in its response.

## Original Protocol

The agent was instructed to output a sweep specification as a JSON block inside
`<sweep>` tags. The system would then parse the response, extract the JSON, and
call the sweep creation API on behalf of the agent.

### Format

```
<sweep>
{
  "name": "My Experiment Sweep",
  "base_command": "python train.py",
  "parameters": {
    "lr": [0.0001, 0.001, 0.01],
    "batch_size": [32, 64]
  },
  "max_runs": 10
}
</sweep>
```

### Field Descriptions

- **`name`**: Human-readable name for the sweep
- **`base_command`**: Shell command template. Parameters are appended as `--key=value`
- **`parameters`**: Grid definition — the system expands it into individual runs
- **`max_runs`**: Maximum number of runs to create

### Rules (Original)

- The agent should NOT run commands itself — output the `<sweep>` spec and the system handles execution
- If the agent needs more info before creating a sweep, explain what's needed and output `<promise>CONTINUE</promise>`
- Once the agent outputs a `<sweep>` tag, the system creates & starts it automatically

## Reason for Archival

The `<sweep>` tag parsing approach was replaced with direct endpoint calls.
The agent now sends the sweep spec JSON directly to the sweep creation endpoint,
removing the need for response-embedded XML tags and server-side parsing.
