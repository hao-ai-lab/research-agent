"""Toy wild-loop tests."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from loop.loop import ToyWildLoop, load_story, run_story, validate_run_skill


class WildLoopToyTests(unittest.TestCase):
    def test_rl_story_completes_with_fallback_and_report(self) -> None:
        story_path = ROOT / "story" / "rl-training" / "story.yaml"
        with tempfile.TemporaryDirectory() as temp_dir:
            summary = run_story(story_path=story_path, output_dir=Path(temp_dir), max_steps=500)

            self.assertTrue(summary["loop_complete"])
            fallback_runs = [run for run in summary["runs"].values() if run.get("used_fallback")]
            self.assertGreaterEqual(len(fallback_runs), 1)
            self.assertIn("Best clip strategy", self._read_report(Path(temp_dir)))
            self.assertIn("Best offpoliciness", self._read_report(Path(temp_dir)))

    def test_reference_only_validator_rejects_inline_payload(self) -> None:
        with self.assertRaises(ValueError):
            validate_run_skill(
                {
                    "kind": "python_script",
                    "target": "skills/python_runner.py",
                    "args": {},
                    "inline_body": "echo hello",
                }
            )

    def test_missing_target_blocks_run_when_no_fallback(self) -> None:
        story_path = ROOT / "story" / "rl-training" / "story.yaml"
        story = load_story(story_path)
        story["runs"] = [
            {
                "run_id": "broken-run",
                "name": "broken",
                "skill": {
                    "kind": "python_script",
                    "target": "skills/does_not_exist.py",
                    "args": {},
                },
            }
        ]
        loop = ToyWildLoop(story=story, story_root=story_path.parent)
        loop.state["runs"]["broken-run"] = {
            "run_id": "broken-run",
            "name": "broken",
            "goal": None,
            "status": "queued",
            "run_spec": story["runs"][0],
            "resolved_instruction": None,
            "used_fallback": False,
            "result": None,
            "error": None,
        }
        run_result = loop._handle_run_execute("broken-run")  # pylint: disable=protected-access
        self.assertEqual(loop.state["runs"]["broken-run"]["status"], "blocked")
        self.assertIsNone(loop.state["runs"]["broken-run"]["resolved_instruction"])
        self.assertEqual(run_result["status"], "ok")

    def test_prompt_tuning_story_executes_all_skill_kinds(self) -> None:
        story_path = ROOT / "story" / "prompt-tuning" / "story.yaml"
        with tempfile.TemporaryDirectory() as temp_dir:
            summary = run_story(story_path=story_path, output_dir=Path(temp_dir), max_steps=500)
            kinds = {run["run_spec"]["skill"]["kind"] for run in summary["runs"].values()}
            self.assertTrue(summary["loop_complete"])
            self.assertEqual(
                kinds,
                {"python_function", "python_script", "shell_script", "prompt_playbook"},
            )
            self.assertTrue(all(run.get("resolved_instruction") for run in summary["runs"].values()))

    def _read_report(self, output_dir: Path) -> str:
        report_path = output_dir / "final_report.md"
        self.assertTrue(report_path.exists())
        return report_path.read_text(encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
