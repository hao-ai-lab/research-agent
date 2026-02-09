#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
OUT_DIR="${ROOT_DIR}/out"
ARCHIVE="${DIST_DIR}/research-agent-frontend-static.tar.gz"

log() {
  printf '[build-frontend] %s\n' "$*"
}

die() {
  printf '[build-frontend] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || die "npm is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

mkdir -p "$DIST_DIR"
rm -rf "$OUT_DIR"

if [ ! -d "${ROOT_DIR}/node_modules" ]; then
  log "Installing frontend dependencies"
  (cd "$ROOT_DIR" && npm install)
fi

log "Building Next.js static export"
(
  cd "$ROOT_DIR"
  RESEARCH_AGENT_STATIC_EXPORT=true \
  NEXT_PUBLIC_USE_MOCK=false \
  NEXT_PUBLIC_API_URL=auto \
  npm run build
)

[ -d "$OUT_DIR" ] || die "Expected static output at ${OUT_DIR}"

log "Packaging frontend static bundle"
rm -f "$ARCHIVE"
tar -C "$OUT_DIR" -czf "$ARCHIVE" .

cat <<EOF
Frontend static bundle built successfully:
  ${ARCHIVE}

Suggested hosted filename:
  research-agent-frontend-static.tar.gz
EOF
