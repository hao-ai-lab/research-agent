"""
Modal app for CI preview deployments of Research Agent.

Each git branch gets its own isolated Modal app with a unique URL.
The container builds the Next.js static frontend at image build time,
then serves both the static bundle and the Python API server at runtime.

Usage:
  # Local preview (hot-reload)
  MODAL_DEPLOY_BRANCH=my-feature modal serve modal_app.py

  # Deploy (used by CI)
  MODAL_DEPLOY_BRANCH=my-feature modal deploy modal_app.py

Required environment variables (set via GitHub Secrets in CI):
  MODAL_TOKEN_ID       - Modal authentication token ID
  MODAL_TOKEN_SECRET   - Modal authentication token secret

Optional:
  MODAL_DEPLOY_BRANCH  - Git branch name for app naming (default: "main")
"""

import modal
import os
import subprocess

# ---------------------------------------------------------------------------
# App naming – each branch gets its own isolated Modal app
# ---------------------------------------------------------------------------
_branch_raw = os.environ.get("MODAL_DEPLOY_BRANCH", "main")
_slug = "".join(c if c.isalnum() or c == "-" else "-" for c in _branch_raw.lower())
_slug = _slug[:40].strip("-") or "main"
APP_NAME = f"research-agent-{_slug}"

app = modal.App(APP_NAME)

# ---------------------------------------------------------------------------
# Container image – Node 20 + Python 3.11 + project deps + built frontend
# ---------------------------------------------------------------------------
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "tmux", "ca-certificates", "gnupg")
    # Node.js 20 via NodeSource
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g pnpm@10.29.2",
    )
    # Python server dependencies
    .pip_install_from_requirements("server/requirements.txt")
    # Copy project source (heavy/generated dirs excluded for build speed)
    .add_local_dir(
        ".",
        remote_path="/app",
        ignore=[
            "node_modules",
            ".next",
            "out",
            "dist",
            ".git",
            "__pycache__",
            ".ra-venv",
            ".build-venv",
            ".uv-cache",
            ".npm-cache",
            ".agents",
        ],
    )
    # Install JS deps and build the static frontend bundle
    .run_commands(
        "mkdir -p /app/workdir",
        "cd /app && pnpm install --frozen-lockfile",
        (
            "cd /app && RESEARCH_AGENT_STATIC_EXPORT=true"
            " NEXT_PUBLIC_USE_MOCK=false"
            " NEXT_PUBLIC_API_URL=auto"
            " pnpm run build"
        ),
    )
)


# ---------------------------------------------------------------------------
# Web endpoint – serves the frontend + Python API in one container
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    scaledown_window=300,
    cpu=1.0,
    memory=1024,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(8000, startup_timeout=60)
def web():
    """Start the Research Agent server inside the Modal container."""
    env = {**os.environ}
    env["RESEARCH_AGENT_FRONTEND_DIR"] = "/app/out"

    subprocess.Popen(
        [
            "python", "server.py",
            "--port", "8000",
            "--host", "0.0.0.0",
            "--workdir", "/app/workdir",
        ],
        cwd="/app/server",
        env=env,
    )
