import sys
import logging
import subprocess
import requests
import os
import argparse
import re
import time
import libtmux
import json
import hashlib
from pathlib import Path

ERROR_KEYWORDS = ["error:", "FAILED", "Segmentation fault", "Out of Memory", "oom-kill", "Slave error", "Traceback (most recent call last)"]

SLURM_CODE_MAP = {
    "PD": "PENDING",
    "R": "RUNNING",
    "CA": "CANCELLED",
    "CF": "CONFIGURING",
    "CG": "COMPLETING",
    "CD": "COMPLETED",
    "F": "FAILED",
    "TO": "TIMEOUT",
    "NF": "NODE_FAIL",
    "RV": "REVOKED",
    "SE": "SPECIAL_EXIT",
    "ST": "STARTING",
    "PR": "PREEMPTED",
    "BF": "BOOT_FAIL",
    "OOM": "OUT_OF_MEMORY"
}

AGENT_METRICS_INTERVAL = 30
AGENT_METRICS_MAX_LINES = 5
AGENT_METRICS_MAX_BYTES = 8000
_last_metrics_pos = {}
_last_agent_check = {}

def get_slurm_status(slurm_id):
    """Check status of a Slurm job using squeue and sacct."""
    try:
        # Check squeue first (for active jobs)
        res = subprocess.run(["squeue", "-j", slurm_id, "-h", "-o", "%t"], capture_output=True, text=True, timeout=5)
        status_code = res.stdout.strip()
        if status_code:
            # Normalize short code to long name if in map
            return SLURM_CODE_MAP.get(status_code, status_code)
        
        # Fallback to sacct for finished jobs
        res = subprocess.run(["sacct", "-j", slurm_id, "-n", "-o", "State"], capture_output=True, text=True, timeout=5)
        output = res.stdout.strip()
        if output:
            # sacct can return multiple lines for job steps, first line is usually the main job
            lines = output.splitlines()
            # sacct full names are often in the form "CANCELLED by 1234" or "COMPLETED"
            full_status = lines[0].strip().split()[0]
            # Normalize common variants
            if full_status.startswith("CANCELLED"): return "CANCELLED"
            return full_status
    except Exception as e:
        logging.warning(f"[Sidecar] Error checking Slurm status for {slurm_id}: {e}")
    return "UNKNOWN"

def check_log_for_errors(log_path):
    """Scan log file for common error keywords."""
    if not log_path or not os.path.exists(log_path):
        return None
    try:
        with open(log_path, "r") as f:
            # Read last 10KB to avoid huge files if they grow fast
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 10000))
            content = f.read()
            for kw in ERROR_KEYWORDS:
                if kw.lower() in content.lower():
                    # Find the line containing the keyword for context (optional, but good)
                    return f"Found error keyword '{kw}'"
    except Exception:
        pass
    return None

def check_wandb_local(pane_id, workdir=None):
    """Detect WandB run directory from tmux pane."""
    try:
        # Use native tmux join-lines flag -J
        res = subprocess.run(["tmux", "capture-pane", "-pt", pane_id, "-J"], capture_output=True, text=True, timeout=5)
        content = res.stdout
        if "WANDB_RUN_DIR:" in content:
            match = re.search(r"WANDB_RUN_DIR: (\S+)", content)
            if match:
                found_path = match.group(1).strip()
                if workdir and not os.path.isabs(found_path):
                    new_dir = os.path.normpath(os.path.join(workdir, found_path))
                else:
                    new_dir = os.path.abspath(found_path)
                logging.info(f"[Sidecar] Detected WandB Run Dir: {new_dir}")
                return new_dir
    except Exception:
        pass
    return None

def find_slurm_id_local(pane_id):
    """Detect srun Job ID from tmux pane."""
    try:
        res = subprocess.run(["tmux", "capture-pane", "-pt", pane_id, "-J"], capture_output=True, text=True, timeout=5)
        content = res.stdout
        match = re.search(r"srun: jobid (\d+)", content)
        if match:
            sid = match.group(1)
            logging.info(f"[Sidecar] Detected srun Job ID: {sid}")
            return sid
    except Exception:
        pass
    return None

def trigger_alert(server_url, job_id, message, choices, severity="warning"):
    data = {
        "message": message,
        "choices": choices,
        "severity": severity
    }
    try:
        logging.info(f"[Sidecar] Triggering alert: {message}")
        res = requests.post(f"{server_url}/runs/{job_id}/alerts", json=data, timeout=5)
        if res.status_code == 200:
            return res.json().get("alert_id")
    except Exception as e:
        logging.error(f"[Sidecar] Failed to trigger alert: {e}")
    return None

