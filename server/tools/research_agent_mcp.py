#!/usr/bin/env python3
"""Research Agent MCP server for fixed run-management tool calls.

This server exposes stable tools around run lifecycle operations so agents do
not have to build ad-hoc curl commands for creating/starting runs.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from typing import Any, Literal

import requests
from fastmcp import FastMCP

mcp = FastMCP("research-agent")

_DEFAULT_SERVER_URL = os.environ.get("RESEARCH_AGENT_SERVER_URL", "http://127.0.0.1:10000")
_DEFAULT_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "")
_DEFAULT_TIMEOUT_SECONDS = float(os.environ.get("RESEARCH_AGENT_MCP_HTTP_TIMEOUT", "20"))

_SERVER_URL = _DEFAULT_SERVER_URL
_AUTH_TOKEN = _DEFAULT_AUTH_TOKEN
_TIMEOUT_SECONDS = _DEFAULT_TIMEOUT_SECONDS


def _headers(include_content_type: bool = False) -> dict[str, str]:
    headers: dict[str, str] = {}
    if include_content_type:
        headers["Content-Type"] = "application/json"
    if _AUTH_TOKEN:
        headers["X-Auth-Token"] = _AUTH_TOKEN
    return headers


def _decode_error_detail(response: requests.Response) -> str:
    text = response.text.strip()
    if not text:
        return "<empty body>"
    try:
        payload = response.json()
    except json.JSONDecodeError:
        return text
    if isinstance(payload, dict) and "detail" in payload:
        return str(payload["detail"])
    return text


def _api_request(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> Any:
    base = _SERVER_URL.rstrip("/")
    endpoint = path.lstrip("/")
    url = f"{base}/{endpoint}"
    try:
        response = requests.request(
            method=method.upper(),
            url=url,
            headers=_headers(include_content_type=payload is not None),
            json=payload,
            params=params,
            timeout=_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Request failed for {method.upper()} {url}: {exc}") from exc

    if not response.ok:
        detail = _decode_error_detail(response)
        raise RuntimeError(
            f"Backend returned HTTP {response.status_code} for {method.upper()} {url}: {detail}"
        )

    content_type = response.headers.get("Content-Type", "").lower()
    if "application/json" in content_type:
        return response.json()
    text = response.text.strip()
    return text or {}


def _normalize_non_empty(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"`{field_name}` must be non-empty")
    return normalized


@mcp.tool()
def create_run(
    name: str,
    command: str,
    workdir: str | None = None,
    sweep_id: str | None = None,
    launch_policy: Literal["ready", "queued", "start_now"] = "ready",
    gpuwrap_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a run using a fixed schema with explicit launch behavior.

    Args:
        name: Human-readable run name.
        command: Shell command to execute for this run.
        workdir: Optional working directory for command execution.
        sweep_id: Optional sweep ID to attach the run to.
        launch_policy:
            - "ready": create run in ready state
            - "queued": create run in queued state (not started yet)
            - "start_now": create run, then immediately call start
        gpuwrap_config: Optional per-run gpuwrap settings passed to sidecar.
    """
    run_name = _normalize_non_empty(name, "name")
    run_command = _normalize_non_empty(command, "command")
    if launch_policy not in {"ready", "queued", "start_now"}:
        raise ValueError("`launch_policy` must be one of: ready, queued, start_now")

    create_body: dict[str, Any] = {
        "name": run_name,
        "command": run_command,
        "auto_start": launch_policy == "queued",
    }
    if workdir and workdir.strip():
        create_body["workdir"] = workdir.strip()
    if sweep_id and sweep_id.strip():
        create_body["sweep_id"] = sweep_id.strip()
    if gpuwrap_config:
        create_body["gpuwrap_config"] = gpuwrap_config
    else:
        # Auto-enable gpuwrap for local GPU environments when caller
        # doesn't specify it (e.g. agent-initiated runs).
        try:
            cluster_resp = _api_request("GET", "/cluster")
            if isinstance(cluster_resp, dict):
                cluster_info = cluster_resp.get("cluster") or cluster_resp
                if cluster_info.get("type") == "local_gpu":
                    create_body["gpuwrap_config"] = {"enabled": True}
        except Exception:
            pass  # Non-fatal — proceed without gpuwrap

    created_run = _api_request("POST", "/runs", payload=create_body)
    if not isinstance(created_run, dict):
        raise RuntimeError("Unexpected backend response while creating run")

    run_id = str(created_run.get("id", "")).strip()
    if not run_id:
        raise RuntimeError("Backend did not return a run id")

    result: dict[str, Any] = {
        "message": "Run created",
        "launch_policy": launch_policy,
        "run": created_run,
    }

    if launch_policy == "start_now":
        start_result = _api_request("POST", f"/runs/{run_id}/start")
        current_run = _api_request("GET", f"/runs/{run_id}")
        result["message"] = "Run created and started"
        result["start"] = start_result
        result["run"] = current_run

    return result


