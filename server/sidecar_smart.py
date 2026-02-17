"""Skill-driven smart monitoring for job sidecar.

This module intentionally keeps only a generic agent loop + session contract,
and delegates smart analysis behavior to retrieved skills/prompts.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from typing import Any

DEFAULT_SMART_SKILL_IDS = [
    "sidecar_smart_monitoring",
    "sidecar_smart_visualization_jit",
]


def _safe_filename(raw: str, fallback: str) -> str:
    candidate = (raw or "").strip()
    if not candidate:
        return fallback
    candidate = candidate.replace("\\", "/")
    candidate = candidate.split("/")[-1]
    candidate = re.sub(r"[^a-zA-Z0-9._-]+", "-", candidate)
    candidate = candidate.strip(".-")
    return candidate or fallback


def _truncate_text(value: str, max_chars: int = 1200) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3] + "..."


def _extract_json_object(text: str) -> dict | None:
    if not text:
        return None
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def _normalize_severity(value: str | None) -> str:
    normalized = (value or "warning").strip().lower()
    if normalized not in {"info", "warning", "critical"}:
        return "warning"
    return normalized


def parse_smart_agent_decision(raw_output: str) -> dict:
    payload = _extract_json_object(raw_output)
    if not payload:
        return {"action": "ignore", "monitor_note": "smart-agent: no parsable JSON output"}

    action = str(payload.get("action") or "ignore").strip().lower()
    if action not in {"alert", "ignore"}:
        action = "ignore"

    message = str(payload.get("message") or "").strip()
    if action == "alert" and not message:
        message = "Smart monitor detected an anomaly."

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        choices = ["Ignore", "Stop Job"]
    else:
        choices = [str(choice)[:80] for choice in choices[:6] if str(choice).strip()]
        if not choices:
            choices = ["Ignore", "Stop Job"]

    monitor_note = str(payload.get("monitor_note") or payload.get("analysis_summary") or "").strip()
    monitor_note = _truncate_text(monitor_note, max_chars=220)

    source = str(payload.get("source") or "smart_agent").strip() or "smart_agent"
    syndrome = str(payload.get("syndrome") or "smart_agent_assessment").strip() or "smart_agent_assessment"

    jit_tasks: list[dict[str, Any]] = []
    tasks = payload.get("jit_tasks")
    if isinstance(tasks, list):
        for idx, task in enumerate(tasks[:8]):
            if not isinstance(task, dict):
                continue
            task_type = str(task.get("task_type") or "").strip().lower()
            if task_type not in {"vega_lite_spec", "markdown_note"}:
                continue
            title = str(task.get("title") or f"task-{idx + 1}").strip() or f"task-{idx + 1}"
            file_name = _safe_filename(str(task.get("file_name") or ""), f"jit-task-{idx + 1}.json")
            jit_tasks.append(
                {
                    "task_type": task_type,
                    "title": _truncate_text(title, max_chars=120),
                    "file_name": file_name,
                    "spec": task.get("spec"),
                    "content": str(task.get("content") or ""),
                    "goal": _truncate_text(str(task.get("goal") or ""), max_chars=300),
                }
            )

    evidence = payload.get("evidence")
    if not isinstance(evidence, dict):
        evidence = {}

    return {
        "action": action,
        "severity": _normalize_severity(str(payload.get("severity") or "warning")),
        "message": _truncate_text(message, max_chars=600),
        "choices": choices,
        "source": source,
        "syndrome": syndrome,
        "monitor_note": monitor_note,
        "monitor_tags": payload.get("monitor_tags") if isinstance(payload.get("monitor_tags"), list) else [],
        "analysis_summary": _truncate_text(str(payload.get("analysis_summary") or ""), max_chars=1200),
        "jit_tasks": jit_tasks,
        "evidence": evidence,
    }


def materialize_jit_tasks(run_dir: str, jit_tasks: list[dict]) -> list[dict]:
    if not jit_tasks:
        return []
    analysis_dir = os.path.join(run_dir, "analysis")
    os.makedirs(analysis_dir, exist_ok=True)

    artifacts: list[dict] = []
    for idx, task in enumerate(jit_tasks):
        task_type = str(task.get("task_type") or "")
        file_name = _safe_filename(str(task.get("file_name") or ""), f"jit-task-{idx + 1}.json")
        target_path = os.path.join(analysis_dir, file_name)

        if task_type == "vega_lite_spec":
            spec_payload = task.get("spec")
            if isinstance(spec_payload, str):
                try:
                    spec_payload = json.loads(spec_payload)
                except json.JSONDecodeError:
                    spec_payload = None
            if not isinstance(spec_payload, dict):
                continue
            if "$schema" not in spec_payload:
                spec_payload["$schema"] = "https://vega.github.io/schema/vega-lite/v5.json"
            with open(target_path, "w", encoding="utf-8") as f:
                json.dump(spec_payload, f, ensure_ascii=False, indent=2)
            artifacts.append(
                {
                    "task_type": task_type,
                    "title": task.get("title") or file_name,
                    "path": target_path,
                    "relative_path": os.path.relpath(target_path, run_dir),
                }
            )
            continue

        if task_type == "markdown_note":
            content = str(task.get("content") or "").strip()
            if not content:
                continue
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(content + "\n")
            artifacts.append(
                {
                    "task_type": task_type,
                    "title": task.get("title") or file_name,
                    "path": target_path,
                    "relative_path": os.path.relpath(target_path, run_dir),
                }
            )
    return artifacts


def load_sidecar_skills(
    skill_ids: list[str] | None = None,
    skill_root: str | None = None,
) -> dict[str, str]:
    skill_ids = skill_ids or DEFAULT_SMART_SKILL_IDS
    if skill_root is None:
        skill_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompt_skills")

    loaded: dict[str, str] = {}
    for skill_id in skill_ids:
        path = os.path.join(skill_root, skill_id, "SKILL.md")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded[skill_id] = f.read()
        except OSError:
            continue
    return loaded


def render_skill_bundle(skills: dict[str, str]) -> str:
    if not skills:
        return ""
    chunks: list[str] = []
    for skill_id, content in skills.items():
        chunks.append(f"## Skill: {skill_id}\n{content.strip()}\n")
    return "\n".join(chunks).strip()


def should_run_smart_analysis(
    job_id: str,
    metrics_file: str | None,
    log_file: str,
    state: dict,
    min_interval_seconds: int,
) -> bool:
    now = time.time()
    last_check_by_job = state.setdefault("smart_last_check", {})
    previous_check = float(last_check_by_job.get(job_id, 0.0))
    if now - previous_check < min_interval_seconds:
        return False

    changed = False
    metrics_sizes = state.setdefault("smart_metrics_sizes", {})
    log_sizes = state.setdefault("smart_log_sizes", {})

    if metrics_file and os.path.isfile(metrics_file):
        metrics_size = os.path.getsize(metrics_file)
        if metrics_size != int(metrics_sizes.get(job_id, -1)):
            changed = True
        metrics_sizes[job_id] = metrics_size

    if os.path.isfile(log_file):
        log_size = os.path.getsize(log_file)
        if log_size != int(log_sizes.get(job_id, -1)):
            changed = True
        log_sizes[job_id] = log_size

    if changed:
        last_check_by_job[job_id] = now
    return changed


def run_smart_sidecar_session(
    *,
    job_id: str,
    command: str,
    run_dir: str,
    workdir: str,
    metrics_rows: list[dict],
    recent_logs: list[str],
    skill_bundle: str,
    model: str = "opencode/kimi-k2.5-free",
) -> dict:
    """Run a smart sidecar agent step based on skills + current context."""
    context_blob = {
        "job_id": job_id,
        "command": command,
        "run_dir": run_dir,
        "metrics_rows": metrics_rows[-120:],
        "recent_logs": recent_logs[-120:],
        "available_analysis_dir": os.path.join(run_dir, "analysis"),
    }

    prompt = (
        "[SYSTEM] You are the smart analysis engine for a training sidecar. "
        "Do not invent mechanical actions. Focus on analysis and optional JIT artifacts. "
        "Follow the provided skills exactly.\n\n"
        "Return ONLY JSON with keys:\n"
        "- action: 'alert' | 'ignore'\n"
        "- severity: info|warning|critical\n"
        "- message: string\n"
        "- choices: array<string>\n"
        "- source: string\n"
        "- syndrome: string\n"
        "- analysis_summary: string\n"
        "- monitor_note: short string\n"
        "- monitor_tags: array<string>\n"
        "- evidence: object\n"
        "- jit_tasks: array of objects with task_type in {'vega_lite_spec','markdown_note'}\n"
        "For vega_lite_spec tasks include: title, file_name, goal, spec(object).\n"
        "For markdown_note tasks include: title, file_name, goal, content(string).\n"
        "If no alert is needed, set action='ignore' and keep message short.\n\n"
        f"[SKILLS]\n{skill_bundle or '(no skills loaded)'}\n\n"
        f"[CONTEXT]\n{json.dumps(context_blob, ensure_ascii=True)}"
    )

    cmd = ["opencode", "run", "--model", model, prompt]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=45,
            cwd=workdir or None,
        )
    except FileNotFoundError:
        return {"action": "ignore", "monitor_note": "smart-agent unavailable: opencode not found"}
    except Exception as e:
        return {"action": "ignore", "monitor_note": f"smart-agent failed: {e}"}

    stdout = (res.stdout or "").strip()
    return parse_smart_agent_decision(stdout)
