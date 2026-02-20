"""SLURM MCP server using CLI commands (squeue, sinfo, sbatch, scancel, sacct, scontrol)."""

import json
import os
import subprocess
import tempfile
from datetime import datetime, timedelta
from typing import Any

from fastmcp import FastMCP

mcp = FastMCP("slurm-cli")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(cmd: list[str], timeout: int = 30) -> dict[str, Any]:
    """Run a SLURM CLI command and return parsed JSON."""
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"`{' '.join(cmd)}` failed (rc={result.returncode}): {result.stderr.strip()}")
    return json.loads(result.stdout)


def _safe_val(data: Any, default: str = "N/A") -> str:
    if isinstance(data, dict):
        return str(data.get("number", default))
    return str(data) if data else default


def _ts(ts: Any) -> str:
    if isinstance(ts, dict):
        ts = ts.get("number", 0)
    if ts and ts != 0:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    return "N/A"


def _dur(seconds: Any) -> str:
    if isinstance(seconds, str):
        try:
            seconds = int(seconds)
        except (ValueError, TypeError):
            return "N/A"
    if isinstance(seconds, dict):
        seconds = seconds.get("number", 0)
    if not seconds or seconds <= 0:
        return "N/A"
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _job_state(job: dict[str, Any]) -> str:
    state = job.get("job_state", ["UNKNOWN"])
    return state[0] if isinstance(state, list) else str(state)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def list_jobs(
    user: str | None = None,
    state: str | None = None,
    partition: str | None = None,
    limit: int = 50,
) -> str:
    """List SLURM jobs. Defaults to the current user's jobs.

    Args:
        user: Filter by username. Defaults to --me (current user). Use '*' for all users.
        state: Comma-separated states to filter (e.g. 'RUNNING,PENDING').
        partition: Filter by partition name.
        limit: Max jobs to return (default 50).
    """
    cmd = ["squeue", "--json"]
    if user and user != "*":
        cmd += ["--user", user]
    elif not user:
        cmd.append("--me")
    if state:
        cmd += ["--states", state]
    if partition:
        cmd += ["--partition", partition]

    data = _run(cmd)
    jobs = data.get("jobs", [])[:limit]

    lines = [f"# SLURM Jobs", "", f"Found **{len(jobs)}** jobs:", ""]
    if not jobs:
        lines.append("No jobs found matching the specified criteria.")
        return "\n".join(lines)

    lines.append("| Job ID | Name | User | State | Partition | Nodes | GPUs | Submit Time |")
    lines.append("|--------|------|------|-------|-----------|-------|------|-------------|")
    for j in jobs:
        st = j.get("submit_time", {})
        st_val = st.get("number", 0) if isinstance(st, dict) else st
        st_str = datetime.fromtimestamp(st_val).strftime("%m-%d %H:%M") if st_val else "-"
        tres = j.get("tres_per_node", "")
        gpu = ""
        if tres and "gpu" in tres:
            gpu = tres.split(":")[-1] if ":" in tres else tres
        name = j.get("name", "-") or "-"
        if len(name) > 40:
            name = name[:37] + "..."
        lines.append(
            f"| {j.get('job_id', '?')} "
            f"| {name} "
            f"| {j.get('user_name', '?')} "
            f"| {_job_state(j)} "
            f"| {j.get('partition', '-') or '-'} "
            f"| {j.get('nodes', '-') or '-'} "
            f"| {gpu} "
            f"| {st_str} |"
        )
    return "\n".join(lines)


