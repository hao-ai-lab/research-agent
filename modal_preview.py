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
import os
import subprocess
import signal
import sys

# ---------------------------------------------------------------------------
# Image: Node 18 + Python 3.11 + tmux + opencode
# ---------------------------------------------------------------------------

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("tmux", "curl", "git", "ca-certificates", "gnupg")
    # Install Node.js 18
    .run_commands(
        "mkdir -p /etc/apt/keyrings",
        "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
        'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
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
    # Install frontend deps and build static export
    .run_commands(
        "npm install -g pnpm",
        "cd /app && pnpm install --frozen-lockfile || cd /app && pnpm install",
        "cd /app && RESEARCH_AGENT_STATIC_EXPORT=true NEXT_PUBLIC_API_URL=auto NEXT_PUBLIC_USE_MOCK=false pnpm run build",
        "ls -la /app/out/index.html || echo 'ERROR: Frontend build did not produce /app/out'",
    )
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = modal.App("research-agent-preview")

OPENCODE_BIN = "/usr/local/bin/opencode"


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("research-agent-preview-secrets")],
    timeout=7200,  # 2 hours max
    cpu=8.0,
    memory=8 * 1024,  # 8GB
)
@modal.concurrent(max_inputs=100)
@modal.web_server(port=10000, startup_timeout=120)
def preview_server():
    """Start the full Research Agent stack inside Modal."""
    os.chdir("/app")

    env = {**os.environ}
    auth_token = env.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "preview-token")
    env["RESEARCH_AGENT_USER_AUTH_TOKEN"] = auth_token

    # Determine frontend dir (static export)
    frontend_dir = "/app/out"
    if os.path.isdir(frontend_dir) and os.path.isfile(os.path.join(frontend_dir, "index.html")):
        env["RESEARCH_AGENT_FRONTEND_DIR"] = frontend_dir
    else:
        print(f"WARNING: Static frontend not found at {frontend_dir}, backend will run without UI")

    # Start a tmux server for job execution support (best-effort)
    try:
        subprocess.Popen(["tmux", "new-session", "-d", "-s", "research-agent"], env=env)
    except Exception as e:
        print(f"WARNING: tmux failed to start: {e}")

    # Start opencode in background (best-effort, non-fatal)
    opencode_config = "/app/server/opencode.json"
    if os.path.isfile(opencode_config):
        env["OPENCODE_CONFIG"] = opencode_config
    try:
        if os.path.isfile(OPENCODE_BIN):
            subprocess.Popen(
                [OPENCODE_BIN, "serve"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print("opencode server started")
        else:
            print(f"WARNING: opencode binary not found at {OPENCODE_BIN}, skipping")
    except Exception as e:
        print(f"WARNING: opencode failed to start: {e}")

    # Prepare workdir
    workdir = "/app"
    os.makedirs(os.path.join(workdir, ".agents"), exist_ok=True)

    # Start the FastAPI backend (blocking – this is the main process)
    subprocess.run(
        [
            sys.executable, "/app/server/server.py",
            "--workdir", workdir,
            "--host", "0.0.0.0",
            "--port", "10000",
            "--tmux-session", "research-agent",
        ],
        env=env,
        cwd="/app/server",
    )
