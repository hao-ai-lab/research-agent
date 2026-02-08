# Wild Loop Toy Plan (Playground Scope)

Date: 2026-02-08  
Scope: `playground/01-wild-loop/` only

## 1. Objective

Build a backend-only toy wild loop that demonstrates every required moving part:

1. Priority event queue (with steer/queued lanes).
2. Prompt-first event handling (events are user one-off prompts, not rigid RPC types).
3. Minimal core loop + extension-based capabilities (scheduler/alerts/analysis as extensions).
4. Human interruption policy (`always proceed`, `page human`, `block until human`, etc.).
5. Reproducible story cases with many prompts and tests.

The toy loop is intentionally simulation-friendly: real jobs can be replaced by fixtures/mocks, but loop behavior must be realistic.

## 2. Non-Goals

1. No production UI implementation in this toy plan.
2. No full server/frontend refactor in this playground.
3. No dependency on real GPU cluster for basic validation.

## 3. Core Design Principles

1. KISS first: the loop runtime should be condensed into one file.
2. Core loop keeps only absolute primitives: dequeue -> execute -> enqueue-followups -> persist state.
3. Everything non-primitive is an extension (scheduler, alert logic, analysis, policy tuning).
4. Event = prompt package with clear `Input / Procedure / Output`.
5. Event `Procedure` is authored like a skill/playbook: reusable steps, explicit decision points, and expected artifacts.
6. Main loop is shared runtime code outside stories.
7. Each story folder is self-contained and invokes the shared loop runtime.
8. Idle queue does not mean loop termination.

## 4. Target Directory Layout

```text
playground/01-wild-loop/
  README.md
  PLAN.toy.md
  PLAN.full.md
  loop/
    loop.py                      # single-file core loop runtime (outside story/)
    extensions/
      scheduler_agent.py         # scheduler extension (can simulate GPU environment)
      run_backend.py             # run launch/finish mock integration
      alert_policy.py            # alert triage/escalation extension
      human_bridge.py            # human notification + synthetic response extension
      analysis_reporter.py       # analysis/report extension
    prompts/
      core/
      extensions/
  story/
    rl-training/
      story.yaml
      entry.py                   # loads story + calls loop.main()
      prompts/
      fixtures/
      expected/
      run.sh
    prompt-tuning/
      story.yaml
      entry.py
      prompts/
      fixtures/
      expected/
      run.sh
    dit-training/
      story.yaml
      entry.py
      prompts/
      fixtures/
      expected/
      run.sh
  tests/
    unit/
    integration/
    story/
```

## 4.1 Primitive vs Extension Boundary (KISS Contract)

Core primitives in `loop/loop.py` only:

1. queue/lane data structure,
2. event selection,
3. prompt execution call,
4. parse event output + append new events,
5. loop termination guards.

Everything else must be loaded as extension hooks:

1. scheduling strategy,
2. GPU resource simulation,
3. alert escalation policy,
4. analysis/report generation,
5. human paging logic,
6. run-skill resolution/execution (`run_backend`).

Core-loop limitation (explicit):

1. Core loop does **not** understand function/script/playbook internals.
2. Core loop only passes run specs to extension hooks and consumes normalized outputs.
3. `run_backend` extension owns:
   1. skill registry lookup,
   2. resolution to `resolved_instruction`,
   3. execution call and status handoff.

## 5. Prompt-First Event Contract

Use one flexible event envelope:

```json
{
  "event_id": "evt_xxx",
  "lane": "user_steer | agent_steer | user_queued | agent_queued",
  "priority": 0,
  "source": "user | agent | system | run_backend | human",
  "intent": "free-text intent",
  "prompt_path": "story/.../prompts/....md",
  "input_payload": {},
  "timeout_s": 120,
  "retry_budget": 2,
  "blocking": false
}
```

Event output contract (common to all prompt files):

