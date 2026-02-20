#!/usr/bin/env python3
"""GPU availability detector for sidecar GPU scheduling.

Uses NVML (pynvml) when available and falls back to nvidia-smi parsing.
Returns *all* currently available GPUs based on whether processes are running.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from typing import Any


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


def _collect_from_nvml() -> tuple[list[dict[str, Any]], str | None]:
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


def _collect_from_nvidia_smi() -> tuple[list[dict[str, Any]], str | None]:
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


def build_payload(
    gpus: list[dict[str, Any]],
    source: str,
) -> dict[str, Any]:
    available: list[dict[str, Any]] = []
    occupied: list[dict[str, Any]] = []
    for gpu in gpus:
        if int(gpu.get("process_count", 0)) == 0:
            available.append(gpu)
        else:
            occupied.append(gpu)
    available.sort(key=lambda row: int(row.get("index", 0)))
    occupied.sort(key=lambda row: int(row.get("index", 0)))
    selected_indices = [int(g["index"]) for g in available]
    occupied_indices = [int(g["index"]) for g in occupied]
    cuda_visible_devices = ",".join(str(i) for i in selected_indices)
    return {
        "source": source,
        "selection_reason": "no_running_processes",
        "total_gpu_count": len(gpus),
        "selected_gpu_indices": selected_indices,
        "selected_gpu_details": available,
        "occupied_gpu_indices": occupied_indices,
        "occupied_gpu_details": occupied,
        "cuda_visible_devices": cuda_visible_devices,
        "all_gpu_details": gpus,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect currently available GPUs for shared hosts")
    parser.parse_args()

    gpus, nvml_error = _collect_from_nvml()
    source = "pynvml"
    errors: list[str] = []
    if nvml_error:
        errors.append(nvml_error)
    if not gpus:
        gpus, smi_error = _collect_from_nvidia_smi()
        source = "nvidia-smi"
        if smi_error:
            errors.append(smi_error)

    payload = build_payload(
        gpus=gpus,
        source=source if gpus else "none",
    )
    if errors:
        payload["errors"] = errors

    print(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
