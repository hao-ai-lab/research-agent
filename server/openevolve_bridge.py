#!/usr/bin/env python3
"""OpenEvolve subprocess bridge.

Modes:
- smoke: generate synthetic checkpoint artifacts for integration testing
- real: execute OpenEvolve CLI as a black-box process
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def run_smoke_mode(output_dir: Path, iterations: int) -> int:
    checkpoints_dir = output_dir / "checkpoints"
    _ensure_dir(checkpoints_dir)

    best_program_id = "smoke-best-program"
    for i in range(1, iterations + 1):
        checkpoint_dir = checkpoints_dir / f"checkpoint_{i}"
        programs_dir = checkpoint_dir / "programs"
        _ensure_dir(programs_dir)

        metadata = {
            "island_feature_maps": [{"0-0": best_program_id}],
            "islands": [[best_program_id]],
            "archive": [best_program_id],
            "best_program_id": best_program_id,
            "island_best_programs": [best_program_id],
            "last_iteration": i,
            "current_island": 0,
            "island_generations": [i],
            "last_migration_generation": 0,
            "feature_stats": {
                "complexity": {"min": 1.0, "max": 1.0, "values": [1.0]},
                "diversity": {"min": 1.0, "max": 1.0, "values": [1.0]},
            },
        }
        (checkpoint_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

        best_program_info = {
            "id": best_program_id,
            "metrics": {
                "combined_score": float(i),
            },
        }
        (checkpoint_dir / "best_program_info.json").write_text(
            json.dumps(best_program_info),
            encoding="utf-8",
        )

        program_doc = {
            "id": best_program_id,
            "code": "# smoke openevolve output\n",
            "metrics": {"combined_score": float(i)},
            "generation": i,
        }
        (programs_dir / f"{best_program_id}.json").write_text(json.dumps(program_doc), encoding="utf-8")

        print(f"[openevolve-bridge] smoke checkpoint_{i} written at {checkpoint_dir}", flush=True)
        time.sleep(0.2)

    print(f"[openevolve-bridge] smoke complete: output_dir={output_dir}", flush=True)
    return 0


def run_real_mode(
    output_dir: Path,
    initial_program: str,
    evaluation_file: str,
    config: str | None,
    iterations: int | None,
) -> int:
    cmd = [
        sys.executable,
        "-m",
        "openevolve.cli",
        initial_program,
        evaluation_file,
        "--output",
        str(output_dir),
    ]
    if config:
        cmd.extend(["--config", config])
    if iterations is not None:
        cmd.extend(["--iterations", str(iterations)])

    print(f"[openevolve-bridge] exec: {' '.join(cmd)}", flush=True)
    proc = subprocess.run(cmd)
    return int(proc.returncode)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenEvolve bridge")
    parser.add_argument("--mode", choices=["smoke", "real"], required=True)
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--initial_program", required=True)
    parser.add_argument("--evaluation_file", required=True)
    parser.add_argument("--config", default=None)
    parser.add_argument("--iterations", type=int, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_dir = Path(args.output_dir)
    _ensure_dir(output_dir)

    if args.mode == "smoke":
        smoke_iterations = args.iterations if args.iterations and args.iterations > 0 else 3
        return run_smoke_mode(output_dir, smoke_iterations)

    return run_real_mode(
        output_dir=output_dir,
        initial_program=args.initial_program,
        evaluation_file=args.evaluation_file,
        config=args.config,
        iterations=args.iterations,
    )


if __name__ == "__main__":
    raise SystemExit(main())
