---
date: 2026-02-07
topic: chat-first-research-workflow
---

# Chat-First Research Workflow

## What We're Building
We are redesigning the app so chat is the operational center for four high-frequency jobs: (1) create sweeps, (2) monitor jobs, (3) handle alerts/errors, and (4) analyze results.

The chat screen gets a new top section called a **Workflow Board** (context cards). This is not a generic dashboard tab. It is a contextual staging area that feeds chat actions directly, so users can open a card, inspect summary details, and push that item into the current chat with one tap.

Two user modes are first-class:
- **First-time users**: guided setup and first experiment launch with low friction.
- **Returning users**: natural language to sweep specs, in-chat monitoring, and in-chat analysis/reporting.

The design should support RL-heavy workflows where users vary model/config dimensions quickly (for example model family, clip strategy, offpoliciness), run sweeps, then compare curves and extract conclusions.

## Why This Approach
### Approach A (Recommended): Embedded Workflow Board inside Chat
Chat remains the main route; add a top context board with independent cards and deep-link actions into chat.

Pros:
- Keeps users in one mental model.
- Reduces tab switching for alerts/runs/charts.
- Compatible with existing mention system (`@run`, `@alert`, `@chart`) and session model.

Cons:
- Chat view becomes denser.
- Requires careful mobile layout and card prioritization.

Best when: chat-first behavior is the product goal.

### Approach B: Separate Dashboard Tab + Chat
A richer dashboard owns cards; chat is secondary.

Pros:
- Cleaner separation of information and conversation.

Cons:
- Conflicts with explicit chat-first requirement.
- Increases switching and context loss.

Best when: dashboard-first analytics tools.

### Approach C: Pure Chat Commands (No Cards)
Everything is text-only via slash commands and mentions.

Pros:
- Minimal UI complexity.

Cons:
- Weak discoverability.
- Poor at monitoring/alerts triage at a glance.

Best when: power-user CLI-like experience only.

## Key Decisions
- **Decision 1: Chat page has two zones**
  Top: Workflow Board (cards). Bottom: chat timeline/composer.
  Rationale: enables at-a-glance context plus conversational action in one place.

- **Decision 2: Separate “Context Items” from “Chats”**
  Context item = run/sweep/alert/analysis opportunity. Chat = conversation thread that may reference many items.
  Rationale: avoids overloading sessions as pseudo-dashboard objects.

- **Decision 3: Card interactions are independent and multi-open**
  Opening one card must not close others. State stored as `Set<cardId>`.
  Rationale: explicitly matches requested behavior.

- **Decision 4: Use masonry-style board, not rigid equal-height grid**
  Cards should keep intrinsic height and avoid synchronized row stretching.
  Rationale: fixes “neighbor card grows when one expands” problem.

- **Decision 5: Every card has “Refer in Chat” action**
  Inserts canonical reference into composer (e.g. `@run:...`, `@alert:...`, `@sweep:...`) and optional starter prompt.
  Rationale: fast handoff from context to reasoning.

- **Decision 6: NL-to-sweep is a 3-stage flow**
  Parse intent -> render structured draft card -> explicit user confirm to launch.
  Rationale: balances speed and safety for expensive experiment launches.

- **Decision 7: In-chat contextual cards can appear during streaming**
  While assistant reasons, emit live context cards (status snapshot, related runs, alert options, charts) before final text answer.
  Rationale: user sees supporting evidence early.

- **Decision 8: First-time onboarding is task-oriented, not settings-oriented**
  Setup checklist cards: connect codebase, detect training command, create first sweep, run first analysis prompt.
  Rationale: users should reach a useful outcome quickly.

## Open Questions
- Should first-time onboarding auto-run codebase scan on first load, or wait for user consent?
- For NL-to-sweep confirmation, should default be “Create Ready” or “Create & Start”?
- Should analysis cards pin into chat transcript permanently or be ephemeral side artifacts?
- Should card ranking prioritize recency, severity, user goal, or a weighted mix?

## Next Steps
-> `/workflows:plan` for implementation details (new components, state shape, backend contracts, streaming UI hints, and rollout phases).
