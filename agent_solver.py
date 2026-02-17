#!/usr/bin/env python3
"""
Agent Solver – launches a Modal container to solve a GitHub issue.

Called by the agent-solver GitHub Action. The Modal function:
1. Clones the repo
2. Creates a branch agent/issue-{N}
3. Runs OpenCode to fix the issue
4. Commits, pushes, and opens a PR

Usage:
    python agent_solver.py \
        --issue-number 42 \
        --issue-title "Fix login bug" \
        --issue-body-file /tmp/body.txt \
        --repo owner/repo
"""

import argparse
import json
import sys
import textwrap
from typing import Any


def run_modal_solver(
    issue_number: int,
    issue_title: str,
    issue_body: str,
    repo: str,
    base_branch: str = "main",
):
    """Deploy and invoke the solver Modal function."""
    import modal

    # Build the image for solving
    image = (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install("git", "curl", "tmux", "ca-certificates", "gnupg")
        .run_commands(
            "mkdir -p /etc/apt/keyrings",
            "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
            'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
            "apt-get update && apt-get install -y nodejs",
        )
        .pip_install("httpx")
        .run_commands("npm install -g opencode || true")
    )

    app = modal.App(f"research-agent-solver-{issue_number}")
    secrets = [modal.Secret.from_name("research-agent-solver-secrets")]

    @app.function(image=image, secrets=secrets, timeout=1800, cpu=2.0, memory=2048)
    def solve(
        issue_num: int,
        title: str,
        body: str,
        repository: str,
        base: str,
    ):
        import httpx as hx
        import subprocess as sp
        import os as _os

        gh_token = _os.environ["GH_PAT"]

        # Clone the repo
        clone_url = f"https://x-access-token:{gh_token}@github.com/{repository}.git"
        sp.run(["git", "clone", "--depth", "50", clone_url, "/workspace"], check=True)
        _os.chdir("/workspace")

        # Configure git
        sp.run(["git", "config", "user.email", "agent-solver[bot]@users.noreply.github.com"], check=True)
        sp.run(["git", "config", "user.name", "Agent Solver"], check=True)

        # Create branch
        branch = f"agent/issue-{issue_num}"
        sp.run(["git", "checkout", "-b", branch], check=True)

        # Build the prompt for OpenCode
        prompt = textwrap.dedent(f"""\
            You are an AI agent tasked with solving a GitHub issue.

            ## Issue #{issue_num}: {title}

            {body}

            ## Instructions
            1. Analyze the issue carefully.
            2. Make the minimal, focused code changes needed to fix it.
            3. Do NOT add unrelated changes.
            4. Ensure the code is correct and follows the existing patterns.

            The repository is a Next.js + FastAPI application. Key files:
            - Frontend: app/, components/, hooks/, lib/
            - Backend: server/server.py, server/job_sidecar.py, server/wild_loop.py
            - Config: package.json, next.config.mjs, tsconfig.json
        """)

        # Run OpenCode agent
        opencode_env = {
            **_os.environ,
            "OPENCODE_CONFIG": "/workspace/server/opencode.json",
        }
        result = sp.run(
            ["opencode", "run", "--model", "opencode/kimi-k2.5-free", prompt],
            capture_output=True,
            text=True,
            timeout=900,  # 15 min max
            cwd="/workspace",
            env=opencode_env,
        )
        agent_output = result.stdout or ""
        agent_error = result.stderr or ""

        # Check if any files changed
        diff_result = sp.run(["git", "diff", "--stat"], capture_output=True, text=True, cwd="/workspace")
        untracked = sp.run(["git", "ls-files", "--others", "--exclude-standard"], capture_output=True, text=True, cwd="/workspace")
        has_changes = bool(diff_result.stdout.strip()) or bool(untracked.stdout.strip())

        if not has_changes:
            return {
                "success": False,
                "error": "Agent made no code changes",
                "agent_output": agent_output[-2000:],
            }

        # Commit and push
        sp.run(["git", "add", "-A"], check=True, cwd="/workspace")
        commit_msg = f"fix: resolve #{issue_num} – {title}\n\nAutomated fix by Agent Solver."
        sp.run(["git", "commit", "-m", commit_msg], check=True, cwd="/workspace")
        sp.run(["git", "push", "origin", branch], check=True, cwd="/workspace")

        # Create PR via GitHub API
        pr_body = textwrap.dedent(f"""\
            Resolves #{issue_num}

            ## 🤖 Agent-Generated PR

            This PR was automatically created by the Agent Solver to address:
            **{title}**

            ### Changes Made
            ```
            {diff_result.stdout.strip() or 'See commit diff'}
            ```

            ### Agent Log (last 1000 chars)
            ```
            {agent_output[-1000:]}
            ```

            ---
            *Automated by [Agent Solver](https://github.com/{repository}/actions)*
        """)

        resp = hx.post(
            f"https://api.github.com/repos/{repository}/pulls",
            json={
                "title": f"fix: #{issue_num} – {title}",
                "body": pr_body,
                "head": branch,
                "base": base,
                "draft": True,  # Always draft so human reviews
            },
            headers={
                "Authorization": f"Bearer {gh_token}",
                "Accept": "application/vnd.github.v3+json",
            },
            timeout=30,
        )

        if resp.status_code in (200, 201):
            pr_data = resp.json()
            pr_number = pr_data.get("number")

            # Add a structured execution log comment on the PR.
            log_comment = textwrap.dedent(f"""\
                🤖 **Agent Solver Log**

                **Source issue:** #{issue_num}
                **Prompt source:** issue title + body

                ### Prompt excerpt
                ```
                {title}

                {(body or "").strip()[:1200]}
                ```

                ### Operations/output excerpt
                ```
                {(agent_output or agent_error or "").strip()[-2000:]}
                ```
            """)
            if pr_number:
                try:
                    hx.post(
                        f"https://api.github.com/repos/{repository}/issues/{pr_number}/comments",
                        json={"body": log_comment},
                        headers={
                            "Authorization": f"Bearer {gh_token}",
                            "Accept": "application/vnd.github.v3+json",
                        },
                        timeout=30,
                    )
                except Exception:
                    pass

            return {
                "success": True,
                "pr_number": pr_number,
                "pr_url": pr_data.get("html_url"),
                "branch": branch,
                "agent_output_tail": (agent_output or agent_error or "")[-2000:],
            }
        else:
            return {
                "success": False,
                "error": f"PR creation failed ({resp.status_code}): {resp.text[:500]}",
                "branch": branch,
                "agent_output_tail": (agent_output or agent_error or "")[-2000:],
            }

    # Run the solver
    with app.run():
        result = solve.remote(
            issue_num=issue_number,
            title=issue_title,
            body=issue_body,
            repository=repo,
            base=base_branch,
        )

    return result


