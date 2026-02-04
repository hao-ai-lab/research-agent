#!/usr/bin/env python3
"""
Job Sidecar - Manages job execution in tmux

This script is spawned by the server in a tmux window to:
1. Create a separate pane for the actual job
2. Execute the command with output capture
3. Monitor completion and report status back to server
"""

import argparse
import logging
import os
import re
import sys
import time
import requests
import libtmux

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("job-sidecar")


def report_status(server_url: str, job_id: str, status: str, extra_data: dict = None):
    """Report status update to server."""
    data = {"status": status}
    if extra_data:
        data.update(extra_data)
    
    try:
        logger.info(f"Reporting status: {status} with data: {extra_data}")
        requests.post(f"{server_url}/runs/{job_id}/status", json=data, timeout=10)
    except Exception as e:
        logger.warning(f"Failed to report status: {e}")


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
        import subprocess
        res = subprocess.run(
            ["tmux", "capture-pane", "-pt", pane_id, "-J"],
            capture_output=True,
            text=True,
            timeout=5
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


def monitor_job(
    server_url: str,
    job_id: str,
    command: str,
    workdir: str,
    run_dir: str
):
    """Main job monitoring loop."""
    logger.info(f"Starting job monitor for {job_id}")
    logger.info(f"Command: {command}")
    logger.info(f"Workdir: {workdir}")
    logger.info(f"Run dir: {run_dir}")
    
    # Find our current pane
    current_pane = get_current_pane()
    if not current_pane:
        logger.error("Could not identify current tmux pane")
        report_status(server_url, job_id, "failed", {"error": "No tmux pane found"})
        return
    
    window = current_pane.window
    
    # Split window to create job pane
    job_pane = window.split(attach=False)
    logger.info(f"Created job pane: {job_pane.pane_id}")
    
    # Change to workdir if specified
    if workdir:
        logger.info(f"Changing directory to: {workdir}")
        job_pane.send_keys(f"cd {workdir}")
        time.sleep(0.2)
    
    # Setup paths
    completion_file = os.path.join(run_dir, "job.done")
    log_file = os.path.join(run_dir, "run.log")
    
    # Clean up old completion file
    if os.path.exists(completion_file):
        os.remove(completion_file)
    
    # Setup log capture via pipe-pane
    try:
        logger.info(f"Piping pane output to {log_file}")
        job_pane.cmd("pipe-pane", f"cat >> {log_file}")
    except Exception as e:
        logger.error(f"Failed to setup pipe-pane: {e}")
    
    # Execute command with exit code capture
    wrapped_command = f"({command}); echo $? > {completion_file}"
    logger.info(f"Executing: {wrapped_command}")
    job_pane.send_keys(wrapped_command)
    
    # Report running status
    report_status(server_url, job_id, "running", {"tmux_pane": job_pane.pane_id})
    
    # Monitoring loop
    found_wandb_dir = None
    check_interval = 2
    
    while not os.path.exists(completion_file):
        try:
            # Check if pane still exists
            window = current_pane.window
            pane_exists = any(p.pane_id == job_pane.pane_id for p in window.panes)
            
            if not pane_exists:
                logger.error("Job pane disappeared")
                report_status(server_url, job_id, "failed", {"error": "Pane disappeared"})
                return
            
            # Detect WandB
            if not found_wandb_dir:
                found_wandb_dir = check_wandb_in_pane(job_pane.pane_id, workdir)
                if found_wandb_dir:
                    logger.info(f"Detected WandB dir: {found_wandb_dir}")
                    report_status(server_url, job_id, "running", {"wandb_dir": found_wandb_dir})
            
        except Exception as e:
            logger.error(f"Error in monitoring loop: {e}")
        
        time.sleep(check_interval)
    
    # Job completed - read exit code
    exit_code = "unknown"
    try:
        with open(completion_file, "r") as f:
            exit_code = f.read().strip()
    except Exception:
        pass
    
    # Final status
    if exit_code == "0":
        logger.info("Job completed successfully")
        report_status(server_url, job_id, "finished", {"exit_code": 0})
    else:
        logger.error(f"Job failed with exit code: {exit_code}")
        report_status(server_url, job_id, "failed", {"exit_code": exit_code})
    
    logger.info("Sidecar exiting")


def main():
    parser = argparse.ArgumentParser(description="Job Sidecar")
    parser.add_argument("--job_id", required=True, help="Job ID")
    parser.add_argument("--server_url", required=True, help="Server URL")
    parser.add_argument("--command_file", required=True, help="Path to command file")
    parser.add_argument("--workdir", default=None, help="Working directory")
    parser.add_argument("--agent_run_dir", default=None, help="Run directory for logs")
    args = parser.parse_args()
    
    # Read command from file
    try:
        with open(args.command_file, "r") as f:
            command = f.read().strip()
    except Exception as e:
        logger.error(f"Failed to read command file: {e}")
        report_status(args.server_url, args.job_id, "failed", {"error": f"Failed to read command: {e}"})
        return
    
    # Run monitor
    monitor_job(
        server_url=args.server_url,
        job_id=args.job_id,
        command=command,
        workdir=args.workdir or os.getcwd(),
        run_dir=args.agent_run_dir or "/tmp"
    )


if __name__ == "__main__":
    main()
