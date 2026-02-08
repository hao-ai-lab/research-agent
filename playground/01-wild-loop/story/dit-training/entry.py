#!/usr/bin/env python3
"""Run the DiT toy story."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from loop.loop import run_story


def main() -> None:
    story_dir = Path(__file__).resolve().parent
    summary = run_story(
        story_path=story_dir / "story.yaml",
        output_dir=story_dir / "expected",
        max_steps=400,
    )
    print(f"story={summary['story']} complete={summary['loop_complete']}")


if __name__ == "__main__":
    main()
