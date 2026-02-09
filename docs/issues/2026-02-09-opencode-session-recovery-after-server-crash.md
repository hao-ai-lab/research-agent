# Issue: Recover OpenCode Generation After Backend Crash

## Date
- February 9, 2026

## Summary
The chat streaming pipeline now persists NDJSON stream logs and metadata, and marks in-flight streams as `interrupted` after a backend restart. However, if the backend process dies while OpenCode is still generating, we currently do not resume the in-progress OpenCode generation itself.

## Current Behavior
- Chat events are persisted to `.agents/chat_streams/<stream_id>.ndjson`.
- Stream metadata is persisted to `.agents/chat_streams_state.json`.
- On restart:
  - in-progress streams are marked `interrupted`;
  - completed-but-uncommitted streams are reconstructed from logs and committed to `.agents/chat_data.json`.
- Missing capability: re-attach to OpenCode and continue consuming generation for interrupted streams.

## Impact
- Users can still inspect partial logs and final committed responses when available.
- For crash mid-generation, responses can remain partial and never complete unless user retries.

## Proposed Follow-up
1. Persist enough OpenCode cursor/session context to support re-attach after restart.
2. Add a recovery worker on startup:
   - scans `interrupted` streams,
   - probes OpenCode session state,
   - resumes event consumption when generation is still active.
3. Add idempotent finalization guard to avoid duplicate assistant messages across retries.
4. Add integration test: simulate process crash during stream and verify successful resume/finalize.

## Acceptance Criteria
- Restart during generation no longer loses completion when OpenCode session is still alive.
- Stream status transitions: `interrupted -> running -> completed` (or `error/stopped`) are persisted.
- No duplicate assistant messages in chat history after recovery.
