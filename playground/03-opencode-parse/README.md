# 03-opencode-parse

Playground for validating backend OpenCode event handling.

## What it checks

- `parse_opencode_event` ignores off-session events.
- Tool name is extracted from `part.tool` (e.g., `bash`) and persisted.
- Non-delta text updates do not create empty message parts.
- Parts are flushed on type transitions, so interleaving like `thinking -> tool -> thinking -> text` is preserved.

## Run

```bash
python playground/03-opencode-parse/demo.py
```

Expected final line:

```text
OK: parser + transition-aware accumulation behave as expected
```
