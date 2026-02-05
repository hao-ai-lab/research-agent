# Slack Integration for Research Agent Chatbot

## Overview

**Goal**: Enable the Research Agent chatbot to be accessed via Slack, allowing users to interact with the AI assistant directly in Slack channels/DMs, receive notifications about run events, and manage ML experiments without leaving Slack.

```mermaid
graph TB
    subgraph Slack
        SlackApp[Slack App]
        SlackBot[Bot User]
        SlackEvents[Events API]
    end
    
    subgraph Backend
        Server[server.py]
        SlackHandler[slack_handler.py]
        OpenCode[OpenCode Integration]
    end
    
    subgraph Frontend
        WebUI[Next.js UI]
        Settings[Settings Dialog]
    end
    
    SlackBot -->|Messages| SlackEvents
    SlackEvents -->|Webhook| SlackHandler
    SlackHandler -->|Chat API| Server
    Server -->|response| SlackHandler
    SlackHandler -->|Reply| SlackBot
    Server -->|Notifications| SlackHandler
    SlackHandler -->|Post| Slack
    Settings -->|Configure| Server
```

---

## What You Need (Prerequisites)

### 1. Slack App Setup

You'll need to create a Slack App in the [Slack API Console](https://api.slack.com/apps):

| Item | Description |
|------|-------------|
| **Slack Workspace** | A workspace where you have permission to install apps |
| **Slack App** | Create via api.slack.com/apps → "Create New App" |
| **Bot Token** | OAuth token starting with `xoxb-` (Bot Token Scopes) |
| **Signing Secret** | For verifying webhook requests |
| **App-Level Token** | For Socket Mode (optional, for local dev) |

### 2. Required Bot Token Scopes

```
app_mentions:read     - React to @mentions
channels:history      - Read messages in channels
channels:read         - View channel info
chat:write            - Send messages
files:read            - Access file attachments
files:write           - Upload files (logs, charts)
im:history            - Read DM history
im:read               - View DM info
im:write              - Send DMs
reactions:read        - Read reactions
reactions:write       - Add reactions
users:read            - Get user info
```

### 3. Event Subscriptions

Enable these events in your Slack App:

| Event | Trigger |
|-------|---------|
| `app_mention` | When someone @mentions the bot |
| `message.im` | Direct messages to the bot |
| `message.channels` | Messages in channels (optional) |

### 4. Environment Variables

Add to `server/.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token    # Optional, for Socket Mode
SLACK_ENABLED=true
```

---

## What I Will Implement

### Phase 1: Backend Slack Handler

#### [NEW] [slack_handler.py](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/server/slack_handler.py)

A new module to handle Slack integration:

```python
# Key functionality:
- Webhook endpoint for Slack events
- Message parsing and command routing
- Integration with existing chat endpoints
- Notification delivery to Slack channels
- Thread management for conversations
```

**Features**:
- **Chat Integration**: Route Slack messages through existing `/chat` endpoint
- **Session Management**: Map Slack thread_ts to chat session IDs
- **Rich Formatting**: Convert AI responses to Slack Block Kit
- **File Attachments**: Handle image/file uploads from Slack
- **Reactions**: Use emoji reactions for status feedback (⏳ thinking, ✅ done, ❌ error)

#### [MODIFY] [server.py](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/server/server.py)

Add Slack endpoints and event hooks:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/slack/events` | POST | Slack Events API webhook |
| `/slack/interactions` | POST | Interactive component callbacks |
| `/slack/notify` | POST | Send notification to configured channel |

---

### Phase 2: Notification System

#### Run Event Notifications

When run status changes occur, optionally post to Slack:

```
🚀 Run Started: train-gpt-large
   Command: python train.py --lr=0.001
   
✅ Run Completed: train-gpt-large  
   Duration: 2h 34m
   Final Loss: 0.0234
   
❌ Run Failed: train-gpt-large
   Error: CUDA out of memory
   [View Logs] [Restart]
```

#### Alert Notifications

Forward high-priority alerts to Slack:

```
⚠️ Alert: Loss Spike Detected
   Run: train-transformer-v2
   Current Loss: 2.34 (was 0.45)
   [View Run] [Acknowledge] [Dismiss]
