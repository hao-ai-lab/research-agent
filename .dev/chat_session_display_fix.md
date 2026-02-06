# Chat Session Persistence Fix

## Problem Statement

The "Recent Chats" section in the navigation panel shows hardcoded mock data instead of real chat sessions from the backend. Backend persistence works correctly (verified in `chat_data.json`), but the frontend navigation page doesn't fetch or display real sessions.

## Root Cause

| Component             | Current Behavior                        | Expected                              |
| --------------------- | --------------------------------------- | ------------------------------------- |
| `server.py`           | ✅ Stores sessions correctly            | -                                     |
| `useChatSession` hook | ✅ Fetches sessions via API             | -                                     |
| `app/page.tsx`        | ❌ Doesn't pass sessions to NavPage     | Pass `sessions` and `onSelectSession` |
| `nav-page.tsx`        | ❌ Uses `mockChatHistory` (lines 29-66) | Accept and display real sessions      |

## Proposed Changes

### [MODIFY] [nav-page.tsx](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/components/nav-page.tsx)

1. **Remove mock data** (lines 29-66)
2. **Add new props** to `NavPageProps`:
   - `sessions: ChatSession[]` - real sessions from backend
   - `onSelectSession: (sessionId: string) => void` - callback when user clicks a session
3. **Update Recent Chats section** (lines 300-332) to use `sessions` prop instead of `filteredChats`

---

### [MODIFY] [app/page.tsx](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/app/page.tsx)

1. **Get sessions from hook**: Use `useChatSession` to get `sessions` and `selectSession`
2. **Pass to NavPage**:
   - `sessions={sessions}`
   - `onSelectSession={(id) => { selectSession(id); setActiveTab('chat'); }}`

---

### [MODIFY] [connected-chat-view.tsx](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/components/connected-chat-view.tsx)

1. **Export `useChatSession` hook** from this file (already done, used in page.tsx line 86)
2. Verify `selectSession` is exposed from the hook

---

## Verification Plan

### Manual Testing

1. **Start servers**:

   ```bash
   # Terminal 1
   cd /Users/mike/Project/GitHub/v0-research-agent-mobile/server
   python server.py --workdir ../tests/story/train-mlp

   # Terminal 2
   cd /Users/mike/Project/GitHub/v0-research-agent-mobile
   npm run dev
   ```

2. **Test session display**:
   - Open `http://localhost:3000`
   - Click hamburger menu
   - **Expected**: Recent Chats shows real sessions from `chat_data.json` (e.g., "Hi", "Analyze my latest run", etc.)
   - **Currently**: Shows mock data ("GPT-4 Fine-tuning Analysis", etc.)

3. **Test session selection**:
   - Click on a session in Recent Chats
   - **Expected**: Chat view loads with that session's messages
   - Navigate back, click different session
   - **Expected**: Messages change to selected session

4. **Test new chat**:
   - Click "New Chat" button
   - Send a message
   - Open nav menu
   - **Expected**: New session appears in Recent Chats

---

## Open Questions

None - this is a straightforward wiring fix.