def run_modal_pr_followup(
    pr_number: int,
    feedback: str,
    repo: str,
):
    """Run a follow-up agent pass for a PR comment prompt."""
    import modal

    image = (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install("git", "curl", "tmux", "ca-certificates", "gnupg")
        .run_commands(
            "mkdir -p /etc/apt/keyrings",
            "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
            'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
            "apt-get update && apt-get install -y nodejs",
        )
        .pip_install("httpx")
        .run_commands("npm install -g opencode || true")
    )

    app = modal.App(f"research-agent-pr-followup-{pr_number}")
    secrets = [modal.Secret.from_name("research-agent-solver-secrets")]

    @app.function(image=image, secrets=secrets, timeout=1800, cpu=2.0, memory=2048)
    def followup(pr_num: int, comment_prompt: str, repository: str) -> dict[str, Any]:
        import httpx as hx
        import subprocess as sp
        import os as _os

        gh_token = _os.environ["GH_PAT"]

        # Discover PR branch.
        pr_resp = hx.get(
            f"https://api.github.com/repos/{repository}/pulls/{pr_num}",
            headers={
                "Authorization": f"Bearer {gh_token}",
                "Accept": "application/vnd.github.v3+json",
            },
            timeout=30,
        )
        if pr_resp.status_code != 200:
            return {
                "success": False,
                "error": f"Unable to load PR #{pr_num}: {pr_resp.status_code}",
            }

        pr_data = pr_resp.json()
        branch = (pr_data.get("head") or {}).get("ref")
        base_branch = (pr_data.get("base") or {}).get("ref")
        if not branch:
            return {
                "success": False,
                "error": f"PR #{pr_num} has no head branch",
            }

        clone_url = f"https://x-access-token:{gh_token}@github.com/{repository}.git"
        sp.run(["git", "clone", "--depth", "50", clone_url, "/workspace"], check=True)
        _os.chdir("/workspace")
        sp.run(["git", "config", "user.email", "agent-solver[bot]@users.noreply.github.com"], check=True)
        sp.run(["git", "config", "user.name", "Agent Solver"], check=True)
        sp.run(["git", "fetch", "origin", branch], check=True)
        sp.run(["git", "checkout", branch], check=True)
        sp.run(["git", "pull", "--ff-only", "origin", branch], check=True)

        prompt = textwrap.dedent(f"""\
            You are updating an existing pull request based on reviewer feedback.

            ## Pull Request #{pr_num}
            - Head branch: {branch}
            - Base branch: {base_branch}

            ## New feedback to address
            {comment_prompt}

            ## Requirements
            1. Make only the changes required by the feedback.
            2. Keep changes minimal and focused.
            3. Do not modify unrelated files.
            4. Ensure changes are commit-ready.
        """)

        opencode_env = {
            **_os.environ,
            "OPENCODE_CONFIG": "/workspace/server/opencode.json",
        }
        result = sp.run(
            ["opencode", "run", "--model", "opencode/kimi-k2.5-free", prompt],
            capture_output=True,
            text=True,
            timeout=900,
            cwd="/workspace",
            env=opencode_env,
        )
        agent_output = result.stdout or ""
        agent_error = result.stderr or ""
        output_tail = (agent_output or agent_error or "")[-2000:]

        diff_result = sp.run(["git", "diff", "--stat"], capture_output=True, text=True, cwd="/workspace")
        untracked = sp.run(["git", "ls-files", "--others", "--exclude-standard"], capture_output=True, text=True, cwd="/workspace")
        has_changes = bool(diff_result.stdout.strip()) or bool(untracked.stdout.strip())

        if not has_changes:
            return {
                "success": True,
                "pr_number": pr_num,
                "branch": branch,
                "no_changes": True,
                "agent_output_tail": output_tail,
            }

        sp.run(["git", "add", "-A"], check=True, cwd="/workspace")
        commit_msg = f"chore: address PR #{pr_num} feedback"
        sp.run(["git", "commit", "-m", commit_msg], check=True, cwd="/workspace")
        sp.run(["git", "push", "origin", branch], check=True, cwd="/workspace")

        return {
            "success": True,
            "pr_number": pr_num,
            "branch": branch,
            "no_changes": False,
            "agent_output_tail": output_tail,
            "diff_stat": diff_result.stdout.strip(),
        }

    with app.run():
        result = followup.remote(pr_num=pr_number, comment_prompt=feedback, repository=repo)

    return result


