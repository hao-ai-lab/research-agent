#!/usr/bin/env python3
"""Shared-GPU execution wrapper with conflict retries.

This process:
1. Calls gpuwrap_detect.py to recommend CUDA_VISIBLE_DEVICES.
2. Applies CUDA_VISIBLE_DEVICES per-command (no global export).
3. Detects likely GPU contention failures, emits alerts, and retries.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


GPU_CONFLICT_PATTERNS = (
    re.compile(r"all CUDA-capable devices are busy or unavailable", re.IGNORECASE),
    re.compile(r"CUDA error:.*busy", re.IGNORECASE),
    re.compile(r"device or resource busy", re.IGNORECASE),
    re.compile(r"CUDA out of memory", re.IGNORECASE),
    re.compile(r"CUBLAS_STATUS_ALLOC_FAILED", re.IGNORECASE),
    re.compile(r"failed to allocate memory on device", re.IGNORECASE),
)


def _as_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _as_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _is_truthy(raw: str | None) -> bool:
    if not raw:
        return False
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return default


def _write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=True, indent=2))
    tmp.replace(path)


@contextlib.contextmanager
def _file_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _cleanup_leases(leases: list[dict[str, Any]], now_ts: float) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for lease in leases:
        expires_at = float(lease.get("expires_at", 0))
        pid = int(lease.get("pid", 0))
        if expires_at <= now_ts:
            continue
        if pid and not _pid_alive(pid):
            continue
        cleaned.append(lease)
    return cleaned


def _active_reserved_indices(leases: list[dict[str, Any]]) -> set[int]:
    indices: set[int] = set()
    for lease in leases:
        for index in lease.get("gpu_indices", []):
            try:
                indices.add(int(index))
            except Exception:
                continue
    return indices


def _call_detector(
    detector_path: Path,
    gpus_needed: int,
    max_memory_used_mb: int,
    max_utilization: int,
    exclude_indices: set[int],
) -> dict[str, Any]:
    cmd = [
        sys.executable,
        str(detector_path),
        "--gpus-needed",
        str(gpus_needed),
        "--max-memory-used-mb",
        str(max_memory_used_mb),
        "--max-utilization",
        str(max_utilization),
        "--exclude-indices",
        ",".join(str(i) for i in sorted(exclude_indices)),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if res.returncode != 0:
        raise RuntimeError(f"gpu detector failed: {res.stderr.strip() or res.stdout.strip()}")
    payload = json.loads((res.stdout or "{}").strip() or "{}")
    if not isinstance(payload, dict):
        raise RuntimeError("gpu detector returned non-object payload")
    return payload


def _reserve_selection(
    reservation_file: Path,
    lock_file: Path,
    detector_path: Path,
    gpus_needed: int,
    max_memory_used_mb: int,
    max_utilization: int,
    lease_ttl_seconds: int,
    run_id: str,
) -> tuple[dict[str, Any], str | None]:
    now_ts = time.time()
    lease_id: str | None = None

    with _file_lock(lock_file):
        state = _load_json(reservation_file, default={"leases": []})
        leases = _cleanup_leases(list(state.get("leases", [])), now_ts)
        excluded = _active_reserved_indices(leases)

        payload = _call_detector(
            detector_path=detector_path,
            gpus_needed=gpus_needed,
            max_memory_used_mb=max_memory_used_mb,
            max_utilization=max_utilization,
            exclude_indices=excluded,
        )
        selected = [int(i) for i in payload.get("selected_gpu_indices", [])]
        if not selected and excluded:
            payload = _call_detector(
                detector_path=detector_path,
                gpus_needed=gpus_needed,
                max_memory_used_mb=max_memory_used_mb,
                max_utilization=max_utilization,
                exclude_indices=set(),
            )
            payload["selection_reason"] = f'{payload.get("selection_reason", "unknown")}+ignored_reservations'
            selected = [int(i) for i in payload.get("selected_gpu_indices", [])]

        if selected:
            lease_id = uuid.uuid4().hex
            leases.append(
                {
                    "id": lease_id,
                    "run_id": run_id,
                    "pid": os.getpid(),
                    "gpu_indices": selected,
                    "created_at": now_ts,
                    "expires_at": now_ts + max(10, lease_ttl_seconds),
                }
            )

        state["leases"] = leases
        _write_json(reservation_file, state)
        return payload, lease_id


def _release_lease(reservation_file: Path, lock_file: Path, lease_id: str | None) -> None:
    if not lease_id:
        return
    now_ts = time.time()
    with _file_lock(lock_file):
        state = _load_json(reservation_file, default={"leases": []})
        leases = _cleanup_leases(list(state.get("leases", [])), now_ts)
        leases = [lease for lease in leases if lease.get("id") != lease_id]
        state["leases"] = leases
        _write_json(reservation_file, state)


def _stream_command(command: str, cuda_visible_devices: str | None) -> tuple[int, str]:
    env = os.environ.copy()
    if cuda_visible_devices:
        env["CUDA_VISIBLE_DEVICES"] = cuda_visible_devices
    else:
        env.pop("CUDA_VISIBLE_DEVICES", None)

    proc = subprocess.Popen(
        ["/bin/bash", "-lc", command],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
    )
    tail = deque(maxlen=400)
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        tail.append(line)
    rc = proc.wait()
    return rc, "".join(tail)


def _selected_was_occupied(selection: dict[str, Any]) -> bool:
    details = selection.get("selected_gpu_details", [])
    if not isinstance(details, list):
        return False
    for row in details:
        if not isinstance(row, dict):
            continue
        try:
            if int(row.get("process_count", 0)) > 0:
                return True
        except Exception:
            continue
    return False


def _looks_like_gpu_conflict(log_tail: str, selection: dict[str, Any]) -> bool:
    if not log_tail:
        return False
    selected = selection.get("selected_gpu_indices", [])
    if not selected:
        return False

    busy_pattern_hit = False
    for pattern in GPU_CONFLICT_PATTERNS:
        if pattern.search(log_tail):
            busy_pattern_hit = True
            break
    if not busy_pattern_hit:
        return False

    if re.search(r"busy or unavailable|resource busy", log_tail, re.IGNORECASE):
        return True

    reason = str(selection.get("selection_reason", ""))
    if "least_loaded" in reason or "ignored_reservations" in reason:
        return True
    return _selected_was_occupied(selection)


def _emit_alert(server_url: str, job_id: str, auth_token: str | None, message: str) -> None:
    if not server_url or not job_id:
        return
    headers = {"Content-Type": "application/json"}
    if auth_token:
        headers["X-Auth-Token"] = auth_token

    payload = {
        "message": message,
        "choices": ["Acknowledge"],
        "severity": "warning",
    }
    try:
        req = urllib_request.Request(
            f"{server_url}/runs/{job_id}/alerts",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib_request.urlopen(req, timeout=5):
            pass
    except (urllib_error.URLError, urllib_error.HTTPError, TimeoutError, OSError):
        pass


def _parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="GPU wrapper runner")
    parser.add_argument("--command", required=True, help="Command to execute")
    parser.add_argument("--job-id", default="", help="Run/job ID")
    parser.add_argument("--server-url", default="", help="Server base URL for alerts")
    parser.add_argument("--auth-token", default="", help="Optional auth token for alerts")
    parser.add_argument("--detector-path", default=str(script_dir / "gpuwrap_detect.py"))
    parser.add_argument("--reservation-dir", default=os.environ.get("RESEARCH_AGENT_GPUWRAP_STATE_DIR", "/tmp/research-agent-gpuwrap"))
    parser.add_argument("--retries", type=int, default=_as_int_env("RESEARCH_AGENT_GPUWRAP_RETRIES", 2))
    parser.add_argument("--retry-delay-seconds", type=float, default=_as_float_env("RESEARCH_AGENT_GPUWRAP_RETRY_DELAY_SECONDS", 8.0))
    parser.add_argument("--gpus-needed", type=int, default=_as_int_env("RESEARCH_AGENT_GPUWRAP_GPUS_NEEDED", 1))
    parser.add_argument("--max-memory-used-mb", type=int, default=_as_int_env("RESEARCH_AGENT_GPUWRAP_MAX_MEMORY_USED_MB", 1500))
    parser.add_argument("--max-utilization", type=int, default=_as_int_env("RESEARCH_AGENT_GPUWRAP_MAX_UTILIZATION", 40))
    parser.add_argument("--lease-ttl-seconds", type=int, default=_as_int_env("RESEARCH_AGENT_GPUWRAP_LEASE_TTL_SECONDS", 180))
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    run_id = args.job_id or f"pid-{os.getpid()}"

    detector_path = Path(args.detector_path).resolve()
    if not detector_path.exists():
        print(f"[gpuwrap] detector missing: {detector_path}", file=sys.stderr)
        return _stream_command(args.command, cuda_visible_devices=None)[0]

    reservation_dir = Path(args.reservation_dir).resolve()
    reservation_dir.mkdir(parents=True, exist_ok=True)
    reservation_file = reservation_dir / "leases.json"
    lock_file = reservation_dir / ".leases.lock"

    retries = max(0, int(args.retries))
    total_attempts = retries + 1
    retry_delay = max(0.1, float(args.retry_delay_seconds))
    gpus_needed = max(1, int(args.gpus_needed))
    max_memory = max(0, int(args.max_memory_used_mb))
    max_util = max(0, int(args.max_utilization))
    lease_ttl = max(30, int(args.lease_ttl_seconds))
    verbose = _is_truthy(os.environ.get("RESEARCH_AGENT_GPUWRAP_VERBOSE", "1"))

    for attempt in range(1, total_attempts + 1):
        selection: dict[str, Any] = {}
        lease_id: str | None = None
        try:
            selection, lease_id = _reserve_selection(
                reservation_file=reservation_file,
                lock_file=lock_file,
                detector_path=detector_path,
                gpus_needed=gpus_needed,
                max_memory_used_mb=max_memory,
                max_utilization=max_util,
                lease_ttl_seconds=lease_ttl,
                run_id=run_id,
            )
        except Exception as exc:
            print(f"[gpuwrap] detector error: {exc}", file=sys.stderr)
            selection = {}
            lease_id = None

        cuda_visible = str(selection.get("cuda_visible_devices", "")).strip()
        if verbose:
            reason = selection.get("selection_reason", "none")
            print(
                f"[gpuwrap] attempt {attempt}/{total_attempts} "
                f"CUDA_VISIBLE_DEVICES={cuda_visible or '<unset>'} reason={reason}",
                flush=True,
            )

        rc = 0
        log_tail = ""
        try:
            rc, log_tail = _stream_command(args.command, cuda_visible_devices=cuda_visible or None)
        finally:
            _release_lease(reservation_file=reservation_file, lock_file=lock_file, lease_id=lease_id)

        if rc == 0:
            return 0

        retryable = _looks_like_gpu_conflict(log_tail=log_tail, selection=selection)
        if not retryable or attempt >= total_attempts:
            return rc

        msg = (
            f"GPU contention detected for run {run_id} on attempt {attempt}/{total_attempts}. "
            f"Assigned GPUs: {cuda_visible or 'none'}. Auto-retrying after {retry_delay:.1f}s."
        )
        print(f"[gpuwrap] {msg}", file=sys.stderr, flush=True)
        _emit_alert(
            server_url=args.server_url,
            job_id=args.job_id,
            auth_token=args.auth_token or None,
            message=msg,
        )
        time.sleep(retry_delay)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
