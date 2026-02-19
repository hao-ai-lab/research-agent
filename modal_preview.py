"""
Modal Preview App – deploys a full Research Agent stack per PR.

Usage (local test):
    modal serve modal_preview.py

Deployed by GitHub Actions on PR open/push:
    modal deploy modal_preview.py --name research-agent-preview-pr-{N}

Required Modal Secret "research-agent-preview-secrets":
    RESEARCH_AGENT_USER_AUTH_TOKEN  – auth token for the preview instance
    ANTHROPIC_API_KEY               – (optional) for agent/chat features
    RESEARCH_AGENT_KEY              – (optional) gateway key
"""

import modal
import logging
import os
import subprocess
import signal
import sys

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request as StarletteRequest
from starlette.responses import StreamingResponse as StarletteStreamingResponse, Response as StarletteResponse
from starlette.routing import Route

# ---------------------------------------------------------------------------
# Image: Node 18 + Python 3.11 + tmux + opencode
# ---------------------------------------------------------------------------

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("tmux", "curl", "git", "ca-certificates", "gnupg")
    # Install Node.js 20 (Next.js requires >=20.9.0)
    .run_commands(
        "mkdir -p /etc/apt/keyrings",
        "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
        'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
        "apt-get update && apt-get install -y nodejs",
    )
    # Python deps for the backend
    .pip_install(
        "fastapi>=0.104.0",
        "uvicorn>=0.24.0",
        "httpx>=0.25.0",
        "pydantic>=2.0.0",
        "libtmux>=0.32.0",
        "requests>=2.31.0",
        "pyyaml>=6.0",
    )
    # Install opencode CLI (always installs to $HOME/.opencode/bin)
    .run_commands(
        "curl -fsSL https://opencode.ai/install | bash",
        "ls -la /root/.opencode/bin/opencode && /root/.opencode/bin/opencode --version || echo 'opencode install failed'",
        "mv /root/.opencode/bin/opencode /usr/local/bin/opencode",
        "which opencode"
    )
    # Copy the full repo into the image
    .add_local_dir(".", "/app", copy=True, ignore=["node_modules", ".next", ".git", "out", "dist", ".ra-venv", "__pycache__"])
    # Install frontend deps (dev mode, no static export needed)
    .run_commands(
        "npm install -g pnpm",
        "cd /app && pnpm install --frozen-lockfile || cd /app && pnpm install",
    )
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = modal.App("research-agent-preview")

OPENCODE_BIN = "/usr/local/bin/opencode"
OPENCODE_PORT = "4096"
BACKEND_INTERNAL_PORT = 10001  # Backend listens here; proxy on 10000
MODAL_PREVIEW_OPENCODE_URL = os.environ.get("MODAL_PREVIEW_OPENCODE_URL", "").strip()
# Captured at deploy time (CI injects a per-PR token).
# The Modal Secret may also contain a stale RESEARCH_AGENT_USER_AUTH_TOKEN;
# we store the deploy-time value here so functions can forcibly use it.
_DEPLOY_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "").strip()

_FUNCTION_ENV = {}
if MODAL_PREVIEW_OPENCODE_URL:
    _FUNCTION_ENV["MODAL_PREVIEW_OPENCODE_URL"] = MODAL_PREVIEW_OPENCODE_URL
if _DEPLOY_AUTH_TOKEN:
    _FUNCTION_ENV["RESEARCH_AGENT_USER_AUTH_TOKEN"] = _DEPLOY_AUTH_TOKEN

_proxy_logger = logging.getLogger("ip-tracker")
_proxy_logger.setLevel(logging.INFO)
_proxy_logger.addHandler(logging.StreamHandler())


