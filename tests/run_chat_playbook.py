#!/usr/bin/env python3
"""CLI for running chat E2E playbook suites."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Running this file directly sets sys.path[0] to tests/, so local package import works.
from e2e_playbook.runner import run_playbook_suite


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run playbook-driven chat E2E tests")
    parser.add_argument(
        "--playbook",
        required=True,
        help="Playbook file or directory containing *.json playbooks",
    )
    parser.add_argument(
        "--server-url",
        default=None,
        help="Override server URL (default uses playbook.server.base_url or http://127.0.0.1:10000)",
    )
    parser.add_argument(
        "--auth-token",
        default=os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", ""),
        help="Auth token for server requests (default from RESEARCH_AGENT_USER_AUTH_TOKEN)",
    )
    parser.add_argument(
        "--output-dir",
        default="tests/e2e_reports",
        help="Directory to store JSON report output",
    )
    parser.add_argument(
        "--min-overall-score",
        type=float,
        default=100.0,
        help="Minimum suite score percent required for success",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    playbook_paths = _resolve_playbook_paths(args.playbook)
    if not playbook_paths:
        print("No playbook JSON files found.", file=sys.stderr)
        return 2

    suite_report = run_playbook_suite(
        playbook_paths,
        server_url_override=args.server_url,
        auth_token=args.auth_token,
    )

    _print_summary(suite_report)
    output_path = _write_report(suite_report, output_dir=args.output_dir)
    print(f"\nSaved report: {output_path}")

    min_score = float(args.min_overall_score)
    score = float(suite_report["summary"]["overall_percent"])
    suite_passed = bool(suite_report["summary"]["passed"])
    if not suite_passed or score < min_score:
        return 1
    return 0


def _resolve_playbook_paths(playbook_arg: str) -> list[Path]:
    path = Path(playbook_arg).expanduser().resolve()
    if path.is_file():
        return [path]
    if path.is_dir():
        return sorted(path.glob("*.json"))
    return []


def _write_report(report: dict, *, output_dir: str) -> Path:
    output_root = Path(output_dir).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_path = output_root / f"chat-playbook-report-{stamp}.json"
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    return output_path


def _print_summary(report: dict) -> None:
    summary = report["summary"]
    print("\n=== Playbook Suite Summary ===")
    print(
        f"Playbooks: {summary['playbooks_passed']}/{summary['playbooks_total']} passed | "
        f"Score: {summary['overall_percent']:.1f}%"
    )

    for item in report["reports"]:
        s = item["summary"]
        status = "PASS" if s["passed"] else "FAIL"
        print(
            f"- [{status}] {item['playbook_name']}: "
            f"{s['passed_assertions']}/{s['total_assertions']} assertions | "
            f"score={s['overall_percent']:.1f}%"
        )
        for point in item["evaluation_points"]:
            point_status = "PASS" if point["passed"] else "FAIL"
            print(
                f"    - [{point_status}] {point['id']}: "
                f"{point['passed_checks']}/{point['total_checks']} checks "
                f"(score={point['score']:.2f}/{point['max_score']:.2f})"
            )


if __name__ == "__main__":
    raise SystemExit(main())
