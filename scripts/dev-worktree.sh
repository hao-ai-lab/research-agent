#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_NAME="$(basename "$ROOT_DIR")"
WORKTREE_HASH="$(printf "%s" "$ROOT_DIR" | shasum | awk '{print $1}')"
PORT_OFFSET="$((16#${WORKTREE_HASH:0:4} % 400))"

FRONTEND_PORT="${FRONTEND_PORT:-$((3000 + PORT_OFFSET))}"
BACKEND_PORT="${BACKEND_PORT:-$((10000 + PORT_OFFSET))}"
SANITIZED_WORKTREE_NAME="$(printf "%s" "$WORKTREE_NAME" | tr -cs 'A-Za-z0-9_-' '-')"
TMUX_SESSION_NAME="${RESEARCH_AGENT_TMUX_SESSION:-research-agent-${SANITIZED_WORKTREE_NAME}}"

START_FRONTEND="${START_FRONTEND:-1}"
START_BACKEND="${START_BACKEND:-1}"

export NEXT_PUBLIC_API_URL="http://127.0.0.1:${BACKEND_PORT}"
export RESEARCH_AGENT_TMUX_SESSION="${TMUX_SESSION_NAME}"

echo "Worktree: ${WORKTREE_NAME}"
echo "Frontend: http://127.0.0.1:${FRONTEND_PORT}"
echo "Backend:  http://127.0.0.1:${BACKEND_PORT}"
echo "Tmux:     ${TMUX_SESSION_NAME}"
echo ""

pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup INT TERM EXIT

if [ "$START_BACKEND" = "1" ]; then
  (
    cd "${ROOT_DIR}/server"
    python3 server.py \
      --workdir "${ROOT_DIR}" \
      --host 127.0.0.1 \
      --port "${BACKEND_PORT}" \
      --tmux-session "${TMUX_SESSION_NAME}"
  ) &
  pids+=("$!")
fi

if [ "$START_FRONTEND" = "1" ]; then
  (
    cd "${ROOT_DIR}"
    npm run dev -- --port "${FRONTEND_PORT}"
  ) &
  pids+=("$!")
fi

if [ "${#pids[@]}" -eq 0 ]; then
  echo "Nothing to start (START_FRONTEND=0 and START_BACKEND=0)."
  exit 1
fi

wait -n "${pids[@]}"
exit_code=$?
cleanup
wait || true
exit "$exit_code"