def _get_client_ip(request: StarletteRequest) -> str:
    """Extract the real client IP from proxy headers."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip", "")
    if real_ip:
        return real_ip.strip()
    if request.client:
        return request.client.host
    return "unknown"


def _start_ip_tracking_proxy(
    host: str = "0.0.0.0", port: int = 10000, backend_port: int = BACKEND_INTERNAL_PORT,
) -> None:
    """Run a lightweight reverse-proxy that logs every request's IP address.

    This blocks the calling thread, which is fine because
    ``@modal.web_server`` expects the decorated function to stay alive.
    """
    backend_url = f"http://127.0.0.1:{backend_port}"
    # Long-lived client so connections are reused across requests.
    _http_client = httpx.AsyncClient(base_url=backend_url, timeout=httpx.Timeout(30.0, read=300.0))

    async def _proxy(request: StarletteRequest) -> StarletteResponse:
        client_ip = _get_client_ip(request)
        path = request.url.path
        if request.url.query:
            path = f"{path}?{request.url.query}"

        _proxy_logger.info("REQUEST %s %s %s", client_ip, request.method, path)

        # Build outgoing headers (drop hop-by-hop)
        headers = dict(request.headers)
        for h in ("host", "transfer-encoding"):
            headers.pop(h, None)

        body = await request.body()

        # Use streaming to support SSE / chunked responses (e.g. /chat).
        backend_req = _http_client.build_request(
            method=request.method, url=path, headers=headers, content=body,
        )
        backend_resp = await _http_client.send(backend_req, stream=True)

        content_type = backend_resp.headers.get("content-type", "")
        is_streaming = "text/event-stream" in content_type or "chunked" in backend_resp.headers.get("transfer-encoding", "")

        _proxy_logger.info(
            "RESPONSE %s %s %s -> %d%s",
            client_ip, request.method, request.url.path, backend_resp.status_code,
            " (streaming)" if is_streaming else "",
        )

        # Strip hop-by-hop headers from the response.
        resp_headers = dict(backend_resp.headers)
        for h in ("transfer-encoding", "content-length", "connection"):
            resp_headers.pop(h, None)

        if is_streaming:
            async def _stream():
                try:
                    async for chunk in backend_resp.aiter_bytes():
                        yield chunk
                finally:
                    await backend_resp.aclose()

            return StarletteStreamingResponse(
                content=_stream(),
                status_code=backend_resp.status_code,
                headers=resp_headers,
                media_type=content_type.split(";")[0].strip() if content_type else None,
            )

        # Non-streaming: read full body and close.
        resp_body = await backend_resp.aread()
        await backend_resp.aclose()
        return StarletteResponse(
            content=resp_body,
            status_code=backend_resp.status_code,
            headers=resp_headers,
        )

    proxy_app = Starlette(
        routes=[Route("/{path:path}", _proxy, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])],
    )

    _proxy_logger.info("IP-tracking proxy listening on %s:%d -> %s", host, port, backend_url)
    uvicorn.run(proxy_app, host=host, port=port, log_level="warning")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("research-agent-preview-secrets")],
    timeout=7200,  # 2 hours max
    cpu=8.0,
    memory=8 * 1024,  # 8GB
    env=_FUNCTION_ENV,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(port=10000, startup_timeout=120)
def preview_server():
    """Start the full Research Agent stack inside Modal (dev mode)."""
    os.chdir("/app")

    env = {**os.environ}
    # Prefer the deploy-time token over any stale value from the Modal Secret.
    auth_token = _DEPLOY_AUTH_TOKEN or env.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "preview-token")
    env["RESEARCH_AGENT_USER_AUTH_TOKEN"] = auth_token

    # Prepare workdir
    workdir = "/app"
    os.makedirs(os.path.join(workdir, ".agents"), exist_ok=True)

    # Start a tmux server for job execution support (best-effort)
    try:
        subprocess.Popen(["tmux", "new-session", "-d", "-s", "research-agent"], env=env)
    except Exception as e:
        print(f"WARNING: tmux failed to start: {e}")

    # Route backend OpenCode traffic to external endpoint when configured.
    external_opencode_url = env.get("MODAL_PREVIEW_OPENCODE_URL", "").strip()
    if external_opencode_url:
        env["OPENCODE_URL"] = external_opencode_url
        print(f"Using external OpenCode endpoint: {external_opencode_url}")

    # Fallback: start local OpenCode only when external endpoint is not configured.
    opencode_config = "/app/server/opencode.json"
    if os.path.isfile(opencode_config):
        env["OPENCODE_CONFIG"] = opencode_config
    if not external_opencode_url:
        try:
            if os.path.isfile(OPENCODE_BIN):
                env["OPENCODE_URL"] = f"http://127.0.0.1:{OPENCODE_PORT}"
                subprocess.Popen(
                    [
                        OPENCODE_BIN, "serve",
                        "--hostname", "127.0.0.1",
                        "--port", OPENCODE_PORT,
                    ],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                print(f"local opencode server started at {env['OPENCODE_URL']}")
            else:
                print(f"WARNING: opencode binary not found at {OPENCODE_BIN}, skipping")
        except Exception as e:
            print(f"WARNING: opencode failed to start: {e}")

    # Start the FastAPI backend on the internal port (not directly exposed)
    print(f"Starting backend on port {BACKEND_INTERNAL_PORT}...")
    subprocess.Popen(
        [
            sys.executable, "/app/server/server.py",
            "--workdir", workdir,
            "--host", "0.0.0.0",
            "--port", str(BACKEND_INTERNAL_PORT),
            "--tmux-session", "research-agent",
        ],
        env=env,
        cwd="/app/server",
    )

    # IP-logging reverse proxy on the Modal-exposed port (10000).
    # This call blocks, which keeps the web_server process alive.
    _start_ip_tracking_proxy(host="0.0.0.0", port=10000, backend_port=BACKEND_INTERNAL_PORT)

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("research-agent-preview-secrets")],
    timeout=7200,  # 2 hours max
    cpu=8.0,
    memory=8 * 1024,  # 8GB
    env=_FUNCTION_ENV,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(port=8080, startup_timeout=120)
def preview_app():
    os.chdir("/app")

    env = {**os.environ}
    # Prefer the deploy-time token over any stale value from the Modal Secret.
    auth_token = _DEPLOY_AUTH_TOKEN or env.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "preview-token")
    env["RESEARCH_AGENT_USER_AUTH_TOKEN"] = auth_token

    # Prepare workdir
    workdir = "/app"
    os.makedirs(os.path.join(workdir, ".agents"), exist_ok=True)

    # Start the Next.js frontend dev server on port 8080 (exposed via Modal)
    # NEXT_PUBLIC_API_URL=auto → resolves to window.location.origin in browser
    # Next.js rewrites in next.config.mjs proxy API calls to backend on 10000
    print("Starting frontend dev server on port 8080...")
    frontend_env = {
        **env,
        "NEXT_PUBLIC_API_URL": "auto",
        "PORT": "8080",
        # Server-side API routes need these to resolve the workspace root
        # and validate auth tokens without depending on the backend.
        "RESEARCH_AGENT_WORKDIR": workdir,
        "RESEARCH_AGENT_USER_AUTH_TOKEN": auth_token,
        "RESEARCH_AGENT_BACKEND_URL": "http://127.0.0.1:10000",
    }
    subprocess.Popen(
        ["npx", "next", "dev", "-p", "8080"],
        env=frontend_env,
        cwd="/app",
    )


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("research-agent-preview-secrets")],
    timeout=7200,  # 2 hours max
    cpu=2.0,
    memory=2 * 1024,  # 2GB
    env=_FUNCTION_ENV,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(port=4096, startup_timeout=120)
def preview_opencode():
    """Expose OpenCode as a standalone preview endpoint."""
    os.chdir("/app")

    env = {**os.environ}
    opencode_config = "/app/server/opencode.json"
    if os.path.isfile(opencode_config):
        env["OPENCODE_CONFIG"] = opencode_config

    if not os.path.isfile(OPENCODE_BIN):
        raise RuntimeError(f"opencode binary not found at {OPENCODE_BIN}")

    print(f"Starting OpenCode server on port {OPENCODE_PORT}...")
    subprocess.Popen(
        [
            OPENCODE_BIN, "serve",
            "--hostname", "0.0.0.0",
            "--port", OPENCODE_PORT,
        ],
        env=env,
        cwd="/app",
    )
