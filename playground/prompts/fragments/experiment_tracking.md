# 🚨 Experiment Tracking (Mandatory)

> **NEVER run experiments directly (e.g. `python train.py`).**
> **ALL experiments MUST be tracked through the server API.**
> **Runs not created via API are invisible to users and not auditable.**

## Sweep/Run Flow

### Step 1: Create a sweep

```bash
curl -X POST {{server_url}}/sweeps/wild \
  -H "Content-Type: application/json" \
  {{auth_header}} \
  -d '{"name": "descriptive-sweep-name", "goal": "what this sweep is testing", "chat_session_id": "{{session_id}}"}'
```

Save the returned `id`.

### Step 2: Create runs (one per configuration)

```bash
curl -X POST {{server_url}}/runs \
  -H "Content-Type: application/json" \
  {{auth_header}} \
  -d '{"name": "trial-name", "command": "cd {{workdir}} && python train.py --lr 0.001", "sweep_id": "<sweep_id>", "chat_session_id": "{{session_id}}", "auto_start": true}'
```

For grid search: create one run per configuration by repeating `POST /runs`. Do not execute grids outside the API.

### Step 3: Monitor

```bash
curl -X GET {{server_url}}/runs {{auth_header}}
```

If waiting on runs with no other meaningful work, signal `<promise>WAITING</promise>`.

## Auditability Rules

- Every experiment trial must be a run created through `POST /runs`
- Runs must be attached to a sweep via `sweep_id`
- Include `chat_session_id` in all creation requests
- Direct local execution is non-compliant
