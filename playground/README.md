# Prompt Architecture Playground

This playground demonstrates a **composable, modular prompt architecture** as a redesign of the monolithic `skills/prompts/` SKILL.md templates.

## Problem

The current prompt system has 3 monolithic templates:
- `wild_v2_planning/SKILL.md` — **282 lines**
- `wild_v2_iteration/SKILL.md` — **190 lines**  
- `wild_v2_reflection/SKILL.md` — **96 lines**

These share ~100+ lines of duplicated content (API catalog, experiment tracking rules, GPU scheduling, preflight checks), with no composition mechanism between them.

## Solution: Composable Fragments

Instead of 3 monolithic templates, we use **11 small, focused fragments** that compose into complete prompts:

```
prompts/
├── fragments/                    # Reusable building blocks
│   ├── identity.md               # Agent persona + behavioral principles
│   ├── context.md                # Goal, workdir, iteration state
│   ├── api_catalog.md            # API reference (single source)
│   ├── experiment_tracking.md    # Sweep/run rules (deduplicated)
│   ├── gpu_scheduling.md         # GPU discovery + parallelism
│   ├── environment_setup.md      # venv/conda/Slurm setup
│   ├── preflight.md              # Server health checks
│   ├── history_patterns.md       # Learn-from-history patterns
│   ├── evo_sweep.md              # Evolutionary sweep (conditional)
│   └── output_contracts/         # Mode-specific output format
│       ├── planning.md
│       ├── iteration.md
│       └── reflection.md
├── modes/                        # Standalone mode prompts
│   ├── agent.md                  # Redesigned chat agent
│   └── idea.md                   # Research ideation
└── assembled/                    # Generated assembled prompts
```

## Usage

```python
from playground.agent.composer import PromptComposer

composer = PromptComposer("playground/prompts")

# Compose a planning prompt from fragments
prompt = composer.compose("planning", {
    "goal": "Train MNIST classifier",
    "workdir": "/project",
    "server_url": "http://localhost:10000",
    ...
})
```

## Running Tests

```bash
cd /path/to/research-agent
python -m pytest playground/tests/test_composer.py -v
```

## Running the Demo

```bash
python -m playground.agent.minimal_loop
```

## Architecture Comparison

| Aspect | Before (Monolithic) | After (Composable) |
|--------|--------------------|--------------------|
| Files | 3 large SKILL.md (282+190+96 lines) | 11 fragments + 3 output contracts |
| Duplication | ~100 lines copied across planning/iteration | Zero — shared fragments |
| Edit surface | Change in 2+ places per update | Change once, reflected everywhere |
| Testability | No tests | Full test suite |
| New modes | Copy entire template | Compose from existing fragments |
