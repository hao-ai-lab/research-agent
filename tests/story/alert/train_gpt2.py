#!/usr/bin/env python3
"""
Lightweight GPT-2 training simulator for story demos.

This script emits a realistic-looking metrics stream (including one loss spike)
so the alert pipeline can be demonstrated without heavy ML dependencies.
"""

import argparse
import json
import os
import time
from datetime import UTC, datetime, timezone

DEFAULT_INTERACTIVE_HOLD_SECONDS = 5


def append_metric(metrics_path: str, payload: dict) -> None:
    with open(metrics_path, "a") as f:
        f.write(json.dumps(payload) + "\n")
        f.flush()
        os.fsync(f.fileno())


def synthetic_loss(step: int, profile: str) -> float:
    baseline = max(1.05, 2.25 - (0.07 * step))
    if profile == "spiky":
        if step == 4:
            return 9.7
        if step == 5:
            return 9.5
    return baseline


def main() -> None:
    parser = argparse.ArgumentParser(description="GPT-2 training simulator")
    parser.add_argument("--model", default="gpt2", help="Model name")
    parser.add_argument("--lr", type=float, default=3e-4, help="Learning rate")
    parser.add_argument("--batch-size", type=int, default=16, help="Batch size")
    parser.add_argument("--steps", type=int, default=10000, help="Total training steps")
    parser.add_argument("--sleep-seconds", type=float, default=1.5, help="Seconds between metric writes")
    parser.add_argument(
        "--profile",
        choices=["spiky", "stable"],
        default="spiky",
        help="Metric profile",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    run_stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    wandb_dir = os.path.join(script_dir, ".mock_wandb", f"run-{run_stamp}")
    os.makedirs(wandb_dir, exist_ok=True)
    metrics_path = os.path.join(wandb_dir, "metrics.jsonl")

    print("Starting GPT-2 training...", flush=True)
    print(f"Config: model={args.model} lr={args.lr} batch_size={args.batch_size}", flush=True)
    print(f"WANDB_RUN_DIR: {wandb_dir}", flush=True)

    for step in range(1, args.steps + 1):
        loss = synthetic_loss(step, args.profile)
        metric = {
            "_timestamp": time.time(),
            "step": step,
            "epoch": round(step / 2.0, 2),
            "loss": round(loss, 4),
            "train/loss": round(loss, 4),
            "model": args.model,
            "lr": args.lr,
            "batch_size": args.batch_size,
        }
        append_metric(metrics_path, metric)
        print(f"[step={step}] loss={metric['loss']}", flush=True)
        time.sleep(args.sleep_seconds)

    hold_seconds = int(os.environ.get("RA_INTERACTIVE_HOLD_SECONDS", str(DEFAULT_INTERACTIVE_HOLD_SECONDS)))
    print("Training loop complete. Keeping run alive for alert interaction...", flush=True)
    end_time = time.time() + hold_seconds
    while time.time() < end_time:
        time.sleep(1)

    print("Run finished.", flush=True)


if __name__ == "__main__":
    main()