```xml
<event_output>
{"status":"ok|retry|needs_human|failed","summary":"...","new_events":[...],"artifacts":[...]}
</event_output>
<promise>CONTINUE|NEEDS_HUMAN|COMPLETE</promise>
```

This keeps structure parseable while letting each event prompt stay long and specific.

## 5.1 Run Is a Skill Contract (Toy)

`run` is not “just a command”; it is a skill invocation that resolves into a concrete executable instruction.

Run schema mode: `Hybrid + Fallback` (locked).  
Skill source policy: `Reference-only` (locked; no inline executable bodies).

```ts
type RunSkillKind = "python_function" | "python_script" | "shell_script" | "prompt_playbook";

interface RunSkillInvocation {
  kind: RunSkillKind;
  target: string; // reference only: module:function, script path, or playbook id/path
  args: Record<string, unknown>;
  workdir?: string;
  env?: Record<string, string>;
  timeout_s?: number;
  resources?: { gpus?: number; cpus?: number; memory_gb?: number };
}

interface RunFallback {
  instruction_text: string;
  target_hint?: string;
  args?: Record<string, unknown>;
}

interface RunSpec {
  run_id: string;
  name: string;
  goal?: string;
  skill: RunSkillInvocation;
  fallback?: RunFallback;
  resolved_instruction: string; // required before launch
}
```

Reference-only validation rules:

1. `skill.target` must point to an existing function/script/playbook reference.
2. Inline executable body payloads are rejected.
3. `resolved_instruction` must be persisted before a run can enter `queued` or `running`.

## 6. Queue and Lane Policy

Default lane ordering:

1. `user_steer`
2. `agent_steer`
3. `user_queued`
4. `agent_queued`

Rules:

1. FIFO within lane.
2. One event executes at a time in toy runtime.
3. New high-priority steer event can preempt next selection (not interrupt mid-handler).
4. Empty queue -> wait/poll/sleep, do not exit.

Scheduler note:

1. Scheduler is an extension agent, not a core primitive.
2. Scheduler consumes `skill.resources` from each run invocation.
3. It may maintain a simulated environment state such as:
   1. `total_gpus`,
   2. `available_gpus`,
   3. `allocations`,
   4. `queue_decisions`.

## 7. Interruption Tolerance Modes (Toy)

1. `wild_night`: auto-proceed by default; only page human on critical safety.
2. `balanced`: agent resolves first; page human if confidence low or repeated failures.
3. `page_on_alert`: any alert pages human immediately.
4. `away_but_ping`: continue automatically, but notify human on severe alerts.

Mock behavior is explicit in main loop:

1. Optional synthetic human response event when timeout expires.
2. `always_proceed=true` guard for unattended runs.

## 8. Story Cases

Each story is runnable via `story/<case>/entry.py` and must import shared runtime from `loop/`.

Story-folder run contract:

1. Each `story/<case>/` includes `skills/` or `fixtures/skills/` for referenced scripts/playbooks/functions.
2. Run specs point to these references via `skill.target`.
3. Stories do not embed inline executable code blobs in run payloads.

### 8.1 `story/rl-training/`

Goal: RL theory-driven sweep and conclusion report.

Planned sweep dimensions:

1. `model`: `qwen2.5-7b-base`, `qwen2.5-7b-math-base`
2. `clip_coef`: `0.2`, `0.28`
3. `offpoliciness` via `{batch_size, mini_batch_size}`:
   1. `{64, 64}`
   2. `{64, 32}`
   3. `{64, 16}`

Expected artifacts:

1. sweep spec
2. run table
3. curve comparison summary
4. final report answering:
   1. which clip strategy works better?
   2. which offpoliciness setting works better?

### 8.2 `story/prompt-tuning/`

Goal: tune prompt variants across a fixed task set.

Expected artifacts:

1. prompt variant table
2. eval score summary
3. selected prompt + rationale
4. failure mode notes

### 8.3 `story/dit-training/`

Goal: run DiT experiments with both metric and qualitative checks.

Expected artifacts:

