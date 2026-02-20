#!/usr/bin/env python3
"""
Stdin-to-stdout filter that strips ANSI escape codes.

Used by job_sidecar.py as the pipe-pane filter so that run.log
is written clean — no server-side stripping needed on every read.

Usage:  tmux pipe-pane "python3 strip_ansi_filter.py >> run.log"
"""

import re
import sys

_ANSI_RE = re.compile(
    r"""
    \x1b
    (?:
        \[  [0-9;?]* [ -/]* [@-~]   # CSI  (colors, cursor, erase)
      | \]  .*? (?:\x07|\x1b\\)      # OSC  (window title, etc.)
      | [()][A-Z0-9]                 # charset designation
      | [^[\]() \x1b]               # other single-char escapes
    )
    """,
    re.VERBOSE,
)

# Collapse CR-based overwrite lines (progress bars) to just the final version.
_CR_OVERWRITE_RE = re.compile(r"^.*\r(?!\n)", re.MULTILINE)

if __name__ == "__main__":
    for line in sys.stdin:
        line = _ANSI_RE.sub("", line)
        line = _CR_OVERWRITE_RE.sub("", line)
        sys.stdout.write(line)
        sys.stdout.flush()