def _clean_feedback_prompt(raw: str) -> str:
    text = (raw or "").strip()
    if text.lower().startswith("/bot"):
        text = text[4:].strip()
    return text


def main():
    parser = argparse.ArgumentParser(description="Agent Solver – solve GitHub issues via Modal")
    parser.add_argument("--mode", choices=["solve-issue", "followup-pr"], default="solve-issue")
    parser.add_argument("--issue-number", type=int)
    parser.add_argument("--issue-title")
    parser.add_argument("--issue-body-file", help="Path to file containing issue body")
    parser.add_argument("--repo", required=True, help="owner/repo")
    parser.add_argument("--base-branch", default="main")
    parser.add_argument("--pr-number", type=int)
    parser.add_argument("--feedback-file", help="Path to file containing follow-up prompt/comment")
    parser.add_argument("--output-file", help="Optional path to write JSON result")
    args = parser.parse_args()

    result: dict[str, Any]
    if args.mode == "solve-issue":
        required = [("issue-number", args.issue_number), ("issue-title", args.issue_title), ("issue-body-file", args.issue_body_file)]
        missing = [name for name, value in required if value in (None, "")]
        if missing:
            parser.error(f"Missing required args for solve-issue mode: {', '.join(missing)}")

        with open(args.issue_body_file, "r", encoding="utf-8") as f:
            issue_body = f.read().strip()

        result = run_modal_solver(
            issue_number=int(args.issue_number),
            issue_title=str(args.issue_title),
            issue_body=issue_body,
            repo=args.repo,
            base_branch=args.base_branch,
        )
    else:
        required = [("pr-number", args.pr_number), ("feedback-file", args.feedback_file)]
        missing = [name for name, value in required if value in (None, "")]
        if missing:
            parser.error(f"Missing required args for followup-pr mode: {', '.join(missing)}")

        with open(args.feedback_file, "r", encoding="utf-8") as f:
            feedback_raw = f.read()
        feedback = _clean_feedback_prompt(feedback_raw)
        if not feedback:
            feedback = "Please review the latest PR comments and make any required updates."

        result = run_modal_pr_followup(
            pr_number=int(args.pr_number),
            feedback=feedback,
            repo=args.repo,
        )

    rendered = json.dumps(result, indent=2)
    print(rendered)
    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            f.write(rendered + "\n")

    if not result.get("success"):
        print(f"ERROR: {result.get('error', 'Unknown error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
