# Telegram Bot Setup Guide

This guide walks you through setting up Telegram notifications for Research Agent.

## Quick Start (5 minutes)

### Step 1: Create Your Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts:
   - Enter a **name** (e.g., "Research Agent Notifier")
   - Enter a **username** ending in `bot` (e.g., `my_research_agent_bot`)
4. Copy the **Bot Token** (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### Step 2: Get Your Chat ID

**Option A (Easiest):** Message [@userinfobot](https://t.me/userinfobot) - it replies with your user ID

**Option B:** After creating your bot:

1. Send any message to your new bot
2. Open this URL in browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Find `"chat":{"id":123456789}` in the response - that's your Chat ID

### Step 3: Configure in Research Agent

1. Open the Research Agent webapp
2. Go to **Settings** (gear icon) → **Integrations** → **Telegram**
3. Enter:
   - **Bot Token**: The token from BotFather
   - **Chat ID**: Your user/group ID
4. Click **Test Connection** - you should receive a message in Telegram!
5. Click **Connect to Telegram**

---

## Hello World Test

After setup, verify with a quick curl command:

```bash
# Replace with your actual values
BOT_TOKEN="123456:ABC-DEF1234..."
CHAT_ID="123456789"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${CHAT_ID}\", \"text\": \"🎉 Hello from Research Agent!\"}"
```

You should see the message appear in Telegram immediately.

---

## Environment Variables (Optional)

For server-side notifications (run completion alerts), set these env vars:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_CHAT_ID="your-chat-id"
export WEBAPP_PUBLIC_URL="https://your-app.vercel.app"  # For /link command
```

---

## Slash Commands

Once configured, your bot responds to these commands:

| Command   | Description                 |
| --------- | --------------------------- |
| `/start`  | Welcome message             |
| `/help`   | Show all commands           |
| `/status` | Server status + active runs |
| `/runs`   | List recent experiments     |
| `/link`   | Get webapp URL              |

> **Note**: For commands to work, you need webhook setup (see Advanced section below).

---

## Receiving Commands (Webhook Setup)

To receive commands like `/status`, `/runs` FROM Telegram, you need to configure a webhook. This tells Telegram where to send messages.

### Using the Settings UI (Recommended)

1. After connecting Telegram, you'll see a **Webhook URL** field
2. Enter your public server URL (e.g., `https://your-server.com`)
3. Click **Setup Webhook** - done!

> **Note**: Your server must be publicly accessible. For local development, use ngrok:
>
> ```bash
> ngrok http 10000
> # Use the https URL ngrok gives you
> ```

### Manual Setup (Alternative)

```bash
BOT_TOKEN="your-bot-token"
SERVER_URL="https://your-server.com"

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${SERVER_URL}/api/telegram/webhook"
```

---

## Troubleshooting

| Issue                           | Solution                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| "Test Connection" fails         | Double-check bot token and chat ID. Ensure you've messaged the bot first. |
| Bot doesn't respond to commands | Webhook not configured. See Advanced section above.                       |
| "Unauthorized" error            | Bot token is invalid. Create a new one via @BotFather.                    |
| "Chat not found"                | Chat ID is wrong. Message @userinfobot to get correct ID.                 |