def request_agent_analysis(server_url, job_id, context, source="sidecar", alert_id=None):
    data = {"context": context, "source": source}
    if alert_id:
        data["alert_id"] = alert_id
    try:
        logging.info(f"[Sidecar] Requesting agent analysis: {context}")
        requests.post(f"{server_url}/runs/{job_id}/agent/analyze", json=data, timeout=5)
    except Exception as e:
        logging.warning(f"[Sidecar] Failed to request agent analysis: {e}")

def wait_for_response(agent_run_dir, alert_id):
    if not agent_run_dir: return None
    
    response_file = os.path.join(agent_run_dir, "alerts", f"{alert_id}.response")
    logging.info(f"[Sidecar] Waiting for response in {response_file}...")
    
    # Wait loop
    for _ in range(300): # 10 minutes max wait
        if os.path.exists(response_file):
            try:
                with open(response_file, "r") as f:
                    return f.read().strip()
            except: pass
        time.sleep(2)
    return None

def read_recent_jsonl(path, max_lines=AGENT_METRICS_MAX_LINES, max_bytes=AGENT_METRICS_MAX_BYTES):
    try:
        if not os.path.exists(path):
            return []
        file_size = os.path.getsize(path)
        start = max(0, file_size - max_bytes)
        with open(path, "r") as f:
            f.seek(start)
            chunk = f.read()
        lines = [line for line in chunk.splitlines() if line.strip()]
        if not lines:
            return []
        recent = lines[-max_lines:]
        parsed = []
        for line in recent:
            try:
                parsed.append(json.loads(line))
            except json.JSONDecodeError:
                parsed.append({"raw": line})
        return parsed
    except Exception as e:
        logging.warning(f"[Sidecar] Failed to read metrics file {path}: {e}")
        return []

def should_run_agent(job_id, metrics_file):
    file_size = os.path.getsize(metrics_file)
    last_size = _last_metrics_pos.get(job_id, 0)
    if file_size < last_size:
        last_size = 0
    if file_size == last_size:
        return False
    _last_metrics_pos[job_id] = file_size
    now = time.time()
    last_check = _last_agent_check.get(job_id, 0)
    if now - last_check < AGENT_METRICS_INTERVAL:
        return False
    _last_agent_check[job_id] = now
    return True

def parse_agent_decision(output):
    if not output or "NOTHING" in output:
        return {"action": "ignore"}
    match = re.search(r"\{.*\}", output, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    action = data.get("action")
    if action not in ["alert", "ignore"]:
        return None
    message = (data.get("message") or "").strip()
    severity = (data.get("severity") or "warning").strip()
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        choices = ["Ignore", "Stop Job"]
    return {
        "action": action,
        "message": message,
        "severity": severity,
        "choices": choices
    }

def run_agent_decision(context, workdir=None):
    prompt = (
        "[SYSTEM] You are monitoring ML training metrics for anomalies. "
        "Decide if the user should be alerted. "
        "Return ONLY a JSON object with keys: action ('alert' or 'ignore'), "
        "message (string), severity (info|warning|critical), choices (list of strings). "
        "If action is ignore, set message to an empty string. "
        "Prefer choices ['Ignore', 'Stop Job'] for alerts.\n"
        f"Context:\n{context}"
    )
    cmd = ["opencode", "run", "--model", "opencode/kimi-k2.5-free", prompt]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=workdir or None
        )
    except FileNotFoundError:
        logging.warning("[Sidecar] opencode CLI not found; skipping agent decision.")
        return None
    except Exception as e:
        logging.warning(f"[Sidecar] Agent decision failed: {e}")
        return None
    output = (res.stdout or "").strip()
    logging.info(f"[Sidecar] Agent decision output: {output}")
    decision = parse_agent_decision(output)
    if decision is None:
        logging.info(f"[Sidecar] Agent output not parseable: {output[:200]}")
    return decision

def should_emit_alert(wandb_dir, message_hash):
    if not wandb_dir:
        return True
    marker = os.path.join(wandb_dir, ".agent_alert_sent")
    if os.path.exists(marker):
        try:
            with open(marker, "r") as f:
                last_hash = f.read().strip()
            if last_hash == message_hash:
                return False
        except Exception:
            return True
    return True

def write_alert_marker(wandb_dir, message_hash):
    if not wandb_dir:
        return
    marker = os.path.join(wandb_dir, ".agent_alert_sent")
    try:
        with open(marker, "w") as f:
            f.write(message_hash)
    except Exception:
        pass

