# Wild Mode - Autonomous Agent Loop

## Overview

Wild Mode lets the AI agent run autonomously: the user states a goal, then the agent designs experiments (sweeps), monitors runs, handles failures/alerts, and iterates until termination conditions are met. The frontend drives the loop as an event-based state machine.

## Architecture

```
User sets goal + conditions
        |
        v
 +--[WildLoopStartDialog]--+
 |  goal, maxIter, time,   |
 |  tokens, custom cond    |
 +----------+--------------+
            |
            v
 +--[useWildLoop hook]------+     +--[useChatSession]--+
 |  State machine:          |---->|  sendMessage()     |
 |  idle -> planning ->     |     |  streamingState    |
 |  monitoring -> reacting  |     +--------------------+
 |  -> waiting -> monitoring|
 |                          |     +--[useRuns]----------+
 |  Diff engine:            |<----|  runs[] polling     |
 |  snapshot {id, status}   |     +--------------------+
 |  on each render          |
 |                          |     +--[useAlerts]--------+
 |  Constraints:            |<----|  alerts[] polling   |
 |  - sequential (no send   |     +--------------------+
 |    while streaming)      |
 |  - 5s min interval       |
 |  - termination checks    |
 +----------+--------------+
            |
            v
 +--[ConnectedChatView]-----+
 |  WildLoopBanner (sticky) |
 |  WildSystemEventCards    |
 |  Purple-styled messages  |
 +-------------------------+
```

## State Machine Phases

| Phase | Description | Transitions |
|-------|-------------|-------------|
| `idle` | No loop running | -> `planning` on startLoop() |
| `planning` | Initial prompt sent, agent analyzing | -> `monitoring` after first response |
| `monitoring` | Watching runs/alerts for changes | -> `reacting` when diff detected |
| `reacting` | Sending event update to agent | -> `monitoring` after response |
| `waiting` | Debounce period between sends | -> `monitoring` after 5s |

## Key Design Decisions

### ChatMode: `'agent' | 'wild'` (was `'wild' | 'debug' | 'sweep'`)

- `agent` = interactive assistant (replaces both `debug` and `sweep`)
- `wild` = autonomous loop mode
- Server only cares about `wildMode: boolean` — `debug` and `sweep` were never distinct server-side concepts. Both mapped to `wildMode=false`.
- The resolve-event-by-chat flow passes `chatMode` directly to `sendMessage()`, which checks `mode === 'wild'`. So `'agent'` correctly produces `wildMode=false`, identical to old `'debug'` behavior.

### Diff Engine

Instead of polling the server for "what changed", the hook snapshots `{id, status}` of all runs on each render and diffs against the previous snapshot. This is zero-cost since `runs[]` is already polled by `useRuns`.

### Sequential Sends

The hook never sends while `streamingState.isStreaming` is true — it waits for the current response to finish before sending the next event update. This prevents message interleaving.

### Token Estimation

Simple `chars / 4` heuristic. Not precise but good enough for budget enforcement.

## Files Changed

### New Files
| File | Purpose |
|------|---------|
| `hooks/use-wild-loop.ts` | Core state machine hook (~200 lines) |
| `components/wild-loop-banner.tsx` | Sticky purple banner showing phase/iteration/elapsed |
| `components/wild-loop-start-dialog.tsx` | Configuration dialog for goal + termination conditions |
| `components/wild-system-event-card.tsx` | Inline event cards (run completed, failed, alert, etc.) |

### Modified Files
| File | Changes |
|------|---------|
| `lib/types.ts` | Added `WildLoopPhase`, `TerminationCondition`, `WildLoopState`, `WildSystemEvent` types. Added `source` to `ChatMessage`, `sweepId`/`sweepParams` to `ExperimentRun` |
| `components/chat-input.tsx` | ChatMode `'agent'\|'wild'`, 2-mode selector (Bot/Zap icons), wild config button, override placeholder |
| `components/chat-message.tsx` | Purple bg + "Wild" badge for `source === 'wild-loop'` messages |
| `components/connected-chat-view.tsx` | Accepts `wildLoop` prop, renders banner + interleaved system events, wild mode empty state |
| `app/page.tsx` | Instantiates `useWildLoop`, passes to `ConnectedChatView`, renders `WildLoopStartDialog` |
| `app/globals.css` | `--wild` / `--wild-foreground` CSS vars, `.wild-pulse` animation |
| `hooks/use-chat-session.ts` | Default mode ref `'agent'` |
| `hooks/use-runs.ts` | Maps `sweep_id`, `sweep_params`, `git_commit` from API |
| `components/runs-view.tsx` | Sweep badges (purple), action buttons (play/stop/rerun) on run items |
| `components/run-detail-view.tsx` | Git commit hash display |
| `server/server.py` | Captures `git rev-parse HEAD` on run creation |
| `lib/api.ts` | Added `git_commit` field to `Run` interface |

## Implementation Progress

- [x] Step 1: Types & ChatMode restructure (`agent`/`wild`)
- [x] Step 2: CSS wild mode colors + animation
- [x] Step 3: Core wild loop hook (state machine, diff engine, termination)
- [x] Step 4: Wild loop banner component
- [x] Step 5: Wild loop start dialog
- [x] Step 6: System event cards
- [x] Step 7: Purple styling for wild messages in chat
- [x] Step 8: Connected chat view integration (banner, events, empty state)
- [x] Step 9: Chat input wild mode behavior
- [x] Step 10: Wire useWildLoop in page.tsx
- [x] Step 11: Browser notifications (in use-wild-loop.ts)
- [x] Step 12: Run improvements (sweep badges, action buttons)
- [x] Step 13: Git commit tracking (server + frontend)
- [x] Build passes (`npm run build` compiles successfully)

## Verification Checklist

- [ ] Mode selector: switch between Agent and Wild, verify UI updates
- [ ] Wild loop start: configure conditions, start loop, verify banner appears
- [ ] Event detection: create a run, verify wild loop detects completion/failure
- [ ] Auto-messaging: verify wild loop sends purple messages on events
- [ ] Pause/Resume: pause loop, verify monitoring stops; resume, verify it continues
- [ ] Termination: set iteration limit to 2, verify loop stops after 2 turns
- [ ] System events: verify inline event cards appear in chat timeline
- [ ] Notifications: verify browser notifications fire on critical events
- [ ] Sweep tags: verify child runs show sweep badge in run list
- [ ] Action buttons: verify play/stop/replay buttons work on run items
- [ ] Mobile viewport: check at 300px width for overflow
