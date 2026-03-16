#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="Iris Studio"
DEFAULT_IRIS_DIR="${ROOT_DIR}/vendor/iris.c"
DEFAULT_MODELS_DIR="${ROOT_DIR}/Models"
ENV_PATH="${ROOT_DIR}/.env"

log() {
  printf '\n[%s] %s\n' "$PROJECT_NAME" "$1" >&2
}

warn() {
  printf '\n[%s] Warning: %s\n' "$PROJECT_NAME" "$1" >&2
}

fail() {
  printf '\n[%s] Error: %s\n' "$PROJECT_NAME" "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "This quick start targets macOS on Apple Silicon."
  fi

  if [[ "$(uname -m)" != "arm64" ]]; then
    warn "This app is designed for Apple Silicon. Continuing anyway."
  fi
}

ensure_xcode_cli() {
  if ! xcode-select -p >/dev/null 2>&1; then
    fail "Xcode Command Line Tools are required. Run: xcode-select --install"
  fi
}

ensure_node() {
  require_command node
  require_command npm

  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$node_major" -lt 20 ]]; then
    fail "Node.js 20 or newer is required. Current version: $(node -v)"
  fi
}

prepare_iris_checkout() {
  local iris_dir="$1"

  mkdir -p "$(dirname "$iris_dir")"

  if [[ -d "$iris_dir/.git" ]]; then
    log "Updating existing iris.c checkout at $iris_dir"
    git -C "$iris_dir" pull --ff-only 2>/dev/null || warn "Could not pull latest iris.c (offline or diverged). Building from current checkout."
  elif [[ -e "$iris_dir" ]]; then
    fail "The path $iris_dir already exists but is not a git checkout. Move it aside and re-run quickstart."
  else
    log "Cloning antirez/iris.c into $iris_dir"
    git clone https://github.com/antirez/iris.c.git "$iris_dir"
  fi

  local lora_patch="${ROOT_DIR}/vendor/iris-lora.patch"
  if [[ -f "$lora_patch" ]]; then
    if git -C "$iris_dir" apply --check "$lora_patch" 2>/dev/null; then
      log "Applying LoRA patch to iris.c"
      git -C "$iris_dir" apply "$lora_patch"
    else
      log "LoRA patch already applied (or not needed)"
    fi
  fi

  log "Building iris.c with Metal support via make mps"
  make -C "$iris_dir" mps

  if [[ ! -x "$iris_dir/iris" ]]; then
    fail "Expected built binary at $iris_dir/iris"
  fi
}

dotenv_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"\n' "$value"
}

write_env_file() {
  local iris_bin="$1"
  local model_dir="$2"
  local storage_root="${ROOT_DIR}/storage"
  local output_dir="${ROOT_DIR}/Outputs"
  local upload_dir="${storage_root}/uploads"
  local thumb_dir="${storage_root}/thumbs"
  local db_path="${storage_root}/app.db"

  mkdir -p "$model_dir" "${ROOT_DIR}/Loras" "$output_dir" "$upload_dir" "$thumb_dir"

  if [[ -f "$ENV_PATH" ]]; then
    local backup_path="${ENV_PATH}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$ENV_PATH" "$backup_path"
    log "Backed up existing .env to $backup_path"
  fi

  cat > "$ENV_PATH" <<EOF
IRIS_BIN=$(dotenv_escape "$iris_bin")
IRIS_MODEL_DIR=$(dotenv_escape "$model_dir")
IRIS_LORA_DIR=$(dotenv_escape "${ROOT_DIR}/Loras")
IRIS_OUTPUT_DIR=$(dotenv_escape "$output_dir")
IRIS_UPLOAD_DIR=$(dotenv_escape "$upload_dir")
IRIS_THUMB_DIR=$(dotenv_escape "$thumb_dir")
IRIS_DB_PATH=$(dotenv_escape "$db_path")
EOF

  log "Wrote environment config to $ENV_PATH"
}

main() {
  ensure_macos
  require_command git
  require_command make
  ensure_xcode_cli
  ensure_node

  log "Quick start will install npm packages, prepare iris.c inside this repo, configure .env with repo-local paths, and launch the app."

  prepare_iris_checkout "$DEFAULT_IRIS_DIR"

  log "Installing npm dependencies"
  (cd "$ROOT_DIR" && npm install)

  write_env_file "$DEFAULT_IRIS_DIR/iris" "$DEFAULT_MODELS_DIR"

  log "Setup complete."
  printf '\nNext environment values:\n'
  printf '  IRIS_BIN=%s\n' "$DEFAULT_IRIS_DIR/iris"
  printf '  IRIS_MODEL_DIR=%s\n' "$DEFAULT_MODELS_DIR"
  printf '  IRIS_LORA_DIR=%s\n' "${ROOT_DIR}/Loras"

  log "Models are not downloaded by quickstart anymore. Open the web UI at http://localhost:3000 and use the Models page when you're ready."
  log "Starting the app... Web UI: http://localhost:3000  API: http://127.0.0.1:8787"
  cd "$ROOT_DIR"
  npm run dev
}

main "$@"
