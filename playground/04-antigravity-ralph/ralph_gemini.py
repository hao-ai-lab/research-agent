#!/usr/bin/env python3
"""
Ralph Wiggum Loop for Google Gemini CLI (Antigravity-compatible)

Implements the Ralph Wiggum technique — an autonomous agentic loop where
the AI coding agent (Gemini CLI) receives the same prompt repeatedly until
it completes a task. Each iteration, the AI sees its previous work in files
and git history, enabling self-correction and incremental progress.

Based on: https://github.com/Th0rgal/open-ralph-wiggum
Technique: https://ghuntley.com/ralph/

Usage:
    python ralph_gemini.py "Build a REST API" --max-iterations 10
    python ralph_gemini.py "Fix tests" --model gemini-2.5-pro --yolo
    python ralph_gemini.py --status
    python ralph_gemini.py --add-context "Focus on auth module"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = "0.1.0"

# ── Paths ────────────────────────────────────────────────────────────────────

STATE_DIR = Path.cwd() / ".ralph"
STATE_PATH = STATE_DIR / "ralph-loop.state.json"
CONTEXT_PATH = STATE_DIR / "ralph-context.md"
HISTORY_PATH = STATE_DIR / "ralph-history.json"


# ── ANSI helpers ─────────────────────────────────────────────────────────────

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _c(code: int, text: str) -> str:
    return f"\x1b[{code}m{text}\x1b[0m"


def bold(t: str) -> str:
    return _c(1, t)


def green(t: str) -> str:
    return _c(32, t)


def yellow(t: str) -> str:
    return _c(33, t)


def red(t: str) -> str:
    return _c(31, t)


def cyan(t: str) -> str:
    return _c(36, t)


def dim(t: str) -> str:
    return _c(2, t)


# ── State persistence ───────────────────────────────────────────────────────


def _ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_state() -> dict[str, Any] | None:
    if not STATE_PATH.exists():
        return None
    try:
        return json.loads(STATE_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def save_state(state: dict[str, Any]) -> None:
    _ensure_state_dir()
    STATE_PATH.write_text(json.dumps(state, indent=2))


def clear_state() -> None:
    if STATE_PATH.exists():
        STATE_PATH.unlink(missing_ok=True)


def load_context() -> str | None:
    if not CONTEXT_PATH.exists():
        return None
    text = CONTEXT_PATH.read_text().strip()
    return text or None


def clear_context() -> None:
    if CONTEXT_PATH.exists():
        CONTEXT_PATH.unlink(missing_ok=True)


def load_history() -> dict[str, Any]:
    if not HISTORY_PATH.exists():
        return {
            "iterations": [],
            "totalDurationMs": 0,
            "struggleIndicators": {
                "repeatedErrors": {},
                "noProgressIterations": 0,
                "shortIterations": 0,
            },
        }
    try:
        return json.loads(HISTORY_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return load_history.__wrapped__()  # type: ignore[attr-defined]


def save_history(history: dict[str, Any]) -> None:
    _ensure_state_dir()
    HISTORY_PATH.write_text(json.dumps(history, indent=2))


def clear_history() -> None:
    if HISTORY_PATH.exists():
        HISTORY_PATH.unlink(missing_ok=True)


# ── Duration formatting ─────────────────────────────────────────────────────


def fmt_duration(ms: int) -> str:
    secs = max(0, ms // 1000)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


# ── File-change detection (via git) ──────────────────────────────────────────


def capture_file_snapshot() -> dict[str, str]:
    """Return {filepath: content_hash} for every tracked / modified file."""
    files: dict[str, str] = {}
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=10,
        )
        tracked = subprocess.run(
            ["git", "ls-files"],
            capture_output=True, text=True, timeout=10,
        )
        all_paths: set[str] = set()
        for line in status.stdout.splitlines():
            if line.strip():
                all_paths.add(line[3:].strip())
        for line in tracked.stdout.splitlines():
            if line.strip():
                all_paths.add(line.strip())

        for fpath in all_paths:
            p = Path(fpath)
            if p.exists() and p.is_file():
                try:
                    h = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
                    files[fpath] = h
                except OSError:
                    pass
    except (subprocess.SubprocessError, FileNotFoundError):
        pass
    return files


def modified_files(before: dict[str, str], after: dict[str, str]) -> list[str]:
    changed: list[str] = []
    for f, h in after.items():
        if before.get(f) != h:
            changed.append(f)
    for f in before:
        if f not in after:
            changed.append(f)
    return changed


# ── Error extraction ─────────────────────────────────────────────────────────


_ERROR_PATTERNS = re.compile(
    r"error:|failed:|exception:|typeerror|syntaxerror|referenceerror"
    r"|test.*fail",
    re.IGNORECASE,
)


def extract_errors(output: str) -> list[str]:
    errors: list[str] = []
    for line in output.splitlines():
        if _ERROR_PATTERNS.search(line):
            cleaned = line.strip()[:200]
            if cleaned and cleaned not in errors:
                errors.append(cleaned)
    return errors[:10]


# ── Prompt construction ──────────────────────────────────────────────────────


def build_prompt(
    goal: str,
    iteration: int,
    max_iterations: int,
    min_iterations: int,
    completion_promise: str,
    context: str | None = None,
) -> str:
    iter_label = (
        f"{iteration} / {max_iterations}"
        if max_iterations > 0
        else f"{iteration} (unlimited)"
    )

    context_section = ""
    if context:
        context_section = f"""
