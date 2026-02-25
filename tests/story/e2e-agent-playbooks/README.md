# E2E Agent Playbooks

This folder stores story-driven playbooks for chat E2E evaluation.

Run all playbooks:

```bash
python tests/run_chat_playbook.py --playbook tests/story/e2e-agent-playbooks
```

Run one playbook:

```bash
python tests/run_chat_playbook.py --playbook tests/story/e2e-agent-playbooks/gpu-wrapper-gating.json
```

## Playbook schema (JSON)

- `name` (string): playbook identifier.
- `description` (string): scenario summary.
- `server.base_url` (string, optional): backend URL.
- `session` (object, optional): chat session config.
- `defaults.mode` (string, optional): default chat mode.
- `defaults.max_stream_retries` (int, optional): stream reattach attempts.
- `steps` (array, required): ordered interaction turns.
- `evaluation_points` (array, optional): weighted score categories.

### Step

- `id` (string): unique step id.
- `message` (string): user message sent to `/chat`.
- `mode` (string, optional): overrides default mode.
- `prompt_override` (string, optional): optional raw prompt override.
- `assertions` (array, required): checks for this turn.

### Assertion types

- `assistant_contains`
- `assistant_not_contains`
- `assistant_regex`
- `response_is_json`
- `response_json_field_equals`
- `tool_name_contains`
- `tool_name_not_contains`
- `first_token_latency_lt_ms`
- `total_latency_lt_ms`
- `event_type_seen`
- `event_type_not_seen`

### Evaluation point

- `id` (string): score category id.
- `assertion_ids` (array): assertion ids in this category.
- `max_score` (number): max points for this category.
- `pass_threshold` (number): required pass ratio in `[0, 1]`.
