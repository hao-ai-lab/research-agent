import json
import os
import time
import secrets
from datetime import datetime
from typing import AsyncGenerator

import modal
from fastapi import Request, FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
import httpx

# Create the Modal app
app = modal.App("openai-gateway-v2")

# Image with required dependencies
image = modal.Image.debian_slim().pip_install("httpx", "fastapi", "starlette")

# Create FastAPI app
web_app = FastAPI(title="OpenAI Gateway", version="1.0.0")

# Global HTTP client
client = httpx.AsyncClient(timeout=120.0)

@web_app.middleware("http")
async def log_full_request(request: Request, call_next):
    print(f"\n🌍 [INCOMING] {request.method} {request.url}")
    print(f"   Path: {request.url.path}")
    print(f"   Headers: {dict(request.headers)}")
    
    # Try to peek at body (careful not to consume stream if not needed, but for debug we want it)
    # Note: Consuming request.stream() in middleware can be tricky. 
    # Safest is to log path/headers here, and body in the endpoint or using a deeper inspection if needed.
    # For 404s, we won't hit the endpoint. Standard FastAPI logging might hide 404 details.
    
    response = await call_next(request)
    
    print(f"🏁 [RESPONSE] Status: {response.status_code}")
    return response

def log_request(request_data: dict, metadata: dict):
    """Log incoming request with metadata."""
    log_entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "type": "request",
        "metadata": metadata,
        "payload": {
            "model": request_data.get("model"),
            "messages_count": len(request_data.get("messages", [])),
            "stream": request_data.get("stream", False),
            "max_tokens": request_data.get("max_tokens"),
            # Don't log full message content for privacy, just summary
            "first_message_role": request_data.get("messages", [{}])[0].get("role"),
            "first_message_preview": request_data.get("messages", [{}])[0].get("content", "")[:50] + "..."
            if request_data.get("messages") else None,
        }
    }
    print(f"📥 REQUEST: {json.dumps(log_entry, indent=2)}")
    return log_entry


def log_response(response_data: dict, latency_ms: float):
    """Log response with latency info."""
    log_entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "type": "response",
        "latency_ms": latency_ms,
        "usage": response_data.get("usage"),
        "model": response_data.get("model"),
        "finish_reason": response_data.get("choices", [{}])[0].get("finish_reason")
        if response_data.get("choices") else None,
    }
    print(f"📤 RESPONSE: {json.dumps(log_entry, indent=2)}")
    return log_entry

