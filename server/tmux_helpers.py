"""Tmux session/window helpers extracted from server.py."""

import os
import sys
import shlex
import time
import logging
from typing import Optional

import libtmux

logger = logging.getLogger("research-agent-server")


def get_tmux_server():
    """Get or create tmux server connection."""
    try:
        return libtmux.Server()
    except Exception as e:
        logger.error(f"Failed to connect to tmux server: {e}")
        return None


def get_or_create_session(session_name: str):
    """Get or create the research-agent tmux session."""
    server = get_tmux_server()
    if not server:
        return None

    try:
        session = server.sessions.get(session_name=session_name, default=None)
        if not session:
            logger.info(f"Creating new tmux session: {session_name}")
            session = server.new_session(session_name=session_name)
        return session
    except Exception as e:
        logger.error(f"Error getting/creating tmux session: {e}")
        return None


def launch_run_in_tmux(
    run_id: str,
    run_data: dict,
    *,
    tmux_session_name: str,
    data_dir: str,
    workdir: str,
    server_callback_url: str,
    user_auth_token: Optional[str],
) -> Optional[str]:
    """Launch a run in a new tmux window with sidecar."""
    session = get_or_create_session(tmux_session_name)
    if not session:
        raise Exception("Tmux session not available. Start tmux first.")

    # Create window name
    run_name = run_data.get("name", run_id)[:20].replace(" ", "-")
    tmux_window_name = f"ra-{run_id[:8]}"

    logger.info(f"Launching run {run_id} in window {tmux_window_name}")

    # Create window
    window = session.new_window(window_name=tmux_window_name, attach=False)
    pane = window.active_pane

    # Setup run directory
    run_dir = os.path.join(data_dir, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)

    # Write command to file
    command_file = os.path.join(run_dir, "command.txt")
    with open(command_file, "w") as f:
        f.write(run_data["command"])

    # Get sidecar path
    server_dir = os.path.dirname(os.path.abspath(__file__))
    sidecar_path = os.path.join(server_dir, "job_sidecar.py")

    # Build sidecar command
    server_url = server_callback_url
    run_workdir = run_data.get("workdir") or workdir

    if getattr(sys, "frozen", False):
        sidecar_cmd = (
            f"{shlex.quote(sys.executable)} --run-sidecar "
            f"--job_id {shlex.quote(run_id)} "
            f"--server_url {shlex.quote(server_url)} "
            f"--command_file {shlex.quote(command_file)} "
            f"--agent_run_dir {shlex.quote(run_dir)} "
            f"--workdir {shlex.quote(run_workdir)}"
        )
    else:
        sidecar_cmd = (
            f'{shlex.quote(sys.executable)} "{sidecar_path}" '
            f'--job_id {shlex.quote(run_id)} '
            f'--server_url {shlex.quote(server_url)} '
            f'--command_file {shlex.quote(command_file)} '
            f'--agent_run_dir {shlex.quote(run_dir)} '
            f'--workdir {shlex.quote(run_workdir)}'
        )
    if user_auth_token:
        sidecar_cmd += f" --auth_token {shlex.quote(user_auth_token)}"

    logger.info(f"Executing sidecar: {sidecar_cmd}")
    pane.send_keys(sidecar_cmd)

    # Update run data
    run_data["status"] = "launching"
    run_data["tmux_window"] = tmux_window_name
    run_data["run_dir"] = run_dir
    run_data["launched_at"] = time.time()

    return tmux_window_name
