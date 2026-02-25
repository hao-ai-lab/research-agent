"""Core orchestration for playbook-driven E2E chat tests."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .assertions import evaluate_assertion
from .client import ChatTestClient
from .playbook import load_playbook


def run_playbook_file(
    playbook_path: str | Path,
    *,
    server_url_override: str | None = None,
    auth_token: str = "",
) -> dict[str, Any]:
    playbook = load_playbook(playbook_path)
    server_cfg = playbook.get("server", {})
    defaults_cfg = playbook.get("defaults", {})
    session_cfg = playbook.get("session", {})

    base_url = (
        server_url_override
        or server_cfg.get("base_url")
        or "http://127.0.0.1:10000"
    )

    client = ChatTestClient(base_url=base_url, auth_token=auth_token)
    client.healthcheck()

    started_at = time.time()
    session_title = str(session_cfg.get("title") or f"playbook:{playbook['name']}")
    session_id = client.create_session(
        title=session_title,
        model_provider=session_cfg.get("model_provider"),
        model_id=session_cfg.get("model_id"),
    )

    system_prompt = session_cfg.get("system_prompt")
    if isinstance(system_prompt, str) and system_prompt.strip():
        client.set_system_prompt(session_id, system_prompt)

    max_stream_retries = int(defaults_cfg.get("max_stream_retries", 2))
    default_mode = str(defaults_cfg.get("mode", "agent"))

    assertion_results_by_id: dict[str, dict[str, Any]] = {}
    step_results: list[dict[str, Any]] = []
    total_assertions = 0
    passed_assertions = 0

    for step in playbook["steps"]:
        step_started = time.perf_counter()
        stream_result = client.send_turn(
            session_id=session_id,
            message=step["message"],
            mode=str(step.get("mode") or default_mode),
            prompt_override=step.get("prompt_override"),
            max_stream_retries=max_stream_retries,
        )
        step_elapsed_ms = (time.perf_counter() - step_started) * 1000.0

        step_result: dict[str, Any] = {
            "id": step["id"],
            "message": step["message"],
            "mode": str(step.get("mode") or default_mode),
            "assistant_text": stream_result.assistant_text,
            "events": stream_result.events,
            "tool_names": stream_result.tool_names,
            "first_token_latency_ms": stream_result.first_token_latency_ms,
            "total_latency_ms": stream_result.total_latency_ms,
            "step_elapsed_ms": step_elapsed_ms,
            "stream_reconnects": stream_result.stream_reconnects,
            "assertion_results": [],
        }

        for assertion in step["assertions"]:
            total_assertions += 1
            result = evaluate_assertion(assertion, step_result)
            result["step_id"] = step["id"]
            if result["passed"]:
                passed_assertions += 1
            assertion_results_by_id[assertion["id"]] = result
            step_result["assertion_results"].append(result)

        step_results.append(step_result)

    evaluation_scores = _score_evaluation_points(
        playbook=playbook,
        assertion_results_by_id=assertion_results_by_id,
    )

    total_score = sum(point["score"] for point in evaluation_scores)
    max_score = sum(point["max_score"] for point in evaluation_scores)
    overall_percent = 100.0 if max_score == 0 else (100.0 * total_score / max_score)
    points_passed = all(point["passed"] for point in evaluation_scores)

    finished_at = time.time()
    return {
        "playbook_name": playbook["name"],
        "playbook_path": str(Path(playbook_path).resolve()),
        "description": playbook.get("description", ""),
        "server_url": base_url,
        "session_id": session_id,
        "started_at": _iso8601(started_at),
        "finished_at": _iso8601(finished_at),
        "duration_s": round(finished_at - started_at, 3),
        "steps": step_results,
        "evaluation_points": evaluation_scores,
        "summary": {
            "passed_assertions": passed_assertions,
            "total_assertions": total_assertions,
            "assertion_pass_rate": 1.0 if total_assertions == 0 else passed_assertions / total_assertions,
            "overall_score": total_score,
            "overall_max_score": max_score,
            "overall_percent": overall_percent,
            "passed": passed_assertions == total_assertions and points_passed,
        },
    }


def run_playbook_suite(
    playbook_paths: list[str | Path],
    *,
    server_url_override: str | None = None,
    auth_token: str = "",
) -> dict[str, Any]:
    reports: list[dict[str, Any]] = []
    for path in playbook_paths:
        report = run_playbook_file(
            path,
            server_url_override=server_url_override,
            auth_token=auth_token,
        )
        reports.append(report)

    suite_max_score = sum(report["summary"]["overall_max_score"] for report in reports)
    suite_score = sum(report["summary"]["overall_score"] for report in reports)
    suite_percent = 100.0 if suite_max_score == 0 else (100.0 * suite_score / suite_max_score)

    return {
        "reports": reports,
        "summary": {
            "playbooks_total": len(reports),
            "playbooks_passed": sum(1 for report in reports if report["summary"]["passed"]),
            "overall_score": suite_score,
            "overall_max_score": suite_max_score,
            "overall_percent": suite_percent,
            "passed": all(report["summary"]["passed"] for report in reports),
        },
    }


def _score_evaluation_points(
    *,
    playbook: dict[str, Any],
    assertion_results_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for point in playbook.get("evaluation_points", []):
        assertion_ids = point.get("assertion_ids", [])
        results = [assertion_results_by_id[item] for item in assertion_ids if item in assertion_results_by_id]

        passed_checks = sum(1 for item in results if item["passed"])
        total_checks = len(results)
        ratio = 1.0 if total_checks == 0 else (passed_checks / total_checks)

        max_score = float(point.get("max_score", 10.0))
        pass_threshold = float(point.get("pass_threshold", 1.0))
        score = ratio * max_score

        points.append({
            "id": point["id"],
            "description": point.get("description", ""),
            "max_score": max_score,
            "score": score,
            "passed_checks": passed_checks,
            "total_checks": total_checks,
            "pass_threshold": pass_threshold,
            "ratio": ratio,
            "passed": ratio >= pass_threshold,
            "assertion_ids": assertion_ids,
            "failed_assertion_ids": [item["id"] for item in results if not item["passed"]],
        })

    if not points:
        points.append({
            "id": "default",
            "description": "Default score from all assertions",
            "max_score": 100.0,
            "score": 100.0,
            "passed_checks": len(assertion_results_by_id),
            "total_checks": len(assertion_results_by_id),
            "pass_threshold": 1.0,
            "ratio": 1.0,
            "passed": True,
            "assertion_ids": list(assertion_results_by_id.keys()),
            "failed_assertion_ids": [],
        })

    return points


def _iso8601(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
