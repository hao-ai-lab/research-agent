# Wild Loop Full Plan (End-to-End Repo)

Date: 2026-02-08  
Scope: full repository integration (`frontend + backend + story harness`)

## 1. Product Outcome

Ship a production-grade Wild Loop where:

1. User one-off prompts become queue events.
2. Backend is authoritative for event queue, lineage, and loop state.
3. Agent executes prompt-defined procedures for planning/sweeping/monitoring/analyzing.
4. Core runtime remains intentionally simple (KISS) with non-primitives as extensions.
5. Human interruption is policy-driven (not hardcoded).
6. RL training, Prompt Tuning, and DiT training are first-class story cases.

## 2. Current State and Gap

Current repo already has:

1. Frontend-driven loop in `hooks/use-wild-loop.ts` with prompt builders and tag parsing.
2. Backend run/sweep/alert APIs in `server/server.py`.
3. Wild mode state endpoints (`/wild/status`, `/wild/configure`, `/wild-mode`).

Key gaps for full wild loop:

1. No backend priority event queue with steer lanes.
2. No persisted event lineage graph.
3. No unified prompt-event contract with per-event input/output schemas.
4. No story harness for RL/prompt-tuning/DiT wild-loop cases.
5. Queue UI in README concept not backed by backend queue primitives yet.

## 3. Target Architecture

## 3.1 Backend as Source of Truth

Add `server/wild_loop/` runtime with a one-file core:

```text
server/wild_loop/
  loop.py                   # single core runtime: queue -> execute -> parse -> enqueue
  extensions/
    scheduler_agent.py      # scheduler extension (resource-aware, can simulate GPU env)
    run_backend.py          # run/sweep/alert API bridge
    alert_policy.py         # escalation/triage extension
    human_bridge.py         # paging + human-response extension
    analysis_reporter.py    # report synthesis extension
  prompts/
    core/
    extensions/
```

Keep existing run/sweep/alert endpoints and reuse them through extensions.

Core primitives only:

1. lane queues + dequeue policy,
2. event prompt execution,
3. event output parsing + follow-up enqueue,
4. loop state/checkpoint,
5. termination checks.

Everything else is extension territory.

Extension responsibilities (explicit):

1. `run_backend` extension provides:
   1. `resolve_run_skill(run_spec) -> resolved_instruction`
   2. `execute_run(resolved_instruction) -> run_status`
2. `scheduler_agent` consumes per-run resource requests and environment simulation state.

## 3.2 Frontend as Control + Visualization

Frontend responsibilities:

1. Show queue panel above composer (collapsible).
2. Show lineage/sequence view for event graph.
3. Send user prompts as steer or queued events.
4. Receive queue updates via polling or SSE.
5. Drag/drop reorder within allowed lanes.

Existing `use-wild-loop.ts` should migrate from local orchestration to backend orchestration client.

## 3.3 Agent Interaction Contract

Every event carries a complete prompt with:

1. `Input`
2. `Procedure` (written like a skill/playbook)
3. `Output`
4. `Failure Handling`

Procedure authoring requirement:

1. reusable step sequence (not ad-hoc prose),
2. explicit branch conditions and escalation points,
3. required verification checks before completion,
4. explicit artifacts/events produced by the procedure.

Run-skill interfaces (public contract):

```ts
type RunSkillKind = "python_function" | "python_script" | "shell_script" | "prompt_playbook";

interface RunSkillInvocation {
  kind: RunSkillKind;
  target: string; // reference only
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
  resolved_instruction: string; // required pre-start
}
```

Standard parse target:

```xml
<event_output>{"status":"ok|retry|needs_human|failed","summary":"...","new_events":[...],"artifacts":[...]}</event_output>
<promise>CONTINUE|NEEDS_HUMAN|COMPLETE</promise>
```

This keeps event meaning flexible while maintaining deterministic parser boundaries.

## 4. API Additions (Full)

Add loop-oriented endpoints:

1. `POST /wild/loops` -> create loop instance.
2. `GET /wild/loops/{loop_id}` -> loop snapshot.
3. `POST /wild/loops/{loop_id}/events` -> enqueue event.
4. `GET /wild/loops/{loop_id}/queue` -> queue lanes + items.
5. `POST /wild/loops/{loop_id}/queue/reorder` -> drag/drop reorder.
6. `GET /wild/loops/{loop_id}/lineage` -> event DAG.
7. `POST /wild/loops/{loop_id}/control` -> pause/resume/stop/set mode.
8. `GET /wild/loops/{loop_id}/stream` -> SSE updates.

