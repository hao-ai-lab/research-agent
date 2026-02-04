#!/usr/bin/env python3
"""
Minimal Chat Server for Research Agent

This is a focused chat server that provides:
- Multi-session chat management
- Streaming responses via NDJSON
- Integration with OpenCode API for AI responses

Run with: python server.py
"""

import json
import os
import time
import uuid
import logging
from typing import Dict, List, Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("chat-server")

# Configuration
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4099")
OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD")
MODEL_PROVIDER = "opencode"
MODEL_ID = "kimi-k2.5-free"
DATA_FILE = os.path.join(os.path.dirname(__file__), "chat_data.json")

# FastAPI app
app = FastAPI(title="Research Agent Chat Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Models
class ChatMessage(BaseModel):
    role: str  # user, assistant
    content: str
    thinking: Optional[str] = None
    timestamp: Optional[float] = None

class ChatRequest(BaseModel):
    session_id: str
    message: str
    wild_mode: bool = False

class CreateSessionRequest(BaseModel):
    title: Optional[str] = None

# State
chat_sessions: Dict[str, dict] = {}  # session_id -> {messages, opencode_session_id, created_at, title}

def save_state():
    """Persist chat sessions to disk."""
    try:
        with open(DATA_FILE, "w") as f:
            json.dump({"chat_sessions": chat_sessions}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving state: {e}")

def load_state():
    """Load chat sessions from disk."""
    global chat_sessions
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r") as f:
                data = json.load(f)
                chat_sessions = data.get("chat_sessions", {})
        except Exception as e:
            logger.error(f"Error loading state: {e}")

load_state()

async def get_opencode_session_for_chat(chat_session_id: str):
    """Get or create an OpenCode session for a specific chat session."""
    global chat_sessions
    
    if chat_session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Chat session not found")
    
    session = chat_sessions[chat_session_id]
    if session.get("opencode_session_id"):
        return session["opencode_session_id"]
    
    async with httpx.AsyncClient() as client:
        auth = httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD) if OPENCODE_PASSWORD else None
        resp = await client.post(f"{OPENCODE_URL}/session", json={}, auth=auth)
        resp.raise_for_status()
        data = resp.json()
        opencode_id = data.get("id")
        session["opencode_session_id"] = opencode_id
        save_state()
        logger.info(f"Created new OpenCode session {opencode_id} for chat {chat_session_id}")
        return opencode_id

# Endpoints

@app.get("/")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "chat-server"}

@app.get("/sessions")
async def list_sessions():
    """List all chat sessions with metadata."""
    sessions = []
    for sid, session in chat_sessions.items():
        sessions.append({
            "id": sid,
            "title": session.get("title", "New Chat"),
            "created_at": session.get("created_at"),
            "message_count": len(session.get("messages", []))
        })
    # Sort by created_at, newest first
    sessions.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return sessions

@app.post("/sessions")
async def create_session(req: Optional[CreateSessionRequest] = None):
    """Create a new chat session."""
    session_id = uuid.uuid4().hex[:12]
    title = req.title if req and req.title else "New Chat"
    chat_sessions[session_id] = {
        "title": title,
        "created_at": time.time(),
        "messages": [],
        "opencode_session_id": None
    }
    save_state()
    logger.info(f"Created new chat session: {session_id}")
    return {
        "id": session_id,
        "title": title,
        "created_at": chat_sessions[session_id]["created_at"],
        "message_count": 0
    }

@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a chat session with all messages."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", [])
    }

@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del chat_sessions[session_id]
    save_state()
    logger.info(f"Deleted chat session: {session_id}")
    return {"message": "Session deleted"}

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message and receive streaming response."""
    session_id = req.session_id
    
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = chat_sessions[session_id]
    messages = session.get("messages", [])
    is_new_session = len(messages) == 0
    
    # Add user message
    user_msg = {
        "role": "user",
        "content": req.message,
        "timestamp": time.time()
    }
    messages.append(user_msg)
    session["messages"] = messages
    
    # Auto-generate title from first message if still "New Chat"
    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")
    
    save_state()

    async def response_generator():
        try:
            opencode_session_id = await get_opencode_session_for_chat(session_id)
            wild_mode_note = ""
            if req.wild_mode:
                wild_mode_note = (
                    "[SYSTEM] Wild mode is ON. Be proactive but confirm before launching actions.\n\n"
                )

            content = f"{wild_mode_note}[USER] {req.message}"

            async with httpx.AsyncClient(timeout=None) as client:
                auth = httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD) if OPENCODE_PASSWORD else None
                # Send the prompt
                prompt_payload = {
                    "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
                    "parts": [{"type": "text", "text": content}]
                }
                logger.info(f"Sending prompt to OpenCode session {opencode_session_id} (Model: {MODEL_PROVIDER}/{MODEL_ID})")
                prompt_resp = await client.post(
                    f"{OPENCODE_URL}/session/{opencode_session_id}/prompt_async", 
                    json=prompt_payload,
                    auth=auth
                )
                prompt_resp.raise_for_status()
                logger.info(f"Sent to OpenCode session {opencode_session_id}")   

                # Stream from the global event endpoint
                full_text_response = ""
                full_thinking_response = ""
                
                async with client.stream("GET", f"{OPENCODE_URL}/global/event", headers={"Accept": "text/event-stream"}, auth=auth) as response:
                    logger.info(f"Start streaming from OpenCode session {opencode_session_id}")
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        
                        try:
                            event_data = json.loads(line[6:])
                            payload = event_data.get("payload", {})
                            etype = payload.get("type", "")
                            props = payload.get("properties", {})
                            
                            part = props.get("part", {})
                            event_sid = props.get("sessionID") or part.get("sessionID")
                            
                            if event_sid != opencode_session_id:
                                continue

                            # Protocol Translation
                            if etype == "message.part.updated":
                                ptype = part.get("type")
                                delta = props.get("delta", "")
                                if ptype == "text":
                                    full_text_response += delta
                                    yield json.dumps({
                                        "type": "part_delta",
                                        "id": part.get("id"),
                                        "ptype": "text",
                                        "delta": delta
                                    }) + "\n"
                                elif ptype == "reasoning":
                                    full_thinking_response += delta
                                    yield json.dumps({
                                        "type": "part_delta",
                                        "id": part.get("id"),
                                        "ptype": "reasoning",
                                        "delta": delta
                                    }) + "\n"
                                elif ptype == "tool":
                                    yield json.dumps({
                                        "type": "part_update",
                                        "id": part.get("id"),
                                        "ptype": "tool",
                                        "state": part.get("state"),
                                        "name": part.get("name")
                                    }) + "\n"

                            elif etype == "session.status":
                                if props.get("status", {}).get("type") == "idle":
                                    yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
                                    break
                        except Exception as e:
                            logger.error(f"Error parsing event line: {e}")
                            continue

                # Save assistant response to session
                if full_text_response or full_thinking_response:
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_text_response.strip(),
                        "thinking": full_thinking_response.strip() if full_thinking_response else None,
                        "timestamp": time.time()
                    }
                    session["messages"].append(assistant_msg)
                    save_state()

        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(response_generator(), media_type="application/x-ndjson")

if __name__ == "__main__":
    logger.info("Starting Chat Server on port 10000...")
    uvicorn.run(app, host="0.0.0.0", port=10000)
