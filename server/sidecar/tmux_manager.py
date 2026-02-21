"""Tmux pane lifecycle management for the job sidecar."""

import logging
import os
import re
import subprocess

import libtmux

logger = logging.getLogger("job-sidecar")


def get_current_pane():
    """Find the tmux pane where this sidecar is running."""
    pane_id = os.environ.get("TMUX_PANE")
    if not pane_id:
        return None

    try:
        server = libtmux.Server()
        for session in server.sessions:
            for window in session.windows:
                for pane in window.panes:
                    if pane.pane_id == pane_id:
                        return pane
    except Exception as e:
        logger.error(f"Error finding current pane: {e}")
    return None


def check_wandb_in_pane(pane_id: str, workdir: str = None) -> str | None:
    """Detect WandB run directory from tmux pane output."""
    try:
        res = subprocess.run(
            ["tmux", "capture-pane", "-pt", pane_id, "-J"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        content = res.stdout

        if "WANDB_RUN_DIR:" in content:
            match = re.search(r"WANDB_RUN_DIR: (\S+)", content)
            if match:
                found_path = match.group(1).strip()
                if workdir and not os.path.isabs(found_path):
                    return os.path.normpath(os.path.join(workdir, found_path))
                return os.path.abspath(found_path)
    except Exception as e:
        logger.warning(f"Error checking for WandB: {e}")
    return None
