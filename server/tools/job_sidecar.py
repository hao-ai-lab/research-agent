#!/usr/bin/env python3
"""
Job Sidecar — CLI entry point for the sidecar monitoring process.

This is a thin CLI shim that parses arguments and delegates to
``agent.sidecar_agent.monitor_job()``.  The actual monitoring logic
and all helper modules live under ``sidecar/`` and ``agent/sidecar_agent.py``.

This script is spawned by the server in a tmux window (via helpers.py)
and via the ``--run-sidecar`` CLI flag in server.py.
"""

import argparse
import json
import logging
import os
import sys

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("job-sidecar")


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="Job Sidecar")
    parser.add_argument("--job_id", required=True, help="Job ID")
    parser.add_argument("--server_url", required=True, help="Server URL")
    parser.add_argument("--command_file", required=True, help="Path to command file")
    parser.add_argument("--workdir", default=None, help="Working directory")
    parser.add_argument("--agent_run_dir", default=None, help="Run directory for logs")
    parser.add_argument("--gpuwrap_config_file", default=None, help="Optional per-run gpuwrap config JSON path")
    parser.add_argument(
        "--auth_token",
        default=os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", ""),
        help="Optional X-Auth-Token for server callbacks",
    )
    args = parser.parse_args(argv)

    # Read command from file
    try:
        with open(args.command_file, "r") as f:
            command = f.read().strip()
    except Exception as e:
        logger.error(f"Failed to read command file: {e}")
        from sidecar.server_api import report_status
        report_status(
            args.server_url,
            args.job_id,
            "failed",
            {"error": f"Failed to read command: {e}"},
            auth_token=args.auth_token or None,
        )
        return

    gpuwrap_config = None
    if args.gpuwrap_config_file:
        try:
            with open(args.gpuwrap_config_file, "r") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                gpuwrap_config = loaded
            else:
                logger.warning("Ignoring gpuwrap config (not an object): %s", args.gpuwrap_config_file)
        except Exception as e:
            logger.warning("Failed to load gpuwrap config file %s: %s", args.gpuwrap_config_file, e)

    # Delegate to the real implementation
    from agent.sidecar_agent import monitor_job
    monitor_job(
        server_url=args.server_url,
        job_id=args.job_id,
        command=command,
        workdir=args.workdir or os.getcwd(),
        run_dir=args.agent_run_dir or "/tmp",
        auth_token=args.auth_token or None,
        gpuwrap_config=gpuwrap_config,
    )


if __name__ == "__main__":
    main()
