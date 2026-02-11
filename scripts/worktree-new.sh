#!/usr/bin/env bash
# worktree-new.sh — One-command worktree creation for research-agent.
#
# Usage:
#   bash scripts/worktree-new.sh <branch>               # create & bootstrap
#   bash scripts/worktree-new.sh <branch> --ide agy      # …and open Antigravity
#   bash scripts/worktree-new.sh <branch> --start        # …and start dev servers
#   bash scripts/worktree-new.sh <branch> --ide agy --start
#
# Configuration (in .env.worktree at repo root, or env vars):
#   WORKTREE_ROOT=/path/to/worktrees   # where worktrees are placed
#
# If WORKTREE_ROOT is not set, defaults to the parent of this repo
# (i.e. sibling directories).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── colours ─────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${CYAN}▸ %s${NC}\n" "$*"; }
ok()    { printf "${GREEN}✔ %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$*"; }
err()   { printf "${RED}✘ %s${NC}\n" "$*" >&2; }

# ── parse args ──────────────────────────────────────────────
BRANCH=""
IDE=""
START=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ide)   IDE="${2:-}"; shift 2 ;;
    --start) START=true; shift ;;
    --help|-h)
      echo "Usage: $(basename "$0") <branch> [--ide agy|code] [--start]"
      echo ""
      echo "Creates a git worktree, bootstraps dependencies, and optionally"
      echo "opens an IDE and starts dev servers."
      echo ""
      echo "Options:"
      echo "  --ide <name>   Open worktree in IDE (agy, code)"
      echo "  --start        Start dev servers after setup"
      echo ""
      echo "Configure WORKTREE_ROOT in .env.worktree or as an env var."
      exit 0
      ;;
    -*)
      err "Unknown option: $1"
      echo "Run '$(basename "$0") --help' for usage."
      exit 1
      ;;
    *)
      if [ -z "$BRANCH" ]; then
        BRANCH="$1"
      else
        err "Unexpected argument: $1"
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$BRANCH" ]; then
  err "Branch name required."
  echo "Usage: $(basename "$0") <branch> [--ide agy|code] [--start]"
  exit 1
fi

# ── load config ─────────────────────────────────────────────
ENV_FILE="${REPO_DIR}/.env.worktree"
if [ -f "${ENV_FILE}" ]; then
  # Source only WORKTREE_ROOT (safe, no eval of arbitrary code)
  _wt_root="$(grep -E '^WORKTREE_ROOT=' "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [ -n "${_wt_root}" ]; then
    WORKTREE_ROOT="${WORKTREE_ROOT:-${_wt_root}}"
  fi
fi

# Default: sibling directory to this repo
WORKTREE_ROOT="${WORKTREE_ROOT:-$(dirname "${REPO_DIR}")}"

# Expand ~ if present
WORKTREE_ROOT="${WORKTREE_ROOT/#\~/$HOME}"

# ── derive paths ────────────────────────────────────────────
REPO_NAME="$(basename "${REPO_DIR}")"
SANITIZED_BRANCH="$(printf "%s" "${BRANCH}" | tr '/' '-')"
WORKTREE_DIR="${WORKTREE_ROOT}/${REPO_NAME}-${SANITIZED_BRANCH}"

# ── banner ──────────────────────────────────────────────────
echo ""
printf "${BOLD}╔══════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║   research-agent  worktree · new             ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════╝${NC}\n"
echo ""
info "Branch:    ${BRANCH}"
info "Directory: ${WORKTREE_DIR}"
echo ""

# ── create worktree ─────────────────────────────────────────
if [ -d "${WORKTREE_DIR}" ]; then
  warn "Directory already exists: ${WORKTREE_DIR}"
  # Check if it's already a worktree
  if git -C "${REPO_DIR}" worktree list --porcelain | grep -q "^worktree ${WORKTREE_DIR}$"; then
    warn "Already a registered worktree. Skipping creation."
  else
    err "Directory exists but is not a worktree. Aborting."
    exit 1
  fi
else
  mkdir -p "${WORKTREE_ROOT}"
  # Check if branch already exists
  if git -C "${REPO_DIR}" show-ref --verify --quiet "refs/heads/${BRANCH}" 2>/dev/null; then
    info "Branch '${BRANCH}' exists — checking out…"
    git -C "${REPO_DIR}" worktree add "${WORKTREE_DIR}" "${BRANCH}"
  else
    info "Creating new branch '${BRANCH}' from HEAD…"
    git -C "${REPO_DIR}" worktree add "${WORKTREE_DIR}" -b "${BRANCH}"
  fi
  ok "Worktree created"
fi

# ── bootstrap ──────────────────────────────────────────────
info "Running worktree-setup.sh…"
# Use the script from this repo (it may not be committed to the worktree yet)
WORKTREE_SETUP="${SCRIPT_DIR}/worktree-setup.sh"
if [ ! -f "${WORKTREE_SETUP}" ]; then
  err "Cannot find worktree-setup.sh at ${WORKTREE_SETUP}"
  exit 1
fi
# Run the setup script in the context of the new worktree
ROOT_DIR="${WORKTREE_DIR}" bash "${WORKTREE_SETUP}"
ok "Bootstrap complete"

# ── open IDE ───────────────────────────────────────────────
if [ -n "${IDE}" ]; then
  case "${IDE}" in
    agy|antigravity)
      if command -v agy &>/dev/null; then
        info "Opening in Antigravity…"
        agy "${WORKTREE_DIR}" &
        ok "Antigravity launched"
      else
        err "'agy' not found in PATH."
      fi
      ;;
    code|vscode)
      info "Opening in VS Code…"
      code "${WORKTREE_DIR}" &
      ok "VS Code launched"
      ;;
    *)
      warn "Unknown IDE '${IDE}'. Supported: agy, code"
      ;;
  esac
fi

# ── start dev servers ──────────────────────────────────────
if [ "$START" = true ]; then
  echo ""
  info "Starting dev servers…"
  # Prefer the worktree's own copy; fall back to source repo's script
  DEV_SCRIPT="${WORKTREE_DIR}/scripts/dev-worktree.sh"
  if [ ! -f "${DEV_SCRIPT}" ]; then
    DEV_SCRIPT="${SCRIPT_DIR}/dev-worktree.sh"
  fi
  cd "${WORKTREE_DIR}" && exec bash "${DEV_SCRIPT}"
else
  echo ""
  echo "┌───────────────────────────────────────────────┐"
  echo "│  Ready!  To start dev servers:                │"
  echo "│                                               │"
  printf "│  cd %s\n" "${WORKTREE_DIR}"
  echo "│  pnpm dev:worktree                            │"
  echo "│                                               │"
  echo "└───────────────────────────────────────────────┘"
  echo ""
fi
