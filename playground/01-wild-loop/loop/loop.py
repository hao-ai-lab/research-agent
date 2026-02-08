#!/usr/bin/env python3
"""KISS toy wild loop: single-file core, inline scheduler, run-as-skill."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List, Optional, Tuple

import yaml

LANE_ORDER = ["user_steer", "agent_steer", "user_queued", "agent_queued"]
TERMINAL_RUN_STATUSES = {"finished", "failed", "blocked", "stopped"}
RUN_SKILL_KINDS = {"python_function", "python_script", "shell_script", "prompt_playbook"}
INLINE_REJECT_KEYS = {
    "inline",
    "inline_body",
    "script_body",
    "source",
    "source_code",
    "code",
    "command_body",
}
EVENT_OUTPUT_RE = re.compile(r"<event_output>\s*(\{.*?\})\s*</event_output>", re.S)
PROMISE_RE = re.compile(r"<promise>\s*(CONTINUE|NEEDS_HUMAN|COMPLETE)\s*</promise>", re.S)


@dataclass
class PromptEvent:
    event_id: str
    lane: str
    source: str
    intent: str
    prompt_path: str
    input_payload: Dict[str, Any] = field(default_factory=dict)
    retry_budget: int = 2
    timeout_s: int = 120
    blocking: bool = False

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "PromptEvent":
        lane = payload.get("lane", "agent_queued")
        if lane not in LANE_ORDER:
            raise ValueError(f"Unknown lane '{lane}'")
        return cls(
            event_id=payload.get("event_id") or f"evt_{uuid.uuid4().hex[:10]}",
            lane=lane,
            source=payload.get("source", "system"),
            intent=payload.get("intent", "unknown"),
            prompt_path=payload.get("prompt_path", ""),
            input_payload=dict(payload.get("input_payload", {})),
            retry_budget=int(payload.get("retry_budget", 2)),
            timeout_s=int(payload.get("timeout_s", 120)),
            blocking=bool(payload.get("blocking", False)),
        )


def make_event(intent: str, lane: str, input_payload: Dict[str, Any], prompt_path: str) -> PromptEvent:
    return PromptEvent.from_dict(
        {
            "intent": intent,
            "lane": lane,
            "source": "agent",
            "prompt_path": prompt_path,
            "input_payload": input_payload,
            "retry_budget": 2,
        }
    )


def validate_run_skill(skill: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(skill, dict):
        raise ValueError("run.skill must be an object")
    for key in INLINE_REJECT_KEYS:
        if key in skill:
            raise ValueError(f"Inline execution payload '{key}' is not allowed")
    kind = skill.get("kind")
    target = skill.get("target")
    args = skill.get("args", {})
    if kind not in RUN_SKILL_KINDS:
        raise ValueError(f"Unsupported run skill kind '{kind}'")
    if not isinstance(target, str) or not target.strip():
        raise ValueError("run.skill.target must be a non-empty reference")
    if not isinstance(args, dict):
        raise ValueError("run.skill.args must be an object")
    return skill


class BackgroundLLM:
    """Background LLM worker; mock by default, opencode optional."""

    def __init__(self, config: Dict[str, Any], story_root: Path):
        self.story_root = story_root
        self.mode = str(config.get("mode", "mock")).strip().lower()
        self.timeout_s = int(config.get("timeout_s", 30))
        self.opencode_cmd = config.get("opencode_cmd", [])
        self._jobs: "queue.Queue[tuple[str, str, Dict[str, Any]]]" = queue.Queue()
        self._results: Dict[str, str] = {}
        self._worker = threading.Thread(target=self._run_worker, daemon=True)
        self._worker.start()

    def submit(self, prompt_text: str, metadata: Dict[str, Any]) -> str:
        job_id = uuid.uuid4().hex
        self._jobs.put((job_id, prompt_text, metadata))
        while job_id not in self._results:
            time.sleep(0.005)
        return self._results.pop(job_id)

    def close(self) -> None:
        self._jobs.put(("__stop__", "", {}))
        self._worker.join(timeout=1.0)

    def _run_worker(self) -> None:
        while True:
            job_id, prompt_text, metadata = self._jobs.get()
            if job_id == "__stop__":
                return
            try:
                if self.mode == "opencode":
                    response = self._run_opencode(prompt_text, metadata)
                else:
                    response = self._mock_response(prompt_text, metadata)
            except Exception as exc:  # pragma: no cover - defensive
                response = f"[llm-error] {exc}"
            self._results[job_id] = response

    def _run_opencode(self, prompt_text: str, metadata: Dict[str, Any]) -> str:
        if not self.opencode_cmd:
            return self._mock_response(prompt_text, metadata)
        cmd = self.opencode_cmd if isinstance(self.opencode_cmd, list) else [str(self.opencode_cmd)]
        process = subprocess.run(
            cmd,
            input=prompt_text,
            text=True,
            capture_output=True,
            cwd=str(self.story_root),
            timeout=self.timeout_s,
            check=False,
        )
        out = (process.stdout or "").strip()
        err = (process.stderr or "").strip()
        if process.returncode != 0:
            return f"[opencode-failed] rc={process.returncode} stderr={err}"
        return out or "[opencode-empty]"

    def _mock_response(self, _prompt_text: str, metadata: Dict[str, Any]) -> str:
        return f"[mock-llm] intent={metadata.get('intent')} recommendation=continue"


class ToyWildLoop:
    """Single-file event loop with built-in scheduler and run executor."""

    def __init__(self, story: Dict[str, Any], story_root: Path):
        self.story = story
        self.story_root = story_root
        self.queues: Dict[str, deque[PromptEvent]] = {lane: deque() for lane in LANE_ORDER}
        total_gpus = int(story.get("scheduler", {}).get("total_gpus", 1))
        self.state: Dict[str, Any] = {
            "mode": story.get("mode", "balanced"),
            "loop_complete": False,
            "analysis_emitted": False,
            "runs": {},
            "alerts": [],
            "artifacts": [],
            "events": {"completed": [], "failed": [], "retried": []},
            "interactions": [],
            "scheduler": {
                "total_gpus": total_gpus,
                "available_gpus": total_gpus,
                "allocations": {},
                "queue_decisions": [],
            },
            "human": {
                "auto_proceed": bool(story.get("human", {}).get("auto_proceed", True)),
                "notifications": [],
            },
        }
        self.llm = BackgroundLLM(config=dict(story.get("llm", {})), story_root=story_root)

    def enqueue(self, event: PromptEvent) -> None:
        self.queues[event.lane].append(event)

    def dequeue(self) -> Optional[PromptEvent]:
        for lane in LANE_ORDER:
            if self.queues[lane]:
                return self.queues[lane].popleft()
        return None

    def run(self, max_steps: int = 500) -> Dict[str, Any]:
        steps = 0
        while steps < max_steps and not self.state["loop_complete"]:
            event = self.dequeue()
            if event is None:
                break
            prompt_text = self._render_prompt(event)
            llm_note = self.llm.submit(prompt_text, {"intent": event.intent, "event_id": event.event_id})
            result = self._handle_event(event)
            self._record_interaction(event, prompt_text, llm_note, result)
            self._apply_result(event, result)
            steps += 1
        self.llm.close()
        return self._snapshot()

    def _render_prompt(self, event: PromptEvent) -> str:
        prompt_body = ""
        if event.prompt_path:
            prompt_path = Path(event.prompt_path)
            if not prompt_path.is_absolute():
                prompt_path = (self.story_root / prompt_path).resolve()
            if prompt_path.exists():
                prompt_body = prompt_path.read_text(encoding="utf-8")
        return "\n".join(
            [
                f"# Event {event.event_id}",
                f"Intent: {event.intent}",
                f"Lane: {event.lane}",
                "## Input",
                json.dumps(event.input_payload, indent=2, sort_keys=True),
                "## Procedure",
                prompt_body or "(no prompt body)",
                "## Output",
                "Emit structured event output and promise.",
            ]
        )

    def _record_interaction(
        self,
        event: PromptEvent,
        prompt_text: str,
        llm_note: str,
        result: Dict[str, Any],
    ) -> None:
        self.state["interactions"].append(
            {
                "ts": time.time(),
                "event_id": event.event_id,
                "intent": event.intent,
                "lane": event.lane,
                "source": event.source,
                "input_payload": self._json_safe(event.input_payload),
                "prompt_text": prompt_text,
                "llm_note": llm_note,
                "result": self._json_safe(result),
            }
        )

    def _json_safe(self, value: Any) -> Any:
        if isinstance(value, PromptEvent):
            return asdict(value)
        if isinstance(value, dict):
            return {str(key): self._json_safe(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._json_safe(item) for item in value]
        return value

    def _handle_event(self, event: PromptEvent) -> Dict[str, Any]:
        if event.intent == "plan_sweep":
            return self._handle_plan_sweep()
        if event.intent == "scheduler_tick":
            return self._handle_scheduler_tick()
        if event.intent == "run_execute":
            return self._handle_run_execute(event.input_payload.get("run_id"))
        if event.intent == "run_alert":
            return self._handle_run_alert(event.input_payload)
        if event.intent == "human_decision":
            return self._handle_human_decision(event.input_payload)
        if event.intent == "analyze":
            return self._handle_analyze()
        return {"status": "failed", "summary": f"Unknown intent: {event.intent}", "promise": "NEEDS_HUMAN"}

    def _handle_plan_sweep(self) -> Dict[str, Any]:
        for run_spec in self.story.get("runs", []):
            run_id = run_spec["run_id"]
            self.state["runs"][run_id] = {
                "run_id": run_id,
                "name": run_spec.get("name", run_id),
                "goal": run_spec.get("goal"),
                "status": "ready",
                "run_spec": run_spec,
                "resolved_instruction": None,
                "used_fallback": False,
                "result": None,
                "error": None,
            }
        return {
            "status": "ok",
            "summary": f"Planned {len(self.story.get('runs', []))} runs",
            "new_events": [make_event("scheduler_tick", "agent_queued", {}, "loop/prompts/core/scheduler_tick.md")],
        }

    def _handle_scheduler_tick(self) -> Dict[str, Any]:
        runs = self.state["runs"]
        ready_runs = [run for run in runs.values() if run["status"] == "ready"]
        if self._all_terminal() and not self.state["analysis_emitted"]:
            self.state["analysis_emitted"] = True
            return {
                "status": "ok",
                "summary": "All runs terminal; triggering analysis",
                "new_events": [make_event("analyze", "agent_queued", {}, "loop/prompts/core/analysis_report.md")],
            }
        if not ready_runs:
            return {"status": "ok", "summary": "No ready runs to schedule", "new_events": []}

        available = int(self.state["scheduler"]["available_gpus"])
        placements: List[PromptEvent] = []
        decisions = []
        for run in ready_runs:
            resources = (run["run_spec"].get("skill") or {}).get("resources", {})
            need = int(resources.get("gpus", 0))
            if need > available:
                continue
            run["status"] = "queued"
            available -= need
            self.state["scheduler"]["allocations"][run["run_id"]] = need
            decisions.append({"run_id": run["run_id"], "allocated_gpus": need, "decision": "scheduled"})
            placements.append(
                make_event(
                    "run_execute",
                    "agent_queued",
                    {"run_id": run["run_id"]},
                    "loop/prompts/core/run_finished_review.md",
                )
            )
        self.state["scheduler"]["available_gpus"] = available
        self.state["scheduler"]["queue_decisions"].extend(decisions)

        return {
            "status": "ok",
            "summary": f"Scheduler placed {len(placements)} runs",
            "new_events": placements,
        }

    def _handle_run_execute(self, run_id: Optional[str]) -> Dict[str, Any]:
        run = self.state["runs"].get(run_id or "")
        if run is None:
            return {"status": "failed", "summary": f"Run not found: {run_id}"}
        run_spec = run["run_spec"]

        try:
            skill = validate_run_skill(dict(run_spec.get("skill", {})))
            resolved_instruction = self._resolve_run_skill(skill)
            run["resolved_instruction"] = resolved_instruction
        except Exception as primary_error:
            fallback = run_spec.get("fallback")
            if fallback:
                try:
                    fallback_skill, fallback_instruction = self._resolve_fallback(fallback)
                    skill = fallback_skill
                    run["resolved_instruction"] = fallback_instruction
                    run["used_fallback"] = True
                except Exception as fallback_error:
                    return self._block_run(run, f"{primary_error}; fallback failed: {fallback_error}")
            else:
                return self._block_run(run, str(primary_error))

        if not run.get("resolved_instruction"):
            return self._block_run(run, "resolved_instruction missing before launch")

        run["status"] = "running"
        result = self._execute_run_skill(skill)
        run["result"] = result
        normalized = str(result.get("status", "success")).lower()
        run["status"] = "finished" if normalized in {"success", "ok", "finished"} else "failed"
        self._release_scheduler_allocation(run["run_id"])

        events = [make_event("scheduler_tick", "agent_queued", {}, "loop/prompts/core/scheduler_tick.md")]
        if result.get("alert"):
            events.append(
                make_event(
                    "run_alert",
                    "agent_steer",
                    {"run_id": run["run_id"], "alert": result["alert"]},
                    "loop/prompts/core/run_alert_triage.md",
                )
            )
        return {
            "status": "ok",
            "summary": f"Run {run['run_id']} finished with status={run['status']}",
            "artifacts": [
                {
                    "type": "run_result",
                    "run_id": run["run_id"],
                    "status": run["status"],
                    "resolved_instruction": run["resolved_instruction"],
                    "used_fallback": run["used_fallback"],
                    "result": result,
                }
            ],
            "new_events": events,
        }

    def _handle_run_alert(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        alert = dict(payload.get("alert", {}))
        run_id = payload.get("run_id")
        alert.setdefault("severity", "warning")
        alert.setdefault("message", "Unspecified run alert")
        alert.setdefault("choices", ["continue_training", "raise_to_human"])
        self.state["alerts"].append({"run_id": run_id, **alert})

        mode = self.state["mode"]
        severity = str(alert["severity"]).lower()
        escalate = severity == "critical" or mode == "page_on_alert"
        if mode == "balanced" and not escalate:
            per_run_alerts = [item for item in self.state["alerts"] if item.get("run_id") == run_id]
            escalate = len(per_run_alerts) > 1

        if escalate:
            return {
                "status": "ok",
                "summary": f"Alert escalated for run={run_id}",
                "new_events": [
                    make_event(
                        "human_decision",
                        "user_steer",
                        {
                            "run_id": run_id,
                            "reason": alert["message"],
                            "simulated_response": "continue_by_human",
                        },
                        "loop/prompts/core/human_page.md",
                    )
                ],
                "artifacts": [{"type": "alert", "run_id": run_id, "mode_action": "escalated"}],
            }
        return {
            "status": "ok",
            "summary": f"Alert auto-handled for run={run_id}",
            "artifacts": [{"type": "alert", "run_id": run_id, "mode_action": "auto_continue"}],
        }

    def _handle_human_decision(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        mode = self.state["mode"]
        auto = bool(self.state["human"]["auto_proceed"])
        decision = payload.get("simulated_response", "continue_by_human")
        if auto or mode in {"wild_night", "away_but_ping"}:
            decision = "continue_by_agent"

        note = {"run_id": payload.get("run_id"), "reason": payload.get("reason"), "decision": decision}
        self.state["human"]["notifications"].append(note)
        return {
            "status": "ok",
            "summary": f"Human decision handled: {decision}",
            "artifacts": [{"type": "human_decision", **note}],
        }

    def _handle_analyze(self) -> Dict[str, Any]:
        story_type = self.story.get("story_type", "generic")
        runs = list(self.state["runs"].values())
        fallback_runs = [run["run_id"] for run in runs if run.get("used_fallback")]
        alerts = self.state["alerts"]

        if story_type == "rl_training":
            report = self._build_rl_report(runs, fallback_runs, alerts)
        elif story_type == "prompt_tuning":
            report = self._build_prompt_tuning_report(runs, fallback_runs, alerts)
        elif story_type == "dit_training":
            report = self._build_dit_report(runs, fallback_runs, alerts)
        else:
            report = self._build_generic_report(runs, fallback_runs, alerts)

        return {
            "status": "ok",
            "summary": "Generated analysis report",
            "promise": "COMPLETE",
            "artifacts": [{"type": "report", "name": "final_report.md", "content": report}],
        }

    def _resolve_run_skill(self, skill: Dict[str, Any]) -> str:
        kind = skill["kind"]
        target = skill["target"]
        args = skill.get("args", {})
        if kind == "python_function":
            if ":" not in target:
                raise ValueError("python_function target must be module:function")
            module_name, function_name = target.split(":", 1)
            self._load_python_function(module_name, function_name)
            return f"python_function::{target}::{json.dumps(args, sort_keys=True)}"
        if kind in {"python_script", "shell_script", "prompt_playbook"}:
            path = self._resolve_reference_path(target)
            if not path.exists():
                raise ValueError(f"Referenced target missing: {target}")
            return f"{kind}::{path}::{json.dumps(args, sort_keys=True)}"
        raise ValueError(f"Unsupported skill kind '{kind}'")

    def _resolve_fallback(self, fallback: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
        target_hint = fallback.get("target_hint")
        if not target_hint:
            raise ValueError("fallback.target_hint missing")
        fallback_skill = {
            "kind": "prompt_playbook",
            "target": target_hint,
            "args": fallback.get("args", {"instruction_text": fallback.get("instruction_text", "")}),
        }
        fallback_skill = validate_run_skill(fallback_skill)
        resolved = self._resolve_run_skill(fallback_skill)
        return fallback_skill, resolved

    def _execute_run_skill(self, skill: Dict[str, Any]) -> Dict[str, Any]:
        kind = skill["kind"]
        if kind == "python_function":
            module_name, function_name = skill["target"].split(":", 1)
            function = self._load_python_function(module_name, function_name)
            return self._normalize_result(function(**dict(skill.get("args", {}))))
        if kind == "python_script":
            return self._run_script(["python3", str(self._resolve_reference_path(skill["target"]))], skill)
        if kind == "shell_script":
            return self._run_script(["bash", str(self._resolve_reference_path(skill["target"]))], skill)
        if kind == "prompt_playbook":
            playbook = self._resolve_reference_path(skill["target"])
            args = dict(skill.get("args", {}))
            first_line = playbook.read_text(encoding="utf-8").splitlines()[0].strip()
            payload = {"status": args.get("status", "success"), "summary": args.get("summary", "Playbook executed")}
            payload.update(args)
            payload["playbook"] = str(playbook.relative_to(self.story_root))
            payload["playbook_title"] = first_line
            return self._normalize_result(payload)
        return {"status": "failed", "error": f"Unsupported skill kind {kind}"}

    def _run_script(self, cmd: List[str], skill: Dict[str, Any]) -> Dict[str, Any]:
        args = dict(skill.get("args", {}))
        cli_args = self._to_cli_args(args)
        timeout_s = int(skill.get("timeout_s", 120))
        workdir_raw = skill.get("workdir")
        workdir = (self.story_root / workdir_raw).resolve() if workdir_raw else self.story_root
        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in skill.get("env", {}).items()})
        result = subprocess.run(
            cmd + cli_args,
            cwd=str(workdir),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        if result.returncode != 0:
            return {"status": "failed", "error": stderr or stdout or "script failed", "returncode": result.returncode}
        parsed = self._try_parse_json_line(stdout)
        return self._normalize_result(parsed if parsed is not None else {"status": "success", "stdout": stdout})

    def _try_parse_json_line(self, text: str) -> Optional[Dict[str, Any]]:
        for line in reversed(text.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                return payload
        return None

    def _normalize_result(self, payload: Any) -> Dict[str, Any]:
        if isinstance(payload, dict):
            payload.setdefault("status", "success")
            return payload
        return {"status": "success", "output": payload}

    def _load_python_function(self, module_name: str, function_name: str) -> Any:
        if str(self.story_root) not in sys.path:
            sys.path.insert(0, str(self.story_root))
        module = importlib.import_module(module_name)
        if not hasattr(module, function_name):
            raise ValueError(f"Function {function_name} missing in module {module_name}")
        return getattr(module, function_name)

    def _resolve_reference_path(self, target: str) -> Path:
        path = Path(target)
        if path.is_absolute():
            return path.resolve()
        return (self.story_root / path).resolve()

    def _to_cli_args(self, args: Dict[str, Any]) -> List[str]:
        cli: List[str] = []
        for key, value in args.items():
            flag = f"--{str(key).replace('_', '-')}"
            if isinstance(value, bool):
                cli.extend([flag, "true" if value else "false"])
            else:
                cli.extend([flag, str(value)])
        return cli

    def _block_run(self, run: Dict[str, Any], reason: str) -> Dict[str, Any]:
        run["status"] = "blocked"
        run["error"] = reason
        self._release_scheduler_allocation(run["run_id"])
        return {
            "status": "ok",
            "summary": f"Run blocked: {run['run_id']} ({reason})",
            "new_events": [
                make_event(
                    "run_alert",
                    "agent_steer",
                    {
                        "run_id": run["run_id"],
                        "alert": {
                            "severity": "critical",
                            "message": f"Run blocked: {reason}",
                            "choices": ["continue_training", "raise_to_human"],
                        },
                    },
                    "loop/prompts/core/run_alert_triage.md",
                ),
                make_event("scheduler_tick", "agent_queued", {}, "loop/prompts/core/scheduler_tick.md"),
            ],
        }

    def _release_scheduler_allocation(self, run_id: str) -> None:
        allocated = int(self.state["scheduler"]["allocations"].pop(run_id, 0))
        self.state["scheduler"]["available_gpus"] += allocated

    def _apply_result(self, event: PromptEvent, result: Dict[str, Any]) -> None:
        status = result.get("status", "ok")
        if status == "retry":
            if event.retry_budget > 0:
                event.retry_budget -= 1
                self.state["events"]["retried"].append(event.event_id)
                self.enqueue(event)
            else:
                self.state["events"]["failed"].append(
                    {"event_id": event.event_id, "summary": "retry budget exhausted"}
                )
        elif status in {"failed", "error"}:
            self.state["events"]["failed"].append({"event_id": event.event_id, "summary": result.get("summary", "")})
        else:
            self.state["events"]["completed"].append(
                {"event_id": event.event_id, "summary": result.get("summary", "")}
            )

        for artifact in result.get("artifacts", []):
            payload = dict(artifact)
            payload.setdefault("event_id", event.event_id)
            payload.setdefault("ts", time.time())
            self.state["artifacts"].append(payload)

        for new_event in result.get("new_events", []):
            if isinstance(new_event, PromptEvent):
                self.enqueue(new_event)
            else:
                self.enqueue(PromptEvent.from_dict(new_event))

        promise = result.get("promise", "CONTINUE")
        if promise == "COMPLETE":
            self.state["loop_complete"] = True
        elif promise == "NEEDS_HUMAN" and self.state["human"]["auto_proceed"]:
            self.enqueue(
                make_event(
                    "human_decision",
                    "user_steer",
                    {"reason": "auto proceed due to unattended mode", "simulated_response": "continue_by_agent"},
                    "loop/prompts/core/human_response_ingest.md",
                )
            )

    def _all_terminal(self) -> bool:
        runs = self.state["runs"]
        return bool(runs) and all(run["status"] in TERMINAL_RUN_STATUSES for run in runs.values())

    def _build_rl_report(
        self,
        runs: List[Dict[str, Any]],
        fallback_runs: List[str],
        alerts: List[Dict[str, Any]],
    ) -> str:
        clip_groups: Dict[str, List[float]] = {}
        offpolicy_groups: Dict[str, List[float]] = {}
        run_lines: List[str] = []
        for run in runs:
            result = run.get("result") or {}
            reward = _to_float(result.get("reward"))
            clip = str(result.get("clip_coef", "unknown"))
            offpolicy = f"bs{result.get('batch_size', '?')}_mbs{result.get('mini_batch_size', '?')}"
            if reward is not None:
                clip_groups.setdefault(clip, []).append(reward)
                offpolicy_groups.setdefault(offpolicy, []).append(reward)
            run_lines.append(
                f"- {run['run_id']} | {run['status']} | model={result.get('model')} | clip={clip} | {offpolicy} | reward={result.get('reward')}"
            )
        best_clip = _best_group(clip_groups)
        best_offpolicy = _best_group(offpolicy_groups)
        return "\n".join(
            [
                "# RL Training Report",
                "",
                f"Best clip strategy: {best_clip[0]} (avg reward {best_clip[1]:.3f})",
                f"Best offpoliciness: {best_offpolicy[0]} (avg reward {best_offpolicy[1]:.3f})",
                "",
                "## Run Table",
                *run_lines,
                "",
                f"Fallback runs used: {fallback_runs or 'none'}",
                f"Alert count: {len(alerts)}",
            ]
        )

    def _build_prompt_tuning_report(
        self,
        runs: List[Dict[str, Any]],
        fallback_runs: List[str],
        alerts: List[Dict[str, Any]],
    ) -> str:
        ranked: List[Tuple[str, float, float, float]] = []
        run_lines: List[str] = []
        for run in runs:
            result = run.get("result") or {}
            score = _to_float(result.get("score")) or 0.0
            cost = _to_float(result.get("cost")) or 999.0
            latency = _to_float(result.get("latency")) or 999.0
            ranked.append((run["run_id"], score, cost, latency))
            run_lines.append(
                f"- {run['run_id']} | {run['status']} | variant={result.get('variant')} | score={score} | cost={cost} | latency={latency}"
            )
        ranked.sort(key=lambda item: (-item[1], item[2], item[3]))
        winner = ranked[0] if ranked else ("none", 0.0, 0.0, 0.0)
        return "\n".join(
            [
                "# Prompt Tuning Report",
                "",
                f"Selected prompt variant run: {winner[0]} (score={winner[1]}, cost={winner[2]}, latency={winner[3]})",
                "",
                "## Run Table",
                *run_lines,
                "",
                f"Fallback runs used: {fallback_runs or 'none'}",
                f"Alert count: {len(alerts)}",
            ]
        )

    def _build_dit_report(
        self,
        runs: List[Dict[str, Any]],
        fallback_runs: List[str],
        alerts: List[Dict[str, Any]],
    ) -> str:
        run_lines: List[str] = []
        best = ("none", -1.0)
        human_checks = 0
        for run in runs:
            result = run.get("result") or {}
            quality = _to_float(result.get("video_quality")) or 0.0
            if quality > best[1]:
                best = (run["run_id"], quality)
            if result.get("human_check_required"):
                human_checks += 1
            run_lines.append(
                f"- {run['run_id']} | {run['status']} | quality={result.get('video_quality')} | fid={result.get('fid')} | human_check_required={bool(result.get('human_check_required'))}"
            )
        return "\n".join(
            [
                "# DiT Training Report",
                "",
                f"Best run by quality: {best[0]} (video_quality={best[1]:.3f})",
                f"Human-review packets required: {human_checks}",
                "",
                "## Run Table",
                *run_lines,
                "",
                f"Fallback runs used: {fallback_runs or 'none'}",
                f"Alert count: {len(alerts)}",
            ]
        )

    def _build_generic_report(
        self,
        runs: List[Dict[str, Any]],
        fallback_runs: List[str],
        alerts: List[Dict[str, Any]],
    ) -> str:
        return "\n".join(
            [
                "# Wild Loop Report",
                "",
                f"Total runs: {len(runs)}",
                f"Finished runs: {len([r for r in runs if r.get('status') == 'finished'])}",
                f"Failed/blocked runs: {len([r for r in runs if r.get('status') in {'failed', 'blocked'}])}",
                f"Fallback runs used: {fallback_runs or 'none'}",
                f"Alert count: {len(alerts)}",
            ]
        )

    def _snapshot(self) -> Dict[str, Any]:
        return {
            "story": self.story.get("name", "unknown"),
            "mode": self.state["mode"],
            "loop_complete": self.state["loop_complete"],
            "queue_sizes": {lane: len(self.queues[lane]) for lane in LANE_ORDER},
            "runs": self.state["runs"],
            "alerts": self.state["alerts"],
            "events": self.state["events"],
            "scheduler": self.state["scheduler"],
            "interactions": self.state["interactions"],
            "artifacts": self.state["artifacts"],
        }


def _to_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _best_group(groups: Dict[str, List[float]]) -> Tuple[str, float]:
    if not groups:
        return ("none", 0.0)
    scored = [(name, mean(values)) for name, values in groups.items() if values]
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored[0]


def _parse_event_output(raw_text: str) -> Optional[Dict[str, Any]]:
    event_match = EVENT_OUTPUT_RE.search(raw_text)
    if not event_match:
        return None
    payload = json.loads(event_match.group(1))
    promise_match = PROMISE_RE.search(raw_text)
    if promise_match:
        payload["promise"] = promise_match.group(1)
    return payload


def load_story(story_path: Path) -> Dict[str, Any]:
    with story_path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def run_story(story_path: Path, output_dir: Optional[Path] = None, max_steps: int = 500) -> Dict[str, Any]:
    story_path = story_path.resolve()
    story_root = story_path.parent
    story = load_story(story_path)
    loop = ToyWildLoop(story=story, story_root=story_root)
    loop.enqueue(
        PromptEvent.from_dict(
            {
                "intent": "plan_sweep",
                "lane": "user_queued",
                "source": "user",
                "prompt_path": str(story_root / "prompts" / "seed_user_prompt.md"),
                "input_payload": {"story": story.get("name", "unnamed")},
                "retry_budget": 1,
            }
        )
    )
    summary = loop.run(max_steps=max_steps)

    if output_dir is None:
        output_dir = story_root / "expected"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")

    report = next((item for item in summary["artifacts"] if item.get("type") == "report"), None)
    if report:
        (output_dir / "final_report.md").write_text(report.get("content", ""), encoding="utf-8")

    with (output_dir / "interactions.jsonl").open("w", encoding="utf-8") as handle:
        for interaction in summary.get("interactions", []):
            handle.write(json.dumps(interaction, sort_keys=True) + "\n")

    timeline_lines = ["# Interaction Timeline", ""]
    for item in summary.get("interactions", []):
        timeline_lines.append(
            f"- {item['event_id']} | {item['intent']} | {item['result'].get('status')} | {item['result'].get('summary')}"
        )
    (output_dir / "timeline.md").write_text("\n".join(timeline_lines) + "\n", encoding="utf-8")
    return summary


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run toy wild-loop story")
    parser.add_argument("--story", required=True, help="Path to story.yaml")
    parser.add_argument("--out", required=False, help="Output directory")
    parser.add_argument("--max-steps", type=int, default=500, help="Max loop steps")
    parser.add_argument("--parse-event-output", required=False, help="Parse and print structured event output from text")
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    if args.parse_event_output:
        parsed = _parse_event_output(args.parse_event_output)
        print(json.dumps(parsed or {}, indent=2, sort_keys=True))
        return
    summary = run_story(story_path=Path(args.story), output_dir=Path(args.out).resolve() if args.out else None, max_steps=args.max_steps)
    print(json.dumps({"story": summary["story"], "loop_complete": summary["loop_complete"]}, indent=2))


if __name__ == "__main__":
    main()
