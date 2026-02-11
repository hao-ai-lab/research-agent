"""
Modal Hub App – Kanban + Chat Feedback Hub for Research Agent.

Deploy with:
    modal deploy hub/modal_hub.py --name research-agent-hub

Required Modal Secret "research-agent-hub-secrets":
    GITHUB_TOKEN                    – GitHub PAT with repo scope
    GITHUB_REPO                     – owner/repo (e.g. hao-ai-lab/research-agent)
    RESEARCH_AGENT_USER_AUTH_TOKEN  – auth for the hub
"""

import modal
import os
import subprocess
import sys

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi>=0.104.0", "uvicorn>=0.24.0", "httpx>=0.25.0", "pydantic>=2.0.0")
    .add_local_dir("hub", "/hub", copy=True)
)

app = modal.App("research-agent-hub")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("research-agent-hub-secrets")],
    timeout=86400,  # 24 hours (long-running web service)
    allow_concurrent_inputs=100,
    cpu=1.0,
    memory=512,
)
@modal.web_server(port=8000, startup_timeout=30)
def hub_server():
    """Start the Hub FastAPI server."""
    os.chdir("/hub")
    subprocess.run(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"],
        cwd="/hub",
    )