1. DiT sweep spec
2. per-run quality summary
3. human-check packet for visual comparison (example: step-0 vs step-5 samples)
4. continue/stop recommendation

## 9. Prompt Catalog (Toy)

Global prompt files (shared by stories):

1. `loop/prompts/plan_event.md`
2. `loop/prompts/sweep_draft.md`
3. `loop/prompts/scheduler_tick.md`
4. `loop/prompts/run_finished_review.md`
5. `loop/prompts/run_alert_triage.md`
6. `loop/prompts/run_failed_recovery.md`
7. `loop/prompts/human_page.md`
8. `loop/prompts/human_response_ingest.md`
9. `loop/prompts/analysis_report.md`
10. `loop/prompts/replan_interrupt.md`
11. `loop/prompts/completion_decision.md`

Per-story prompt packs:

1. `story/<case>/prompts/seed_user_prompt.md`
2. `story/<case>/prompts/domain_constraints.md`
3. `story/<case>/prompts/domain_report_schema.md`
4. `story/<case>/prompts/domain_alert_policy.md`

All prompts must explicitly include sections:

1. `## Input`
2. `## Procedure`
3. `## Output`
4. `## Failure Handling`

`## Procedure` should read like a playbook module:

1. ordered steps the agent executes,
2. branch conditions (`if X, do Y`),
3. required checks before finishing,
4. expected structured artifacts to emit.

## 10. Testing Plan (Toy, Heavy)

### 10.1 Unit Tests

1. Queue lane ordering and FIFO behavior.
2. Preemption insertion correctness.
3. Event output parser validity checks.
4. Retry budget exhaustion behavior.
5. Interruption policy decisions by mode.
6. Lineage linking for fork/merge events.

### 10.2 Integration Tests

1. Plan -> Sweep -> Scheduler -> RunEvent -> Analyze happy path.
2. Alert path with auto-resolve.
3. Alert path with human escalation.
4. Failed run -> fix -> rerun loop.
5. Replan event injected mid-sweep by user steer.
6. Idle waiting behavior with delayed run completion events.

### 10.3 Story E2E Tests

`story/rl-training/`:

1. Full grid expansion creates 12 runs.
2. Report includes clip and offpoliciness conclusions.
3. Balanced mode escalates after repeated failures.
4. Wild-night mode auto-continues without blocking.

`story/prompt-tuning/`:

1. Selects best prompt variant from fixture scores.
2. Handles tie with deterministic tie-break rule.
3. Requests human only when outputs violate schema repeatedly.

`story/dit-training/`:

1. Produces human-review packet for qualitative comparison event.
2. Non-blocking human notification mode continues training.
3. Critical alert mode pages human immediately.

### 10.4 Failure/Chaos Tests

1. Malformed `<event_output>` recovery prompt.
2. Duplicate event id dedup.
3. Out-of-order completion event handling.
4. Alert flooding batch-aggregation behavior.
5. Agent outputs `COMPLETE` too early -> guard rejects completion.

## 11. Deliverables

1. Shared toy backend loop in one core file: `loop/loop.py`.
2. Three runnable story cases under `story/`.
3. Extension set under `loop/extensions/` (scheduler/policy/analysis/human bridge).
4. Prompt library (shared + per-story).
5. Test suite with unit/integration/story/chaos coverage.
6. Example run artifacts per story (`story/<case>/expected/`).

## 12. Definition of Done (Toy)

1. `story/rl-training/run.sh` completes with expected report conclusions.
2. `story/prompt-tuning/run.sh` selects a prompt and emits rationale.
3. `story/dit-training/run.sh` triggers qualitative human-check path.
4. Test suite passes and verifies lane order, escalation, and replan behavior.
5. Main loop runtime remains outside `story/`, is condensed into one core file, and all stories invoke it.
6. Every run has `skill` plus persisted `resolved_instruction` before launch.
7. Reference-only validation rejects inline execution payloads.
8. Hybrid fallback path is exercised by at least one story case.
