---
title: "feat: Sidecar Agent V2 (playbook-driven monitoring)"
type: feat
date: 2026-02-17
issue: https://github.com/hao-ai-lab/research-agent/issues/165
---

# Sidecar Agent V2 Design

## Problem
Current sidecar logic is mostly rule-based and can miss higher-level failure modes (log syndromes, RL-specific pathologies, and baseline drift). It also has weak behavior when requested GPUs are already occupied.

## Goals
- Keep sidecar efficient (single-process monitor loop).
- Improve anomaly detection coverage using a playbook approach.
- Add predictable behavior for `CUDA_VISIBLE_DEVICES` occupancy.
- Provide periodic monitoring summaries that Wild Loop can use for arbitration.
- Add focused tests so behavior is stable and debuggable.

## Non-Goals
- Full multi-agent sidecar fanout.
- Heavy centralized historical analytics service.
- Perfect domain coverage for all ML workloads in one iteration.

## Design (V2)

### 1. Single-Loop, Multi-Signal Monitoring
Each monitor tick evaluates signals in this order:
1. Hard deterministic metric rules (NaN/Inf, high loss, spike).
2. Playbook log syndromes (OOM, CUDA device busy, NCCL failure, traceback, etc.).
3. Playbook metric syndromes by inferred workload profile:
   - Supervised: validation collapse/regression.
   - RL: reward collapse, reward-hacking suspicion (reward up while success drops), KL explosion.
4. Baseline drift checks from lightweight historical summaries (throughput and quality drift for similar command fingerprints).
5. LLM alert judge as a soft fallback gate.

Only the highest-severity new decision is surfaced per tick (with signature dedupe TTL).

### 2. Workload Profile Inference
Infer profile from command + metric keys + log text:
- `reinforcement_learning`
- `supervised`
- `generic`

This chooses which playbook rules run, keeping checks relevant and cheap.

### 3. GPU Preflight for `CUDA_VISIBLE_DEVICES`
Before launching command execution:
- Parse requested GPU IDs from `CUDA_VISIBLE_DEVICES`.
- Poll `nvidia-smi` to check occupancy on those GPUs.
- Wait up to a bounded timeout for availability.
- If still occupied at timeout, create a warning alert with operator decision (`Continue Anyway` / `Stop Job`).

This makes contention behavior explicit instead of failing silently later.

### 4. Lightweight Cross-Run Memory
Persist a tiny run summary (profile + key metrics + throughput) into a local history JSONL in workdir. Use it for cheap baseline comparisons on future runs with similar command fingerprints.

### 5. Wild Loop Integration (Small)
Sidecar sends periodic monitoring snapshot fields via run status updates (`monitor_note`, tags, and compact monitoring dict). Wild Loop experiment-context rendering includes these notes for active/failed runs, giving central orchestration visibility without heavy coupling.

## User Story
As an experiment owner running sweeps and long trainings, I want sidecar to catch suspicious training behavior early (including logs + workload-specific metric patterns), clearly handle busy GPU preflight conditions, and share concise monitoring state to Wild Loop so I can react quickly with less manual babysitting.

## Acceptance Criteria
- Sidecar detects at least one log-based syndrome and one workload-specific metric syndrome.
- Sidecar handles occupied `CUDA_VISIBLE_DEVICES` with bounded wait + explicit operator choice.
- Sidecar emits periodic monitoring snapshots to run state.
- Wild Loop context includes sidecar monitor notes for active/failed runs.
- New sidecar logic is covered by automated tests.

## Test Cases

### Automated Unit Tests
1. Parse `CUDA_VISIBLE_DEVICES` from command variants.
2. Detect log syndromes from incremental log tail.
3. Detect supervised validation regression from metric series.
4. Detect RL reward-hacking suspicion from metric series.
5. Detect baseline throughput/quality drift against history summaries.

### Manual/E2E Validation
1. GPU contention scenario:
   - Launch run with occupied `CUDA_VISIBLE_DEVICES=0`.
   - Verify sidecar waits, then prompts alert on timeout.
2. Log anomaly scenario:
   - Inject synthetic `CUDA out of memory` into run log.
   - Verify alert appears with critical/warning severity as expected.
3. RL regression scenario:
   - Feed metrics where reward spikes while success_rate drops.
   - Verify reward-hacking alert.
4. Wild loop observability:
   - Run in wild mode and confirm monitor notes appear in experiment context for active runs.

## Rollout Notes
- Keep rule thresholds conservative to reduce alert fatigue.
- Start with single-loop architecture; if CPU cost grows, split detectors by cadence in later iteration.
- History file is best-effort and bounded (not required for run success).
