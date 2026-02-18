#!/usr/bin/env python3
"""Helper script to run benchmark with specific kernel parameters."""

import argparse
import json
import sys
import os

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PROJECT_ROOT)


def update_kernel_config(block_size, num_warps, num_stages, use_fp8):
    """Update kernel.py with new parameters."""
    kernel_path = os.path.join(PROJECT_ROOT, "solution", "triton", "kernel.py")

    with open(kernel_path, "r") as f:
        content = f.read()

    # Replace parameter values
    lines = content.split("\n")
    new_lines = []
    for line in lines:
        if line.startswith("BLOCK_SIZE = "):
            new_lines.append(f"BLOCK_SIZE = {block_size}")
        elif line.startswith("NUM_WARPS = "):
            new_lines.append(f"NUM_WARPS = {num_warps}")
        elif line.startswith("NUM_STAGES = "):
            new_lines.append(f"NUM_STAGES = {num_stages}")
        elif line.startswith("USE_FP8 = "):
            new_lines.append(f"USE_FP8 = {str(use_fp8)}")
        else:
            new_lines.append(line)

    with open(kernel_path, "w") as f:
        f.write("\n".join(new_lines))

    print(
        f"Updated kernel config: BLOCK_SIZE={block_size}, NUM_WARPS={num_warps}, NUM_STAGES={num_stages}, USE_FP8={use_fp8}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--block-size", type=int, required=True)
    parser.add_argument("--num-warps", type=int, required=True)
    parser.add_argument("--num-stages", type=int, required=True)
    parser.add_argument("--use-fp8", type=lambda x: x.lower() == "true", required=True)
    parser.add_argument("--output", type=str, required=True)
    args = parser.parse_args()

    update_kernel_config(args.block_size, args.num_warps, args.num_stages, args.use_fp8)

    # Run benchmark
    import subprocess

    result = subprocess.run(
        [sys.executable, "scripts/benchmark.py", "--output", args.output],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
