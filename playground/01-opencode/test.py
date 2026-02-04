import httpx
import asyncio
import json
import os
import sys

# Configuration
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://localhost:4099")
USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD")
MODEL_PROVIDER = "opencode"
MODEL_ID = "kimi-k2.5-free"

async def test_opencode_interaction():
    """Main test flow: create session, send prompt, and stream response."""
    print(f"🚀 Starting OpenCode interaction test at {OPENCODE_URL}")
    
    auth = httpx.BasicAuth(USERNAME, PASSWORD) if PASSWORD else None
    async with httpx.AsyncClient(timeout=None, auth=auth) as client:
        try:
            # 1. Create Session
            session_id = await create_session(client)
            if not session_id:
                return

            # 2. Send Prompt
            if not await send_prompt(client, session_id, "Hello, tell me a very short joke."):
                return

            # 3. Stream and Process Events
            print("👂 Waiting for response stream...")
            await stream_events(client, session_id)
            
        except httpx.ConnectError:
            print(f"🛑 Connection Error: Is OpenCode running on {OPENCODE_URL}?")
        except Exception as e:
            print(f"💥 Unexpected Error: {e}")

async def create_session(client):
    """Creates a new OpenCode session."""
    print("📡 Creating session...")
    resp = await client.post(f"{OPENCODE_URL}/session", json={})
    if resp.status_code != 200:
        print(f"❌ Session creation failed ({resp.status_code}): {resp.text}")
        return None
    
    sid = resp.json().get("id")
    print(f"✅ Session created: {sid}")
    return sid

async def send_prompt(client, session_id, text):
    """Sends a prompt to the specified session."""
    print(f"📤 Sending prompt: '{text}' (Model: {MODEL_PROVIDER}/{MODEL_ID})")
    payload = {
        "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
        "parts": [{"type": "text", "text": text}]
    }
    resp = await client.post(f"{OPENCODE_URL}/session/{session_id}/prompt_async", json=payload)
    
    if resp.status_code not in [200, 204]:
        print(f"❌ Prompt failed ({resp.status_code}): {resp.text}")
        return False
        
    print("✅ Prompt accepted.")
    return True

async def stream_events(client, session_id):
    """Streams events and handles output or errors for the session."""
    async with client.stream("GET", f"{OPENCODE_URL}/global/event", headers={"Accept": "text/event-stream"}) as response:
        if response.status_code != 200:
            print(f"❌ Event stream connection failed ({response.status_code})")
            return

        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            
            try:
                event = json.loads(line[6:])
                payload = event.get("payload", {})
                etype = payload.get("type", "")
                props = payload.get("properties", {})
                
                # Check if this event belongs to our session
                parts = props.get("part", {})
                event_sid = props.get("sessionID") or parts.get("sessionID")
                if event_sid != session_id:
                    continue

                if etype == "message.part.updated":
                    handle_delta(props, parts)
                elif etype == "session.error":
                    handle_error(props)
                elif etype == "session.status" and props.get("status", {}).get("type") == "idle":
                    print("\n\n✅ Session reached idle state.")
                    break
                        
            except (json.JSONDecodeError, KeyError):
                continue

def handle_delta(props, part):
    """Prints text deltas to stdout."""
    if part.get("type") == "text":
        sys.stdout.write(props.get("delta", ""))
        sys.stdout.flush()

def handle_error(props):
    """Prints diagnostic information for session errors."""
    error = props.get("error", {})
    message = error.get("data", {}).get("message") or error.get("message") or "Unknown error"
    url = error.get("data", {}).get("metadata", {}).get("url")
    
    print(f"\n\n❌ Session Error: {message}")
    if url:
        print(f"🔗 Target URL: {url}")
    if "401" in str(message) or "unauthorized" in str(message).lower():
        print("💡 TIP: This looks like a provider authorization issue (e.g., GitHub Copilot or OpenAI key).")

if __name__ == "__main__":
    asyncio.run(test_opencode_interaction())
