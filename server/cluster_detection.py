"""Cluster detection helpers extracted from server.py."""

import os
import shutil
import socket
import subprocess
import time
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLUSTER_TYPE_VALUES = {
    "unknown",
    "slurm",
    "local_gpu",
    "kubernetes",
    "ray",
    "shared_head_node",
}
CLUSTER_STATUS_VALUES = {"unknown", "healthy", "degraded", "offline"}
CLUSTER_SOURCE_VALUES = {"unset", "manual", "detected"}


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def _default_cluster_state() -> dict:
    now = time.time()
    return {
        "type": "unknown",
        "status": "unknown",
        "source": "unset",
        "label": "Unknown",
        "description": "Cluster has not been configured yet.",
        "head_node": None,
        "node_count": None,
        "gpu_count": None,
        "notes": None,
        "confidence": None,
        "details": {},
        "last_detected_at": None,
        "updated_at": now,
    }


def _cluster_type_label(cluster_type: str) -> str:
    mapping = {
        "unknown": "Unknown",
        "slurm": "Slurm",
        "local_gpu": "Local GPU",
        "kubernetes": "Kubernetes",
        "ray": "Ray",
        "shared_head_node": "Shared GPU Head Node",
    }
    return mapping.get(cluster_type, "Unknown")


def _cluster_type_description(cluster_type: str) -> str:
    mapping = {
        "unknown": "Cluster has not been configured yet.",
        "slurm": "Slurm-managed cluster scheduler detected.",
        "local_gpu": "Single-host GPU workstation/cluster detected.",
        "kubernetes": "Kubernetes cluster control plane detected.",
        "ray": "Ray cluster runtime detected.",
        "shared_head_node": "Head node with SSH fan-out to worker nodes.",
    }
    return mapping.get(cluster_type, "Cluster has not been configured yet.")


def _normalize_cluster_type(raw_type: Optional[str]) -> str:
    if not raw_type:
        return "unknown"
    value = raw_type.strip().lower().replace("-", "_")
    aliases = {
        "localgpu": "local_gpu",
        "local_gpu_cluster": "local_gpu",
        "shared_gpu_head_node": "shared_head_node",
        "shared_gpu": "shared_head_node",
        "head_node": "shared_head_node",
        "k8s": "kubernetes",
    }
    value = aliases.get(value, value)
    return value if value in CLUSTER_TYPE_VALUES else "unknown"


def _normalize_cluster_status(raw_status: Optional[str]) -> str:
    if not raw_status:
        return "unknown"
    value = raw_status.strip().lower()
    return value if value in CLUSTER_STATUS_VALUES else "unknown"


def _normalize_cluster_source(raw_source: Optional[str]) -> str:
    if not raw_source:
        return "unset"
    value = raw_source.strip().lower()
    return value if value in CLUSTER_SOURCE_VALUES else "unset"


def _normalize_cluster_state(raw_state: Any) -> dict:
    normalized = _default_cluster_state()
    if not isinstance(raw_state, dict):
        return normalized

    cluster_type = _normalize_cluster_type(raw_state.get("type"))
    normalized.update(
        {
            "type": cluster_type,
            "status": _normalize_cluster_status(raw_state.get("status")),
            "source": _normalize_cluster_source(raw_state.get("source")),
            "label": _cluster_type_label(cluster_type),
            "description": _cluster_type_description(cluster_type),
            "head_node": raw_state.get("head_node"),
            "node_count": raw_state.get("node_count"),
            "gpu_count": raw_state.get("gpu_count"),
            "notes": raw_state.get("notes"),
            "confidence": raw_state.get("confidence"),
            "details": raw_state.get("details") if isinstance(raw_state.get("details"), dict) else {},
            "last_detected_at": raw_state.get("last_detected_at"),
            "updated_at": raw_state.get("updated_at") or time.time(),
        }
    )
    return normalized


# ---------------------------------------------------------------------------
# Environment probing
# ---------------------------------------------------------------------------

