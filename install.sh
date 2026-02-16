#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="${RESEARCH_AGENT_INSTALL_DIR:-${HOME}/.research-agent/app}"
DEFAULT_BACKEND_BINARY_URL="https://drive.google.com/uc?export=download&id=1CIdMPZzF2GceTZkSwK_8_8T9crN1cfDl"
DEFAULT_FRONTEND_BUNDLE_URL="${RESEARCH_AGENT_DEFAULT_FRONTEND_BUNDLE_URL:-https://drive.google.com/uc?export=download&id=14kuhcyxGBtBl_oa774AaIcW4-FtyE7QR}"

log() {
  printf '[install.sh] %s\n' "$*"
}

die() {
  printf '[install.sh] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v bash >/dev/null 2>&1 || die "bash is required"

mkdir -p "${INSTALL_DIR}/scripts" "${INSTALL_DIR}/server/dist"

LOCAL_SCRIPT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/research-agent" ]; then
  LOCAL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/research-agent"
fi

if [ -n "$LOCAL_SCRIPT" ]; then
  log "Installing CLI from local source: ${LOCAL_SCRIPT}"
  cp "$LOCAL_SCRIPT" "${INSTALL_DIR}/scripts/research-agent"
else
  log "Installing embedded CLI script"
  cat > "${INSTALL_DIR}/scripts/research-agent" <<'__RESEARCH_AGENT_EMBEDDED__'
#!/usr/bin/env bash

set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]}"
while [ -L "$SOURCE_PATH" ]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  [[ "$SOURCE_PATH" != /* ]] && SOURCE_PATH="${SOURCE_DIR}/${SOURCE_PATH}"
done

SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_STATE_DIR="${HOME}/.research-agent"
STATE_DIR="${RESEARCH_AGENT_STATE_DIR:-$DEFAULT_STATE_DIR}"
CONFIG_FILE="${STATE_DIR}/config.env"
ONBOARDED_FILE="${STATE_DIR}/onboarded"
AUTH_TOKEN_FILE_DEFAULT="${STATE_DIR}/auth-token"
INSTALL_DIR_DEFAULT="${APP_DIR}"
DEFAULT_OPENCODE_PORT=4096

INSTALL_DIR="${INSTALL_DIR_DEFAULT}"
PYTHON_BIN=""
BACKEND_BIN=""
BACKEND_BINARY_URL="${RESEARCH_AGENT_BACKEND_BINARY_URL:-}"
BACKEND_BINARY_BASE_URL="${RESEARCH_AGENT_BACKEND_BINARY_BASE_URL:-}"
BACKEND_BINARY_SHA256="${RESEARCH_AGENT_BACKEND_BINARY_SHA256:-}"
FRONTEND_BUNDLE_URL="${RESEARCH_AGENT_FRONTEND_BUNDLE_URL:-}"
FRONTEND_BUNDLE_BASE_URL="${RESEARCH_AGENT_FRONTEND_BUNDLE_BASE_URL:-}"
AUTH_TOKEN_FILE="${AUTH_TOKEN_FILE_DEFAULT}"
PROJECT_ROOT=""
PROJECT_NAME=""
PROJECT_HASH=""
FRONTEND_PORT=""
BACKEND_PORT=""
OPENCODE_PORT="${DEFAULT_OPENCODE_PORT}"
TMUX_SESSION_NAME=""
RUNTIME_FILE=""
BACKEND_PUBLIC_URL=""
FRONTEND_PUBLIC_URL=""
FRONTEND_API_URL=""

q() {
  printf '%q' "$1"
}

log() {
  printf '[research-agent] %s\n' "$*"
}

warn() {
  printf '[research-agent] WARN: %s\n' "$*" >&2
}

die() {
  printf '[research-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
research-agent: one-command onboarding and lifecycle manager

Usage:
  research-agent [command] [options]
  ra [command] [options]

Commands:
  install    Install dependencies, create isolated Python env, and install CLI links
  fetch-backend  Download prebuilt backend binary from website
  fetch-frontend  Download prebuilt frontend static bundle from website
  build-backend  Build standalone backend binary
  onboard    Prepare machine-level state (auth token + env checks)
  start      Start OpenCode + backend + frontend in tmux (default command)
  tunnel     Start ngrok tunnels for backend/frontend and print public URLs
  stop       Stop tmux session for the current project
  status     Show session, ports, and tunnel status
  help       Show this help

Common options:
  --project-root <path>  Project root for runs/data (defaults to current directory)
  --install-dir <path>   Installed app directory (default: script parent)
  --frontend-port <n>    Override frontend port
  --backend-port <n>     Override backend port
  --opencode-port <n>    Override OpenCode port (default: 4096)
  --backend-binary-url <url>       Use explicit backend binary URL
  --backend-binary-base-url <url>  Use base URL with platform auto-detection
  --backend-binary-sha256 <hash>   Optional SHA256 for downloaded binary
  --frontend-bundle-url <url>      Use explicit frontend bundle URL (.tar.gz)
  --frontend-bundle-base-url <url> Use base URL (expects research-agent-frontend-static.tar.gz)
  --tunnel               For start: immediately run tunnel after startup

Examples:
  research-agent install
  research-agent fetch-backend --backend-binary-base-url https://example.com/releases
  research-agent fetch-frontend --frontend-bundle-base-url https://example.com/releases
  research-agent build-backend
  research-agent start --project-root "$PWD"
  research-agent tunnel
  research-agent stop
EOF
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "Missing required command: ${cmd}"
}

maybe_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

load_machine_config() {
  if [ -f "$CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    INSTALL_DIR="${RESEARCH_AGENT_INSTALL_DIR:-$INSTALL_DIR}"
    PYTHON_BIN="${RESEARCH_AGENT_PYTHON_BIN:-$PYTHON_BIN}"
    BACKEND_BIN="${RESEARCH_AGENT_BACKEND_BIN:-$BACKEND_BIN}"
    BACKEND_BINARY_URL="${RESEARCH_AGENT_BACKEND_BINARY_URL:-$BACKEND_BINARY_URL}"
    BACKEND_BINARY_BASE_URL="${RESEARCH_AGENT_BACKEND_BINARY_BASE_URL:-$BACKEND_BINARY_BASE_URL}"
    BACKEND_BINARY_SHA256="${RESEARCH_AGENT_BACKEND_BINARY_SHA256:-$BACKEND_BINARY_SHA256}"
    FRONTEND_BUNDLE_URL="${RESEARCH_AGENT_FRONTEND_BUNDLE_URL:-$FRONTEND_BUNDLE_URL}"
    FRONTEND_BUNDLE_BASE_URL="${RESEARCH_AGENT_FRONTEND_BUNDLE_BASE_URL:-$FRONTEND_BUNDLE_BASE_URL}"
    AUTH_TOKEN_FILE="${RESEARCH_AGENT_AUTH_TOKEN_FILE:-$AUTH_TOKEN_FILE}"
  fi
}

save_machine_config() {
  ensure_state_dir
  {
    printf 'RESEARCH_AGENT_INSTALL_DIR=%q\n' "$INSTALL_DIR"
    printf 'RESEARCH_AGENT_PYTHON_BIN=%q\n' "$PYTHON_BIN"
    printf 'RESEARCH_AGENT_BACKEND_BIN=%q\n' "$BACKEND_BIN"
    printf 'RESEARCH_AGENT_BACKEND_BINARY_URL=%q\n' "$BACKEND_BINARY_URL"
    printf 'RESEARCH_AGENT_BACKEND_BINARY_BASE_URL=%q\n' "$BACKEND_BINARY_BASE_URL"
    printf 'RESEARCH_AGENT_BACKEND_BINARY_SHA256=%q\n' "$BACKEND_BINARY_SHA256"
    printf 'RESEARCH_AGENT_FRONTEND_BUNDLE_URL=%q\n' "$FRONTEND_BUNDLE_URL"
    printf 'RESEARCH_AGENT_FRONTEND_BUNDLE_BASE_URL=%q\n' "$FRONTEND_BUNDLE_BASE_URL"
    printf 'RESEARCH_AGENT_AUTH_TOKEN_FILE=%q\n' "$AUTH_TOKEN_FILE"
  } >"$CONFIG_FILE"
}

generate_auth_token() {
  if maybe_cmd openssl; then
    openssl rand -hex 16
    return
  fi

  python3 - <<'PY'
import secrets
print(secrets.token_hex(16))
PY
}

ensure_auth_token() {
  AUTH_TOKEN_FILE="${AUTH_TOKEN_FILE:-$AUTH_TOKEN_FILE_DEFAULT}"
  if [ -s "$AUTH_TOKEN_FILE" ]; then
    return
  fi

  ensure_state_dir
  local token
  token="$(generate_auth_token)"
  printf '%s\n' "$token" >"$AUTH_TOKEN_FILE"
  chmod 600 "$AUTH_TOKEN_FILE"
  log "Generated auth token at ${AUTH_TOKEN_FILE}"
}

get_auth_token() {
  [ -s "$AUTH_TOKEN_FILE" ] || die "Auth token not found at ${AUTH_TOKEN_FILE}"
  tr -d '\n\r' <"$AUTH_TOKEN_FILE"
}

ensure_python_runtime() {
  local venv_dir="${INSTALL_DIR}/.ra-venv"
  local requirements_file="${INSTALL_DIR}/server/requirements.txt"

  [ -f "$requirements_file" ] || die "Missing requirements file: ${requirements_file}"

  if maybe_cmd uv; then
    log "Configuring isolated backend env with uv"
    if [ ! -x "${venv_dir}/bin/python" ]; then
      uv venv "$venv_dir"
    fi
    uv pip install --python "${venv_dir}/bin/python" -r "$requirements_file"
  else
    warn "uv not found; falling back to python venv"
    require_cmd python3
    if [ ! -x "${venv_dir}/bin/python" ]; then
      python3 -m venv "$venv_dir"
    fi
    "${venv_dir}/bin/pip" install --upgrade pip
    "${venv_dir}/bin/pip" install -r "$requirements_file"
  fi

  PYTHON_BIN="${venv_dir}/bin/python"
}

maybe_install_opencode() {
  if maybe_cmd opencode; then
    return
  fi

  if maybe_cmd npm; then
    warn "opencode not found; attempting npm global install"
    if npm install -g opencode; then
      return
    fi
  fi

  warn "opencode CLI is still missing. Install manually: npm install -g opencode"
}

install_cli_links() {
  local bin_dir="${HOME}/.local/bin"
  local launcher="${bin_dir}/research-agent"
  local target="${INSTALL_DIR}/scripts/research-agent"
  mkdir -p "$bin_dir"

  cat >"$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR=$(q "$INSTALL_DIR")
TARGET="\${APP_DIR}/scripts/research-agent"

if [ ! -x "\$TARGET" ]; then
  echo "research-agent is not installed at \$APP_DIR" >&2
  echo "Reinstall with your installer URL, e.g.:" >&2
  echo "  curl -fsSL \"<install.sh-url>\" | bash" >&2
  exit 1
fi

exec "\$TARGET" "\$@"
EOF
  chmod +x "$launcher"

  local existing_ra
  existing_ra="$(command -v ra 2>/dev/null || true)"
  if [ -z "$existing_ra" ] || [ "$existing_ra" = "${bin_dir}/ra" ] || [ "$existing_ra" = "$launcher" ]; then
    ln -sf "$launcher" "${bin_dir}/ra"
    log "Installed alias: ra"
  else
    warn "Skipped alias ra because command is already used by: ${existing_ra}"
  fi

  if [[ ":$PATH:" != *":${bin_dir}:"* ]]; then
    warn "${bin_dir} is not on PATH. Add this line to your shell profile:"
    warn "export PATH=\"${bin_dir}:\$PATH\""
  fi
}

get_backend_binary() {
  local override="${RESEARCH_AGENT_BACKEND_BIN:-$BACKEND_BIN}"
  if [ -n "$override" ] && [ -x "$override" ]; then
    printf '%s\n' "$override"
    return 0
  fi

  local candidate="${INSTALL_DIR}/server/dist/research-agent-backend"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [ -x "${candidate}.exe" ]; then
    printf '%s\n' "${candidate}.exe"
    return 0
  fi

  return 1
}

detect_platform_tuple() {
  local os_raw arch_raw os arch ext
  os_raw="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch_raw="$(uname -m | tr '[:upper:]' '[:lower:]')"

  case "$os_raw" in
    linux*) os="linux" ;;
    darwin*) os="darwin" ;;
    msys*|mingw*|cygwin*) os="windows" ;;
    *) return 1 ;;
  esac

  case "$arch_raw" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) return 1 ;;
  esac

  ext=""
  if [ "$os" = "windows" ]; then
    ext=".exe"
  fi

  printf '%s %s %s\n' "$os" "$arch" "$ext"
}

get_backend_binary_download_url() {
  if [ -n "$BACKEND_BINARY_URL" ]; then
    printf '%s\n' "$BACKEND_BINARY_URL"
    return 0
  fi
  if [ -z "$BACKEND_BINARY_BASE_URL" ]; then
    return 1
  fi

  local os arch ext
  read -r os arch ext < <(detect_platform_tuple) || return 1
  printf '%s/research-agent-backend-%s-%s%s\n' "${BACKEND_BINARY_BASE_URL%/}" "$os" "$arch" "$ext"
}

verify_sha256_file() {
  local file_path="$1"
  local expected="$2"

  if [ -z "$expected" ]; then
    return 0
  fi

  local actual=""
  if maybe_cmd sha256sum; then
    actual="$(sha256sum "$file_path" | awk '{print $1}')"
  elif maybe_cmd shasum; then
    actual="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  else
    warn "Skipping SHA256 verification (sha256sum/shasum unavailable)"
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    warn "SHA256 mismatch for downloaded backend binary"
    warn "Expected: $expected"
    warn "Actual:   $actual"
    return 1
  fi

  return 0
}

download_backend_binary() {
  local url
  url="$(get_backend_binary_download_url || true)"
  if [ -z "$url" ]; then
    return 1
  fi

  local target_dir="${INSTALL_DIR}/server/dist"
  local target="${target_dir}/research-agent-backend"
  if [[ "$url" == *.exe ]]; then
    target="${target}.exe"
  fi

  mkdir -p "$target_dir"

  local temp_file="${target}.download.$$"
  rm -f "$temp_file"

  log "Downloading backend binary from ${url}"
  if ! curl -fsSL "$url" -o "$temp_file"; then
    warn "Failed to download backend binary from ${url}"
    rm -f "$temp_file"
    return 1
  fi

  if ! verify_sha256_file "$temp_file" "$BACKEND_BINARY_SHA256"; then
    rm -f "$temp_file"
    return 1
  fi

  chmod +x "$temp_file" 2>/dev/null || true
  mv -f "$temp_file" "$target"

  BACKEND_BIN="$target"
  log "Backend binary downloaded to ${BACKEND_BIN}"
  return 0
}

get_frontend_static_dir() {
  local override="${RESEARCH_AGENT_FRONTEND_DIR:-}"
  if [ -n "$override" ] && [ -f "$override/index.html" ]; then
    printf '%s\n' "$override"
    return 0
  fi

  local candidate="${INSTALL_DIR}/frontend"
  if [ -f "${candidate}/index.html" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

get_frontend_bundle_download_url() {
  if [ -n "$FRONTEND_BUNDLE_URL" ]; then
    printf '%s\n' "$FRONTEND_BUNDLE_URL"
    return 0
  fi
  if [ -n "$FRONTEND_BUNDLE_BASE_URL" ]; then
    printf '%s/research-agent-frontend-static.tar.gz\n' "${FRONTEND_BUNDLE_BASE_URL%/}"
    return 0
  fi
  return 1
}

download_frontend_bundle() {
  require_cmd tar
  local url
  url="$(get_frontend_bundle_download_url || true)"
  if [ -z "$url" ]; then
    return 1
  fi

  local target_dir="${INSTALL_DIR}/frontend"
  local archive="${INSTALL_DIR}/frontend-static.tar.gz"
  local temp_archive="${archive}.download.$$"

  rm -f "$temp_archive"
  mkdir -p "$INSTALL_DIR"

  log "Downloading frontend static bundle from ${url}"
  if ! curl -fsSL "$url" -o "$temp_archive"; then
    warn "Failed to download frontend bundle from ${url}"
    rm -f "$temp_archive"
    return 1
  fi

  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  if ! tar -xzf "$temp_archive" -C "$target_dir"; then
    warn "Failed to extract frontend bundle (${url})"
    rm -f "$temp_archive"
    return 1
  fi
  rm -f "$temp_archive"

  if [ ! -f "${target_dir}/index.html" ]; then
    # Handle tarballs with top-level directory
    local nested_index
    nested_index="$(find "$target_dir" -mindepth 2 -maxdepth 2 -type f -name index.html | head -n 1 || true)"
    if [ -n "$nested_index" ]; then
      local nested_root
      nested_root="$(dirname "$nested_index")"
      local temp_dir="${INSTALL_DIR}/frontend.tmp.$$"
      rm -rf "$temp_dir"
      mv "$nested_root" "$temp_dir"
      rm -rf "$target_dir"
      mv "$temp_dir" "$target_dir"
    fi
  fi

  if [ ! -f "${target_dir}/index.html" ]; then
    warn "Frontend bundle extracted but index.html is missing in ${target_dir}"
    return 1
  fi

  log "Frontend static bundle ready at ${target_dir}"
  return 0
}

hash_project_root() {
  if maybe_cmd sha256sum; then
    printf '%s' "$PROJECT_ROOT" | sha256sum | awk '{print $1}'
    return
  fi
  if maybe_cmd shasum; then
    printf '%s' "$PROJECT_ROOT" | shasum -a 256 | awk '{print $1}'
    return
  fi
  die "Need sha256sum or shasum to derive stable ports"
}

sanitize_name() {
  local raw="$1"
  local out
  out="$(printf '%s' "$raw" | tr -cs 'A-Za-z0-9_-' '-')"
  out="${out#-}"
  out="${out%-}"
  if [ -z "$out" ]; then
    out="project"
  fi
  printf '%s' "$out"
}

init_project_context() {
  local project_root="$1"
  PROJECT_ROOT="$(cd "$project_root" && pwd)"
  PROJECT_NAME="$(basename "$PROJECT_ROOT")"
  PROJECT_HASH="$(hash_project_root)"
  local offset=$((16#${PROJECT_HASH:0:4} % 400))
  FRONTEND_PORT="${FRONTEND_PORT:-$((3000 + offset))}"
  BACKEND_PORT="${BACKEND_PORT:-$((10000 + offset))}"
  TMUX_SESSION_NAME="research-agent-$(sanitize_name "$PROJECT_NAME")-${offset}"
  RUNTIME_FILE="${PROJECT_ROOT}/.agents/ra-runtime.env"
}

write_runtime_file() {
  mkdir -p "${PROJECT_ROOT}/.agents"
  {
    printf 'PROJECT_ROOT=%q\n' "$PROJECT_ROOT"
    printf 'PROJECT_NAME=%q\n' "$PROJECT_NAME"
    printf 'INSTALL_DIR=%q\n' "$INSTALL_DIR"
    printf 'PYTHON_BIN=%q\n' "$PYTHON_BIN"
    printf 'TMUX_SESSION_NAME=%q\n' "$TMUX_SESSION_NAME"
    printf 'FRONTEND_PORT=%q\n' "$FRONTEND_PORT"
    printf 'BACKEND_PORT=%q\n' "$BACKEND_PORT"
    printf 'OPENCODE_PORT=%q\n' "$OPENCODE_PORT"
    printf 'FRONTEND_API_URL=%q\n' "$FRONTEND_API_URL"
    printf 'BACKEND_PUBLIC_URL=%q\n' "$BACKEND_PUBLIC_URL"
    printf 'FRONTEND_PUBLIC_URL=%q\n' "$FRONTEND_PUBLIC_URL"
  } >"$RUNTIME_FILE"
}

load_runtime_file_if_exists() {
  if [ -f "$RUNTIME_FILE" ]; then
    # shellcheck disable=SC1090
    source "$RUNTIME_FILE"
  fi
}

tmux_session_exists() {
  tmux has-session -t "$1" >/dev/null 2>&1
}

tmux_window_exists() {
  local session="$1"
  local window="$2"
  tmux list-windows -t "$session" -F '#W' | grep -Fxq "$window"
}

tmux_replace_window() {
  local session="$1"
  local window="$2"
  local command="$3"

  if tmux_window_exists "$session" "$window"; then
    tmux kill-window -t "${session}:${window}"
  fi

  tmux new-window -d -t "$session" -n "$window" "$command"
}

ensure_tmux_session() {
  if ! tmux_session_exists "$TMUX_SESSION_NAME"; then
    tmux new-session -d -s "$TMUX_SESSION_NAME" -n bootstrap "sleep infinity"
  fi
}

wait_for_http_ok() {
  local url="$1"
  local timeout_seconds="$2"
  local name="$3"
  local elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  warn "${name} did not become healthy at ${url} after ${timeout_seconds}s"
  return 1
}

get_http_content_type() {
  local url="$1"
  curl -fsSI "$url" 2>/dev/null | tr -d '\r' | awk -F': *' '
    tolower($1) == "content-type" {
      print tolower($2)
      exit
    }
  '
}

generate_opencode_password() {
  openssl rand -hex 16
}

build_opencode_command() {
  local oc_password="$1"
  local config_path="${INSTALL_DIR}/server/opencode.json"
  if [ -f "$config_path" ]; then
    printf 'cd %s && OPENCODE_CONFIG=%s OPENCODE_SERVER_PASSWORD=%s opencode serve' \
      "$(q "$PROJECT_ROOT")" \
      "$(q "$config_path")" \
      "$(q "$oc_password")"
  else
    printf 'cd %s && OPENCODE_SERVER_PASSWORD=%s opencode serve' \
      "$(q "$PROJECT_ROOT")" \
      "$(q "$oc_password")"
  fi
}

build_backend_command() {
  local auth_token="$1"
  local oc_password="$2"
  local backend_bin
  backend_bin="$(get_backend_binary || true)"
  local frontend_dir
  frontend_dir="$(get_frontend_static_dir || true)"

  local frontend_env=""
  if [ -n "$frontend_dir" ]; then
    frontend_env=" RESEARCH_AGENT_FRONTEND_DIR=$(q "$frontend_dir")"
  fi

  if [ -n "$backend_bin" ]; then
    BACKEND_BIN="$backend_bin"
    printf 'cd %s && RESEARCH_AGENT_USER_AUTH_TOKEN=%s OPENCODE_URL=%s OPENCODE_SERVER_PASSWORD=%s%s %s --workdir %s --host 127.0.0.1 --port %s --tmux-session %s' \
      "$(q "${INSTALL_DIR}/server")" \
      "$(q "$auth_token")" \
      "$(q "http://127.0.0.1:${OPENCODE_PORT}")" \
      "$(q "$oc_password")" \
      "$frontend_env" \
      "$(q "$backend_bin")" \
      "$(q "$PROJECT_ROOT")" \
      "$(q "$BACKEND_PORT")" \
      "$(q "$TMUX_SESSION_NAME")"
    return
  fi

  [ -x "$PYTHON_BIN" ] || die "Python runtime missing at ${PYTHON_BIN}"
  printf 'cd %s && RESEARCH_AGENT_USER_AUTH_TOKEN=%s OPENCODE_URL=%s OPENCODE_SERVER_PASSWORD=%s%s %s server.py --workdir %s --host 127.0.0.1 --port %s --tmux-session %s' \
    "$(q "${INSTALL_DIR}/server")" \
    "$(q "$auth_token")" \
    "$(q "http://127.0.0.1:${OPENCODE_PORT}")" \
    "$(q "$oc_password")" \
    "$frontend_env" \
    "$(q "$PYTHON_BIN")" \
    "$(q "$PROJECT_ROOT")" \
    "$(q "$BACKEND_PORT")" \
    "$(q "$TMUX_SESSION_NAME")"
}

build_frontend_command() {
  local api_url="$1"
  printf 'cd %s && NEXT_PUBLIC_API_URL=%s NEXT_PUBLIC_USE_MOCK=false RESEARCH_AGENT_WORKDIR=%s RESEARCH_AGENT_BACKEND_URL=%s npm run dev -- --hostname 127.0.0.1 --port %s' \
    "$(q "$INSTALL_DIR")" \
    "$(q "$api_url")" \
    "$(q "$PROJECT_ROOT")" \
    "$(q "$api_url")" \
    "$(q "$FRONTEND_PORT")"
}

start_services() {
  local auth_token="$1"
  local frontend_static_dir
  frontend_static_dir="$(get_frontend_static_dir || true)"
  local has_frontend_source=0
  if [ -f "${INSTALL_DIR}/package.json" ]; then
    has_frontend_source=1
  fi

  FRONTEND_API_URL="http://127.0.0.1:${BACKEND_PORT}"
  BACKEND_PUBLIC_URL="${BACKEND_PUBLIC_URL:-}"
  FRONTEND_PUBLIC_URL="${FRONTEND_PUBLIC_URL:-}"

  local oc_password
  oc_password="$(generate_opencode_password)"
  log "Generated OPENCODE_SERVER_PASSWORD for this session"

  ensure_tmux_session
  tmux_replace_window "$TMUX_SESSION_NAME" "opencode" "$(build_opencode_command "$oc_password")"
  tmux_replace_window "$TMUX_SESSION_NAME" "backend" "$(build_backend_command "$auth_token" "$oc_password")"

  if [ -n "$frontend_static_dir" ]; then
    if tmux_window_exists "$TMUX_SESSION_NAME" "frontend"; then
      tmux kill-window -t "${TMUX_SESSION_NAME}:frontend"
    fi
    log "Using bundled frontend static files from ${frontend_static_dir}"
  elif [ "$has_frontend_source" -eq 1 ]; then
    tmux_replace_window "$TMUX_SESSION_NAME" "frontend" "$(build_frontend_command "$FRONTEND_API_URL")"
  else
    warn "No frontend static bundle and no source tree found. Backend will run without local UI."
  fi

  if tmux_window_exists "$TMUX_SESSION_NAME" "bootstrap"; then
    tmux kill-window -t "${TMUX_SESSION_NAME}:bootstrap"
  fi

  wait_for_http_ok "http://127.0.0.1:${BACKEND_PORT}/" 30 "Backend" || true
  if [ -n "$frontend_static_dir" ]; then
    local backend_root_content_type
    backend_root_content_type="$(get_http_content_type "http://127.0.0.1:${BACKEND_PORT}/" || true)"
    if [[ "$backend_root_content_type" == application/json* ]]; then
      warn "Backend root is returning JSON instead of static HTML."
      warn "Your backend runtime may be outdated and missing frontend static serving support."
      if [ "$has_frontend_source" -eq 1 ]; then
        warn "Falling back to source frontend dev server."
        tmux_replace_window "$TMUX_SESSION_NAME" "frontend" "$(build_frontend_command "$FRONTEND_API_URL")"
        wait_for_http_ok "http://127.0.0.1:${FRONTEND_PORT}" 45 "Frontend" || true
      else
        warn "Rebuild/redeploy backend binary and run 'research-agent fetch-backend' or reinstall."
      fi
    fi
  fi
  if [ "$has_frontend_source" -eq 1 ] && [ -z "$frontend_static_dir" ]; then
    wait_for_http_ok "http://127.0.0.1:${FRONTEND_PORT}" 45 "Frontend" || true
  fi
}

get_ngrok_url_for_port() {
  local port="$1"
  python3 - "$port" <<'PY'
import json
import sys
from urllib.request import urlopen

port = str(sys.argv[1])

try:
    with urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as r:
        payload = json.loads(r.read().decode("utf-8"))
except Exception:
    sys.exit(1)

expected_suffixes = {
    f":{port}",
    f"localhost:{port}",
    f"127.0.0.1:{port}",
    f"http://localhost:{port}",
    f"http://127.0.0.1:{port}",
}

for tunnel in payload.get("tunnels", []):
    addr = str(tunnel.get("config", {}).get("addr", ""))
    public_url = str(tunnel.get("public_url", ""))
    if not public_url:
        continue
    if any(addr.endswith(sfx) for sfx in expected_suffixes):
        print(public_url)
        sys.exit(0)

sys.exit(1)
PY
}

wait_for_ngrok_url() {
  local port="$1"
  local timeout_seconds="$2"
  local elapsed=0
  local url

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    url="$(get_ngrok_url_for_port "$port" || true)"
    if [ -n "$url" ]; then
      printf '%s\n' "$url"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

start_tunnels() {
  require_cmd tmux
  require_cmd ngrok
  require_cmd python3

  local frontend_static_dir
  frontend_static_dir="$(get_frontend_static_dir || true)"
  local has_frontend_source=0
  if [ -f "${INSTALL_DIR}/package.json" ]; then
    has_frontend_source=1
  fi

  if ! tmux_session_exists "$TMUX_SESSION_NAME"; then
    die "tmux session ${TMUX_SESSION_NAME} is not running. Start services first."
  fi

  tmux_replace_window "$TMUX_SESSION_NAME" "ngrok-backend" "ngrok http 127.0.0.1:${BACKEND_PORT}"
  BACKEND_PUBLIC_URL="$(wait_for_ngrok_url "$BACKEND_PORT" 30 || true)"
  if [ -z "$BACKEND_PUBLIC_URL" ]; then
    die "Could not read backend ngrok URL from http://127.0.0.1:4040/api/tunnels"
  fi

  if [ -n "$frontend_static_dir" ]; then
    FRONTEND_API_URL="$BACKEND_PUBLIC_URL"
    FRONTEND_PUBLIC_URL="$BACKEND_PUBLIC_URL"
    if tmux_window_exists "$TMUX_SESSION_NAME" "ngrok-frontend"; then
      tmux kill-window -t "${TMUX_SESSION_NAME}:ngrok-frontend"
    fi
    log "Frontend is served by backend static files. Reusing backend public URL."
    return
  fi

  if [ "$has_frontend_source" -eq 1 ]; then
    FRONTEND_API_URL="$BACKEND_PUBLIC_URL"
    tmux_replace_window "$TMUX_SESSION_NAME" "frontend" "$(build_frontend_command "$FRONTEND_API_URL")"
    wait_for_http_ok "http://127.0.0.1:${FRONTEND_PORT}" 45 "Frontend" || true

    tmux_replace_window "$TMUX_SESSION_NAME" "ngrok-frontend" "ngrok http 127.0.0.1:${FRONTEND_PORT}"
    FRONTEND_PUBLIC_URL="$(wait_for_ngrok_url "$FRONTEND_PORT" 30 || true)"
    if [ -z "$FRONTEND_PUBLIC_URL" ]; then
      die "Could not read frontend ngrok URL from http://127.0.0.1:4040/api/tunnels"
    fi
    return
  fi

  FRONTEND_PUBLIC_URL=""
  FRONTEND_API_URL="$BACKEND_PUBLIC_URL"
  warn "No frontend runtime available. Only backend public URL is exposed."
}

machine_onboard() {
  require_cmd tmux
  require_cmd curl
  maybe_install_opencode

  local has_source_tree=0
  if [ -f "${INSTALL_DIR}/package.json" ] && [ -f "${INSTALL_DIR}/server/server.py" ]; then
    has_source_tree=1
  fi

  ensure_auth_token

  local backend_bin
  backend_bin="$(get_backend_binary || true)"
  if [ -n "$backend_bin" ]; then
    BACKEND_BIN="$backend_bin"
    PYTHON_BIN=""
    log "Using packaged backend binary: ${BACKEND_BIN}"
  elif download_backend_binary; then
    BACKEND_BIN="$(get_backend_binary || true)"
    PYTHON_BIN=""
    log "Using downloaded backend binary: ${BACKEND_BIN}"
  else
    if [ "$has_source_tree" -eq 1 ]; then
      ensure_python_runtime
      BACKEND_BIN=""
    else
      die "No backend binary available and no source tree present for Python fallback."
    fi
  fi

  local frontend_static_dir
  frontend_static_dir="$(get_frontend_static_dir || true)"
  if [ -n "$frontend_static_dir" ]; then
    log "Using frontend static bundle: ${frontend_static_dir}"
  elif download_frontend_bundle; then
    frontend_static_dir="$(get_frontend_static_dir || true)"
    if [ -n "$frontend_static_dir" ]; then
      log "Using downloaded frontend static bundle: ${frontend_static_dir}"
    fi
  elif [ "$has_source_tree" -eq 0 ]; then
    warn "No frontend static bundle found and no source tree present."
    warn "Set RESEARCH_AGENT_FRONTEND_BUNDLE_URL or RESEARCH_AGENT_FRONTEND_BUNDLE_BASE_URL before install."
  fi

  save_machine_config

  {
    printf 'onboarded_at=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'install_dir=%q\n' "$INSTALL_DIR"
  } >"$ONBOARDED_FILE"
}

print_start_summary() {
  local auth_token="$1"
  local frontend_static_dir
  frontend_static_dir="$(get_frontend_static_dir || true)"
  local frontend_line
  if [ -n "$frontend_static_dir" ]; then
    local backend_root_content_type
    backend_root_content_type="$(get_http_content_type "http://127.0.0.1:${BACKEND_PORT}/" || true)"
    if [[ "$backend_root_content_type" == application/json* ]]; then
      frontend_line="not ready (backend root is JSON; backend binary likely outdated)"
    else
      frontend_line="http://127.0.0.1:${BACKEND_PORT} (served by backend static)"
    fi
  elif [ -f "${INSTALL_DIR}/package.json" ]; then
    frontend_line="http://127.0.0.1:${FRONTEND_PORT}"
  else
    frontend_line="unavailable (no static bundle and no source tree)"
  fi

  cat <<EOF
Research Agent is running for project: ${PROJECT_ROOT}
  Frontend (local): ${frontend_line}
  Backend  (local): http://127.0.0.1:${BACKEND_PORT}
  Tmux session:     ${TMUX_SESSION_NAME}
  Auth token:       ${auth_token}

Useful commands:
  research-agent status --project-root $(q "$PROJECT_ROOT")
  research-agent tunnel --project-root $(q "$PROJECT_ROOT")
  research-agent stop --project-root $(q "$PROJECT_ROOT")
  tmux attach -t ${TMUX_SESSION_NAME}
EOF
}

cmd_install() {
  local install_dir_override=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --install-dir)
        install_dir_override="${2:-}"
        shift 2
        ;;
      --backend-binary-url)
        BACKEND_BINARY_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-base-url)
        BACKEND_BINARY_BASE_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-sha256)
        BACKEND_BINARY_SHA256="${2:-}"
        shift 2
        ;;
      --frontend-bundle-url)
        FRONTEND_BUNDLE_URL="${2:-}"
        shift 2
        ;;
      --frontend-bundle-base-url)
        FRONTEND_BUNDLE_BASE_URL="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown install option: $1"
        ;;
    esac
  done

  if [ -n "$install_dir_override" ]; then
    INSTALL_DIR="$(cd "$install_dir_override" && pwd)"
  fi

  if [ -f "${INSTALL_DIR}/package.json" ]; then
    require_cmd npm
    log "Installing frontend dependencies in ${INSTALL_DIR}"
    (cd "$INSTALL_DIR" && npm install)
  else
    log "No source package.json found in ${INSTALL_DIR}; continuing with artifact-only install"
  fi

  machine_onboard
  install_cli_links

  log "Install complete"
  log "Run: research-agent start --project-root \"\$PWD\""
}

cmd_fetch_backend() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --install-dir)
        INSTALL_DIR="$(cd "${2:-}" && pwd)"
        shift 2
        ;;
      --backend-binary-url)
        BACKEND_BINARY_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-base-url)
        BACKEND_BINARY_BASE_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-sha256)
        BACKEND_BINARY_SHA256="${2:-}"
        shift 2
        ;;
      --frontend-bundle-url)
        FRONTEND_BUNDLE_URL="${2:-}"
        shift 2
        ;;
      --frontend-bundle-base-url)
        FRONTEND_BUNDLE_BASE_URL="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown fetch-backend option: $1"
        ;;
    esac
  done

  if ! download_backend_binary; then
    die "Unable to download backend binary. Set --backend-binary-url or --backend-binary-base-url."
  fi

  save_machine_config
  log "Backend binary is ready: ${BACKEND_BIN}"
}

cmd_fetch_frontend() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --install-dir)
        INSTALL_DIR="$(cd "${2:-}" && pwd)"
        shift 2
        ;;
      --frontend-bundle-url)
        FRONTEND_BUNDLE_URL="${2:-}"
        shift 2
        ;;
      --frontend-bundle-base-url)
        FRONTEND_BUNDLE_BASE_URL="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown fetch-frontend option: $1"
        ;;
    esac
  done

  if ! download_frontend_bundle; then
    die "Unable to download frontend bundle. Set --frontend-bundle-url or --frontend-bundle-base-url."
  fi

  save_machine_config
  log "Frontend static bundle is ready: $(get_frontend_static_dir)"
}

cmd_build_backend() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --install-dir)
        INSTALL_DIR="$(cd "${2:-}" && pwd)"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown build-backend option: $1"
        ;;
    esac
  done

  local build_script="${INSTALL_DIR}/server/build-backend-binary.sh"
  [ -x "$build_script" ] || die "Missing build script: ${build_script}"
  "$build_script"

  local backend_bin
  backend_bin="$(get_backend_binary || true)"
  if [ -z "$backend_bin" ]; then
    die "Backend binary build finished but no executable was found in server/dist"
  fi

  BACKEND_BIN="$backend_bin"
  save_machine_config
  log "Backend binary ready at ${BACKEND_BIN}"
}

cmd_onboard() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --install-dir)
        INSTALL_DIR="$(cd "${2:-}" && pwd)"
        shift 2
        ;;
      --backend-binary-url)
        BACKEND_BINARY_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-base-url)
        BACKEND_BINARY_BASE_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-sha256)
        BACKEND_BINARY_SHA256="${2:-}"
        shift 2
        ;;
      --frontend-bundle-url)
        FRONTEND_BUNDLE_URL="${2:-}"
        shift 2
        ;;
      --frontend-bundle-base-url)
        FRONTEND_BUNDLE_BASE_URL="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown onboard option: $1"
        ;;
    esac
  done

  machine_onboard
  log "Onboarding complete"
}

cmd_start() {
  local project_root="."
  local with_tunnel=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-root)
        project_root="${2:-}"
        shift 2
        ;;
      --frontend-port)
        FRONTEND_PORT="${2:-}"
        shift 2
        ;;
      --backend-port)
        BACKEND_PORT="${2:-}"
        shift 2
        ;;
      --opencode-port)
        OPENCODE_PORT="${2:-}"
        shift 2
        ;;
      --backend-binary-url)
        BACKEND_BINARY_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-base-url)
        BACKEND_BINARY_BASE_URL="${2:-}"
        shift 2
        ;;
      --backend-binary-sha256)
        BACKEND_BINARY_SHA256="${2:-}"
        shift 2
        ;;
      --frontend-bundle-url)
        FRONTEND_BUNDLE_URL="${2:-}"
        shift 2
        ;;
      --frontend-bundle-base-url)
        FRONTEND_BUNDLE_BASE_URL="${2:-}"
        shift 2
        ;;
      --tunnel)
        with_tunnel=1
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown start option: $1"
        ;;
    esac
  done

  [ -d "$project_root" ] || die "Project root does not exist: ${project_root}"
  init_project_context "$project_root"

  if [ ! -f "$ONBOARDED_FILE" ]; then
    log "Machine is not onboarded yet; running onboarding"
    machine_onboard
  fi

  require_cmd tmux
  require_cmd curl
  require_cmd opencode

  local backend_bin
  backend_bin="$(get_backend_binary || true)"
  if [ -z "$backend_bin" ] && [ ! -x "$PYTHON_BIN" ]; then
    download_backend_binary || true
    backend_bin="$(get_backend_binary || true)"
  fi
  if [ -z "$backend_bin" ] && [ ! -x "$PYTHON_BIN" ]; then
    machine_onboard
    backend_bin="$(get_backend_binary || true)"
  fi
  if [ -n "$backend_bin" ]; then
    BACKEND_BIN="$backend_bin"
  elif [ ! -x "$PYTHON_BIN" ]; then
    die "No backend runtime found. Build a binary with 'research-agent build-backend' or install Python runtime."
  fi

  ensure_auth_token

  local auth_token
  auth_token="$(get_auth_token)"
  start_services "$auth_token"
  write_runtime_file

  if [ "$with_tunnel" -eq 1 ]; then
    start_tunnels
    write_runtime_file
  fi

  print_start_summary "$auth_token"

  if [ -n "$FRONTEND_PUBLIC_URL" ] || [ -n "$BACKEND_PUBLIC_URL" ]; then
    cat <<EOF

Public URLs:
  Frontend: ${FRONTEND_PUBLIC_URL:-not-ready}
  Backend:  ${BACKEND_PUBLIC_URL:-not-ready}
EOF
  fi
}

cmd_tunnel() {
  local project_root="."
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-root)
        project_root="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown tunnel option: $1"
        ;;
    esac
  done

  [ -d "$project_root" ] || die "Project root does not exist: ${project_root}"
  init_project_context "$project_root"
  load_runtime_file_if_exists

  start_tunnels
  write_runtime_file

  cat <<EOF
ngrok tunnels are active for ${PROJECT_ROOT}
  Frontend (public): ${FRONTEND_PUBLIC_URL}
  Backend  (public): ${BACKEND_PUBLIC_URL}

Frontend is configured to call backend at:
  ${FRONTEND_API_URL}
EOF
}

cmd_stop() {
  local project_root="."
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-root)
        project_root="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown stop option: $1"
        ;;
    esac
  done

  [ -d "$project_root" ] || die "Project root does not exist: ${project_root}"
  init_project_context "$project_root"
  load_runtime_file_if_exists
  require_cmd tmux

  if tmux_session_exists "$TMUX_SESSION_NAME"; then
    tmux kill-session -t "$TMUX_SESSION_NAME"
    log "Stopped tmux session ${TMUX_SESSION_NAME}"
  else
    log "No running session found for ${PROJECT_ROOT}"
  fi

  rm -f "$RUNTIME_FILE"
}

cmd_status() {
  local project_root="."
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-root)
        project_root="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown status option: $1"
        ;;
    esac
  done

  [ -d "$project_root" ] || die "Project root does not exist: ${project_root}"
  init_project_context "$project_root"
  load_runtime_file_if_exists
  require_cmd tmux

  printf 'Project root: %s\n' "$PROJECT_ROOT"
  printf 'Install dir:  %s\n' "$INSTALL_DIR"
  printf 'Tmux session: %s\n' "$TMUX_SESSION_NAME"
  local frontend_static_dir
  frontend_static_dir="$(get_frontend_static_dir || true)"
  if [ -n "$frontend_static_dir" ]; then
    printf 'Frontend:     http://127.0.0.1:%s (served by backend static)\n' "$BACKEND_PORT"
    printf 'Frontend dir: %s\n' "$frontend_static_dir"
  elif [ -f "${INSTALL_DIR}/package.json" ]; then
    printf 'Frontend:     http://127.0.0.1:%s\n' "$FRONTEND_PORT"
  else
    printf 'Frontend:     unavailable\n'
  fi
  printf 'Backend:      http://127.0.0.1:%s\n' "$BACKEND_PORT"
  local backend_bin
  backend_bin="$(get_backend_binary || true)"
  if [ -n "$backend_bin" ]; then
    printf 'Backend mode: binary (%s)\n' "$backend_bin"
  elif [ -n "$PYTHON_BIN" ]; then
    printf 'Backend mode: python (%s)\n' "$PYTHON_BIN"
  else
    printf 'Backend mode: unavailable\n'
  fi
  if [ -n "$FRONTEND_PUBLIC_URL" ] || [ -n "$BACKEND_PUBLIC_URL" ]; then
    printf 'Frontend pub: %s\n' "${FRONTEND_PUBLIC_URL:-n/a}"
    printf 'Backend pub:  %s\n' "${BACKEND_PUBLIC_URL:-n/a}"
  fi

  if tmux_session_exists "$TMUX_SESSION_NAME"; then
    printf 'Session up:   yes\n'
    tmux list-windows -t "$TMUX_SESSION_NAME" -F '  - #W: #F'
  else
    printf 'Session up:   no\n'
  fi
}

main() {
  local command="${1:-start}"
  if [ "$#" -gt 0 ]; then
    shift
  fi

  load_machine_config

  case "$command" in
    install)
      cmd_install "$@"
      ;;
    fetch-backend)
      cmd_fetch_backend "$@"
      ;;
    fetch-frontend)
      cmd_fetch_frontend "$@"
      ;;
    build-backend)
      cmd_build_backend "$@"
      ;;
    onboard)
      cmd_onboard "$@"
      ;;
    start)
      cmd_start "$@"
      ;;
    tunnel)
      cmd_tunnel "$@"
      ;;
    stop)
      cmd_stop "$@"
      ;;
    status)
      cmd_status "$@"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      die "Unknown command: ${command}. Use 'research-agent help'."
      ;;
  esac
}

main "$@"
__RESEARCH_AGENT_EMBEDDED__
fi
chmod +x "${INSTALL_DIR}/scripts/research-agent"

log "Running install bootstrap (artifact-first, no git clone)"
install_args=(install --install-dir "$INSTALL_DIR")

BACKEND_BINARY_URL="${RESEARCH_AGENT_BACKEND_BINARY_URL:-$DEFAULT_BACKEND_BINARY_URL}"
if [ -n "$BACKEND_BINARY_URL" ]; then
  install_args+=(--backend-binary-url "$BACKEND_BINARY_URL")
fi

FRONTEND_BUNDLE_URL="${RESEARCH_AGENT_FRONTEND_BUNDLE_URL:-$DEFAULT_FRONTEND_BUNDLE_URL}"
if [ -n "$FRONTEND_BUNDLE_URL" ]; then
  install_args+=(--frontend-bundle-url "$FRONTEND_BUNDLE_URL")
fi

if [ -n "${RESEARCH_AGENT_BACKEND_BINARY_BASE_URL:-}" ]; then
  install_args+=(--backend-binary-base-url "$RESEARCH_AGENT_BACKEND_BINARY_BASE_URL")
fi
if [ -n "${RESEARCH_AGENT_FRONTEND_BUNDLE_BASE_URL:-}" ]; then
  install_args+=(--frontend-bundle-base-url "$RESEARCH_AGENT_FRONTEND_BUNDLE_BASE_URL")
fi
if [ -n "${RESEARCH_AGENT_BACKEND_BINARY_SHA256:-}" ]; then
  install_args+=(--backend-binary-sha256 "$RESEARCH_AGENT_BACKEND_BINARY_SHA256")
fi

"${INSTALL_DIR}/scripts/research-agent" "${install_args[@]}"

cat <<EOF

Install complete.

Next step (from your research project root):
  research-agent start --project-root "\$PWD"

Optional public tunnel:
  research-agent tunnel --project-root "\$PWD"
EOF
