#!/usr/bin/env python3
"""
Mock benchmark script for FlashInfer contest test fixture.

Simulates benchmarking a Triton kernel against a FlashInfer baseline.
Outputs deterministic metrics that improve with better kernel config,
so the wild loop can demonstrate measurable iteration progress.

Usage:
    python scripts/benchmark.py [--output results/metrics.json]
"""

import argparse
import hashlib
import json
import math
import os
import sys
import time

# Add project root to path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PROJECT_ROOT)


def load_config():
    """Load config.toml."""
    config_path = os.path.join(PROJECT_ROOT, "config.toml")
    try:
        import toml
        return toml.load(config_path)
    except ImportError:
        # Fallback: simple toml parser
        config = {}
        section = None
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1]
                    config[section] = {}
                elif "=" in line and section:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip('"')
                    if val.lower() in ("true", "false"):
                        val = val.lower() == "true"
                    config[section][key] = val
        return config


def load_kernel_config():
    """Load kernel tuning parameters from kernel.py."""
    kernel_path = os.path.join(PROJECT_ROOT, "solution", "triton", "kernel.py")
    params = {
        "BLOCK_SIZE": 64,
        "NUM_WARPS": 4,
        "NUM_STAGES": 2,
        "USE_FP8": False,
    }
    try:
        with open(kernel_path) as f:
            content = f.read()
        for line in content.split("\n"):
            line = line.strip()
            for key in params:
                if line.startswith(f"{key} =") or line.startswith(f"{key}="):
                    val = line.split("=", 1)[1].strip()
                    if val.lower() in ("true", "false"):
                        params[key] = val.lower() == "true"
                    else:
                        try:
                            params[key] = int(val)
                        except ValueError:
                            pass
    except FileNotFoundError:
        pass
    return params


def compute_speedup(kernel_params):
    """
    Compute a deterministic speedup score based on kernel parameters.

    The scoring function is designed so that:
    - Default params (BLOCK_SIZE=64, NUM_WARPS=4, NUM_STAGES=2) → ~0.85x baseline
    - Better params (BLOCK_SIZE=128, NUM_WARPS=8, NUM_STAGES=3) → ~1.2x baseline
    - Optimal params (BLOCK_SIZE=256, NUM_WARPS=8, NUM_STAGES=4, USE_FP8=True) → ~1.5x baseline
    """
    block_score = {
        32: 0.7, 64: 0.85, 128: 1.1, 256: 1.3, 512: 1.15,
    }.get(kernel_params.get("BLOCK_SIZE", 64), 0.8)

    warp_score = {
        2: 0.75, 4: 0.9, 8: 1.15, 16: 1.0,
    }.get(kernel_params.get("NUM_WARPS", 4), 0.85)

    stage_score = {
        1: 0.8, 2: 0.9, 3: 1.1, 4: 1.2, 5: 1.05,
    }.get(kernel_params.get("NUM_STAGES", 2), 0.85)

    fp8_bonus = 1.15 if kernel_params.get("USE_FP8", False) else 1.0

    # Geometric mean of component scores
    raw_speedup = (block_score * warp_score * stage_score * fp8_bonus) ** 0.5

    # Add small deterministic noise based on config hash
    config_str = json.dumps(kernel_params, sort_keys=True)
    noise_seed = int(hashlib.md5(config_str.encode()).hexdigest()[:8], 16)
    noise = (noise_seed % 100 - 50) / 1000  # ±0.05

    return round(raw_speedup + noise, 4)


def compute_latency(speedup):
    """Convert speedup ratio to simulated latency in ms."""
    baseline_latency_ms = 2.45  # Simulated FlashInfer baseline latency
    return round(baseline_latency_ms / speedup, 4)


def run_benchmark():
    parser = argparse.ArgumentParser(description="FlashInfer kernel benchmark")
    parser.add_argument("--output", default="results/metrics.json",
                        help="Output metrics file path")
    parser.add_argument("--workloads", default="all",
                        help="Workload set to benchmark (default: all)")
    args = parser.parse_args()

    print("=" * 60)
    print("FlashInfer Kernel Benchmark (Mock)")
    print("=" * 60)

    # Load configs
    config = load_config()
    kernel_params = load_kernel_config()

    print(f"\nSolution: {config.get('solution', {}).get('name', 'unknown')}")
    print(f"Track: {config.get('solution', {}).get('definition', 'unknown')}")
    print(f"Language: {config.get('build', {}).get('language', 'unknown')}")
    print(f"\nKernel config: {json.dumps(kernel_params, indent=2)}")

    # Simulate benchmark workloads
    workloads = [
        {"name": "moe_fp8_e32_h7168_i2048_topk8", "batch_sizes": [1, 4, 16, 64]},
        {"name": "moe_fp8_e32_h7168_i2048_topk2", "batch_sizes": [1, 4, 16, 64]},
    ]

    print(f"\nRunning {len(workloads)} workloads...")
    time.sleep(0.5)  # Simulate computation time

    results = []
    total_speedup = 0.0
    total_correct = 0
    total_workloads = 0

    for wl in workloads:
        for bs in wl["batch_sizes"]:
            # Vary speedup slightly by batch size
            bs_factor = 1.0 + (math.log2(max(bs, 1)) - 3) * 0.05
            speedup = compute_speedup(kernel_params) * bs_factor
            latency = compute_latency(speedup)
            correct = speedup > 0.3  # Always correct for reasonable configs

            result = {
                "workload": wl["name"],
                "batch_size": bs,
                "speedup": round(speedup, 4),
                "latency_ms": latency,
                "correctness": correct,
                "baseline_latency_ms": 2.45,
            }
            results.append(result)
            total_speedup += speedup
            total_correct += int(correct)
            total_workloads += 1

            status = "✓" if correct else "✗"
            print(f"  {status} {wl['name']} bs={bs}: speedup={speedup:.4f}x, latency={latency:.4f}ms")

    # Aggregate metrics
    avg_speedup = total_speedup / max(total_workloads, 1)
    win_rate = total_correct / max(total_workloads, 1)
    best_speedup = max(r["speedup"] for r in results)
    worst_speedup = min(r["speedup"] for r in results)

    metrics = {
        "summary": {
            "avg_speedup": round(avg_speedup, 4),
            "best_speedup": round(best_speedup, 4),
            "worst_speedup": round(worst_speedup, 4),
            "win_rate": round(win_rate, 4),
            "total_workloads": total_workloads,
            "correct_workloads": total_correct,
        },
        "kernel_config": kernel_params,
        "solution_config": config.get("solution", {}),
        "workload_results": results,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    # Write output
    output_path = os.path.join(PROJECT_ROOT, args.output)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"\n{'=' * 60}")
    print(f"RESULTS SUMMARY")
    print(f"{'=' * 60}")
    print(f"  Average speedup: {avg_speedup:.4f}x")
    print(f"  Best speedup:    {best_speedup:.4f}x")
    print(f"  Worst speedup:   {worst_speedup:.4f}x")
    print(f"  Win rate:        {win_rate:.1%}")
    print(f"  Correct:         {total_correct}/{total_workloads}")
    print(f"\nMetrics written to: {output_path}")

    return metrics


if __name__ == "__main__":
    run_benchmark()