def _run_command_capture(args: list[str], timeout: float = 2.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = (proc.stdout or proc.stderr or "").strip()
        return proc.returncode == 0, output
    except Exception:
        return False, ""


def _count_gpu_devices() -> Optional[int]:
    if not shutil.which("nvidia-smi"):
        return None
    ok, output = _run_command_capture(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=2.5)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_slurm_nodes() -> Optional[int]:
    if not shutil.which("sinfo"):
        return None
    ok, output = _run_command_capture(["sinfo", "-h", "-N"], timeout=2.0)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_kubernetes_nodes() -> Optional[int]:
    if not shutil.which("kubectl"):
        return None
    ok, output = _run_command_capture(["kubectl", "get", "nodes", "--no-headers"], timeout=2.5)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_ssh_hosts() -> int:
    ssh_config = os.path.expanduser("~/.ssh/config")
    if not os.path.exists(ssh_config):
        return 0
    try:
        count = 0
        with open(ssh_config, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line.lower().startswith("host "):
                    continue
                host_targets = [segment for segment in line[5:].split(" ") if segment]
                has_real_target = any(
                    target not in {"*", "?"} and "*" not in target and "?" not in target
                    for target in host_targets
                )
                if has_real_target:
                    count += 1
        return count
    except Exception:
        return 0


def _infer_cluster_from_environment() -> dict:
    now = time.time()
    type_hint = _normalize_cluster_type(os.environ.get("RESEARCH_AGENT_CLUSTER_TYPE"))
    gpu_count = _count_gpu_devices()
    slurm_nodes = _count_slurm_nodes()
    kube_nodes = _count_kubernetes_nodes()
    ssh_hosts = _count_ssh_hosts()

    has_slurm_env = any(key.startswith("SLURM_") for key in os.environ.keys())
    has_kube_env = bool(os.environ.get("KUBERNETES_SERVICE_HOST")) or os.path.exists(
        "/var/run/secrets/kubernetes.io/serviceaccount/token"
    )
    has_ray_env = bool(os.environ.get("RAY_ADDRESS"))
    has_ray_cli = bool(shutil.which("ray"))

    detected_type = "unknown"
    confidence = 0.35
    details: dict[str, Any] = {
        "signals": [],
        "slurm_nodes": slurm_nodes,
        "kubernetes_nodes": kube_nodes,
        "ssh_hosts": ssh_hosts,
    }

    if type_hint != "unknown":
        detected_type = type_hint
        confidence = 0.98
        details["signals"].append("RESEARCH_AGENT_CLUSTER_TYPE")
    elif has_kube_env or (kube_nodes or 0) > 0:
        detected_type = "kubernetes"
        confidence = 0.93 if has_kube_env else 0.82
        details["signals"].append("kubernetes")
    elif has_slurm_env or (slurm_nodes or 0) > 0:
        detected_type = "slurm"
        confidence = 0.9 if has_slurm_env else 0.8
        details["signals"].append("slurm")
    elif has_ray_env or has_ray_cli:
        detected_type = "ray"
        confidence = 0.85 if has_ray_env else 0.65
        details["signals"].append("ray")
    elif ssh_hosts >= 3:
        detected_type = "shared_head_node"
        confidence = 0.64
        details["signals"].append("ssh-host-fanout")
    elif gpu_count is not None and gpu_count > 0:
        detected_type = "local_gpu"
        confidence = 0.78 if gpu_count > 1 else 0.68
        details["signals"].append("nvidia-smi")

    if detected_type == "slurm":
        node_count = slurm_nodes
    elif detected_type == "kubernetes":
        node_count = kube_nodes
    elif detected_type == "shared_head_node":
        node_count = ssh_hosts if ssh_hosts > 0 else None
    elif detected_type == "local_gpu":
        node_count = 1
    else:
        node_count = None

    host = socket.gethostname() if detected_type in {"local_gpu", "shared_head_node"} else None
    status = "healthy" if detected_type != "unknown" else "unknown"

    return {
        "type": detected_type,
        "status": status,
        "source": "detected",
        "label": _cluster_type_label(detected_type),
        "description": _cluster_type_description(detected_type),
        "head_node": host,
        "node_count": node_count,
        "gpu_count": gpu_count,
        "notes": None,
        "confidence": round(confidence, 2),
        "details": details,
        "last_detected_at": now,
        "updated_at": now,
    }