Compatibility:

1. Existing `/wild/status` and `/wild/configure` remain, but become wrappers to active loop state.
2. Existing `/chat` still executes LLM calls; engine can route event prompts through it.
3. `POST /runs` accepts `run_skill` and optional `run_fallback`.
4. Legacy `command` stays supported for compatibility.
5. If both `run_skill` and `command` exist, `run_skill` takes precedence.
6. Server persists `resolved_instruction` and mirrors it to legacy `command` for existing UI compatibility.

## 4.1 Important Public API / Interface Additions

1. `RunSkillInvocation`, `RunFallback`, and `RunSpec` types.
2. `POST /runs` payload extension: `run_skill`, `run_fallback`.
3. `resolved_instruction` persistence requirement before run launch.
4. Reference-only target validation policy.

## 5. Queue Model and Policy

Lanes and default priority:

1. `user_steer`
2. `agent_steer`
3. `user_queued`
4. `agent_queued`

Policy modes:

1. `wild_night` (maximize autonomous throughput)
2. `balanced` (agent-first, escalate selectively)
3. `page_on_alert` (immediate page for alerts)
4. `away_but_ping` (continue but notify on severe incidents)

Scheduler implementation note:

1. Scheduler is an extension agent, not part of loop primitive core.
2. Scheduler reads `skill.resources` from each run invocation.
3. It may maintain environment simulation state:
   1. total/available GPUs,
   2. per-run GPU allocations,
   3. placement decisions and queuing decisions.

Guardrails:

1. max iterations
2. max wall time
3. max unresolved alerts
4. per-event retry budget
5. anti-flood batching for repeated alerts

## 6. Story Harness (Repo-Wide)

Create wild-loop story harness:

```text
tests/story/wild-loop/
  rl-training/
    story.yaml
    prompts/
    fixtures/
    expected/
    run.sh
    verify.py
  prompt-tuning/
    story.yaml
    prompts/
    fixtures/
    expected/
    run.sh
    verify.py
  dit-training/
    story.yaml
    prompts/
    fixtures/
    expected/
    run.sh
    verify.py
```

Main loop code stays outside story folders (`server/wild_loop/`), and stories invoke it via API/CLI.

## 7. User Story Designs

## 7.1 RL Training Story (`tests/story/wild-loop/rl-training/`)

Core idea: theory-heavy user proposes parameter changes, runs sweep, validates results.

Planned sweep dimensions:

1. model: `qwen2.5-7b-base`, `qwen2.5-7b-math-base`
2. clip strategy: `clip_coef=0.2` vs `clip_coef=0.28`
3. offpoliciness:
   1. `{batch_size=64, mini_batch_size=64}`
   2. `{batch_size=64, mini_batch_size=32}`
   3. `{batch_size=64, mini_batch_size=16}`

Flow:

1. setup `verl` workspace event
2. plan/sweep generation event
3. run scheduling events
4. curve read + conclusion event
5. report generation event

Required output:

1. recommendation on clip strategy
2. recommendation on offpoliciness
3. evidence-linked report with run table and curve summary

## 7.2 Prompt Tuning Story (`tests/story/wild-loop/prompt-tuning/`)

Flow:

1. define prompt search space
2. execute evaluation runs across benchmark set
3. triage failures
4. produce selected prompt and comparison report

Required output:

1. chosen prompt template
2. quality/cost/latency tradeoff notes
3. failure bucket analysis

## 7.3 DiT Training Story (`tests/story/wild-loop/dit-training/`)

Flow:

1. create DiT training sweep
2. monitor metrics + generated sample quality
3. trigger qualitative comparison event (step-0 vs step-5 samples)
4. decide continue/stop/escalate

Required output:

1. DiT run quality summary
2. human-check packet when automatic validator is weak
3. final recommendation

## 8. Prompt Library Plan (Full)

Shared prompt catalog in `server/wild_loop/prompts/`:

1. `seed_intent.md`
2. `plan_event.md`
3. `sweep_spec.md`
4. `scheduler_tick.md`
5. `run_finished_review.md`
6. `run_alert_triage.md`
7. `run_failed_recovery.md`
8. `human_escalation.md`
9. `human_response_ingest.md`
10. `analysis_report.md`
11. `replan_steer.md`
12. `completion_gate.md`