## Additional Context (added by user mid-loop)
{context}
"""

    return textwrap.dedent(f"""\
        # Ralph Wiggum Loop — Iteration {iteration}

        You are in an iterative development loop. The same prompt is sent to you
        each iteration. You see your previous work in the files and git history.
        Use that to make incremental progress.

        ## Your Main Goal
        {goal}

        ## Critical Rules
        - Work toward the goal described above.
        - When ALL work is truly complete and verified, output EXACTLY:
          <promise>{completion_promise}</promise>
        - Output the promise tag DIRECTLY — do not quote it, explain it, or say
          you "will" output it.
        - Do NOT lie or output a false promise to exit the loop.
        - If you are stuck, try a different approach.
        - Check your work before claiming completion.

        ## Current Iteration: {iter_label} (min: {min_iterations})
        {context_section}
        Now, work on the task. Good luck!
    """).strip()


# ── Completion detection ─────────────────────────────────────────────────────


def check_completion(output: str, promise_text: str) -> bool:
    """Check for <promise>TEXT</promise> in output (case-insensitive)."""
    pattern = re.compile(
        rf"<promise>\s*{re.escape(promise_text)}\s*</promise>",
        re.IGNORECASE,
    )
    return bool(pattern.search(strip_ansi(output)))


# ── Gemini CLI agent ─────────────────────────────────────────────────────────


def find_gemini_binary() -> str:
    """Locate the gemini CLI binary."""
    env_override = os.environ.get("RALPH_GEMINI_BINARY")
    if env_override:
        return env_override

    gemini = shutil.which("gemini")
    if gemini:
        return gemini

    raise FileNotFoundError(
        "Gemini CLI not found. Install it from https://github.com/google-gemini/gemini-cli\n"
        "  npm install -g @anthropic-ai/gemini-cli   # or see repo for instructions\n"
        "Or set RALPH_GEMINI_BINARY to the binary path."
    )


def run_gemini_iteration(
    binary: str,
    prompt: str,
    model: str | None = None,
    yolo: bool = False,
    sandbox: str | None = None,
    extra_flags: list[str] | None = None,
) -> tuple[str, str, int]:
    """
    Run one iteration of the Gemini CLI agent.

    Returns (stdout, stderr, exit_code).
    """
    cmd: list[str] = [binary, "-p", prompt]

    if model:
        cmd.extend(["-m", model])

    if yolo:
        cmd.append("--yolo")

    if sandbox:
        cmd.extend(["--sandbox", sandbox])

    if extra_flags:
        cmd.extend(extra_flags)

    print(dim(f"  → {' '.join(cmd[:4])}{'...' if len(cmd) > 4 else ''}"))

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,  # 10 min timeout per iteration
    )

    return proc.stdout, proc.stderr, proc.returncode


# ── Status command ───────────────────────────────────────────────────────────


def cmd_status() -> None:
    state = load_state()
    history_data = load_history() if HISTORY_PATH.exists() else None
    context = load_context()

    print()
    print(bold("╔══════════════════════════════════════════════════════════════╗"))
    print(bold("║              Ralph Wiggum Status (Gemini CLI)               ║"))
    print(bold("╚══════════════════════════════════════════════════════════════╝"))
    print()

    if state and state.get("active"):
        elapsed = int(
            (time.time() - datetime.fromisoformat(state["startedAt"]).timestamp())
            * 1000
        )
        print(f"  🔄 {bold('ACTIVE LOOP')}")
        max_iter = state.get("maxIterations", 0)
        iter_label = (
            f"{state['iteration']} / {max_iter}" if max_iter > 0 else f"{state['iteration']} (unlimited)"
        )
        print(f"     Iteration:  {iter_label}")
        print(f"     Started:    {state['startedAt']}")
        print(f"     Elapsed:    {fmt_duration(elapsed)}")
        print(f"     Promise:    {state.get('completionPromise', 'COMPLETE')}")
        print(f"     Model:      {state.get('model') or 'default'}")
        prompt_preview = state.get("prompt", "")[:60]
        if len(state.get("prompt", "")) > 60:
            prompt_preview += "..."
        print(f"     Prompt:     {prompt_preview}")
    else:
        print("  ⏹️  No active loop")

    if context:
        print(f"\n  📝 {bold('PENDING CONTEXT')} (will be injected next iteration):")
        for line in context.splitlines():
            print(f"     {line}")

    if history_data and history_data.get("iterations"):
        iters = history_data["iterations"]
        total_ms = history_data.get("totalDurationMs", 0)
        print(f"\n  📊 {bold('HISTORY')} ({len(iters)} iterations)")
        print(f"     Total time: {fmt_duration(total_ms)}")

        recent = iters[-5:]
        print("\n     Recent iterations:")
        for it in recent:
            dur = fmt_duration(it.get("durationMs", 0))
            files_n = len(it.get("filesModified", []))
            done = "✅" if it.get("completionDetected") else "⏳"
            print(f"     #{it['iteration']}  {dur}  {files_n} files  {done}")

        struggle = history_data.get("struggleIndicators", {})
        no_progress = struggle.get("noProgressIterations", 0)
        short = struggle.get("shortIterations", 0)
        if no_progress >= 3 or short >= 3:
            print(f"\n  ⚠️  {yellow('STRUGGLE INDICATORS:')}")
            if no_progress >= 3:
                print(f"     - No file changes in {no_progress} iterations")
            if short >= 3:
                print(f"     - {short} very short iterations (<30s)")
            print(f"\n     💡 Use: python {__file__} --add-context \"your hint\"")

    print()


# ── Add-context command ──────────────────────────────────────────────────────


def cmd_add_context(text: str) -> None:
    _ensure_state_dir()
    timestamp = datetime.now(timezone.utc).isoformat()
    entry = f"\n## Context added at {timestamp}\n{text}\n"

    if CONTEXT_PATH.exists():
        existing = CONTEXT_PATH.read_text()
        CONTEXT_PATH.write_text(existing + entry)
    else:
        CONTEXT_PATH.write_text(f"# Ralph Loop Context\n{entry}")

    print(green("✅ Context added for next iteration"))
    print(f"   File: {CONTEXT_PATH}")

    state = load_state()
    if state and state.get("active"):
        print(f"   Will be picked up in iteration {state['iteration'] + 1}")
    else:
        print("   Will be used when loop starts")


# ── Auto-commit ──────────────────────────────────────────────────────────────


def auto_commit(iteration: int) -> None:
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=10,
        )
        if status.stdout.strip():
            subprocess.run(["git", "add", "-A"], check=True, timeout=10)
            subprocess.run(
                ["git", "commit", "-m", f"Ralph iteration {iteration}: work in progress"],
                capture_output=True, check=True, timeout=30,
            )
            print(dim("  📝 Auto-committed changes"))
    except (subprocess.SubprocessError, FileNotFoundError):
        pass


# ── Main loop ────────────────────────────────────────────────────────────────


def run_ralph_loop(args: argparse.Namespace) -> None:
    # Validate Gemini CLI is available
    try:
        gemini_bin = find_gemini_binary()
    except FileNotFoundError as e:
        print(red(f"❌ {e}"))
        sys.exit(1)

    # Check for version
    try:
        ver = subprocess.run(
            [gemini_bin, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        gemini_version = ver.stdout.strip().splitlines()[0] if ver.stdout.strip() else "unknown"
    except (subprocess.SubprocessError, IndexError):
        gemini_version = "unknown"

    prompt = args.prompt
    max_iterations: int = args.max_iterations
    min_iterations: int = args.min_iterations
    completion_promise: str = args.completion_promise
    model: str | None = args.model
    yolo: bool = args.yolo
    no_commit: bool = args.no_commit

    # Check for resume
    existing = load_state()
    resuming = bool(existing and existing.get("active"))
    if resuming and existing:
        prompt = existing["prompt"]
        max_iterations = existing.get("maxIterations", max_iterations)
        min_iterations = existing.get("minIterations", min_iterations)
        completion_promise = existing.get("completionPromise", completion_promise)
        model = existing.get("model", model)
        print(cyan("🔄 Resuming Ralph loop from saved state"))

    print()
    print(bold("╔══════════════════════════════════════════════════════════════╗"))
    print(bold("║          Ralph Wiggum Loop — Gemini CLI Agent               ║"))
    print(bold("╚══════════════════════════════════════════════════════════════╝"))
    print()
    print(f"  Agent:      Gemini CLI ({gemini_version})")
    print(f"  Model:      {model or 'default'}")
    print(f"  Promise:    {completion_promise}")
    print(f"  Min iters:  {min_iterations}")
    print(f"  Max iters:  {max_iterations if max_iterations > 0 else 'unlimited'}")

    prompt_preview = prompt.replace("\n", " ")[:80]
    if len(prompt) > 80:
        prompt_preview += "..."
    print(f"  Task:       {prompt_preview}")
    if yolo:
        print(f"  Permissions: {yellow('auto-approve all tools (--yolo)')}")
    print()
    print("  Starting loop... (Ctrl+C to stop)")
    print("  " + "═" * 58)

    # Initialize state
    state: dict[str, Any] = existing if resuming and existing else {
        "active": True,
        "iteration": 1,
        "minIterations": min_iterations,
        "maxIterations": max_iterations,
        "completionPromise": completion_promise,
        "prompt": prompt,
        "model": model,
        "agent": "gemini-cli",
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    if not resuming:
        save_state(state)

    history = load_history() if resuming else {
        "iterations": [],
        "totalDurationMs": 0,
        "struggleIndicators": {
            "repeatedErrors": {},
            "noProgressIterations": 0,
            "shortIterations": 0,
        },
    }
    if not resuming:
        save_history(history)

    # Main loop
    try:
        while True:
            iteration = state["iteration"]

            # Check max iterations
            if max_iterations > 0 and iteration > max_iterations:
                print()
                print(bold(f"  ⏹️  Max iterations ({max_iterations}) reached."))
                print(f"     Total time: {fmt_duration(history['totalDurationMs'])}")
                clear_state()
                break

            iter_label = (
                f"{iteration} / {max_iterations}"
                if max_iterations > 0
                else str(iteration)
            )
            min_note = (
                f" (min: {min_iterations})"
                if min_iterations > 1 and iteration < min_iterations
                else ""
            )
            print(f"\n  🔄 Iteration {iter_label}{min_note}")
            print("  " + "─" * 58)

            # Capture pre-iteration state
            context_at_start = load_context()
            snapshot_before = capture_file_snapshot()
            iter_start = time.time()

            # Build prompt
            full_prompt = build_prompt(
                goal=prompt,
                iteration=iteration,
                max_iterations=max_iterations,
                min_iterations=min_iterations,
                completion_promise=completion_promise,
                context=context_at_start,
            )

            # Run agent
            try:
                stdout, stderr, exit_code = run_gemini_iteration(
                    binary=gemini_bin,
                    prompt=full_prompt,
                    model=model,
                    yolo=yolo,
                )
            except subprocess.TimeoutExpired:
                print(yellow("  ⚠️  Iteration timed out (10 min). Continuing..."))
                stdout, stderr, exit_code = "", "TIMEOUT", 1

            iter_duration_ms = int((time.time() - iter_start) * 1000)

            # Print output
            if stdout.strip():
                print()
                for line in stdout.splitlines():
                    print(f"  │ {line}")
                print()

            if stderr.strip():
                print(dim(f"  stderr: {stderr.strip()[:200]}"))

            # Detect completion
            combined = f"{stdout}\n{stderr}"
            completion_detected = check_completion(combined, completion_promise)

            # Capture post-iteration state
            snapshot_after = capture_file_snapshot()
            files_changed = modified_files(snapshot_before, snapshot_after)
            errors = extract_errors(combined)

            # Print iteration summary
            status_icon = green("✅") if completion_detected else "⏳"
            files_label = (
                green(f"{len(files_changed)} files")
                if files_changed
                else dim("0 files")
            )
            exit_label = (
                green(f"exit {exit_code}")
                if exit_code == 0
                else yellow(f"exit {exit_code}")
            )
            print(
                f"  {status_icon} Iteration {iteration}: "
                f"{fmt_duration(iter_duration_ms)}  "
                f"{files_label}  "
                f"{exit_label}"
            )
            if files_changed:
                for f in files_changed[:5]:
                    print(dim(f"     · {f}"))
                if len(files_changed) > 5:
                    print(dim(f"     · ... and {len(files_changed) - 5} more"))

            # Record history
            record = {
                "iteration": iteration,
                "startedAt": datetime.fromtimestamp(iter_start, tz=timezone.utc).isoformat(),
                "endedAt": datetime.now(timezone.utc).isoformat(),
                "durationMs": iter_duration_ms,
                "agent": "gemini-cli",
                "model": model or "default",
                "filesModified": files_changed,
                "exitCode": exit_code,
                "completionDetected": completion_detected,
                "errors": errors,
            }
            history["iterations"].append(record)
            history["totalDurationMs"] += iter_duration_ms

            # Struggle detection
            struggle = history["struggleIndicators"]
            if not files_changed:
                struggle["noProgressIterations"] += 1
            else:
                struggle["noProgressIterations"] = 0
            if iter_duration_ms < 30_000:
                struggle["shortIterations"] += 1
            else:
                struggle["shortIterations"] = 0
            if not errors:
                struggle["repeatedErrors"] = {}
            else:
                for err in errors:
                    key = err[:100]
                    struggle["repeatedErrors"][key] = (
                        struggle["repeatedErrors"].get(key, 0) + 1
                    )
            save_history(history)

            # Struggle warning
            if iteration > 2 and (
                struggle["noProgressIterations"] >= 3
                or struggle["shortIterations"] >= 3
            ):
                print(yellow("\n  ⚠️  Potential struggle detected:"))
                if struggle["noProgressIterations"] >= 3:
                    print(f"     - No file changes in {struggle['noProgressIterations']} iterations")
                if struggle["shortIterations"] >= 3:
                    print(f"     - {struggle['shortIterations']} very short iterations")
                print(f"     💡 Tip: python {__file__} --add-context \"hint\"")

            # Non-zero exit warning
            if exit_code != 0:
                print(yellow(f"\n  ⚠️  Gemini CLI exited with code {exit_code}. Continuing..."))

            # Completion check
            if completion_detected:
                if iteration < min_iterations:
                    print(f"\n  ⏳ Completion detected, but min iterations ({min_iterations}) not reached.")
                    print(f"     Continuing to iteration {iteration + 1}...")
                else:
                    print()
                    print(bold(green("  ╔══════════════════════════════════════════════════════════╗")))
                    print(bold(green(f"  ║  ✅ Task completed in {iteration} iteration(s)")))
                    print(bold(green(f"  ║  Total time: {fmt_duration(history['totalDurationMs'])}")))
                    print(bold(green("  ╚══════════════════════════════════════════════════════════╝")))
                    clear_state()
                    clear_history()
                    clear_context()
                    break

            # Clear consumed context
            if context_at_start:
                print(dim("  📝 Context consumed this iteration"))
                clear_context()

            # Auto-commit
            if not no_commit:
                auto_commit(iteration)

            # Advance
            state["iteration"] += 1
            save_state(state)

            # Brief pause between iterations
            time.sleep(1)

    except KeyboardInterrupt:
        print(yellow("\n\n  ⏹️  Loop stopped by user (Ctrl+C)"))
        clear_state()
        print(f"     Completed {state['iteration'] - 1} iteration(s)")
        print(f"     Total time: {fmt_duration(history['totalDurationMs'])}")
        sys.exit(0)


# ── CLI ──────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ralph Wiggum Loop — Iterative AI development with Gemini CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              %(prog)s "Build a REST API for todos" --max-iterations 10
              %(prog)s "Fix failing tests" --model gemini-2.5-pro --yolo
              %(prog)s --status
              %(prog)s --add-context "Focus on the auth module"

            How it works:
              1. Sends your prompt to Gemini CLI (non-interactive mode)
              2. Gemini works on the task, modifies files
              3. Ralph checks output for <promise>COMPLETE</promise>
              4. If not found, repeats with the same prompt
              5. Gemini sees its previous work in files & git
              6. Loop until success or max iterations

            Based on: https://github.com/Th0rgal/open-ralph-wiggum
            Technique: https://ghuntley.com/ralph/
        """),
    )

    parser.add_argument("--version", "-v", action="version", version=f"ralph-gemini {VERSION}")

    # Subcommands via flags
    parser.add_argument("--status", action="store_true", help="Show current loop status and history")
    parser.add_argument("--add-context", metavar="TEXT", help="Add context/hint for next iteration")
    parser.add_argument("--clear-context", action="store_true", help="Clear pending context")

    # Main loop options
    parser.add_argument("prompt", nargs="?", default="", help="Task description for the AI")
    parser.add_argument("--min-iterations", type=int, default=1, help="Minimum iterations before completion allowed (default: 1)")
    parser.add_argument("--max-iterations", type=int, default=0, help="Maximum iterations (0 = unlimited, default: 0)")
    parser.add_argument("--completion-promise", default="COMPLETE", help="Phrase that signals completion (default: COMPLETE)")
    parser.add_argument("--model", "-m", default=None, help="Gemini model to use (e.g., gemini-2.5-pro)")
    parser.add_argument("--yolo", action="store_true", help="Auto-approve all tool permissions")
    parser.add_argument("--no-commit", action="store_true", help="Don't auto-commit after each iteration")

    args = parser.parse_args()

    # Route to subcommands
    if args.status:
        cmd_status()
        return

    if args.add_context:
        cmd_add_context(args.add_context)
        return

    if args.clear_context:
        clear_context()
        print(green("✅ Context cleared"))
        return

    # Main loop requires a prompt
    if not args.prompt:
        parser.print_help()
        sys.exit(1)

    run_ralph_loop(args)


if __name__ == "__main__":
    main()
