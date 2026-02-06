"""
Telegram Bot Handler for Research Agent

Handles:
- Sending notifications to Telegram
- Processing incoming commands from Telegram webhook
- Slash commands: /start, /status, /runs, /link, /help
"""

import os
import httpx
from typing import Optional
from fastapi import APIRouter, Request
from pydantic import BaseModel

# Environment variables for Telegram
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
WEBAPP_PUBLIC_URL = os.environ.get("WEBAPP_PUBLIC_URL", "http://localhost:3000")

router = APIRouter(prefix="/api/telegram", tags=["telegram"])


class TelegramTestRequest(BaseModel):
    bot_token: str
    chat_id: str


class TelegramSendRequest(BaseModel):
    text: str
    parse_mode: str = "HTML"
    bot_token: Optional[str] = None
    chat_id: Optional[str] = None


# =============================================================================
# Helper Functions
# =============================================================================

def escape_html(text: str) -> str:
    """Escape HTML special characters for Telegram HTML parse mode."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


async def send_telegram_message(
    bot_token: str,
    chat_id: str,
    text: str,
    parse_mode: str = "HTML"
) -> dict:
    """Send a message to Telegram."""
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": parse_mode,
            },
            timeout=10.0,
        )
        return response.json()


# =============================================================================
# Command Handlers
# =============================================================================

def get_help_text() -> str:
    """Return help text with available commands."""
    return """🤖 <b>Research Agent Bot</b>

Available commands:
/start - Welcome message
/status - Server and system status
/runs - List recent experiment runs
/link - Get webapp URL
/help - Show this help message

<i>Tip: You'll receive notifications here when experiments complete or encounter errors.</i>"""


def get_start_text() -> str:
    """Return welcome message."""
    return """👋 <b>Welcome to Research Agent!</b>

I'll help you monitor your ML experiments and receive notifications.

Type /help to see available commands."""


async def get_status_text(runs: dict = None) -> str:
    """Return current server status."""
    # Count runs by status if provided
    if runs:
        running = sum(1 for r in runs.values() if r.get("status") == "running")
        completed = sum(1 for r in runs.values() if r.get("status") in ["finished", "completed"])
        failed = sum(1 for r in runs.values() if r.get("status") == "failed")
        queued = sum(1 for r in runs.values() if r.get("status") in ["queued", "ready"])
        
        return f"""📊 <b>Server Status</b>

🟢 Server: Online
📈 Experiments:
  • Running: {running}
  • Completed: {completed}
  • Failed: {failed}
  • Queued: {queued}"""
    
    return """📊 <b>Server Status</b>

🟢 Server: Online
ℹ️ No run data available"""


async def get_runs_text(runs: dict = None) -> str:
    """Return list of recent runs."""
    if not runs:
        return "📋 <b>Recent Runs</b>\n\nNo experiments found."
    
    # Get up to 10 most recent runs
    sorted_runs = sorted(
        runs.values(),
        key=lambda r: r.get("created_at", 0),
        reverse=True
    )[:10]
    
    if not sorted_runs:
        return "📋 <b>Recent Runs</b>\n\nNo experiments found."
    
    status_emoji = {
        "running": "🔄",
        "finished": "✅",
        "completed": "✅",
        "failed": "❌",
        "queued": "⏳",
        "ready": "📝",
        "stopped": "⏹️",
    }
    
    lines = ["📋 <b>Recent Runs</b>\n"]
    for run in sorted_runs:
        emoji = status_emoji.get(run.get("status", ""), "❓")
        name = escape_html(run.get("name", run.get("id", "Unknown")))
        status = run.get("status", "unknown")
        lines.append(f"  {emoji} <code>{name}</code> - {status}")
    
    return "\n".join(lines)


def get_link_text() -> str:
    """Return webapp link."""
    url = WEBAPP_PUBLIC_URL
    return f"""🔗 <b>Research Agent Webapp</b>

Open the dashboard:
{url}"""


async def handle_command(
    command: str,
    runs: dict = None,
) -> str:
    """Handle a telegram command and return the response text."""
    command = command.lower().strip()
    
    if command == "/start":
        return get_start_text()
    elif command == "/help":
        return get_help_text()
    elif command == "/status":
        return await get_status_text(runs)
    elif command == "/runs":
        return await get_runs_text(runs)
    elif command == "/link":
        return get_link_text()
    else:
        return f"❓ Unknown command: {escape_html(command)}\n\nType /help for available commands."


# =============================================================================
# API Endpoints
# =============================================================================

@router.post("/test")
async def test_telegram_connection(request: TelegramTestRequest):
    """Test Telegram bot connection by sending a test message."""
    try:
        result = await send_telegram_message(
            bot_token=request.bot_token,
            chat_id=request.chat_id,
            text="""✅ <b>Research Agent connected successfully!</b>

Available commands:
/status - System status
/runs - List experiments
/link - Get webapp URL
/help - Show commands""",
        )
        return {"ok": result.get("ok", False), "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/send")
async def send_notification(request: TelegramSendRequest):
    """Send a notification message to Telegram."""
    bot_token = request.bot_token or TELEGRAM_BOT_TOKEN
    chat_id = request.chat_id or TELEGRAM_CHAT_ID
    
    if not bot_token or not chat_id:
        return {"ok": False, "error": "Bot token and chat ID required"}
    
    try:
        result = await send_telegram_message(
            bot_token=bot_token,
            chat_id=chat_id,
            text=request.text,
            parse_mode=request.parse_mode,
        )
        return {"ok": result.get("ok", False), "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/webhook")
async def telegram_webhook(request: Request):
    """
    Webhook endpoint for receiving Telegram updates.
    
    To set up the webhook, call:
    https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_SERVER>/api/telegram/webhook
    """
    try:
        update = await request.json()
        
        # Extract message if present
        message = update.get("message", {})
        text = message.get("text", "")
        chat_id = message.get("chat", {}).get("id")
        
        if not text or not chat_id:
            return {"ok": True}  # Ignore non-text updates
        
        # Check if it's a command
        if text.startswith("/"):
            # Import runs from main server module if available
            try:
                from server import runs
            except ImportError:
                runs = {}
            
            response_text = await handle_command(text.split()[0], runs)
            
            # Get bot token from env or storage
            bot_token = TELEGRAM_BOT_TOKEN
            if bot_token:
                await send_telegram_message(
                    bot_token=bot_token,
                    chat_id=str(chat_id),
                    text=response_text,
                )
        
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# =============================================================================
# Notification Helpers (for use by server.py)
# =============================================================================

async def notify_run_completed(run_name: str, run_id: str, status: str = "completed"):
    """Send a notification when a run completes."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    
    emoji = "✅" if status == "completed" else "❌" if status == "failed" else "ℹ️"
    text = f"""{emoji} <b>Run {status}</b>

<code>{escape_html(run_name)}</code>
ID: {run_id}

Open in dashboard: {WEBAPP_PUBLIC_URL}"""
    
    await send_telegram_message(
        bot_token=TELEGRAM_BOT_TOKEN,
        chat_id=TELEGRAM_CHAT_ID,
        text=text,
    )


async def notify_alert(run_name: str, alert_type: str, message: str):
    """Send an alert notification."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    
    emoji = "🚨" if alert_type == "error" else "⚠️" if alert_type == "warning" else "ℹ️"
    text = f"""{emoji} <b>Alert: {alert_type.upper()}</b>

Run: <code>{escape_html(run_name)}</code>
{escape_html(message)}"""
    
    await send_telegram_message(
        bot_token=TELEGRAM_BOT_TOKEN,
        chat_id=TELEGRAM_CHAT_ID,
        text=text,
    )
