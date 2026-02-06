#!/usr/bin/env python3
"""
Fake GPT-2 training script that emits mocked high-loss metrics.

Purpose:
- Provide deterministic alert-triggering input for the sidecar.
- Avoid heavy dependencies (no torch/wandb required).
"""

import argparse
import json
import os
import time
from datetime import datetime


def append_metric(metrics_path: str, payload: dict) -> None:
    with open(metrics_path, "a") as f:
        f.write(json.dumps(payload) + "\n")
        f.flush()
        os.fsync(f.fileno())


def main() -> None:
    parser = argparse.ArgumentParser(description="Mock GPT-2 high-loss trainer")
    parser.add_argument("--steps", type=int, default=12, help="Number of emitted training steps")
    parser.add_argument("--sleep-seconds", type=float, default=1.5, help="Seconds between metric writes")
    parser.add_argument("--hold-seconds", type=int, default=180, help="How long to keep process alive after metrics")
    parser.add_argument("--high-loss", type=float, default=9.4, help="Loss value to trigger alert")
    parser.add_argument("--normal-loss", type=float, default=2.1, help="Baseline loss value")
    args = parser.parse_args()

    workdir = os.getcwd()
    run_stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    wandb_dir = os.path.join(workdir, "tests", "story", "alert", ".mock_wandb", f"run-{run_stamp}")
    os.makedirs(wandb_dir, exist_ok=True)
    metrics_path = os.path.join(wandb_dir, "metrics.jsonl")

    print("Starting mock GPT-2 training with synthetic metrics...", flush=True)
    print(f"WANDB_RUN_DIR: {wandb_dir}", flush=True)
    print(f"Writing metrics to: {metrics_path}", flush=True)

    for step in range(1, args.steps + 1):
        # Emit one early spike to trigger the rule-based sidecar alert.
        if step == 4:
            loss = args.high_loss
        else:
            loss = max(0.8, args.normal_loss - 0.05 * step)

        metric = {
            "_timestamp": time.time(),
            "step": step,
            "epoch": step / 2.0,
            "loss": round(loss, 4),
            "train/loss": round(loss, 4),
            "model": "gpt2",
            "run_kind": "mock_high_loss",
        }
        append_metric(metrics_path, metric)
        print(f"[step={step}] loss={metric['loss']}", flush=True)
        time.sleep(args.sleep_seconds)

    print(f"Metrics done. Holding process for {args.hold_seconds}s for interactive alert handling...", flush=True)
    end_time = time.time() + args.hold_seconds
    tick = 0
    while time.time() < end_time:
        tick += 1
        if tick % 10 == 0:
            print("mock trainer heartbeat...", flush=True)
        time.sleep(1)

    print("Mock GPT-2 run finished.", flush=True)


if __name__ == "__main__":
    main()
