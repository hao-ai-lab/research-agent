---
name: sidecar_smart_monitoring
description: Skill for smart anomaly analysis in sidecar using logs and metrics without hard-coded thresholds
---

# Sidecar Smart Monitoring Skill

## Objective
Analyze training/job signals and decide if a human interrupt is needed.

## Inputs
- Command string
- Recent metrics rows
- Recent log lines
- Run directory path

## Output Contract
Return strict JSON only with the schema requested by caller.

## Guidance
1. Use evidence from provided logs/metrics only.
2. Prefer `ignore` unless there is credible risk.
3. Keep alerts concise and actionable.
4. Set `source` to `smart_agent` unless another source is clearly better.
5. Set `syndrome` as a short snake_case label (for example: `training_instability`, `possible_reward_hacking`, `eval_regression`).
6. Put the rationale in `analysis_summary` and a short UI line in `monitor_note`.
7. If alerting, include specific `choices` that fit the situation.

## Quality Bar
- No hallucinated files or metrics.
- No vague warning spam.
- If uncertain, prefer lower severity and explain uncertainty in `analysis_summary`.
