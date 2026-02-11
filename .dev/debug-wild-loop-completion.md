# Wild Loop End Detection — Root Cause Analysis & Fix Plan

The frontend has two bugs that prevent reliable detection of when a wild loop has ended: a race condition in the streaming-end effect, and COMPLETE/NEEDS_HUMAN signals being ignored outside the `analyzing` stage.

---

## Bug 1: Race condition in streaming-end detection (critical)

**File**: `components/connected-chat-view.tsx` lines 249–282

The `useEffect` that detects when streaming finishes has `messages` in its dependency array. This creates a race:

1. `isStreaming` transitions to `false` → effect fires → 200ms timer scheduled → `prevStreamingRef` set to `false` → returns cleanup
2. `messages` array updates (assistant message appended) → **cleanup cancels the timer** → effect re-runs → `prevStreamingRef` is already `false` → neither branch matches

**Result**: `onResponseComplete` never fires, so the wild loop can't process the agent's signal and the loop appears to hang.

**Secondary issue**: Even if the timer does fire, the closure captured `messages` from step 1 (before the assistant message was appended), so `lastMsg` may not be the assistant response the code expects.

### Fix

- Remove `messages` from the effect's dependency array so message updates don't cancel the timer.
- Inside the timer callback, read messages from a ref (not the closure) to get the latest value.
- Alternatively, split into two effects: one that only tracks `isStreaming` transitions, and a separate ref that always points to latest messages.

---

## Bug 2: COMPLETE/NEEDS_HUMAN signals ignored in `exploring` and `running` stages

**File**: `hooks/use-wild-loop.ts` lines 642–754 (`onResponseComplete`)

`parseSignal()` is called at line 646, but the result is **only checked in the `analyzing` branch** (line 721). In `exploring` (line 655) and `running` (line 708), the signal is silently discarded:

- **Exploring**: If the agent says `<promise>COMPLETE</promise>`, the code just looks for a `<sweep>` tag, doesn't find one, and queues another exploring prompt.
- **Running**: Signal is completely ignored; only `<resolve_alert>` is parsed.

### Fix

Add signal checks at the top of `onResponseComplete`, before the stage-specific branches:

```typescript
if (signal?.type === 'COMPLETE') { stop(); return }
if (signal?.type === 'NEEDS_HUMAN') { pause(); return }
```

This makes COMPLETE/NEEDS_HUMAN respected regardless of stage.

---

## Bug 3 (minor): Duplicate analysis events from polling race

**File**: `hooks/use-wild-loop.ts` lines 488–513

When all runs become terminal, the polling effect calls `setStage('analyzing')` and enqueues an analysis event. But `setStage` is async — the next 5s poll can fire before the state update takes effect, matching the `allTerminal` condition again and enqueuing a second analysis event (with a unique `Date.now()`-based ID that defeats dedup).

### Fix

Add a ref guard (`analysisQueuedRef`) that is set synchronously when the analysis event is queued, and checked before queueing again.

---

## Implementation Steps

1. **Fix Bug 1** in `connected-chat-view.tsx`: Add a `messagesRef` that always points to latest messages. Remove `messages` from the streaming-end effect's dependency array. Read from `messagesRef.current` inside the timer callback.
2. **Fix Bug 2** in `use-wild-loop.ts`: Move COMPLETE/NEEDS_HUMAN signal handling to the top of `onResponseComplete`, before the stage-switch.
3. **Fix Bug 3** in `use-wild-loop.ts`: Add `analysisQueuedRef` guard around the analysis enqueue in the polling effect.
4. **Verify** no regressions in the existing wild loop flow (exploring → running → analyzing → complete).
