"""
Hub App – Kanban + Chat Feedback Hub for Research Agent.

Backend API (FastAPI) that:
- Fetches GitHub issues/PRs and presents them as kanban cards
- Accepts user feedback and creates GitHub issues
- Routes feedback to existing PRs
- Serves the frontend SPA

Required env vars (via Modal secret "research-agent-hub-secrets"):
    GITHUB_TOKEN                    – GitHub PAT with repo scope
    GITHUB_REPO                     – owner/repo (e.g. hao-ai-lab/research-agent)
    RESEARCH_AGENT_USER_AUTH_TOKEN  – auth for this hub instance
"""

import os
import time
import logging
from typing import Optional, List

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hub")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "hao-ai-lab/research-agent")
AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "")
GITHUB_API = "https://api.github.com"

# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------

app = FastAPI(title="Research Agent Hub")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    # Public routes: /, static assets
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    if AUTH_TOKEN:
        token = request.headers.get("X-Auth-Token") or request.query_params.get("token")
        if token != AUTH_TOKEN:
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


# ---------------------------------------------------------------------------
# GitHub helpers
# ---------------------------------------------------------------------------

def gh_headers():
    h = {"Accept": "application/vnd.github.v3+json"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return h


async def gh_get(path: str, params: dict = None):
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{GITHUB_API}{path}", headers=gh_headers(), params=params)
        resp.raise_for_status()
        return resp.json()


async def gh_post(path: str, json_data: dict):
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(f"{GITHUB_API}{path}", headers=gh_headers(), json=json_data)
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class FeedbackRequest(BaseModel):
    message: str
    title: Optional[str] = None  # auto-generated if not provided
    labels: Optional[List[str]] = None
    route_to_pr: Optional[int] = None  # PR number to route feedback to


class RouteRequest(BaseModel):
    issue_number: int
    pr_number: int
    comment: Optional[str] = None


# ---------------------------------------------------------------------------
# Kanban helpers
# ---------------------------------------------------------------------------

def issue_to_kanban_column(issue: dict) -> str:
    """Map issue labels and state to a kanban column."""
    labels = [l["name"].lower() for l in issue.get("labels", [])]
    state = issue.get("state", "open")

    if state == "closed":
        return "done"
    if any(x in labels for x in ["in review", "review", "in-review"]):
        return "review"
    if any(x in labels for x in ["in progress", "in-progress", "wip"]):
        return "in_progress"
    if issue.get("pull_request"):
        return "review"
    return "backlog"


def issue_to_card(issue: dict, prs: list = None) -> dict:
    """Convert a GitHub issue to a kanban card."""
    # Find linked PR
    linked_pr = None
    if prs:
        for pr in prs:
            if f"#{issue['number']}" in (pr.get("body") or ""):
                linked_pr = {
                    "number": pr["number"],
                    "url": pr["html_url"],
                    "title": pr["title"],
                    "state": pr["state"],
                    "draft": pr.get("draft", False),
                }
                break

    labels = [l["name"] for l in issue.get("labels", [])]
    is_agent = "agent-solve" in labels

    return {
        "id": issue["number"],
        "title": issue["title"],
        "body": (issue.get("body") or "")[:200],
        "state": issue["state"],
        "labels": labels,
        "assignee": (issue.get("assignee") or {}).get("login"),
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
        "url": issue["html_url"],
        "column": issue_to_kanban_column(issue),
        "linked_pr": linked_pr,
        "agent_solving": is_agent,
    }


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"status": "ok", "repo": GITHUB_REPO}


@app.get("/api/kanban")
async def get_kanban():
    """Get kanban board data — issues organized into columns."""
    owner, repo = GITHUB_REPO.split("/", 1)

    # Fetch issues and PRs in parallel
    issues = await gh_get(f"/repos/{owner}/{repo}/issues", params={
        "state": "all",
        "per_page": 50,
        "sort": "updated",
        "direction": "desc",
    })
    prs = await gh_get(f"/repos/{owner}/{repo}/pulls", params={
        "state": "open",
        "per_page": 30,
    })

    # Filter out PRs from issues list (GitHub API includes PRs in /issues)
    real_issues = [i for i in issues if "pull_request" not in i]

    # Build cards
    cards = [issue_to_card(i, prs) for i in real_issues]

    # Organize into columns
    columns = {
        "backlog": [],
        "in_progress": [],
        "review": [],
        "done": [],
    }
    for card in cards:
        col = card.get("column", "backlog")
        if col in columns:
            columns[col].append(card)

    # Add PR cards to review column
    for pr in prs:
        pr_number = pr["number"]
        preview_url = f"https://{owner}--research-agent-preview-pr-{pr_number}-preview-server.modal.run"
        columns["review"].append({
            "id": f"pr-{pr_number}",
            "title": f"PR #{pr_number}: {pr['title']}",
            "body": (pr.get("body") or "")[:200],
            "state": pr["state"],
            "labels": [l["name"] for l in pr.get("labels", [])],
            "assignee": (pr.get("assignee") or {}).get("login"),
            "created_at": pr["created_at"],
            "updated_at": pr["updated_at"],
            "url": pr["html_url"],
            "column": "review",
            "is_pr": True,
            "draft": pr.get("draft", False),
            "preview_url": preview_url,
            "agent_solving": "agent" in pr.get("head", {}).get("ref", ""),
        })

    return {
        "columns": columns,
        "total_issues": len(real_issues),
        "total_prs": len(prs),
    }


