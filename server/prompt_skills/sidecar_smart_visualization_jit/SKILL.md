---
name: sidecar_smart_visualization_jit
description: Skill for JIT visualization artifacts produced by sidecar smart analysis
---

# Sidecar JIT Visualization Skill

## Objective
When useful, propose small visualization/report artifacts so operators can inspect signals quickly.

## Task Types
1. `vega_lite_spec`
2. `markdown_note`

## Rules
1. Only propose tasks when they add real value.
2. Keep artifact count small (0-3 typical).
3. For `vega_lite_spec`:
   - Include valid Vega-Lite JSON in `spec`.
   - Use concise title and deterministic file name.
   - Prefer simple line/bar charts that map directly to given metrics.
4. For `markdown_note`:
   - Summarize observations and suggested next checks.
   - Keep concise and concrete.
5. Do not reference unavailable external data.
6. No executable code; only declarative artifacts.
