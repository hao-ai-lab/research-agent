#!/usr/bin/env python3
"""
Notebook Kernel Worker

A tiny line-oriented JSON kernel used by the Report notebook panel.
Each input line must be a JSON object:
  {"id": "exec-id", "code": "print('hello')"}

The kernel keeps state across executions and emits one response line per request:
  __RA_NOTEBOOK_RESPONSE__{"id": ..., "stdout": ..., "stderr": ..., "result": ..., "error": ...}
"""

import ast
import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from typing import Any, Dict

RESPONSE_PREFIX = "__RA_NOTEBOOK_RESPONSE__"


def build_result(code: str, globals_ns: Dict[str, Any]) -> Dict[str, Any]:
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()

    result_text = None
    error_text = None

    try:
        tree = ast.parse(code, mode="exec")

        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                head = tree.body[:-1]
                tail = tree.body[-1]

                if head:
                    exec(compile(ast.Module(body=head, type_ignores=[]), "<notebook>", "exec"), globals_ns)

                value = eval(compile(ast.Expression(body=tail.value), "<notebook>", "eval"), globals_ns)
                if value is not None:
                    result_text = repr(value)
            else:
                exec(compile(tree, "<notebook>", "exec"), globals_ns)
    except Exception:
        error_text = traceback.format_exc()

    return {
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "result": result_text,
        "error": error_text,
    }


def main() -> int:
    globals_ns: Dict[str, Any] = {
        "__name__": "__main__",
        "__package__": None,
    }

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        response: Dict[str, Any]
        request_id = "unknown"

        try:
            payload = json.loads(line)
            request_id = str(payload.get("id") or "unknown")
            code = str(payload.get("code") or "")
            response = {"id": request_id, **build_result(code, globals_ns)}
        except Exception:
            response = {
                "id": request_id,
                "stdout": "",
                "stderr": "",
                "result": None,
                "error": traceback.format_exc(),
            }

        print(f"{RESPONSE_PREFIX}{json.dumps(response, ensure_ascii=True)}", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
