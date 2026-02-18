#!/usr/bin/env python3
"""
End-to-end backend-only Wild Loop V2 test on FlashInfer kernel optimization.

This script:
  1. Starts opencode in headless mode (opencode serve) in the FlashInfer project dir
  2. Starts the research-agent server on port 10099
  3. Kicks off a V2 wild loop via POST /wild/v2/start
  4. Polls status every 15s, streaming server logs and sweep/run state
  5. Terminates after the loop finishes or a 30-minute timeout
  6. Prints a summary of what happened

Usage:
    python3 tests/wild_loop_v2_e2e_test.py

Environment:
    MODEL_PROVIDER  (default: opencode)
    MODEL_ID        (default: kimi-k2.5-free)
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WORKDIR = os.path.join(PROJECT_ROOT, "tests", "story", "flashinfer-kernel")
SERVER_DIR = os.path.join(PROJECT_ROOT, "server")
SERVER_PYTHON = os.path.join(PROJECT_ROOT, ".ra-venv", "bin", "python3")
SERVER_PORT = 10099
OPENCODE_PORT = 4097
SERVER_URL = f"http://127.0.0.1:{SERVER_PORT}"
OPENCODE_URL = f"http://127.0.0.1:{OPENCODE_PORT}"

GOAL = (
    "Optimize the Triton fused MoE kernel to maximize benchmark speedup. "
    "Tune BLOCK_SIZE, NUM_WARPS, NUM_STAGES, and USE_FP8 in solution/triton/kernel.py, "
    "then run scripts/benchmark.py to measure performance."
)

MAX_ITERATIONS = 10
WAIT_SECONDS = 30.0   # wait between iterations when WAITING
POLL_INTERVAL = 15    # seconds between status polls
TIMEOUT_MINUTES = 30

MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "opencode")
MODEL_ID = os.environ.get("MODEL_ID", "kimi-k2.5-free")

# Auth token — read from .ra-auth-token file
AUTH_TOKEN_FILE = os.path.join(PROJECT_ROOT, ".ra-auth-token")
AUTH_TOKEN = ""
if os.path.isfile(AUTH_TOKEN_FILE):
    with open(AUTH_TOKEN_FILE) as f:
        AUTH_TOKEN = f.read().strip()

LOG_DIR = os.path.join(PROJECT_ROOT, "tests", "e2e_logs")


def _headers() -> dict:
    if AUTH_TOKEN:
        return {"X-Auth-Token": AUTH_TOKEN}
    return {}


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def log_separator():
    print("=" * 80, flush=True)


# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

processes: list[subprocess.Popen] = []
log_threads: list[threading.Thread] = []


def cleanup():
    """Kill all child processes."""
    log("🧹 Cleaning up processes...")
    for proc in processes:
        if proc.poll() is None:
            log(f"  Killing PID {proc.pid}")
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except OSError:
                proc.kill()
    for proc in processes:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def stream_output(proc: subprocess.Popen, label: str, log_file_path: str):
    """Stream subprocess stdout to console (filtered) and to a log file."""
    os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
    with open(log_file_path, "w") as log_f:
        for raw_line in iter(proc.stdout.readline, b""):
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            log_f.write(line + "\n")
            log_f.flush()
            # Print interesting lines to console
            lower = line.lower()
            if any(kw in lower for kw in (
                "wild-v2", "wild_v2", "sweep", "run ",
                "opencode", "iteration", "planning", "error",
                "failed", "prompt", "session", "sse:",
                "created", "started", "finished",
            )):
                ts = datetime.now().strftime("%H:%M:%S")
                print(f"  [{ts}] [{label}] {line.strip()}", flush=True)


def start_opencode() -> subprocess.Popen:
    log("🚀 Starting opencode serve on port %d..." % OPENCODE_PORT)
    env = os.environ.copy()
    proc = subprocess.Popen(
        ["opencode", "serve", "--port", str(OPENCODE_PORT), "--print-logs"],
        cwd=WORKDIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
    )
    processes.append(proc)
    log(f"   opencode PID: {proc.pid}")
    # Stream logs in background thread
    t = threading.Thread(
        target=stream_output, args=(proc, "OC", os.path.join(LOG_DIR, "opencode.log")),
        daemon=True,
    )
    t.start()
    log_threads.append(t)
    return proc


def start_server() -> subprocess.Popen:
    log(f"🚀 Starting research-agent server on port {SERVER_PORT}...")
    env = os.environ.copy()
    env["MODEL_PROVIDER"] = MODEL_PROVIDER
    env["MODEL_ID"] = MODEL_ID
    env["OPENCODE_URL"] = OPENCODE_URL
    env["PYTHONUNBUFFERED"] = "1"
    if AUTH_TOKEN:
        env["RESEARCH_AGENT_USER_AUTH_TOKEN"] = AUTH_TOKEN
    proc = subprocess.Popen(
        [
            SERVER_PYTHON, "server.py",
            "--workdir", WORKDIR,
            "--port", str(SERVER_PORT),
        ],
        cwd=os.path.abspath(SERVER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
    )
    processes.append(proc)
    log(f"   server PID: {proc.pid}")
    # Stream logs in background thread
    t = threading.Thread(
        target=stream_output, args=(proc, "SRV", os.path.join(LOG_DIR, "server.log")),
        daemon=True,
    )
    t.start()
    log_threads.append(t)
    return proc


def wait_for_service(url: str, name: str, timeout: int = 60):
    log(f"⏳ Waiting for {name} at {url}...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(url, headers=_headers(), timeout=3)
            if r.status_code < 500:
                log(f"   ✅ {name} is ready (status {r.status_code})")
                return
        except requests.ConnectionError:
            pass
        time.sleep(2)
    raise TimeoutError(f"{name} did not become ready within {timeout}s")


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def api_get(path: str, quiet: bool = False):
    try:
        r = requests.get(f"{SERVER_URL}{path}", headers=_headers(), timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        if not quiet:
            log(f"   ⚠️  GET {path} failed: {e}")
        return None


def api_post(path: str, data: dict = None):
    try:
        r = requests.post(f"{SERVER_URL}{path}", json=data or {}, headers=_headers(), timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log(f"   ⚠️  POST {path} failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Main test flow
# ---------------------------------------------------------------------------

def _reset_test_state():
    """Clean stale session state and reset kernel.py to defaults."""
    # Remove old wild loop sessions
    wild_dir = os.path.join(WORKDIR, ".agents", "wild")
    if os.path.exists(wild_dir):
        shutil.rmtree(wild_dir)
        log("   Cleaned stale .agents/wild/")

    # Remove old jobs (sweeps/runs)
    jobs_file = os.path.join(WORKDIR, ".agents", "jobs.json")
    if os.path.exists(jobs_file):
        os.remove(jobs_file)
        log("   Cleaned stale .agents/jobs.json")

    # Remove old experiment results
    exp_dir = os.path.join(WORKDIR, "exp")
    if os.path.exists(exp_dir):
        shutil.rmtree(exp_dir)
        log("   Cleaned stale exp/")

    # Reset kernel.py to default (unoptimized) values
    kernel_path = os.path.join(WORKDIR, "solution", "triton", "kernel.py")
    if os.path.exists(kernel_path):
        with open(kernel_path) as f:
            content = f.read()
        # Replace optimized values with defaults
        replacements = [
            (r"BLOCK_SIZE\s*=\s*\d+", "BLOCK_SIZE = 64"),
            (r"NUM_WARPS\s*=\s*\d+", "NUM_WARPS = 4"),
            (r"NUM_STAGES\s*=\s*\d+", "NUM_STAGES = 2"),
            (r"USE_FP8\s*=\s*\w+", "USE_FP8 = False"),
        ]
        for pattern, replacement in replacements:
            content = re.sub(pattern, replacement, content)
        # Reset the comment block to default
        content = re.sub(
            r"# Tunable parameters.*?\n(?:#.*\n)*",
            "# Tunable parameters — the wild loop agent should experiment with these\n",
            content,
        )
        with open(kernel_path, "w") as f:
            f.write(content)
        log("   Reset kernel.py to default params (BLOCK_SIZE=64, NUM_WARPS=4, NUM_STAGES=2, USE_FP8=False)")


def run_test():
    os.makedirs(LOG_DIR, exist_ok=True)

    log_separator()
    log("🧹 Resetting test state...")
    _reset_test_state()

    log_separator()
    log("🧪 Wild Loop V2 E2E Test — FlashInfer Kernel Optimization")
    log(f"   Goal: {GOAL}")
    log(f"   Model: {MODEL_PROVIDER}/{MODEL_ID}")
    log(f"   Workdir: {WORKDIR}")
    log(f"   Server: {SERVER_URL}")
    log(f"   Max iterations: {MAX_ITERATIONS}")
    log(f"   Timeout: {TIMEOUT_MINUTES} min")
    log(f"   Logs dir: {LOG_DIR}")
    log(f"   Auth: {'yes' if AUTH_TOKEN else 'no'}")
    log_separator()

    # 1. Start services
    opencode_proc = start_opencode()
    time.sleep(3)
    server_proc = start_server()

    # 2. Wait for both services
    wait_for_service(f"{OPENCODE_URL}/session", "OpenCode", timeout=45)
    wait_for_service(f"{SERVER_URL}/wild/v2/status", "Research Agent Server", timeout=90)

    log_separator()
    log("✅ Both services are running!")
    log_separator()

    # 3. Start the V2 wild loop
    log("📡 Starting V2 wild loop via POST /wild/v2/start ...")
    start_result = api_post("/wild/v2/start", {
        "goal": GOAL,
        "max_iterations": MAX_ITERATIONS,
        "wait_seconds": WAIT_SECONDS,
    })
    if not start_result:
        log("❌ Failed to start V2 wild loop!")
        return

    session_id = start_result.get("session_id", "unknown")
    log(f"   Session ID: {session_id}")
    log(f"   Status: {start_result.get('status')}")
    log_separator()

    # 4. Monitor loop — poll every POLL_INTERVAL seconds
    deadline = time.time() + TIMEOUT_MINUTES * 60
    poll_count = 0
    last_iteration = -1
    stall_polls = 0          # polls since last iteration change
    sweeps_seen = set()
    runs_seen = set()

    while time.time() < deadline:
        poll_count += 1
        time.sleep(POLL_INTERVAL)

        # Get status
        status = api_get("/wild/v2/status", quiet=True)
        if not status:
            log(f"[Poll #{poll_count}] ⚠️  Could not reach status endpoint")
            continue

        is_active = status.get("active", False)
        current_iter = status.get("iteration", 0)
        loop_status = status.get("status", "unknown")
        history = status.get("history", [])

        # Stall detection
        if current_iter != last_iteration:
            stall_polls = 0
        else:
            stall_polls += 1
        if stall_polls >= 10:
            log(f"   ⚠️  STALL: iteration stuck at {current_iter} for {stall_polls} polls ({stall_polls * POLL_INTERVAL}s)")

        # Print update
        if current_iter != last_iteration or poll_count % 5 == 0:
            log_separator()
            log(f"📊 Poll #{poll_count} | Status: {loop_status} | Iter: {current_iter}/{MAX_ITERATIONS} | Active: {is_active}")

            if history:
                latest = history[-1]
                log(f"   Latest: iter={latest.get('iteration')} promise={latest.get('promise', 'none')} "
                    f"dur={latest.get('duration_s', '?')}s files={len(latest.get('files_modified', []))}")
                summary = latest.get("summary", "")
                if summary:
                    log(f"   Summary: {summary[:250]}")

            last_iteration = current_iter

        # Check sweeps
        sweeps_data = api_get("/sweeps", quiet=True)
        if sweeps_data and isinstance(sweeps_data, list):
            for s in sweeps_data:
                sid = s.get("id", "")
                if sid and sid not in sweeps_seen:
                    sweeps_seen.add(sid)
                    log(f"   🎯 NEW SWEEP: {sid} — {s.get('name', 'unnamed')}")

        # Check runs
        runs_data = api_get("/runs", quiet=True)
        if runs_data and isinstance(runs_data, list):
            for r in runs_data:
                rid = r.get("id", "")
                if rid and rid not in runs_seen:
                    runs_seen.add(rid)
                    log(f"   🏃 NEW RUN: {rid} — {r.get('name', 'unnamed')} | "
                        f"status={r.get('status')} | sweep={r.get('sweep_id', 'none')}")

        # Check iteration log via API
        if poll_count % 3 == 0:
            iter_log = api_get(f"/wild/v2/iteration-log/{session_id}", quiet=True)
            if iter_log and iter_log.get("log"):
                log_text = iter_log["log"]
                lines = [l for l in log_text.split("\n") if l.strip()]
                if lines:
                    log("   📜 Iteration Log (last 10 lines):")
                    for l in lines[-10:]:
                        print(f"      {l}", flush=True)

        # Check if loop is done
        if not is_active and loop_status in ("done", "failed", "cancelled"):
            log_separator()
            log(f"🏁 Loop finished! Status: {loop_status}")
            break

        # Check if processes died
        if server_proc.poll() is not None:
            log("❌ Server process died!")
            break
        if opencode_proc.poll() is not None:
            log("❌ OpenCode process died!")
            break

    # 5. Final summary
    log_separator()
    log("📊 FINAL SUMMARY")
    log_separator()

    final_status = api_get("/wild/v2/status", quiet=True) or status or {}
    final_sweeps = api_get("/sweeps", quiet=True) or []
    final_runs = api_get("/runs", quiet=True) or []

    log(f"Loop status: {final_status.get('status', 'unknown')}")
    log(f"Iterations completed: {final_status.get('iteration', 0)}")
    log(f"Sweeps created: {len(final_sweeps) if isinstance(final_sweeps, list) else 0}")
    log(f"Runs created: {len(final_runs) if isinstance(final_runs, list) else 0}")

    if isinstance(final_sweeps, list) and final_sweeps:
        log("\n📦 Sweeps:")
        for s in final_sweeps:
            log(f"   • {s.get('id', '??')} — {s.get('name', 'unnamed')} "
                f"(status={s.get('status')}, runs={len(s.get('run_ids', []))})")

    if isinstance(final_runs, list) and final_runs:
        log("\n🏃 Runs:")
        for r in final_runs:
            log(f"   • {r.get('id', '??')} — {r.get('name', 'unnamed')} "
                f"(status={r.get('status')}, sweep={r.get('sweep_id', 'none')}, "
                f"cmd={r.get('command', '')[:80]})")

    # Check the plan
    plan = api_get(f"/wild/v2/plan/{session_id}", quiet=True)
    if plan and plan.get("plan"):
        log(f"\n📋 Final Plan ({len(plan['plan'])} chars):")
        for line in plan["plan"].split("\n")[:30]:
            log(f"   {line}")

    # Check iteration log
    iter_log = api_get(f"/wild/v2/iteration-log/{session_id}", quiet=True)
    if iter_log and iter_log.get("log"):
        log(f"\n📜 Iteration Log ({len(iter_log['log'])} chars):")
        for line in iter_log["log"].split("\n")[:50]:
            log(f"   {line}")

    log_separator()
    if sweeps_seen:
        log("✅ PASS: Agent created sweeps via API!")
    else:
        log("❌ FAIL: No sweeps were created — agent may be running scripts directly")

    if runs_seen:
        log(f"✅ PASS: Agent created {len(runs_seen)} run(s) via API!")
    else:
        log("❌ FAIL: No runs were created via API")

    log_separator()
    log(f"📁 Full logs saved to: {LOG_DIR}")
    log(f"   • {LOG_DIR}/server.log — full server output")
    log(f"   • {LOG_DIR}/opencode.log — full opencode output")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        run_test()
    except KeyboardInterrupt:
        log("\n⚠️  Interrupted by user")
    except Exception as e:
        log(f"❌ Test error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        cleanup()
