# Wild Mode — Ralph Loop (Autonomous Agent Loop)

## Overview

Wild Mode (a.k.a. Ralph Loop) lets the AI agent run **fully autonomously**: the user states a goal, then the agent iteratively designs experiments, monitors runs, handles failures/alerts, and decides next steps — all without human interruption. The loop only pauses for the human when the agent emits a high-confidence `<signal>NEEDS_HUMAN</signal>` tag.

Inspired by [open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum).

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
 |  Proactive iterative     |---->|  sendMessage()     |
 |  loop (Ralph-style):     |     |  await streaming   |
 |                          |     +--------------------+
 |  startLoop():            |
 |    1. Create session     |     +--[useRuns]----------+
 |    2. Send initial       |<----|  runs[] polling     |
 |       prompt             |     +--------------------+
 |    3. Await response     |
 |    4. Parse signal       |     +--[useAlerts]--------+
 |                          |<----|  alerts[] polling   |
 |  Auto-continuation:      |     +--------------------+
 |    streaming ends →      |
 |    check signal →        |
 |    delay (5s/15s) →      |
 |    send continuation     |
 |    prompt → repeat       |
 +----------+--------------+
            |
            v
 +--[ConnectedChatView]-----+
 |  WildLoopBanner (sticky) |
 |  WildSystemEventCards    |
 |  Purple-styled messages  |
 +-------------------------+