@mcp.tool()
def get_job_details(job_id: str) -> str:
    """Get detailed information about a specific SLURM job.

    Args:
        job_id: The SLURM job ID.
    """
    data = _run(["scontrol", "show", "job", job_id, "--json"])
    jobs = data.get("jobs", [])
    if not jobs:
        return f"# Job Not Found\n\nJob `{job_id}` not found."

    job = jobs[0]
    state = _job_state(job)

    lines = [
        f"# Job Details: {job.get('name', 'Unnamed')} (ID: {job_id})",
        "",
        "## Status",
        f"- **State**: **{state}**",
        f"- **User**: {job.get('user_name', 'Unknown')}",
        f"- **Partition**: {job.get('partition', 'N/A')}",
        f"- **Account**: {job.get('account', 'N/A')}",
        "",
        "## Resources",
        f"- **Nodes**: {job.get('nodes', 'N/A')} ({_safe_val(job.get('node_count'))} nodes)",
        f"- **CPUs**: {_safe_val(job.get('cpus'))}",
        f"- **TRES**: {job.get('tres_alloc_str', 'N/A')}",
        f"- **GPUs/node**: {job.get('tres_per_node', 'N/A')}",
        f"- **Working Dir**: `{job.get('current_working_directory', 'N/A')}`",
        "",
        "## Timing",
        f"- **Submitted**: {_ts(job.get('submit_time'))}",
        f"- **Started**: {_ts(job.get('start_time'))}",
        f"- **End**: {_ts(job.get('end_time'))}",
        f"- **Time Limit**: {_dur(_safe_val(job.get('time_limit'), '0'))} (minutes)",
        f"- **Elapsed**: {_dur(_safe_val(job.get('run_time'), '0'))}",
        "",
        "## Files",
        f"- **Stdout**: `{job.get('standard_output', 'N/A')}`",
        f"- **Stderr**: `{job.get('standard_error', 'N/A')}`",
        "",
    ]

    # Node allocation
    job_resources = job.get("job_resources", {})
    alloc = job_resources.get("allocation", []) if isinstance(job_resources, dict) else []
    if not alloc:
        nodes_info = job_resources.get("nodes", {}) if isinstance(job_resources, dict) else {}
        alloc = nodes_info.get("allocation", []) if isinstance(nodes_info, dict) else []
    if alloc:
        lines += ["## Node Allocation", ""]
        for n in alloc[:8]:
            cpus_info = n.get("cpus", {})
            cpu_count = cpus_info.get("count", "?") if isinstance(cpus_info, dict) else cpus_info
            mem_info = n.get("memory", {})
            mem_used = mem_info.get("used", "?") if isinstance(mem_info, dict) else "?"
            lines.append(f"- **{n.get('name', '?')}**: {cpu_count} CPUs, {mem_used} MB mem used")
        if len(alloc) > 8:
            lines.append(f"- *... and {len(alloc) - 8} more*")
        lines.append("")

    # Exit code
    exit_info = job.get("exit_code", {})
    if isinstance(exit_info, dict):
        rc = exit_info.get("return_code", {})
        code = rc.get("number", 0) if isinstance(rc, dict) else rc
        status_list = exit_info.get("status", [])
        status = status_list[0] if isinstance(status_list, list) and status_list else "UNKNOWN"
        lines += ["## Exit Status", f"- **Exit Code**: {code}", f"- **Status**: {status}", ""]

    # State reason
    reason = job.get("state_reason", "")
    if reason and reason != "None":
        lines += ["## Additional Info", f"- **Reason**: {reason}", ""]

    return "\n".join(lines)