# Dummy monitoring for prototype
def check_metrics_and_alert(server_url, job_id, workdir, agent_run_dir, step, wandb_dir=None):
    # Check for manual trigger
    trigger_file = os.path.join(workdir, "trigger_alert") if workdir else None
    if trigger_file and os.path.exists(trigger_file):
        logging.info("[Sidecar] Alert trigger file found!")
        os.remove(trigger_file)
        alert_id = trigger_alert(server_url, job_id, "Manual Trigger Detected", ["Ignore", "Stop Job"])
        if alert_id:
            request_agent_analysis(
                server_url,
                job_id,
                f"Manual alert trigger file detected at {trigger_file}.",
                source="manual-trigger",
                alert_id=alert_id
            )
            response = wait_for_response(agent_run_dir, alert_id)
            if response == "Stop Job": return "STOP"

    # Check for Metric Anomalies (agent-driven)
    if wandb_dir:
        metrics_file = os.path.join(wandb_dir, "metrics.jsonl")
        if os.path.exists(metrics_file) and should_run_agent(job_id, metrics_file):
            recent_metrics = read_recent_jsonl(metrics_file)
            if recent_metrics:
                context_blob = {
                    "event": "metrics_update",
                    "wandb_dir": wandb_dir,
                    "metrics_file": metrics_file,
                    "recent_metrics": recent_metrics
                }
                decision = run_agent_decision(json.dumps(context_blob, ensure_ascii=True), workdir)
                logging.info(f"[Sidecar] Agent decision: {decision}")
                if decision and decision.get("action") == "alert":
                    message = decision.get("message") or "Metric anomaly detected."
                    if len(message) > 600:
                        message = f"{message[:597]}..."
                    message_hash = hashlib.sha1(message.encode("utf-8")).hexdigest()
                    if should_emit_alert(wandb_dir, message_hash):
                        logging.warning(f"[Sidecar] Agent-triggered alert: {message}")
                        alert_id = trigger_alert(
                            server_url,
                            job_id,
                            message,
                            decision.get("choices") or ["Ignore", "Stop Job"],
                            decision.get("severity") or "warning"
                        )
                        if alert_id:
                            write_alert_marker(wandb_dir, message_hash)
                            response = wait_for_response(agent_run_dir, alert_id)
                            logging.info(f"[Sidecar] User response: {response}")
                            if response == "Stop Job":
                                return "STOP"

    return "CONTINUE"

def get_current_pane():
    """Find the tmux pane where this sidecar is running."""
    server = libtmux.Server()
    # TMUX_PANE environment variable is set by tmux in each pane
    pane_id = os.environ.get("TMUX_PANE")
    if not pane_id:
        return None
    
    for session in server.sessions:
        for window in session.windows:
            for pane in window.panes:
                if pane.pane_id == pane_id:
                    return pane
    return None

