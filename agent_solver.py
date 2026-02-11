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
import os
import subprocess
import sys
import textwrap
import time


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
            ["opencode", "run", prompt],
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
            return {
                "success": True,
                "pr_number": pr_data.get("number"),
                "pr_url": pr_data.get("html_url"),
                "branch": branch,
            }
        else:
            return {
                "success": False,
                "error": f"PR creation failed ({resp.status_code}): {resp.text[:500]}",
                "branch": branch,
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

    print(json.dumps(result, indent=2))

    if not result.get("success"):
        print(f"ERROR: {result.get('error', 'Unknown error')}", file=sys.stderr)
        sys.exit(1)

    return result


def main():
    parser = argparse.ArgumentParser(description="Agent Solver – solve GitHub issues via Modal")
    parser.add_argument("--issue-number", type=int, required=True)
    parser.add_argument("--issue-title", required=True)
    parser.add_argument("--issue-body-file", required=True, help="Path to file containing issue body")
    parser.add_argument("--repo", required=True, help="owner/repo")
    parser.add_argument("--base-branch", default="main")
    args = parser.parse_args()

    # Read issue body from file
    with open(args.issue_body_file, "r") as f:
        issue_body = f.read().strip()

    run_modal_solver(
        issue_number=args.issue_number,
        issue_title=args.issue_title,
        issue_body=issue_body,
        repo=args.repo,
        base_branch=args.base_branch,
    )


if __name__ == "__main__":
    main()