```

---

### Phase 3: Slash Commands (Optional)

Register slash commands for quick actions:

| Command | Description |
|---------|-------------|
| `/run list` | List recent runs |
| `/run start <name>` | Start a queued run |
| `/run stop <id>` | Stop a running job |
| `/sweep create` | Create hyperparameter sweep |
| `/chat <message>` | Chat with AI assistant |

---

### Phase 4: Frontend Integration

#### [MODIFY] [types.ts](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/lib/types.ts)

Extend Slack integration settings:

```typescript
slack?: {
  enabled: boolean
  apiKey?: string      // Bot token
  channel?: string     // Default notification channel
  notifyOnComplete?: boolean
  notifyOnFail?: boolean
  notifyOnAlert?: boolean
  threadReplies?: boolean  // Reply in threads
}
```

#### [MODIFY] [settings-dialog.tsx](file:///Users/mike/Project/GitHub/v0-research-agent-mobile/components/settings-dialog.tsx)

- Add notification preference toggles
- Add "Test Connection" button
- Show connection status

---

## Architecture Details

### Message Flow

```
User @mentions bot in Slack
        ↓
Slack Events API → POST /slack/events
        ↓
slack_handler.py parses event
        ↓
Find/create chat session for thread
        ↓
Call existing chat() function
        ↓
Stream response (accumulate for Slack)
        ↓
Format with Block Kit
        ↓
Post reply to Slack thread
```

### Thread-to-Session Mapping

```json
{
  "slack_threads": {
    "C012345.1234567890.123456": {
      "session_id": "abc123def456",
      "channel_id": "C012345",
      "user_id": "U012345",
      "created_at": 1234567890
    }
  }
}
```

### Slack Block Kit Response Format

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "AI response with *formatting*"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "🤖 Research Agent | 0.8s"
        }
      ]
    }
  ]
}
```

---

## Dependencies

### Python (add to `server/requirements.txt`)

```
slack-sdk>=3.23.0
slack-bolt>=1.18.0  # Optional, for easier event handling
```

---

## Implementation Checklist

### Slack App Setup (Manual)
- [ ] Create Slack App at api.slack.com
- [ ] Configure Bot Token Scopes
- [ ] Enable Event Subscriptions
- [ ] Install app to workspace
- [ ] Get tokens and secrets

### Backend
- [ ] Create `slack_handler.py` with SlackHandler class
- [ ] Add webhook endpoints to `server.py`
- [ ] Implement thread-to-session mapping
- [ ] Add notification functions
- [ ] Handle Slack message formatting
- [ ] Add error handling and rate limiting

### Frontend
- [ ] Extend Slack settings in `types.ts`
- [ ] Add notification toggles to settings dialog
- [ ] Add connection test button
- [ ] Show Slack status indicator

### Testing
- [ ] Test app mention responses
- [ ] Test DM conversations
- [ ] Test run notifications
- [ ] Test alert forwarding
- [ ] Test thread continuity

---

## Verification Plan

### Manual Testing

1. **Bot Mention Test**
   - @mention the bot in a channel
   - Verify bot responds in a thread
   - Continue conversation in thread
   - Confirm session continuity

2. **DM Test**
   - Send DM to bot
   - Verify response
   - Check session persists

3. **Notification Test**
   - Start a run from web UI
   - Verify Slack notification sent
   - Click action buttons
   - Confirm actions work

### Scripts

```bash
# Test Slack connection
curl -X POST http://localhost:10000/slack/test

# Simulate Slack event
curl -X POST http://localhost:10000/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type": "url_verification", "challenge": "test"}'
```

---

## Open Questions for You

1. **Socket Mode vs Webhooks**: Do you have a public URL for webhooks, or should I implement Socket Mode for local development?

2. **Notification Granularity**: Should notifications be per-run configurable, or global settings only?

3. **Multi-Workspace**: Do you need support for multiple Slack workspaces?

4. **Rate Limiting**: Any concerns about message rate limits in your Slack plan?

5. **Existing Slack App**: Do you already have a Slack app created, or should I provide step-by-step instructions for creating one?

---

## Timeline Estimate

| Phase | Effort | Description |
|-------|--------|-------------|
| Phase 1 | 2-3h | Slack handler + basic messaging |
| Phase 2 | 1-2h | Notification system |
| Phase 3 | 1h | Slash commands (optional) |
| Phase 4 | 30m | Frontend settings update |
| Testing | 1h | End-to-end verification |

**Total**: ~5-7 hours of implementation time

---

## References

- [Slack API Documentation](https://api.slack.com/docs)
- [Slack Block Kit Builder](https://app.slack.com/block-kit-builder)
- [slack-sdk Python Package](https://slack.dev/python-slack-sdk/)
- [Slack Events API](https://api.slack.com/events-api)
