# Slack Integration

Get real-time notifications for your Research Agent experiments directly in Slack.

## Features

- **Run Notifications** — Get alerted when runs complete or fail
- **Experiment Alerts** — Receive alert notifications with severity indicators
- **Test Notifications** — Verify your setup with a one-click test message
- **Per-Event Toggles** — Choose exactly which events trigger notifications
- **Rich Messages** — Formatted Slack messages with Block Kit

## Quick Start

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name your app (e.g., "Research Agent") and select your workspace

### 2. Configure Bot Permissions

Navigate to **OAuth & Permissions** and add these Bot Token Scopes:

| Scope           | Purpose                     |
| --------------- | --------------------------- |
| `chat:write`    | Send messages to channels   |
| `channels:read` | Access public channel info  |
| `groups:read`   | Access private channel info |
| `im:read`       | Access DM info              |
| `mpim:read`     | Access group DM info        |

### 3. Install to Workspace

1. Go to **Install App** in the sidebar
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 4. Invite the Bot

In your desired Slack channel, type:

```
/invite @YourBotName
```

### 5. Configure in Research Agent

**Option A: UI Settings**

1. Open Settings → Integrations → Slack
2. Enter your Bot Token and channel name
3. (Optional) Enter your Signing Secret from **Basic Information** → **App Credentials**
4. Toggle which notifications you want
5. Click **Connect to Slack**
6. Use **Send Test** to verify

**Option B: API**

```bash
curl -X POST http://localhost:10000/integrations/slack/configure \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: YOUR_TOKEN" \
  -d '{
    "bot_token": "xoxb-...",
    "channel": "#ml-experiments",
    "signing_secret": "",
    "notify_on_complete": true,
    "notify_on_failed": true,
    "notify_on_alert": true
  }'
```

## API Endpoints

| Method   | Endpoint                        | Description                                              |
| -------- | ------------------------------- | -------------------------------------------------------- |
| `POST`   | `/integrations/slack/configure` | Configure Slack with bot token, channel, and preferences |
| `GET`    | `/integrations/slack/status`    | Get current configuration status                         |
| `POST`   | `/integrations/slack/test`      | Send a test notification                                 |
| `DELETE` | `/integrations/slack/configure` | Disconnect Slack integration                             |

## Notification Types

### Run Completed ✅

Sent when a run finishes successfully. Includes run name, duration, and exit status.

### Run Failed ❌

Sent when a run fails or is stopped. Includes error details and exit code.

### Experiment Alert ⚠️

Sent when an alert is created. Color-coded by severity (critical/warning/info).

## Architecture

```
┌──────────────────┐    ┌───────────┐    ┌──────────┐
│  Research Agent   │───▶│   Slack   │───▶│  Slack   │
│  server.py hooks  │    │  Handler  │    │   API    │
└──────────────────┘    └───────────┘    └──────────┘
        │                     │
   Run status /          slack_handler.py
   Alert creation        SlackNotifier
```

- `server.py` triggers notifications on run status changes and alert creation
- `slack_handler.py` manages the Slack SDK client and message formatting
- Configuration persists in `settings.json` alongside other server settings
- Graceful degradation if `slack-sdk` is not installed

## Dependencies

- `slack-sdk>=3.27.0` (added to `server/requirements.txt`)

## Troubleshooting

| Issue                     | Solution                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| "channel_not_found"       | Ensure the bot is invited to the channel with `/invite @BotName` |
| "invalid_auth"            | Verify your Bot Token starts with `xoxb-` and is correct         |
| "not_in_channel"          | The bot needs to be a member of the target channel               |
| Messages not appearing    | Check that the correct notification toggles are enabled          |
| "slack-sdk not installed" | Run `pip install slack-sdk>=3.27.0` in your server environment   |
