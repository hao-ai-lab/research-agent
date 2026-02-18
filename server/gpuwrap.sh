#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_BIN="${PYTHON_BIN:-python3}"

exec "$PY_BIN" "$SCRIPT_DIR/gpuwrap_runner.py" "$@"
