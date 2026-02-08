#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

python3 "${ROOT_DIR}/loop/loop.py" \
  --story "${SCRIPT_DIR}/story.yaml" \
  --out "${SCRIPT_DIR}/expected"

echo
echo "=== DIT STORY REPORT ==="
cat "${SCRIPT_DIR}/expected/final_report.md"