@web_app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """
    OpenAI-compatible /v1/chat/completions endpoint.
    
    Accepts standard OpenAI chat completion requests and forwards to DeepInfra.
    Requires 'Authorization: Bearer <GATEWAY_TOKEN>' header.
    """
    start_time = time.time()

    # Print the raw request
    print(f"🔍 RAW REQUEST: {request.method} {request.url}")
    print(f"🔍 RAW HEADERS: {dict(request.headers)}")
    print(f"🔍 RAW BODY: {await request.body()}")
    
    # --- AUTHENTICATION ---
    auth_header = request.headers.get("Authorization")
    gateway_token = os.environ.get("GATEWAY_TOKEN", "")
    
    if not gateway_token:
        # If token is not configured on server, deny everything by default for security
        print("❌ Secure Error: GATEWAY_TOKEN not configured on server")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": "Gateway misconfiguration", "type": "server_error"}}
        )
    print(f"🔍 Auth: Found GATEWAY_TOKEN. Now checking Authorization header...")

    if not auth_header or not auth_header.startswith("Bearer "):
        print("❌ Auth Error: Missing or invalid Authorization header")
        return JSONResponse(
            status_code=401,
            content={"error": {"message": "Missing API key", "type": "invalid_request_error"}}
        )
    print(f"🔍 Auth: Found Authorization header. Now comparing...")
    
    # Constant-time comparison to prevent timing attacks
    client_token = auth_header.split("Bearer ")[1].strip()
    if not secrets.compare_digest(client_token, gateway_token):
        print("❌ Auth Error: Invalid token provided")
        return JSONResponse(
            status_code=401,
            content={"error": {"message": "Invalid API key", "type": "invalid_request_error"}}
        )
    print(f"✅ Auth: Valid token provided")
    # ----------------------

    # Parse JSON body manually
    print(f"🔍 Request: Parsing JSON body...")
    try:
        request_data = await request.json()
    except Exception:
        request_data = {}
    # print(f"🔍 Request: Parsed JSON body: {request_data}")
    
    # Extract metadata from request
    metadata = {
        "gateway_version": "1.0.0",
        "backend": "deepinfra",
        "request_id": f"gw-{int(time.time() * 1000)}",
        "auth_user": "authenticated_client"
    }
    print(f"🔍 Request: Extracted metadata: {metadata}")
    
    # Log the incoming request
    log_request(request_data, metadata)
    
    # Get DeepInfra token
    print(f"🔍 Request: Getting DeepInfra token...")
    deepinfra_token = os.environ.get("DEEPINFRA_TOKEN")
    if not deepinfra_token:
        print(f"❌ Error: DEEPINFRA_TOKEN not configured")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": "DEEPINFRA_TOKEN not configured", "type": "server_error"}}
        )
    print(f"🔍 Request: Found DeepInfra token")
    
    # Forward to DeepInfra
    deepinfra_url = "https://api.deepinfra.com/v1/openai/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {deepinfra_token}",
    }
    
    # Aggressively filter keys for Gemini/DeepInfra debugging
    allowed_keys = {"model", "messages", "stream", "max_tokens", "temperature", "top_p"}
    keys_to_remove = []
    for key in request_data.keys():
        if key not in allowed_keys:
            keys_to_remove.append(key)
    
    for key in keys_to_remove:
        print(f"⚠️ Removing potentially unsupported key: {key}")
        del request_data[key]

    print(f"🔍 Request: Forwarding to DeepInfra...")
    is_streaming = request_data.get("stream", False)
    
    if is_streaming:
        async def stream_generator():
            try:
                async with client.stream("POST", deepinfra_url, json=request_data, headers=headers) as upstream_resp:
                    # Propagate 4xx/5xx from upstream
                    if upstream_resp.status_code >= 400:
                        print(f"❌ Upstream stream error: {upstream_resp.status_code}")
                        error_content = await upstream_resp.read()
                        yield json.dumps({"error": f"Upstream error {upstream_resp.status_code}: {error_content.decode()}"}).encode()
                        return

                    async for chunk in upstream_resp.aiter_bytes():
                        yield chunk
            except Exception as e:
                print(f"❌ Streaming error: {e}")
                yield json.dumps({"error": str(e)}).encode()

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={"X-Gateway-Request-Id": metadata["request_id"]}
        )
    else:
        # Handle non-streaming response
        try:
            response = await client.post(deepinfra_url, json=request_data, headers=headers)
            latency_ms = (time.time() - start_time) * 1000
            
            if response.status_code == 200:
                response_data = response.json()
                log_response(response_data, latency_ms)
                return JSONResponse(
                    content=response_data,
                    headers={"X-Gateway-Request-Id": metadata["request_id"]}
                )
            else:
                return JSONResponse(
                    status_code=response.status_code,
                    content={"error": {"message": f"{response.text} | Debug Body: {json.dumps(request_data)}", "type": "upstream_error"}}
                )
        except Exception as e:
            print(f"❌ Request error: {e}")
            return JSONResponse(
                status_code=500,
                content={"error": {"message": str(e), "type": "server_error"}}
            )


@web_app.get("/health")
async def health():
    """Health check endpoint."""
    print("🔍 Health check endpoint")
    return {"status": "ok", "gateway": "openai-gateway", "version": "1.0.0"}


@web_app.get("/v1/models")
async def models():
    """List available models (OpenAI-compatible /v1/models endpoint)."""
    return {
        "object": "list",
        "data": [
            {
                "id": "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
                "object": "model",
                "created": 1700000000,
                "owned_by": "meta",
            },
            {
                "id": "meta-llama/Meta-Llama-3.1-70B-Instruct",
                "object": "model",
                "created": 1700000000,
                "owned_by": "meta",
            },
            {
                "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
                "object": "model",
                "created": 1700000000,
                "owned_by": "Qwen",
            },
            {
                "id": "deepseek-ai/DeepSeek-V3",
                "object": "model",
                "created": 1700000000,
                "owned_by": "deepseek-ai",
            },
            { "id": "moonshotai/Kimi-K2.5", "object": "model", "created": 1700000000, "owned_by": "moonshotai" },
            { "id": "zai-org/GLM-4.7-Flash", "object": "model", "created": 1700000000, "owned_by": "zai-org" },
            { "id": "MiniMaxAI/MiniMax-M2.1", "object": "model", "created": 1700000000, "owned_by": "MiniMaxAI" },
            { "id": "allenai/Olmo-3.1-32B-Instruct", "object": "model", "created": 1700000000, "owned_by": "allenai" },
            { "id": "anthropic/claude-4-opus", "object": "model", "created": 1700000000, "owned_by": "anthropic" },
            { "id": "anthropic/claude-3-7-sonnet-latest", "object": "model", "created": 1700000000, "owned_by": "anthropic" },
            { "id": "anthropic/claude-4-sonnet", "object": "model", "created": 1700000000, "owned_by": "anthropic" },
            # { "id": "google/gemini-2.5-pro", "object": "model", "created": 1700000000, "owned_by": "google" },
            # { "id": "google/gemini-2.5-flash", "object": "model", "created": 1700000000, "owned_by": "google" }
        ]
    }

@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("deepinfra-secrets"),
        modal.Secret.from_name("gateway-secrets"),
    ],
    timeout=300,
)
@modal.asgi_app()
def api():
    return web_app
