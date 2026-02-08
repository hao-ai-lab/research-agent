#!/usr/bin/env python3
"""Generic python script skill runner for toy stories."""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Toy script skill runner")
    parser.add_argument("--status", default="success")
    parser.add_argument("--summary", default="")
    parser.add_argument("--model")
    parser.add_argument("--variant")
    parser.add_argument("--clip-coef", type=float, dest="clip_coef")
    parser.add_argument("--batch-size", type=int, dest="batch_size")
    parser.add_argument("--mini-batch-size", type=int, dest="mini_batch_size")
    parser.add_argument("--reward", type=float)
    parser.add_argument("--score", type=float)
    parser.add_argument("--cost", type=float)
    parser.add_argument("--latency", type=float)
    parser.add_argument("--video-quality", type=float, dest="video_quality")
    parser.add_argument("--fid", type=float)
    parser.add_argument("--human-check-required", dest="human_check_required")
    parser.add_argument("--alert-severity", dest="alert_severity")
    parser.add_argument("--alert-message", dest="alert_message")
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    payload: Dict[str, Any] = {
        key: value
        for key, value in vars(args).items()
        if value is not None and value != ""
    }
    human_check_required = payload.get("human_check_required")
    if isinstance(human_check_required, str):
        payload["human_check_required"] = human_check_required.lower() == "true"

    if payload.get("alert_severity"):
        payload["alert"] = {
            "severity": payload.pop("alert_severity"),
            "message": payload.pop("alert_message", "Script skill emitted alert"),
            "choices": ["continue_training", "raise_to_human"],
        }

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
