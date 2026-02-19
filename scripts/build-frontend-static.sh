#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
OUT_DIR="${ROOT_DIR}/out"
ARCHIVE="${DIST_DIR}/research-agent-frontend-static.tar.gz"
API_DIR="${ROOT_DIR}/app/api"
API_BACKUP_DIR="${ROOT_DIR}/.build-static-export-api-backup"

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

restore_api_dir() {
  if [ -d "$API_BACKUP_DIR" ]; then
    rm -rf "$API_DIR"
    mv "$API_BACKUP_DIR" "$API_DIR"
  fi
}

if [ -d "$API_DIR" ]; then
  rm -rf "$API_BACKUP_DIR"
  mv "$API_DIR" "$API_BACKUP_DIR"
  trap restore_api_dir EXIT
  log "Temporarily disabled app/api for static export"
fi

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
  npm run build -- --webpack
)

[ -d "$OUT_DIR" ] || die "Expected static output at ${OUT_DIR}"

log "Packaging frontend static bundle"
rm -f "$ARCHIVE"
tar -C "$OUT_DIR" -czf "$ARCHIVE" .

restore_api_dir
trap - EXIT

cat <<EOF
Frontend static bundle built successfully:
  ${ARCHIVE}

Suggested hosted filename:
  research-agent-frontend-static.tar.gz
EOF