```

## Loop Flow (Ralph-style)

1. **User configures goal + conditions** → dialog closes
2. **startLoop()** creates a new chat session
3. **Iteration 1**: Sends full Ralph system prompt with goal, instructions, current state. Awaits agent response.
4. **Signal parsing**: Scans response for `<signal>COMPLETE|NEEDS_HUMAN|CONTINUE</signal>`
   - `COMPLETE` → stop loop, notify human
   - `NEEDS_HUMAN` → pause loop, notify human (browser notification)
   - `CONTINUE` (or no signal) → schedule next iteration
5. **Auto-continuation**: When streaming ends (`isStreaming` transitions `true→false`), the effect fires:
   - Check termination conditions (iterations, time, tokens)
   - Parse signal from last response
   - If CONTINUE: wait 5s (no running) or 15s (runs active), then send continuation prompt
6. **Continuation prompt** includes: current run state, new events (diff engine), pending alerts (with choices for agent to self-decide), instruction to keep going
7. Repeat until COMPLETE, NEEDS_HUMAN, or termination condition

## Key Design: No Human Interrupts

The Ralph Loop **guarantees** the human is not interrupted unless:

| Signal | When Used | What Happens |
|--------|-----------|--------------|
| `<signal>CONTINUE</signal>` | Default. More work to do. | Loop continues automatically |
| `<signal>COMPLETE</signal>` | Goal genuinely achieved | Loop stops, browser notification |
| `<signal>NEEDS_HUMAN</signal>` | Irreversible decision with major risk | Loop pauses, browser notification, human resumes |

The prompts explicitly instruct the agent:
- "Do NOT ask the human for help"
- "Make your own decisions"
- "If stuck, try a different approach"
- "ONLY use NEEDS_HUMAN for irreversible decisions with major cost/risk"
- Pending alerts with choices → agent decides itself

## Signal Detection

```typescript
const SIGNAL_RE = /<signal>\s*(COMPLETE|NEEDS_HUMAN|CONTINUE)\s*<\/signal>/i
```

Scanned from the agent's response text. Case-insensitive, whitespace-tolerant. If no signal is found, defaults to `CONTINUE`.

## Diff Engine

Between iterations, the hook computes what changed:
- New runs that appeared
- Run status transitions (completed, failed, etc.)
- New critical alerts (tracked by `processedAlertIds` Set to avoid duplicates)

Changes are included in the continuation prompt so the agent sees what happened.

## Timing

| Scenario | Delay Between Iterations |
|----------|-------------------------|
| No running runs | 5 seconds (`MIN_INTERVAL_MS`) |
| Running runs exist | 15 seconds (`IDLE_POLL_MS`) — gives runs time to progress |

## State Machine Phases

| Phase | Description | Transitions |
|-------|-------------|-------------|
| `idle` | No loop running | -> `planning` on startLoop() |
| `planning` | Initial prompt sent | -> `monitoring` after first response |
| `monitoring` | Waiting between iterations | -> `reacting` when next iteration fires |
| `reacting` | Continuation prompt being sent | -> `monitoring` after response |
| `waiting` | Paused (NEEDS_HUMAN or user pause) | -> `monitoring` on resumeLoop() |

## ChatMode: `'agent' | 'wild'`

- `agent` = interactive assistant (replaces old `debug`/`sweep`)
- `wild` = autonomous Ralph loop mode
- Server only checks `wildMode: boolean` — modes that aren't `'wild'` all map to `wildMode=false`

## Files

### New Files
| File | Purpose |
|------|---------|
| `hooks/use-wild-loop.ts` | Core Ralph loop hook (~350 lines) |
| `components/wild-loop-banner.tsx` | Sticky purple banner: phase, turn, elapsed, pause/stop |
| `components/wild-loop-start-dialog.tsx` | Goal + termination conditions dialog |
| `components/wild-system-event-card.tsx` | Inline event cards in chat timeline |

### Modified Files
| File | Changes |
|------|---------|
| `lib/types.ts` | `WildLoopPhase`, `TerminationCondition`, `WildLoopState`, `WildSystemEvent`, `source` on `ChatMessage`, `sweepId`/`sweepParams` on `ExperimentRun` |
| `components/chat-input.tsx` | ChatMode `'agent'\|'wild'`, 2-mode selector, wild config button |
| `components/chat-message.tsx` | Purple bg + "Wild" badge for `source === 'wild-loop'` |
| `components/connected-chat-view.tsx` | `wildLoop` prop, banner, interleaved system events |
| `app/page.tsx` | `useWildLoop` + `WildLoopStartDialog` |
| `app/globals.css` | `--wild` CSS vars, `.wild-pulse` animation |
| `hooks/use-chat-session.ts` | Default mode `'agent'` |
| `hooks/use-runs.ts` | Maps `sweep_id`, `sweep_params`, `git_commit` |
| `components/runs-view.tsx` | Sweep badges, action buttons |
| `components/run-detail-view.tsx` | Git commit hash |
| `server/server.py` | `git rev-parse HEAD` on run creation |
| `lib/api.ts` | `git_commit` on `Run` |

## Implementation Progress

- [x] Types & ChatMode restructure
- [x] CSS wild mode colors + animation
- [x] Core Ralph loop hook (proactive iterative, signal-based)
- [x] Wild loop banner
- [x] Wild loop start dialog
- [x] System event cards
- [x] Purple styling for wild messages
- [x] Connected chat view integration
- [x] Chat input wild mode behavior
- [x] Wire useWildLoop in page.tsx
- [x] Browser notifications
- [x] Run improvements (sweep badges, action buttons)
- [x] Git commit tracking
- [x] **v2: Rewrite to proactive Ralph-style loop** (auto-continuation, signal detection, no human interrupts)
- [x] Build passes

## Verification Checklist

- [ ] Mode selector: switch between Agent and Wild
- [ ] Wild loop start: configure conditions, start loop, banner appears
- [ ] Auto-continuation: agent responds, loop automatically sends next iteration
- [ ] Signal detection: agent outputs `<signal>COMPLETE</signal>`, loop stops
- [ ] NEEDS_HUMAN: agent outputs signal, loop pauses + browser notification
- [ ] Pause/Resume: user pauses, loop stops iterating; resume continues
- [ ] Termination: max iterations hit, loop auto-stops
- [ ] Alert self-resolution: pending alerts appear in prompt, agent decides
- [ ] System events: inline event cards in chat timeline
- [ ] Sweep tags: child runs show sweep badge
- [ ] Action buttons: play/stop/replay on run items
- [ ] Mobile: 300px width, no overflow