@mcp.tool()
def submit_job(script: str) -> str:
    """Submit a batch job to SLURM. Takes a complete bash script with #SBATCH directives.

    Args:
        script: Full bash script content including #!/bin/bash and #SBATCH directives.

    Example script:
        #!/bin/bash
        #SBATCH --job-name=test
        #SBATCH --partition=main
        #SBATCH --nodes=1
        #SBATCH --gpus-per-node=8
        #SBATCH --time=01:00:00
        #SBATCH --output=slurm-%j.out

        echo "Hello from SLURM"
        python train.py
    """
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False, prefix="slurm_mcp_") as f:
        f.write(script)
        tmp_path = f.name

    try:
        result = subprocess.run(
            ["sbatch", tmp_path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return f"# Submission Failed\n\n```\n{result.stderr.strip()}\n```"

        # Parse job ID from "Submitted batch job 12345"
        output = result.stdout.strip()
        job_id = output.split()[-1] if output else "unknown"
        return f"# Job Submitted\n\n- **Job ID**: {job_id}\n- **Script**: `{tmp_path}`\n- **Output**: {output}"
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@mcp.tool()
def cancel_job(job_id: str) -> str:
    """Cancel a running or pending SLURM job.

    Args:
        job_id: The SLURM job ID to cancel.
    """
    result = subprocess.run(
        ["scancel", job_id],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        return f"# Cancel Failed\n\nJob `{job_id}`: {result.stderr.strip()}"
    return f"# Job Cancelled\n\nJob `{job_id}` has been cancelled."


@mcp.tool()
def cluster_status(partition: str | None = None) -> str:
    """Get SLURM cluster status: partitions, nodes, and GPU availability.

    Args:
        partition: Optional partition name to filter.
    """
    cmd = ["sinfo", "--json"]
    data = _run(cmd)
    entries = data.get("sinfo", [])

    if partition:
        entries = [e for e in entries if e.get("partition", {}).get("name") == partition
                   or (isinstance(e.get("partition"), str) and e["partition"] == partition)]

    # Group by partition
    partitions: dict[str, dict[str, Any]] = {}
    for e in entries:
        p_info = e.get("partition", {})
        p_name = p_info.get("name", "unknown") if isinstance(p_info, dict) else str(p_info)

        if p_name not in partitions:
            partitions[p_name] = {
                "nodes_total": 0, "nodes_idle": 0, "nodes_alloc": 0, "nodes_other": 0,
                "cpus_total": 0, "cpus_idle": 0, "cpus_alloc": 0,
                "gres": set(),
            }
        p = partitions[p_name]

        nodes = e.get("nodes", {})
        if isinstance(nodes, dict):
            p["nodes_total"] += nodes.get("total", 0)
            p["nodes_idle"] += nodes.get("idle", 0)
            p["nodes_alloc"] += nodes.get("allocated", 0)
            p["nodes_other"] += nodes.get("other", 0)

        cpus = e.get("cpus", {})
        if isinstance(cpus, dict):
            p["cpus_total"] += cpus.get("total", 0)
            p["cpus_idle"] += cpus.get("idle", 0)
            p["cpus_alloc"] += cpus.get("allocated", 0)

        gres = e.get("gres", {})
        if isinstance(gres, dict):
            total_gres = gres.get("total", "")
            if total_gres:
                p["gres"].add(total_gres)

    lines = ["# SLURM Cluster Status", ""]
    lines.append("| Partition | Nodes (total/idle/alloc/other) | CPUs (total/idle/alloc) | GPUs |")
    lines.append("|-----------|-------------------------------|------------------------|------|")
    for name, p in sorted(partitions.items()):
        gres_str = "; ".join(sorted(p["gres"])) if p["gres"] else "-"
        if len(gres_str) > 30:
            gres_str = gres_str[:27] + "..."
        lines.append(
            f"| {name} "
            f"| {p['nodes_total']}/{p['nodes_idle']}/{p['nodes_alloc']}/{p['nodes_other']} "
            f"| {p['cpus_total']}/{p['cpus_idle']}/{p['cpus_alloc']} "
            f"| {gres_str} |"
        )

    lines += ["", f"**{len(partitions)} partitions** reported by `sinfo`"]
    return "\n".join(lines)


@mcp.tool()
def job_history(
    days: int = 7,
    user: str | None = None,
    state: str | None = None,
    limit: int = 50,
) -> str:
    """Get completed job history from SLURM accounting.

    Args:
        days: Number of days to look back (default 7).
        user: Filter by username (defaults to current user).
        state: Filter by state (e.g. 'COMPLETED', 'FAILED', 'TIMEOUT').
        limit: Max jobs to return (default 50).
    """
    start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    cmd = ["sacct", "--json", "-S", start_date]
    if user:
        cmd += ["--user", user]
    if state:
        cmd += ["--state", state]

    data = _run(cmd, timeout=60)
    jobs = data.get("jobs", [])[:limit]

    lines = [f"# Job History (last {days} days)", "", f"Found **{len(jobs)}** jobs:", ""]
    if not jobs:
        lines.append("No jobs found in the specified time range.")
        return "\n".join(lines)

    lines.append("| Job ID | Name | State | Partition | Nodes | Elapsed | Exit |")
    lines.append("|--------|------|-------|-----------|-------|---------|------|")
    for j in jobs:
        # sacct uses different field structure than squeue
        state_info = j.get("state", {})
        if isinstance(state_info, dict):
            current = state_info.get("current", ["UNKNOWN"])
            job_st = current[0] if isinstance(current, list) else str(current)
        else:
            job_st = str(state_info)

        time_info = j.get("time", {})
        elapsed = time_info.get("elapsed", 0) if isinstance(time_info, dict) else 0

        exit_info = j.get("exit_code", {})
        if isinstance(exit_info, dict):
            rc = exit_info.get("return_code", {})
            exit_code = rc.get("number", 0) if isinstance(rc, dict) else rc
        else:
            exit_code = "?"

        name = j.get("name", "-") or "-"
        if len(name) > 35:
            name = name[:32] + "..."

        lines.append(
            f"| {j.get('job_id', '?')} "
            f"| {name} "
            f"| {job_st} "
            f"| {j.get('partition', '-')} "
            f"| {j.get('allocation_nodes', '-')} "
            f"| {_dur(elapsed)} "
            f"| {exit_code} |"
        )
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run()
