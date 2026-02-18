"""Git diff/file helpers extracted from server.py."""

import os
import re
import subprocess
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GIT_DIFF_MAX_LINES_PER_FILE = 400
GIT_DIFF_DEFAULT_FILE_LIMIT = 200
GIT_FILES_DEFAULT_LIMIT = 5000
GIT_FILE_MAX_BYTES = 120000
_HUNK_HEADER_RE = re.compile(r"^@@ -(?P<old>\d+)(?:,\d+)? \+(?P<new>\d+)(?:,\d+)? @@")


# ---------------------------------------------------------------------------
# Functions — accept *workdir* so the module stays free of global state.
# ---------------------------------------------------------------------------

def _run_git_command(args: List[str], workdir: str, timeout_seconds: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", workdir, *args],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _is_git_repo(workdir: str) -> bool:
    try:
        result = _run_git_command(["rev-parse", "--is-inside-work-tree"], workdir, timeout_seconds=5)
    except Exception:
        return False
    return result.returncode == 0 and result.stdout.strip() == "true"


def _collect_changed_files(workdir: str, limit: int) -> List[Dict[str, str]]:
    files_by_path: Dict[str, str] = {}

    diff_names = _run_git_command(["diff", "--name-status", "-z", "HEAD", "--"], workdir, timeout_seconds=15)
    if diff_names.returncode != 0:
        raise RuntimeError(diff_names.stderr.strip() or "Failed to list git diff files")

    tokens = [token for token in diff_names.stdout.split("\x00") if token]
    index = 0
    while index < len(tokens):
        status_token = tokens[index]
        status_code = status_token[:1] if status_token else "M"
        index += 1

        path = ""
        if status_code in {"R", "C"}:
            if index + 1 >= len(tokens):
                break
            index += 1  # Skip old path
            path = tokens[index]
            index += 1
            status_code = "M"
        else:
            if index >= len(tokens):
                break
            path = tokens[index]
            index += 1

        if not path:
            continue

        status = "modified"
        if status_code == "A":
            status = "added"
        elif status_code == "D":
            status = "deleted"
        files_by_path[path] = status

    untracked = _run_git_command(["ls-files", "--others", "--exclude-standard", "-z"], workdir, timeout_seconds=10)
    if untracked.returncode == 0:
        for path in untracked.stdout.split("\x00"):
            if path:
                files_by_path[path] = "added"

    changed = [
        {"path": path, "status": files_by_path[path]}
        for path in sorted(files_by_path.keys())
    ]
    return changed[:limit]


def _parse_unified_diff(diff_text: str, max_lines: int = GIT_DIFF_MAX_LINES_PER_FILE) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    old_line: Optional[int] = None
    new_line: Optional[int] = None

    for raw_line in diff_text.splitlines():
        if raw_line.startswith(("diff --git ", "index ", "--- ", "+++ ")):
            continue

        if raw_line.startswith("Binary files "):
            parsed.append(
                {"type": "hunk", "text": "Binary file changed.", "oldLine": None, "newLine": None}
            )
            break

        if raw_line.startswith("\\ No newline at end of file"):
            continue

        if raw_line.startswith("@@"):
            match = _HUNK_HEADER_RE.match(raw_line)
            if match:
                old_line = int(match.group("old"))
                new_line = int(match.group("new"))
            else:
                old_line = None
                new_line = None

            parsed.append({"type": "hunk", "text": raw_line, "oldLine": None, "newLine": None})

        elif raw_line.startswith("+"):
            parsed.append({"type": "add", "text": raw_line[1:], "oldLine": None, "newLine": new_line})
            if new_line is not None:
                new_line += 1

        elif raw_line.startswith("-"):
            parsed.append({"type": "remove", "text": raw_line[1:], "oldLine": old_line, "newLine": None})
            if old_line is not None:
                old_line += 1

        elif raw_line.startswith(" "):
            parsed.append({"type": "context", "text": raw_line[1:], "oldLine": old_line, "newLine": new_line})
            if old_line is not None:
                old_line += 1
            if new_line is not None:
                new_line += 1

        if len(parsed) >= max_lines:
            parsed.append(
                {
                    "type": "hunk",
                    "text": f"... diff truncated to {max_lines} lines ...",
                    "oldLine": None,
                    "newLine": None,
                }
            )
            break

    return parsed


def _build_untracked_file_lines(path: str, workdir: str, max_lines: int = GIT_DIFF_MAX_LINES_PER_FILE) -> List[Dict[str, Any]]:
    workdir_real = os.path.realpath(workdir)
    file_path = os.path.realpath(os.path.join(workdir, path))

    if not (file_path == workdir_real or file_path.startswith(workdir_real + os.sep)):
        return [{"type": "hunk", "text": "Invalid path outside repository.", "oldLine": None, "newLine": None}]

    if not os.path.exists(file_path):
        return [{"type": "hunk", "text": "File not found in working tree.", "oldLine": None, "newLine": None}]

    try:
        with open(file_path, "rb") as handle:
            content = handle.read()
    except Exception as exc:
        return [{"type": "hunk", "text": f"Unable to read file: {exc}", "oldLine": None, "newLine": None}]

    if b"\x00" in content:
        return [{"type": "hunk", "text": "Binary file added.", "oldLine": None, "newLine": None}]

    lines = content.decode("utf-8", errors="replace").splitlines()
    parsed: List[Dict[str, Any]] = [
        {"type": "hunk", "text": f"@@ -0,0 +1,{len(lines)} @@", "oldLine": None, "newLine": None}
    ]

    if not lines:
        parsed.append({"type": "add", "text": "", "oldLine": None, "newLine": 1})
        return parsed

    for line_number, line_text in enumerate(lines[:max_lines], start=1):
        parsed.append({"type": "add", "text": line_text, "oldLine": None, "newLine": line_number})

    if len(lines) > max_lines:
        parsed.append(
            {
                "type": "hunk",
                "text": f"... file truncated to {max_lines} lines ...",
                "oldLine": None,
                "newLine": None,
            }
        )

    return parsed


def _build_file_diff(path: str, status: str, unified: int, workdir: str) -> Dict[str, Any]:
    lines: List[Dict[str, Any]] = []

    if status == "added":
        tracked_check = _run_git_command(["ls-files", "--error-unmatch", "--", path], workdir, timeout_seconds=5)
        if tracked_check.returncode == 0:
            diff_result = _run_git_command(
                ["diff", "--no-color", f"--unified={unified}", "HEAD", "--", path],
                workdir,
                timeout_seconds=20,
            )
            if diff_result.returncode == 0:
                lines = _parse_unified_diff(diff_result.stdout)
            else:
                lines = [{"type": "hunk", "text": "Unable to render file diff.", "oldLine": None, "newLine": None}]
        else:
            lines = _build_untracked_file_lines(path, workdir)
    else:
        diff_result = _run_git_command(
            ["diff", "--no-color", f"--unified={unified}", "HEAD", "--", path],
            workdir,
            timeout_seconds=20,
        )
        if diff_result.returncode == 0:
            lines = _parse_unified_diff(diff_result.stdout)
        else:
            lines = [{"type": "hunk", "text": "Unable to render file diff.", "oldLine": None, "newLine": None}]

    if not lines:
        if status == "deleted":
            lines = [{"type": "hunk", "text": "File deleted with no textual hunks.", "oldLine": None, "newLine": None}]
        elif status == "added":
            lines = [{"type": "hunk", "text": "New file with no textual content.", "oldLine": None, "newLine": None}]
        else:
            lines = [{"type": "hunk", "text": "No textual diff available.", "oldLine": None, "newLine": None}]

    additions = sum(1 for line in lines if line.get("type") == "add")
    deletions = sum(1 for line in lines if line.get("type") == "remove")

    return {
        "path": path,
        "status": status,
        "additions": additions,
        "deletions": deletions,
        "lines": lines,
    }


def _resolve_repo_path(relative_path: str, workdir: str) -> Optional[str]:
    """Resolve repository-relative file path and block traversal outside workdir."""
    if not relative_path:
        return None

    normalized = relative_path.strip().replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
        return None

    repo_root = os.path.realpath(workdir)
    target = os.path.realpath(os.path.join(workdir, normalized))

    if target == repo_root or target.startswith(repo_root + os.sep):
        return target
    return None