Story-specific overlays in `tests/story/wild-loop/<case>/prompts/`:

1. domain constraints
2. domain output schema
3. domain alert policy
4. report template

## 9. Test Strategy (End-to-End)

## 9.1 Backend Unit Tests

1. lane ordering and FIFO
2. enqueue/dequeue invariants
3. parser strictness for `<event_output>` and `<promise>`
4. policy decision matrix
5. lineage graph integrity
6. validate accepted run skill kinds
7. reject inline executable body payloads (reference-only validator)
8. require `resolved_instruction` before start
9. fallback parser/validator behavior

## 9.2 Backend Integration Tests

1. event lifecycle: user prompt -> plan -> sweep -> run events -> analysis
2. alert response path and persisted resolution
3. retry logic for malformed agent output
4. anti-flood alert batching
5. pause/resume/stop control behavior
6. `python_script` skill resolves and runs
7. `python_function` skill resolves and runs
8. `shell_script` skill resolves and runs
9. `prompt_playbook` skill resolves and runs
10. primary resolve failure -> fallback resolve success
11. primary+fallback failure -> blocked run plus alert event
12. legacy `command` path still executes

## 9.3 Frontend Integration/E2E

1. queue panel rendering and lane counts
2. drag/drop reorder API sync
3. lineage view reflects executed order + parent-child links
4. steer event submission during running stage
5. interruption mode toggle and visible effect

## 9.4 Story E2E Matrix

RL:

1. baseline full sweep success
2. failed run recovery and rerun
3. conflicting conclusions forcing additional runs
4. unattended overnight mode
5. each run contains `skill` and `resolved_instruction`

Prompt Tuning:

1. best-prompt selection
2. tie-break handling
3. regression alert and rollback
4. playbook-based runs execute with args

DiT:

1. qualitative-check escalation path
2. non-blocking human notification
3. critical alert immediate page mode
4. scheduler consumes GPU resource requests from run skill metadata

## 10. Rollout Plan

## Phase 1: Backend Foundation

1. Implement single-file core loop in `server/wild_loop/loop.py`.
2. Add minimal queue + loop control endpoints.
3. Keep feature behind flag (default off).

## Phase 2: Handler and Prompt Runtime

1. Add extensions for scheduler/run-backend/alerts/human/analysis.
2. Implement run skill resolver.
3. Implement reference-only validator.
4. Implement fallback resolver path.
5. Implement legacy command compatibility adapter.
6. Integrate extensions with existing chat/run/sweep/alert APIs.
7. Add retry and guardrails.

## Phase 3: Frontend Queue + Lineage

1. Build queue panel and lineage components.
2. Migrate `use-wild-loop.ts` to backend-driven mode.
3. Add mode controls and steer event composer actions.

## Phase 4: Story Harness + Validation

1. Add three user-story case folders.
2. Add deterministic fixtures and verification scripts.
3. Run full matrix tests in CI.

## 11. Risks and Mitigation

1. Alert flooding -> batch + cooldown + dedup key.
2. Early false `COMPLETE` -> completion gate requires evidence checks.
3. Infinite retries -> strict retry budget + fallback escalation.
4. Queue starvation -> fairness rules and max consecutive lane picks.
5. Human unavailability -> explicit unattended policy and synthetic auto-response option.

## 12. Definition of Done (Full)

1. Backend core loop is implemented in one file and remains small/stupid-simple.
2. Extension hooks cover scheduler, alert policy, analysis, and human bridge.
3. Backend queue/lineage APIs are stable and tested.
4. Frontend queue + lineage views operate on backend data.
5. Three story cases are runnable and reproducible.
6. RL story outputs clip/offpoliciness conclusions with evidence.
7. Prompt tuning and DiT stories pass end-to-end checks.
8. Wild loop handles auto-proceed and human escalation modes correctly.
9. All story runs use run-skill path (no inline executable bodies).
10. Fallback path is tested and observable.
11. Compatibility path for legacy `command` is verified.

## 13. Explicit Assumptions and Defaults

1. `args` are JSON-serializable.
2. `target` is always a reference (path/module/playbook id), never inline executable content.
3. `resolved_instruction` is immutable once run enters `running`.
4. Default fallback executor uses referenced `prompt_playbook`.
5. Scheduler simulation state is extension-local, not core loop primitive state.
