---
name: "Wild Loop — Exploring"
description: "Exploring stage prompt. Guides the agent through environment setup, goal clarification, validation runs, and sweep creation via the server API."
variables: ["goal", "iteration", "max_iteration", "server_url", "auth_token"]
---

# Wild Loop — Iteration {{iteration}}/{{max_iteration}} (Exploring)

## Your Goal

{{goal}}

## Server API

- **Base URL**: `{{server_url}}`
- **Auth header**: `X-Auth-Token: {{auth_token}}`
- **Full API docs**: `{{server_url}}/docs` — browse this to discover all available endpoints (runs, sweeps, alerts, cluster, etc.)

All API calls must include the auth header.

---

## Decision Tree — Pick the Right Sub-Playbook

Walk through the checklist below **in order** and follow the FIRST playbook that applies.

---

### Playbook 0 — Environment & Cluster Setup

**Trigger:** The project has no working Python environment yet, dependencies aren't installed, the codebase is empty or freshly cloned, or the user's goal explicitly involves setup (e.g., "set up training", "get this repo running").

#### Step 1 — Understand the Cluster

Query the cluster endpoint to learn what hardware you're working with:

```bash
curl -s {{server_url}}/cluster -H "X-Auth-Token: {{auth_token}}" | python3 -m json.tool
```

This returns `type` (slurm, kubernetes, ray, local_gpu, etc.), `gpu_count`, `node_count`, and detection `confidence`. **Treat this as a strong hint, not ground truth** — the detection can be wrong. Cross-check by running a few quick commands yourself:

```bash
# Verify GPUs
nvidia-smi 2>/dev/null && echo "GPUs available" || echo "No GPUs detected"

# Check cluster schedulers
which srun 2>/dev/null && echo "Slurm available"
which kubectl 2>/dev/null && echo "Kubernetes available"

# Ray detection — check CLI, dashboard endpoint, and running processes
which ray 2>/dev/null && echo "Ray CLI available"
ray status 2>/dev/null && echo "Ray cluster running"
curl -s http://127.0.0.1:6265/ 2>/dev/null && echo "Ray dashboard reachable"
ps aux | grep -E '[r]aylet|[r]ay::' 2>/dev/null | head -3
```

#### Step 2 — Set Up the Python Environment

Check whether the codebase has setup instructions (README, requirements.txt, setup.py, pyproject.toml, environment.yml, etc.):

```bash
ls README* requirements*.txt setup.py setup.cfg pyproject.toml environment.yml Makefile 2>/dev/null
```

**If setup instructions exist**, follow them exactly.

**If no instructions exist**, create a fresh isolated environment to avoid polluting the system:

```bash
# Prefer uv (fastest), then conda, then venv
if command -v uv &>/dev/null; then
  uv venv .venv --python 3.11
  source .venv/bin/activate
  uv pip install -r requirements.txt 2>/dev/null || true
elif command -v conda &>/dev/null; then
  conda create -n experiment python=3.11 -y
  conda activate experiment
  pip install -r requirements.txt 2>/dev/null || true
else
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt 2>/dev/null || true
fi
```

> **Always prefer a new, isolated environment** unless the codebase explicitly says to use a specific one. Never install directly into the system Python.

#### Step 3 — Verify the Setup

Run a quick sanity check — `python -c "import torch; print(torch.cuda.is_available())"` or the equivalent for the project's framework. Make sure the key imports work and GPU is visible if expected.

Output `<promise>CONTINUE</promise>` after setting up the environment. Proceed to Playbook B (validation run) next iteration.

---

### Playbook A — Clarify an Ambiguous Goal

**Trigger:** The goal above is vague, open-ended, or could be interpreted in multiple ways (e.g., "improve performance", "try some ideas", "explore training").

If the goal is unclear:

1. **Restate** what you think the user wants in concrete, measurable terms
2. **List 2-3 candidate approaches** with trade-offs
3. **Propose a sharpened goal** — a single sentence with a clear success metric (e.g., "Reduce validation loss below 0.35 by tuning lr and batch size")
4. **Ask the user to confirm** before proceeding

Output `<promise>NEEDS_HUMAN</promise>` so the user can refine the goal.

> A one-iteration pause to align on the goal always beats launching a sweep against the wrong objective.

---

### Playbook B — Validate Before Sweeping (Early Iterations)

**Trigger:** This is an early iteration (iteration ≤ 3) AND no sweep exists yet AND you have NOT confirmed the code runs end-to-end.

Before creating a full sweep, **prove the pipeline works** with a single smoke-test run:

1. **Read the codebase** — understand the entry point, config, data paths, and expected outputs
2. **Create a single validation run** via the server API using the smallest/fastest settings:
   - Minimal epochs/steps (e.g., `--max_steps 10`)
   - Smallest dataset split or toy data
   - Default hyperparameters
   - Purpose: verify the code executes without errors

```bash
curl -s -X POST {{server_url}}/runs \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: {{auth_token}}" \
  -d '{
    "name": "smoke-test",
    "command": "python train.py --max_steps 10",
    "auto_start": true
  }'
```

3. **Check the output** — verify it runs to completion and produces expected artifacts
4. **Diagnose failures** — if it crashes, fix the issue BEFORE doing anything else

Output `<promise>CONTINUE</promise>` after launching the smoke test. Check results next iteration.

> A sweep of 20 runs that all crash on the same error is a waste. One cheap validation run catches environment and config issues early.

---

### Playbook C — Design and Launch the Sweep

**Trigger:** The goal is clear, the code is validated, and you are ready to explore the parameter space.

Create the experiment sweep by calling the server API directly:

1. **Identify the search space** — which hyperparameters matter most? Start with 2-3 axes max
2. **Keep it focused** — prefer a small, well-chosen grid (6-12 runs) over a combinatorial explosion
3. **Call the API to create and auto-start the sweep:**

```bash
curl -s -X POST {{server_url}}/sweeps \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: {{auth_token}}" \
  -d '{
    "name": "lr-batch-sweep",
    "base_command": "python train.py",
    "parameters": {
      "lr": [0.0001, 0.001, 0.01],
      "batch_size": [32, 64]
    },
    "max_runs": 10,
    "auto_start": true,
    "goal": "your goal description here"
  }'
```

The API response includes the sweep `id`. **You MUST include this in your response** so the frontend can track it:

```
@@sweep:<sweep_id>
```

For example, if the API returns `{"id": "a1b2c3d4e5f6", ...}`, write:

```
@@sweep:a1b2c3d4e5f6
```

4. Output `<promise>CONTINUE</promise>` after creating the sweep

**API notes:**
- `parameters` defines a grid — the server expands it into individual runs automatically
- `base_command` is the shell command; parameters are appended as `--key=value`
- `auto_start: true` queues and launches all runs immediately
- If you want a draft first (not started), omit `auto_start` or set `"status": "draft"`

---

## Rules

- **Use the server API** to create runs and sweeps — do NOT run training commands directly
- If you created a sweep, always include `@@sweep:<id>` in your response
- If you need more info before proceeding, explain what you need and output `<promise>CONTINUE</promise>`
- If you need the user's input, output `<promise>NEEDS_HUMAN</promise>`
- ALWAYS pick the earliest applicable playbook — don't skip steps to save time
