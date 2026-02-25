"""
Research Agent Server — GitHub Integration Endpoints

Creates bug issues in the repository's GitHub Issues via gh CLI.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core import config
from core.state import chat_sessions, save_chat_state

logger = logging.getLogger("research-agent-server")
router = APIRouter()

_ISSUE_URL_RE = re.compile(r"https://github\.com/[^\s/]+/[^\s/]+/issues/\d+")
_REPO_RE = re.compile(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$")


class GithubBugReportRequest(BaseModel):
    description: str = Field(min_length=3, max_length=12000)
    session_id: Optional[str] = None
    title: Optional[str] = None


def _run_cmd(args: list[str], timeout_seconds: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=config.WORKDIR,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _resolve_repo() -> str:
    configured = os.environ.get("RESEARCH_AGENT_GITHUB_REPO", "").strip()
    if configured:
        return configured

    result = _run_cmd(["git", "remote", "get-url", "origin"], timeout_seconds=8)
    if result.returncode != 0:
        raise RuntimeError("Unable to resolve GitHub repository from git remote origin")

    remote_url = result.stdout.strip()
    match = _REPO_RE.search(remote_url)
    if not match:
        raise RuntimeError("Origin remote is not a GitHub repository URL")
    return f"{match.group('owner')}/{match.group('repo')}"


def _build_issue_title(req: GithubBugReportRequest) -> str:
    raw = (req.title or req.description.splitlines()[0]).strip()
    collapsed = re.sub(r"\s+", " ", raw).strip()
    if not collapsed.lower().startswith("bug:"):
        collapsed = f"Bug: {collapsed}"
    return collapsed[:120]


def _build_issue_body(req: GithubBugReportRequest) -> str:
    reported_at = time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime())
    session_line = req.session_id if req.session_id else "n/a"
    return (
        "## Bug report\n\n"
        f"{req.description.strip()}\n\n"
        "## Metadata\n\n"
        "- Reported via Research Agent chat\n"
        f"- Session: `{session_line}`\n"
        f"- Workdir: `{config.WORKDIR}`\n"
        f"- Reported at (UTC): `{reported_at}`\n"
    )


def _extract_issue_url(output: str) -> Optional[str]:
    match = _ISSUE_URL_RE.search(output or "")
    if not match:
        return None
    return match.group(0)


def _ensure_bug_label(repo: str) -> None:
    _run_cmd(
        [
            "gh",
            "label",
            "create",
            "Bug",
            "--repo",
            repo,
            "--color",
            "d73a4a",
            "--description",
            "Something is not working",
        ],
        timeout_seconds=10,
    )


def _create_bug_issue(repo: str, title: str, body: str) -> str:
    _ensure_bug_label(repo)
    cmd = [
        "gh",
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body",
        body,
        "--label",
        "Bug",
    ]
    result = _run_cmd(cmd, timeout_seconds=45)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Issue creation failed").strip()
        raise RuntimeError(detail)

    issue_url = _extract_issue_url(result.stdout) or _extract_issue_url(result.stderr)
    if not issue_url:
        raise RuntimeError("Issue was created but URL was not returned by gh")
    return issue_url


def _append_report_messages(session_id: Optional[str], user_text: str, issue_url: str) -> None:
    if not session_id:
        return
    session = chat_sessions.get(session_id)
    if not isinstance(session, dict):
        return

    now = time.time()
    messages = session.setdefault("messages", [])
    if not isinstance(messages, list):
        return

    messages.append({"role": "user", "content": user_text, "timestamp": now})
    messages.append({
        "role": "assistant",
        "content": f"Created Bug issue: {issue_url}",
        "timestamp": time.time(),
    })
    if session.get("title") == "New Chat" and len(messages) == 2:
        preview = user_text[:50]
        session["title"] = preview + ("..." if len(user_text) > 50 else "")
    save_chat_state()


@router.post("/integrations/github/report-bug")
async def report_bug(req: GithubBugReportRequest):
    """Create a GitHub issue labeled Bug in the current repo."""
    try:
        repo = _resolve_repo()
        issue_title = _build_issue_title(req)
        issue_body = _build_issue_body(req)
        issue_url = _create_bug_issue(repo, issue_title, issue_body)
        _append_report_messages(req.session_id, req.description, issue_url)
        return {
            "ok": True,
            "repo": repo,
            "issue_url": issue_url,
            "issue_title": issue_title,
            "label": "Bug",
        }
    except RuntimeError as exc:
        logger.error("GitHub bug report failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="GitHub CLI not found. Install gh and authenticate with `gh auth login`.",
        )
    except Exception as exc:
        logger.exception("Unexpected GitHub bug report error")
        raise HTTPException(status_code=500, detail=f"Unexpected error: {exc}")
