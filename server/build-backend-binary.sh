#!/usr/bin/env bash

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_VENV="${SERVER_DIR}/.build-venv"
DIST_DIR="${SERVER_DIR}/dist"
PYINSTALLER_WORK="${SERVER_DIR}/build/pyinstaller/work"
PYINSTALLER_SPEC="${SERVER_DIR}/build/pyinstaller/spec"
BIN_NAME="${RESEARCH_AGENT_BACKEND_BIN_NAME:-research-agent-backend}"
UV_CACHE_DIR_DEFAULT="${SERVER_DIR}/.uv-cache"

log() {
  printf '[build-backend] %s\n' "$*"
}

die() {
  printf '[build-backend] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || die "python3 is required to build backend binary"

if command -v uv >/dev/null 2>&1; then
  export UV_CACHE_DIR="${UV_CACHE_DIR:-$UV_CACHE_DIR_DEFAULT}"
  log "Using uv to prepare build environment"
  log "uv cache: ${UV_CACHE_DIR}"
  if [ ! -x "${BUILD_VENV}/bin/python" ]; then
    uv venv "${BUILD_VENV}"
  fi
  uv pip install --python "${BUILD_VENV}/bin/python" -r "${SERVER_DIR}/requirements.txt" pyinstaller
else
  log "Using python venv + pip to prepare build environment"
  if [ ! -x "${BUILD_VENV}/bin/python" ]; then
    python3 -m venv "${BUILD_VENV}"
  fi
  "${BUILD_VENV}/bin/pip" install --upgrade pip
  "${BUILD_VENV}/bin/pip" install -r "${SERVER_DIR}/requirements.txt" pyinstaller
fi

mkdir -p "${DIST_DIR}" "${PYINSTALLER_WORK}" "${PYINSTALLER_SPEC}"
rm -f "${DIST_DIR}/${BIN_NAME}" "${DIST_DIR}/${BIN_NAME}.exe"

log "Building one-file backend binary"
"${BUILD_VENV}/bin/pyinstaller" \
  --onefile \
  --name "${BIN_NAME}" \
  --distpath "${DIST_DIR}" \
  --workpath "${PYINSTALLER_WORK}" \
  --specpath "${PYINSTALLER_SPEC}" \
  --add-data "${SERVER_DIR}/opencode.json:." \
  --add-data "${SERVER_DIR}/gpuwrap_detect.py:." \
  --hidden-import agent.job_sidecar \
  --hidden-import core \
  --hidden-import core.config \
  --hidden-import core.models \
  --hidden-import core.state \
  --hidden-import chat \
  --hidden-import chat.routes \
  --hidden-import chat.streaming \
  --hidden-import runs \
  --hidden-import runs.routes \
  --hidden-import runs.helpers \
  --hidden-import runs.sweep_routes \
  --hidden-import runs.log_routes \
  --hidden-import runs.evo_sweep \
  --hidden-import agent \
  --hidden-import agent.wild_loop_v2 \
  --hidden-import agent.wild_routes \
  --hidden-import agent.v2_prompts \
  --hidden-import skills \
  --hidden-import skills.manager \
  --hidden-import skills.routes \
  --hidden-import memory \
  --hidden-import memory.store \
  --hidden-import memory.routes \
  --hidden-import integrations \
  --hidden-import integrations.slack_handler \
  --hidden-import integrations.slack_routes \
  --hidden-import integrations.git_routes \
  --hidden-import integrations.journey_routes \
  --hidden-import integrations.cluster_routes \
  --hidden-import integrations.plan_routes \
  "${SERVER_DIR}/server.py"

if [ -x "${DIST_DIR}/${BIN_NAME}" ]; then
  output_path="${DIST_DIR}/${BIN_NAME}"
elif [ -x "${DIST_DIR}/${BIN_NAME}.exe" ]; then
  output_path="${DIST_DIR}/${BIN_NAME}.exe"
else
  die "Build completed but backend binary was not found in ${DIST_DIR}"
fi

cat <<EOF
Backend binary built successfully:
  ${output_path}

Run it directly:
  ${output_path} --workdir /path/to/project --port 10000 --host 127.0.0.1

Or via launcher:
  research-agent start --project-root "\$PWD"
EOF
