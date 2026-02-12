# Collapsed Tool/Thinking Summary — Use OpenCode Native Summary

## Problem

When tool/thinking parts auto-collapse (or are manually collapsed), we show a truncated preview:
- **Tools**: `toolDescription` (from the input's `description` or `title` field) or truncated `toolInput`
- **Thinking**: first line of raw thinking content

This works but is not ideal — `toolInput` is often JSON, and thinking content first lines are often not very meaningful.

## Desired Behavior

OpenCode likely provides a **summary** field per tool call (similar to how it shows tool call results in its own UI). If we can surface this summary through the SSE stream, we'd have a much better collapsed preview.

## Investigation Needed

1. **Check OpenCode's SSE event schema** — Does the `part_update` event for tools include a `summary` or `description` field beyond what we already extract?
2. **Check the `state` object** — We currently extract `state.input.description` and `state.input.title`. Are there other fields like `state.summary`, `state.result_summary`, or similar?
3. **Check the session snapshot** — When we call `GET /session/:id`, do the persisted parts include a summary?

## Implementation Plan

1. Add `toolSummary?: string` to both `StreamingPart` (in `use-chat-session.ts`) and `MessagePart` (in `lib/types.ts`)
2. Extract the summary from the SSE event in `processStreamEvent` and from saved parts in `messagePartToStreamingPart`
3. Use `toolSummary` as the preferred source for collapsed preview text, falling back to `toolDescription` → `toolInput`
4. For thinking parts, consider generating a client-side summary (first sentence, or keyword extraction)

## Files

- `hooks/use-chat-session.ts` — SSE event processing, `StreamingPart` type
- `components/streaming-message.tsx` — streaming part rendering
- `components/chat-message.tsx` — saved part rendering  
- `lib/types.ts` — `MessagePart` type