def monitor_local(server_url, job_id, command, workdir, agent_run_dir=None):
    logging.info(f"[Sidecar] Local mode: {command}")
    current_pane = get_current_pane()
    if not current_pane:
        logging.error("[Sidecar] Error: Could not identify current tmux pane.")
        report_status(server_url, job_id, "failed", {"error": "No tmux pane found"})
        return

    window = current_pane.window
    
    # Split the window to create a pane for the actual job
    # We'll split it vertically (side by side)
    job_pane = window.split(attach=False)
    logging.info(f"[Sidecar] Created new tmux pane: {job_pane.pane_id}")
    
    if workdir:
        logging.info(f"[Sidecar] Changing directory to: {workdir}")
        job_pane.send_keys(f"cd {workdir}")
    
    # We want to capture the status and ideally the PID
    # We'll wrap the command to signal completion
    if agent_run_dir:
        completion_file = os.path.join(agent_run_dir, "job.done")
        run_log_file = os.path.join(agent_run_dir, "run.log")
    else:
        completion_dir = os.path.join(workdir, ".agents") if workdir else "/tmp"
        os.makedirs(completion_dir, exist_ok=True)
        completion_file = os.path.join(completion_dir, f"job-{job_id}-done")
        run_log_file = os.path.join(completion_dir, f"job-{job_id}.log")
    
    if os.path.exists(completion_file):
        os.remove(completion_file)

    # Use tmux pipe-pane to stream output to file. 
    # This captures both stdout and stderr as they appear in the pane.
    try:
        logging.info(f"[Sidecar] Piping pane output to {run_log_file}")
        # 'cat >>' ensures we append if the sidecar restarts or multiple commands are run
        job_pane.cmd("pipe-pane", f"cat >> {run_log_file}")
    except Exception as e:
        logging.error(f"[Sidecar] Failed to setup pipe-pane: {e}")
        
    # Run command and capture exit code. 
    # We wrap in parentheses to ensure the exit code is for the whole command.
    wrapped_command = f"({command}); echo $? > {completion_file}"
    logging.info(f"[Sidecar] Sending command to pane: {wrapped_command}")
    job_pane.send_keys(wrapped_command)
    
    report_status(server_url, job_id, "running", {"tmux_pane": job_pane.pane_id})
    
    found_wandb_dir = None
    slurm_id = None
    is_srun = "srun" in command

    # Monitoring loop
    step_check = 0
    while not os.path.exists(completion_file):
        try:
            step_check += 1
            window = current_pane.window
            found = False
            for p in window.panes:
                if p.pane_id == job_pane.pane_id:
                    found = True
                    break
            if not found:
                logging.error("[Sidecar] Error: Job pane disappeared.")
                report_status(server_url, job_id, "failed", {"error": "Pane disappeared"})
                return

            # Detect WandB
            if not found_wandb_dir:
                found_wandb_dir = check_wandb_local(job_pane.pane_id, workdir)
                if found_wandb_dir:
                    report_status(server_url, job_id, "running", {"wandb_dir": found_wandb_dir})
            
            # Detect srun Job ID
            if is_srun and not slurm_id:
                slurm_id = find_slurm_id_local(job_pane.pane_id)
                if slurm_id:
                    report_status(server_url, job_id, "running", {"slurm_id": slurm_id})
            
            # If we have a Slurm ID, check its status
            if slurm_id:
                s_status = get_slurm_status(slurm_id)
                failure_states = ["FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "PREEMPTED", "OUT_OF_MEMORY"]
                if any(s_status.startswith(f) for f in failure_states):
                    logging.error(f"[Sidecar] Slurm job {slurm_id} failed with status: {s_status}")
                    # Even if srun process is still alive (sometimes it hangs), 
                    # Slurm says it's dead.
                    report_status(server_url, job_id, "failed", {"slurm_id": slurm_id, "slurm_status": s_status})
                    # job_pane.cmd("kill-pane") # Cleanup
                    return

            # Check for alerts
            action = check_metrics_and_alert(server_url, job_id, workdir, agent_run_dir, step_check, found_wandb_dir)
            if action == "STOP":
                logging.info("[Sidecar] Stopping job as requested...")
                # Kill the pane
                job_pane.cmd("kill-pane")
                report_status(server_url, job_id, "stopped", {"info": "User stopped via alert"})
                return

            # Check for logs errors
            error_msg = check_log_for_errors(run_log_file)
            if error_msg:
                logging.warning(f"[Sidecar] Potential error detected in logs: {error_msg}")
                # For now just update status with info, might want to alert if severe
                report_status(server_url, job_id, "running", {"last_error": error_msg})

        except Exception as e:
            logging.error(f"[Sidecar] Error in monitoring loop: {e}")
            break
        time.sleep(2)
    
    # Final cleanup and report
    exit_code = "unknown"
    if os.path.exists(completion_file):
        try:
            with open(completion_file, "r") as f:
                exit_code = f.read().strip()
        except: pass
    
    if exit_code == "0":
        report_status(server_url, job_id, "finished", {"exit_code": 0})
    else:
        error_msg = check_log_for_errors(run_log_file)
        report_status(server_url, job_id, "failed", {"exit_code": exit_code, "error": error_msg})

def report_status(server_url, job_id, status, extra_data=None):
    data = {"status": status}
    if extra_data:
        data.update(extra_data)
    try:
        logging.info(f"[Sidecar] Reporting status: {status} with data: {extra_data}")
        # Using a longer timeout for robustness
        requests.post(f"{server_url}/runs/{job_id}/status", json=data, timeout=10)
    except Exception as e:
        logging.warning(f"[Sidecar] Warning: Failed to report status to {server_url}: {e}")

def monitor_slurm(server_url, job_id, command, workdir):
    logging.info(f"[Sidecar] Slurm mode: {command}")
    
    try:
        process = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=workdir
        )
        
        output = process.stdout + process.stderr
        logging.info(f"Submission output:\n{output}")
        
        # Extract Slurm Job ID
        match = re.search(r"Submitted batch job (\d+)", output, re.IGNORECASE)
        if not match:
            logging.error("[Sidecar] Error: Failed to extract Slurm Job ID.")
            report_status(server_url, job_id, "failed", {"error": "Failed to extract Slurm ID", "output": output})
            return
            
        slurm_id = match.group(1)
        logging.info(f"[Sidecar] Detected Slurm Job ID: {slurm_id}")
        report_status(server_url, job_id, "running", {"slurm_id": slurm_id})
        
        found_wandb_dir = None
        # Slurm typically defaults to slurm-<id>.out in the current directory
        # unless specified otherwise in the sbatch headers.
        slurm_log_path = os.path.join(workdir if workdir else ".", f"slurm-{slurm_id}.out")

        def check_wandb_slurm(log_path, found_dir):
            if found_dir: return found_dir
            if os.path.exists(log_path):
                try:
                    with open(log_path, "r") as f:
                        content = f.read()
                        if "WANDB_RUN_DIR:" in content:
                            match = re.search(r"WANDB_RUN_DIR: (\S+)", content)
                            if match:
                                found_path = match.group(1).strip()
                                if workdir and not os.path.isabs(found_path):
                                    new_dir = os.path.normpath(os.path.join(workdir, found_path))
                                else:
                                    new_dir = os.path.abspath(found_path)
                                logging.info(f"[Sidecar] Detected WandB Run Dir from Slurm log: {new_dir}")
                                report_status(server_url, job_id, "running", {"wandb_dir": new_dir, "slurm_id": slurm_id})
                                return new_dir
                except Exception as e:
                    logging.warning(f"[Sidecar] Warning: Failed to read Slurm log {log_path}: {e}")
            return None

        slurm_log_path = os.path.join(workdir if workdir else ".", f"slurm-{slurm_id}.out")

        # Polling loop
        while True:
            status = get_slurm_status(slurm_id)
            found_wandb_dir = check_wandb_slurm(slurm_log_path, found_wandb_dir)

            terminal_states = ["UNKNOWN", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "PREEMPTED", "OUT_OF_MEMORY"]
            if any(status.startswith(s) for s in terminal_states):
                # If it's done or unknown, break and do final report
                break
            
            # Update status
            if status == "PD":
                report_status(server_url, job_id, "queued", {"slurm_id": slurm_id})
            elif status == "R":
                report_status(server_url, job_id, "running", {"slurm_id": slurm_id})
            
            # Also check log for immediate errors even while "running"
            error_msg = check_log_for_errors(slurm_log_path)
            if error_msg:
                # We might not want to stop immediately if it's just a warning, 
                # but "FAILED" or "error:" in Slurm log is usually fatal.
                # For now just log it, but we could trigger an alert.
                logging.warning(f"[Sidecar] Potential error detected in Slurm log: {error_msg}")

            time.sleep(10)

        # Final check after job is done
        found_wandb_dir = check_wandb_slurm(slurm_log_path, found_wandb_dir)
        final_status = get_slurm_status(slurm_id)
        
        if "COMPLETED" in final_status:
            report_status(server_url, job_id, "finished", {"slurm_final_status": final_status})
        elif any(s in final_status for s in ["FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "PREEMPTED", "OUT_OF_MEMORY"]):
            error_msg = check_log_for_errors(slurm_log_path)
            report_status(server_url, job_id, "failed", {"slurm_final_status": final_status, "error": error_msg})
        else:
            report_status(server_url, job_id, "finished", {"slurm_final_status": final_status or "ASSUMED_COMPLETED"})
            
    except Exception as e:
        logging.error(f"[Sidecar] Error monitoring Slurm: {e}")
        report_status(server_url, job_id, "failed", {"error": str(e)})

def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
    parser = argparse.ArgumentParser()
    parser.add_argument("--job_id", required=True)
    parser.add_argument("--server_url", required=True)
    parser.add_argument("--command_file", required=True)
    parser.add_argument("--workdir", default=None)
    parser.add_argument("--agent_run_dir", default=None)
    args = parser.parse_args()

    # Read command from file
    # TODO: Let's think about the design of command passing across process... 
    # This has been a historic headache.
    try:
        with open(args.command_file, "r") as f:
            command = f.read().strip()
    except Exception as e:
        logging.error(f"[Sidecar] Failed to read command file {args.command_file}: {e}")
        report_status(args.server_url, args.job_id, "failed", {"error": f"Failed to read command file: {e}"})
        return

    # Determine if sbatch
    if "sbatch" in command:
        monitor_slurm(args.server_url, args.job_id, command, args.workdir)
    else:
        monitor_local(args.server_url, args.job_id, command, args.workdir, args.agent_run_dir)

if __name__ == "__main__":
    main()
