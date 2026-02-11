#!/usr/bin/env bash
# worktree-setup.sh — Bootstrap a git worktree for research-agent development.
#
# Usage:
#   bash scripts/worktree-setup.sh              # bootstrap this worktree
#   bash scripts/worktree-setup.sh --install-hook  # also install post-checkout hook
#
# This script is idempotent — safe to rerun after dependency changes.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SENTINEL="${ROOT_DIR}/.worktree-initialized"

# ───────────────────────── colours ──────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # no colour

info()  { printf "${CYAN}▸ %s${NC}\n" "$*"; }
ok()    { printf "${GREEN}✔ %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$*"; }

# ───────────────────── install hook flag ────────────────────
if [[ "${1:-}" == "--install-hook" ]]; then
  # Find the git common dir (shared across worktrees)
  GIT_COMMON="$(git -C "${ROOT_DIR}" rev-parse --git-common-dir)"
  HOOK_DIR="${GIT_COMMON}/hooks"
  mkdir -p "${HOOK_DIR}"

  cat > "${HOOK_DIR}/post-checkout" << 'HOOK'
#!/usr/bin/env bash
# Auto-run worktree-setup.sh on branch checkouts (arg $3 == 1).
# Installed by: scripts/worktree-setup.sh --install-hook
if [ "$3" = "1" ] && [ -f "scripts/worktree-setup.sh" ]; then
  bash scripts/worktree-setup.sh
fi
HOOK
  chmod +x "${HOOK_DIR}/post-checkout"
  ok "Installed post-checkout hook at ${HOOK_DIR}/post-checkout"
  exit 0
fi

# ───────────────────── main bootstrap ───────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   research-agent  worktree bootstrap     ║"
echo "╚══════════════════════════════════════════╝"
echo ""
info "Root: ${ROOT_DIR}"

# 1. Node dependencies
if command -v pnpm &>/dev/null; then
  info "Installing Node dependencies (pnpm install)…"
  (cd "${ROOT_DIR}" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
  ok "Node dependencies installed"
else
  warn "pnpm not found — skipping Node install. Run 'npm install -g pnpm' first."
fi

# 2. Python virtual-env + server deps
VENV_DIR="${ROOT_DIR}/.ra-venv"
REQ_FILE="${ROOT_DIR}/server/requirements.txt"

if [ -f "${REQ_FILE}" ]; then
  if [ ! -d "${VENV_DIR}" ]; then
    info "Creating Python venv at .ra-venv…"
    python3 -m venv "${VENV_DIR}"
  fi
  info "Installing Python dependencies…"
  "${VENV_DIR}/bin/pip" install -q -r "${REQ_FILE}"
  ok "Python dependencies installed"
else
  warn "server/requirements.txt not found — skipping Python setup."
fi

# 3. Copy .env.local from the main worktree (if available)
MAIN_WORKTREE="$(git -C "${ROOT_DIR}" worktree list --porcelain \
  | grep '^worktree ' | head -1 | sed 's/^worktree //')"

if [ -n "${MAIN_WORKTREE}" ] && [ "${MAIN_WORKTREE}" != "${ROOT_DIR}" ]; then
  for envfile in .env.local .env; do
    SRC="${MAIN_WORKTREE}/${envfile}"
    DST="${ROOT_DIR}/${envfile}"
    if [ -f "${SRC}" ] && [ ! -f "${DST}" ]; then
      cp "${SRC}" "${DST}"
      ok "Copied ${envfile} from main worktree"
    fi
  done
else
  info "This appears to be the main worktree — skipping .env copy."
fi

# 4. Sentinel
touch "${SENTINEL}"
ok "Worktree initialized (${SENTINEL})"

# 5. Next steps
echo ""
echo "┌──────────────────────────────────────────┐"
echo "│  Ready!  Start dev servers with:         │"
echo "│                                          │"
echo "│    pnpm dev:worktree                     │"
echo "│                                          │"
echo "└──────────────────────────────────────────┘"
echo ""
