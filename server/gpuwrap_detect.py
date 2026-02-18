#!/usr/bin/env python3
"""GPU availability detector for gpuwrap.

Uses NVML (pynvml) when available and falls back to nvidia-smi parsing.
Outputs a JSON payload that includes a recommended CUDA_VISIBLE_DEVICES.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from typing import Any


def _parse_excluded(raw: str) -> set[int]:
    excluded: set[int] = set()
    if not raw:
        return excluded
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            excluded.add(int(token))
        except ValueError:
            continue
    return excluded


def _to_mb(value: int) -> int:
    return int(round(float(value) / (1024.0 * 1024.0)))


def _nvml_process_count(pynvml_mod, handle) -> int:
    count = 0
    fns = (
        "nvmlDeviceGetComputeRunningProcesses_v3",
        "nvmlDeviceGetComputeRunningProcesses_v2",
        "nvmlDeviceGetComputeRunningProcesses",
    )
    for fn_name in fns:
        fn = getattr(pynvml_mod, fn_name, None)
        if not fn:
            continue
        try:
            count += len(fn(handle))
            break
        except Exception:
            continue

    graphics_fn = getattr(pynvml_mod, "nvmlDeviceGetGraphicsRunningProcesses", None)
    if graphics_fn:
        try:
            count += len(graphics_fn(handle))
        except Exception:
            pass
    return count


def _collect_from_nvml(excluded: set[int]) -> tuple[list[dict[str, Any]], str | None]:
    try:
        import pynvml  # type: ignore
    except ImportError:
        return [], "pynvml_not_installed"

    try:
        pynvml.nvmlInit()
    except Exception as exc:
        return [], f"nvml_init_failed:{exc}"

    rows: list[dict[str, Any]] = []
    try:
        count = pynvml.nvmlDeviceGetCount()
        for index in range(count):
            if index in excluded:
                continue
            try:
                handle = pynvml.nvmlDeviceGetHandleByIndex(index)
                memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
                util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                name = pynvml.nvmlDeviceGetName(handle)
                uuid = pynvml.nvmlDeviceGetUUID(handle)
                rows.append(
                    {
                        "index": index,
                        "name": name.decode() if isinstance(name, (bytes, bytearray)) else str(name),
                        "uuid": uuid.decode() if isinstance(uuid, (bytes, bytearray)) else str(uuid),
                        "memory_used_mb": _to_mb(memory.used),
                        "memory_total_mb": _to_mb(memory.total),
                        "utilization_gpu": int(getattr(util, "gpu", 0)),
                        "process_count": _nvml_process_count(pynvml, handle),
                    }
                )
            except Exception:
                continue
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass

    return rows, None


def _run_capture(cmd: list[str]) -> tuple[bool, str]:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except Exception:
        return False, ""
    if res.returncode != 0:
        return False, res.stderr or ""
    return True, res.stdout or ""


def _collect_from_nvidia_smi(excluded: set[int]) -> tuple[list[dict[str, Any]], str | None]:
    if not shutil_which("nvidia-smi"):
        return [], "nvidia_smi_not_found"

    ok, raw = _run_capture(
        [
            "nvidia-smi",
            "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ]
    )
    if not ok:
        return [], "nvidia_smi_query_failed"

    process_counts: dict[str, int] = {}
    ok_proc, proc_raw = _run_capture(
        [
            "nvidia-smi",
            "--query-compute-apps=gpu_uuid,pid",
            "--format=csv,noheader,nounits",
        ]
    )
    if ok_proc:
        for line in proc_raw.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            gpu_uuid = parts[0]
            process_counts[gpu_uuid] = process_counts.get(gpu_uuid, 0) + 1

    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            continue
        try:
            index = int(parts[0])
            util = int(float(parts[3]))
            mem_used = int(float(parts[4]))
            mem_total = int(float(parts[5]))
        except ValueError:
            continue
        if index in excluded:
            continue
        gpu_uuid = parts[1]
        rows.append(
            {
                "index": index,
                "uuid": gpu_uuid,
                "name": parts[2],
                "utilization_gpu": util,
                "memory_used_mb": mem_used,
                "memory_total_mb": mem_total,
                "process_count": process_counts.get(gpu_uuid, 0),
            }
        )
    return rows, None


def shutil_which(binary: str) -> str | None:
    paths = os.environ.get("PATH", "").split(os.pathsep)
    for path in paths:
        candidate = os.path.join(path, binary)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _score_gpu(gpu: dict[str, Any]) -> float:
    process_penalty = float(gpu.get("process_count", 0)) * 1_000_000.0
    memory_penalty = float(gpu.get("memory_used_mb", 0)) * 100.0
    util_penalty = float(gpu.get("utilization_gpu", 0)) * 10.0
    return process_penalty + memory_penalty + util_penalty


def _select_gpus(
    gpus: list[dict[str, Any]],
    gpus_needed: int,
    max_memory_used_mb: int,
    max_utilization: int,
) -> tuple[list[dict[str, Any]], str]:
    if not gpus:
        return [], "no_gpu_detected"

    strict = [
        gpu for gpu in gpus
        if int(gpu.get("process_count", 0)) == 0
        and int(gpu.get("memory_used_mb", 0)) <= max_memory_used_mb
        and int(gpu.get("utilization_gpu", 0)) <= max_utilization
    ]
    if len(strict) >= gpus_needed:
        return sorted(strict, key=_score_gpu)[:gpus_needed], "strict_idle"

    sorted_gpus = sorted(gpus, key=_score_gpu)
    return sorted_gpus[: min(gpus_needed, len(sorted_gpus))], "least_loaded"


def build_payload(
    gpus: list[dict[str, Any]],
    source: str,
    gpus_needed: int,
    max_memory_used_mb: int,
    max_utilization: int,
) -> dict[str, Any]:
    selected, reason = _select_gpus(
        gpus=gpus,
        gpus_needed=gpus_needed,
        max_memory_used_mb=max_memory_used_mb,
        max_utilization=max_utilization,
    )
    selected_indices = [int(g["index"]) for g in selected]
    cuda_visible_devices = ",".join(str(i) for i in selected_indices)
    return {
        "source": source,
        "selection_reason": reason,
        "gpus_needed": gpus_needed,
        "total_gpu_count": len(gpus),
        "selected_gpu_indices": selected_indices,
        "selected_gpu_details": selected,
        "cuda_visible_devices": cuda_visible_devices,
        "all_gpu_details": gpus,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Recommend CUDA_VISIBLE_DEVICES for shared GPU hosts")
    parser.add_argument("--gpus-needed", type=int, default=1)
    parser.add_argument("--max-memory-used-mb", type=int, default=1500)
    parser.add_argument("--max-utilization", type=int, default=40)
    parser.add_argument("--exclude-indices", default="")
    args = parser.parse_args()

    gpus_needed = max(1, int(args.gpus_needed))
    excluded = _parse_excluded(args.exclude_indices)

    gpus, nvml_error = _collect_from_nvml(excluded)
    source = "pynvml"
    errors: list[str] = []
    if nvml_error:
        errors.append(nvml_error)
    if not gpus:
        gpus, smi_error = _collect_from_nvidia_smi(excluded)
        source = "nvidia-smi"
        if smi_error:
            errors.append(smi_error)

    payload = build_payload(
        gpus=gpus,
        source=source if gpus else "none",
        gpus_needed=gpus_needed,
        max_memory_used_mb=max(0, int(args.max_memory_used_mb)),
        max_utilization=max(0, int(args.max_utilization)),
    )
    if errors:
        payload["errors"] = errors

    print(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