@mcp.tool()
def start_run(run_id: str) -> dict[str, Any]:
    """Start an existing run by id."""
    normalized_run_id = _normalize_non_empty(run_id, "run_id")
    start_result = _api_request("POST", f"/runs/{normalized_run_id}/start")
    current_run = _api_request("GET", f"/runs/{normalized_run_id}")
    return {
        "message": "Run started",
        "start": start_result,
        "run": current_run,
    }


_DEFAULT_BASH_TIMEOUT = int(os.environ.get("RESEARCH_AGENT_QUICK_BASH_TIMEOUT", "30"))


@mcp.tool()
def quick_bash(
    command: str,
    workdir: str | None = None,
    timeout_seconds: int = _DEFAULT_BASH_TIMEOUT,
) -> dict[str, Any]:
    """Execute a shell command directly and return stdout/stderr.

    Use this tool for quick operations like listing files, reading short
    outputs, checking git status, etc.  It runs the command as a subprocess
    with an explicit timeout so it never hangs.

    Args:
        command: Shell command to execute (e.g. "ls -la", "cat file.py").
        workdir: Working directory to run the command in.  If omitted the
                 server's current working directory is used.
        timeout_seconds: Max seconds before the command is killed (default 30).
    """
    cmd = command.strip()
    if not cmd:
        raise ValueError("`command` must be non-empty")

    timeout_seconds = max(1, min(timeout_seconds, 120))

    cwd = None
    if workdir and workdir.strip():
        resolved = os.path.abspath(workdir.strip())
        if os.path.isdir(resolved):
            cwd = resolved
        else:
            return {
                "exit_code": 1,
                "stdout": "",
                "stderr": f"workdir does not exist: {resolved}",
            }

    try:
        result = subprocess.run(
            cmd,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env={**os.environ, "TERM": "dumb"},
        )
        stdout = result.stdout
        stderr = result.stderr
        # Truncate very long output to avoid blowing up context
        if len(stdout) > 50_000:
            stdout = stdout[:50_000] + f"\n... (truncated, total {len(result.stdout)} chars)"
        if len(stderr) > 10_000:
            stderr = stderr[:10_000] + f"\n... (truncated, total {len(result.stderr)} chars)"
        return {
            "exit_code": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout_seconds}s: {cmd}",
        }
    except Exception as exc:
        return {
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Failed to execute command: {exc}",
        }


@mcp.tool()
def list_directory(
    path: str | None = None,
    include_hidden: bool = False,
) -> dict[str, Any]:
    """List files and directories at the given path.

    A lightweight alternative to bash 'ls' that never hangs.  Returns
    structured data with file names, types, and sizes.

    Args:
        path: Directory to list.  Defaults to the server's working directory.
        include_hidden: Whether to include dotfiles/dotdirs (default False).
    """
    target = os.path.abspath(path.strip()) if path and path.strip() else os.getcwd()
    if not os.path.isdir(target):
        return {"error": f"Not a directory: {target}", "entries": []}

    entries = []
    try:
        for name in sorted(os.listdir(target)):
            if not include_hidden and name.startswith("."):
                continue
            full = os.path.join(target, name)
            try:
                stat = os.stat(full)
                entries.append({
                    "name": name,
                    "type": "dir" if os.path.isdir(full) else "file",
                    "size": stat.st_size,
                })
            except OSError:
                entries.append({"name": name, "type": "unknown", "size": 0})
    except PermissionError as exc:
        return {"error": str(exc), "entries": []}

    return {"path": target, "count": len(entries), "entries": entries}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Research Agent MCP server")
    parser.add_argument(
        "--server-url",
        default=_DEFAULT_SERVER_URL,
        help=f"Backend base URL (default: {_DEFAULT_SERVER_URL})",
    )
    parser.add_argument(
        "--auth-token",
        default=_DEFAULT_AUTH_TOKEN,
        help="Optional X-Auth-Token for backend API calls",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=_DEFAULT_TIMEOUT_SECONDS,
        help=f"HTTP timeout in seconds (default: {_DEFAULT_TIMEOUT_SECONDS})",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    _SERVER_URL = args.server_url
    _AUTH_TOKEN = args.auth_token
    _TIMEOUT_SECONDS = max(float(args.timeout), 1.0)
    mcp.run()
