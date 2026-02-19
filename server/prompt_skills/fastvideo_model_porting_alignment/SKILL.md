---
name: "FastVideo Model Porting & Alignment"
description: "Ports new models into FastVideo with strict numerical alignment to official implementations. Use when adding a FastVideo model/pipeline, porting an official or Diffusers checkpoint, or debugging parity/alignment."
variables: ["goal", "model_name", "official_repo", "official_weights_path"]
category: "skill"
---

# FastVideo Model Porting & Alignment

## Goal

{{goal}}

## Inputs

- **Model name**: {{model_name}}
- **Official repo**: {{official_repo}}
- **Official weights path**: {{official_weights_path}}

If an input is missing, infer a sensible value and continue.

## Source of Truth

Read and follow:

1. `docs/contributing/coding_agents.md`
2. `docs/design/overview.md`
3. `docs/contributing/testing.md`

Reference:
- https://haoailab.com/FastVideo/contributing/coding_agents/#faq

## Non-Negotiable Workflow

1. Isolate workspace first (worktree if already in FastVideo; clone otherwise).
2. Set isolated directory as default task root.
3. Fetch official code + weights.
4. Write `PLAN.md` before implementation.
5. Execute `PLAN.md` step-by-step.
6. Treat parity/alignment as first-class acceptance criteria.

Never jump from idea to direct edits.

## Step 0: Workspace Isolation (Required)

### If current directory is a FastVideo repo

```bash
MODEL_SLUG="${MODEL_NAME:-{{model_name}}}"
ROOT="$(git rev-parse --show-toplevel)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BRANCH="codex/port-${MODEL_SLUG}-${STAMP}"
WT_DIR="$(dirname "$ROOT")/FastVideo-${MODEL_SLUG}-${STAMP}"

git -C "$ROOT" worktree add -b "$BRANCH" "$WT_DIR"
cd "$WT_DIR"
```

### If current directory is NOT a FastVideo repo

```bash
MODEL_SLUG="${MODEL_NAME:-{{model_name}}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET_DIR="$HOME/dev/FastVideo-${MODEL_SLUG}-${STAMP}"

git clone https://github.com/hao-ai-lab/FastVideo.git "$TARGET_DIR"
cd "$TARGET_DIR"
git checkout -b "codex/port-${MODEL_SLUG}-${STAMP}"
```

From this point on, use the isolated directory as the root for all commands.

## Step 0.5: Fetch Official Repo + Weights

- Clone the official implementation under the FastVideo root.
- Download official weights to `official_weights/<model_name>/`.
- If a valid Diffusers-format repo exists, prefer direct download.

Example:

```bash
python scripts/huggingface/download_hf.py \
  --repo_id "{{official_repo}}" \
  --local_dir "official_weights/{{model_name}}" \
  --repo_type model
```

## Step 1: Plan First (`PLAN.md`)

Create `PLAN.md` with checkboxes and acceptance criteria.

Minimum sections:

1. Scope and constraints
2. Architecture mapping (official -> FastVideo)
3. Component parity milestones (DiT first)
4. Pipeline wiring milestones
5. Testing milestones (component parity, pipeline parity, SSIM)
6. Example + docs milestones
7. Risks and mitigations

## Step 2: Implement in Parity-First Order

### 2.1 Model + mapping first

- Add/extend model in `fastvideo/models/...`
- Add config + `param_names_mapping` in `fastvideo/configs/models/...`
- Reuse existing FastVideo layers where possible
- Attention convention:
  - `DistributedAttention` for full-sequence self-attention in DiT
  - `LocalAttention` for cross-attention / non-global attention

FAQ rule: implement FastVideo model shape/naming first, then finalize conversion/mapping.

### 2.2 Numerical alignment immediately

- Add component parity tests under `tests/local_tests/...`
- Compare official vs FastVideo outputs with fixed seeds/inputs
- Start with `atol=1e-4`, `rtol=1e-4`
- Keep dtype consistent (bf16 if available, else fp32)
- Use `load_state_dict(strict=False)` while iterating mapping

If parity fails, debug in this order:

1. Fix key mapping (`param_names_mapping`)
2. Align attention backend (for example `FASTVIDEO_ATTENTION_BACKEND=TORCH_SDPA`)
3. Align scheduler/sigma/timestep behavior
4. Add activation logging to locate first divergence

### 2.3 Repeat for each component

Repeat model+mapping+parity for each required component:
- DiT
- VAE
- Encoder/tokenizer
- Any model-specific extras

### 2.4 Pipeline integration

- Add pipeline config in `fastvideo/configs/pipelines/`
- Add sampling defaults in `fastvideo/configs/sample/`
- Register via explicit `register_configs(...)` in `fastvideo/registry.py`
- Add pipeline logic in `fastvideo/pipelines/basic/<pipeline>/`
- Add reusable stages in `fastvideo/pipelines/stages/`

### 2.5 End-to-end validation

- Add pipeline parity tests: `tests/local_tests/pipelines/`
- Add SSIM tests: `fastvideo/tests/ssim/`
- Add minimal runnable example: `examples/inference/basic/`
- Run locally and generate a video sample

### 2.6 Documentation

Update `docs/` with:
- usage
- constraints
- memory/speed caveats
- backend requirements

## Diffusers vs Conversion Rule

If Diffusers-format exists and loads correctly:
- skip conversion script
- focus on mapping + parity

If not:
- add conversion script
- stage converted output at `converted_weights/<model_name>/`
- still validate parity against official implementation

## Alignment Gate (Must Pass)

- [ ] Mapping rules explicit and reviewed
- [ ] Missing/unexpected key mismatches resolved
- [ ] Component parity tests passing
- [ ] Pipeline parity checks passing
- [ ] SSIM regression checks passing
- [ ] Example script generates expected video
- [ ] Documentation updated

## Required Output

When using this skill, always provide:

1. Isolated workspace path
2. Branch name
3. Completed `PLAN.md`
4. Execution progress per plan item
5. Final parity/test summary + residual risks
