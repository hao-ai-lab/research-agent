# Non-WandB metric capture strategy for sidecar

**Type:** Enhancement
**Status:** Tabled for future iteration
**Priority:** Medium

## Problem

The sidecar currently relies on WandB for metric capture. When a training script doesn't use WandB, there's no automated way to stream metrics to the research agent dashboard.

## Current Behavior

- Sidecar detects WandB via `WANDB_RUN_DIR:` in stdout or by scanning `workdir/wandb/`
- Parses `wandb-history.jsonl` / `metrics.jsonl` for metrics
- If no WandB, charts show only fallback/fake data

## Desired Behavior

Support metric capture from non-WandB training scripts through one or more strategies:

### Strategy 1: Master agent codebase analysis
- When the master agent (wild loop) schedules a job, it should analyze the training script's codebase
- Identify what metrics are logged, to where, and in what format
- Pass this metadata to the sidecar so it knows what to parse

### Strategy 2: Stdout parsing
- Sidecar parses structured stdout patterns like:
  - `Epoch 5/10 - Loss: 0.123 - Accuracy: 0.95`
  - JSON lines: `{"loss": 0.123, "accuracy": 0.95, "step": 100}`
  - TensorBoard-style: `loss=0.123, acc=0.95`
- This is fragile but covers many common scripts

### Strategy 3: Log file convention
- Define a convention: if a script writes to `metrics.jsonl` in its working directory, sidecar picks it up
- The wild loop prompt should instruct the agent to add this logging to scripts that lack it

### Strategy 4: TensorBoard integration
- Many scripts log to TensorBoard even without WandB
- Parse TFEvents files from `runs/` or `logs/` directories

## Implementation Notes

- The wild loop prompt (`server/prompt_skills/wild_*`) should be updated to:
  1. Check if the target script uses WandB
  2. If not, either add WandB logging or add `metrics.jsonl` logging
  3. Pass metric format info to the sidecar via the run config

## Decision

Tabling this for future iteration. The WandB path is the primary supported integration for now. Non-WandB support will be addressed based on real usage patterns.

## Related Files

- Sidecar agent loop: `server/job_sidecar.py` (SidecarAgentLoop class)
- Server metrics endpoint: `POST /runs/{run_id}/metrics`
- Wild loop prompts: `server/prompt_skills/wild_*`