@app.get("/api/issues")
async def get_issues():
    """Get raw GitHub issues."""
    owner, repo = GITHUB_REPO.split("/", 1)
    data = await gh_get(f"/repos/{owner}/{repo}/issues", params={
        "state": "open",
        "per_page": 50,
    })
    return [i for i in data if "pull_request" not in i]


@app.get("/api/prs")
async def get_prs():
    """Get open PRs with preview URLs."""
    owner, repo = GITHUB_REPO.split("/", 1)
    prs = await gh_get(f"/repos/{owner}/{repo}/pulls", params={
        "state": "open",
        "per_page": 30,
    })
    result = []
    for pr in prs:
        pr_num = pr["number"]
        preview_url = f"https://{owner}--research-agent-preview-pr-{pr_num}-preview-server.modal.run"
        result.append({
            "number": pr_num,
            "title": pr["title"],
            "state": pr["state"],
            "draft": pr.get("draft", False),
            "url": pr["html_url"],
            "preview_url": preview_url,
            "branch": pr.get("head", {}).get("ref"),
            "is_agent": "agent" in pr.get("head", {}).get("ref", ""),
            "labels": [l["name"] for l in pr.get("labels", [])],
        })
    return result


@app.post("/api/feedback")
async def submit_feedback(req: FeedbackRequest):
    """Create a GitHub issue from user feedback, optionally route to a PR."""
    owner, repo = GITHUB_REPO.split("/", 1)

    title = req.title or f"Feedback: {req.message[:60]}..."
    labels = req.labels or ["feedback", "agent-solve"]

    body = f"## User Feedback\n\n{req.message}\n\n---\n*Created via Research Agent Hub*"

    if req.route_to_pr:
        body += f"\n\n**Routed to PR:** #{req.route_to_pr}"

    issue = await gh_post(f"/repos/{owner}/{repo}/issues", {
        "title": title,
        "body": body,
        "labels": labels,
    })

    # If routing to a PR, also add a comment on the PR
    if req.route_to_pr:
        await gh_post(f"/repos/{owner}/{repo}/issues/{req.route_to_pr}/comments", {
            "body": f"📋 **Feedback routed from Hub** (Issue #{issue['number']}):\n\n{req.message}",
        })

    return {
        "issue_number": issue["number"],
        "issue_url": issue["html_url"],
        "routed_to_pr": req.route_to_pr,
    }


@app.post("/api/route")
async def route_to_pr(req: RouteRequest):
    """Route an existing issue to a PR by linking them."""
    owner, repo = GITHUB_REPO.split("/", 1)

    comment = req.comment or f"This issue has been linked to PR #{req.pr_number} for resolution."

    # Comment on the issue
    await gh_post(f"/repos/{owner}/{repo}/issues/{req.issue_number}/comments", {
        "body": f"🔗 **Routed to PR #{req.pr_number}**\n\n{comment}",
    })

    # Comment on the PR
    await gh_post(f"/repos/{owner}/{repo}/issues/{req.pr_number}/comments", {
        "body": f"📋 **Linked Issue #{req.issue_number}**\n\n{comment}",
    })

    return {"ok": True}


@app.post("/api/label")
async def update_label(issue_number: int, column: str):
    """Update issue labels to reflect kanban column movement."""
    owner, repo = GITHUB_REPO.split("/", 1)

    column_labels = {
        "backlog": [],
        "in_progress": ["in-progress"],
        "review": ["in-review"],
        "done": [],
    }

    new_labels = column_labels.get(column, [])

    # Remove old column labels and add new one
    issue = await gh_get(f"/repos/{owner}/{repo}/issues/{issue_number}")
    current_labels = [l["name"] for l in issue.get("labels", [])]
    remove_labels = {"in-progress", "in-review", "wip"}
    filtered = [l for l in current_labels if l.lower() not in remove_labels]
    final_labels = filtered + new_labels

    async with httpx.AsyncClient(timeout=15) as client:
        await client.patch(
            f"{GITHUB_API}/repos/{owner}/{repo}/issues/{issue_number}",
            headers=gh_headers(),
            json={"labels": final_labels, "state": "closed" if column == "done" else "open"},
        )

    return {"ok": True, "labels": final_labels}


# ---------------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")

@app.get("/")
async def serve_frontend():
    """Serve the single-page frontend."""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.isfile(index_path):
        with open(index_path, "r") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>Hub Frontend Not Found</h1>", status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
