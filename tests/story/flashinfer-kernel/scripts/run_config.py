#!/usr/bin/env python3
"""
Parameterized benchmark runner for kernel tuning.
Modifies kernel.py with given config, runs benchmark, saves results.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KERNEL_PATH = os.path.join(PROJECT_ROOT, "solution", "triton", "kernel.py")


def update_kernel_config(block_size, num_warps, num_stages, use_fp8):
    """Update kernel.py with new configuration values."""
    with open(KERNEL_PATH, "r") as f:
        content = f.read()

    # Replace each config line
    lines = content.split("\n")
    new_lines = []
    for line in lines:
        if line.startswith("BLOCK_SIZE = "):
            line = f"BLOCK_SIZE = {block_size}"
        elif line.startswith("NUM_WARPS = "):
            line = f"NUM_WARPS = {num_warps}"
        elif line.startswith("NUM_STAGES = "):
            line = f"NUM_STAGES = {num_stages}"
        elif line.startswith("USE_FP8 = "):
            line = f"USE_FP8 = {use_fp8}"
        new_lines.append(line)

    with open(KERNEL_PATH, "w") as f:
        f.write("\n".join(new_lines))


def run_benchmark(output_path):
    """Run benchmark and return results."""
    cmd = [
        sys.executable,
        os.path.join(PROJECT_ROOT, "scripts", "benchmark.py"),
        "--output",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=PROJECT_ROOT)

    if result.returncode != 0:
        print(f"Benchmark failed: {result.stderr}", file=sys.stderr)
        return None

    with open(output_path) as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--block-size", type=int, required=True)
    parser.add_argument("--num-warps", type=int, required=True)
    parser.add_argument("--num-stages", type=int, required=True)
    parser.add_argument("--use-fp8", type=lambda x: x.lower() == "true", required=True)
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument(
        "--restore-after",
        action="store_true",
        help="Restore original kernel.py after run",
    )
    args = parser.parse_args()

    # Read original kernel content for restoration
    with open(KERNEL_PATH, "r") as f:
        original_content = f.read()

    try:
        # Update kernel with config
        update_kernel_config(
            args.block_size, args.num_warps, args.num_stages, args.use_fp8
        )

        # Run benchmark
        output_path = os.path.join(PROJECT_ROOT, args.output)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        results = run_benchmark(output_path)

        if results:
            # Print summary for API tracking
            summary = results["summary"]
            config = results["kernel_config"]
            print(
                json.dumps(
                    {
                        "config": config,
                        "avg_speedup": summary["avg_speedup"],
                        "best_speedup": summary["best_speedup"],
                        "win_rate": summary["win_rate"],
                    }
                )
            )

    finally:
        # Restore original kernel.py
        if args.restore_after:
            with open(KERNEL_PATH, "w") as f:
                f.write(original_content)


if __name__ == "__main__":
    main()
