#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="Iris Studio"
DEFAULT_IRIS_DIR="${ROOT_DIR}/vendor/iris.c"
DEFAULT_MODELS_DIR="${ROOT_DIR}/Models"
HF_MODEL_URL="https://huggingface.co/black-forest-labs/FLUX.2-klein-9B"
HF_REPO_ID="black-forest-labs/FLUX.2-klein-9B"
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

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local response

  read -r -p "$prompt [$default_value]: " response
  if [[ -z "$response" ]]; then
    printf '%s\n' "$default_value"
  else
    printf '%s\n' "$response"
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local default_answer="$2"
  local suffix
  local response

  if [[ "$default_answer" == "y" ]]; then
    suffix="[Y/n]"
  else
    suffix="[y/N]"
  fi

  while true; do
    read -r -p "$prompt $suffix " response
    response="${response:-$default_answer}"
    response="$(printf '%s' "$response" | tr '[:upper:]' '[:lower:]')"
    case "$response" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) printf 'Please answer y or n.\n' ;;
    esac
  done
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

ensure_python() {
  require_command python3
  if ! python3 -m pip --version >/dev/null 2>&1; then
    fail "python3 with pip is required to install the Hugging Face CLI."
  fi
}

install_hf_cli_if_needed() {
  if command -v hf >/dev/null 2>&1; then
    return
  fi

  ensure_python
  log "Installing the Hugging Face CLI under your user account."
  python3 -m pip install --user --upgrade "huggingface_hub[cli]"
  export PATH="$(python3 -m site --user-base)/bin:${PATH}"

  if ! command -v hf >/dev/null 2>&1; then
    fail "The Hugging Face CLI was installed but is not on PATH. Re-run this script after adding $(python3 -m site --user-base)/bin to your shell PATH."
  fi
}

prepare_iris_checkout() {
  local iris_dir="$1"

  mkdir -p "$(dirname "$iris_dir")"

  if [[ -d "$iris_dir/.git" ]]; then
    log "Updating existing iris.c checkout at $iris_dir"
    git -C "$iris_dir" pull --ff-only 2>/dev/null || warn "Could not pull latest iris.c (offline or diverged). Building from current checkout."
  elif [[ -e "$iris_dir" ]]; then
    fail "The path $iris_dir already exists but is not a git checkout. Move it or choose a different location."
  else
    log "Cloning antirez/iris.c into $iris_dir"
    git clone https://github.com/antirez/iris.c.git "$iris_dir"
  fi

  # Apply custom LoRA patch if not already applied.
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

download_model_snapshot() {
  local models_root="$1"
  local token="$2"
  local download_failed=0
  local model_dir="${models_root}/flux-klein-9b-distilled"

  mkdir -p "$models_root"
  install_hf_cli_if_needed

  log "Downloading FLUX.2 [klein] 9B into $model_dir"
  if ! HF_TOKEN="$token" hf download "$HF_REPO_ID" --local-dir "$model_dir"; then
    download_failed=1
  fi

  if [[ "$download_failed" -ne 0 ]]; then
    fail "Hugging Face download failed. Confirm the token is valid and that you accepted the terms at $HF_MODEL_URL"
  fi
}

resolve_model_dir() {
  local model_dir="$DEFAULT_MODELS_DIR"
  local choice=""
  local hf_token=""

  printf '\nModel setup options:\n' >&2
  printf '  1. Download FLUX.2 [klein] 9B into this project now (requires HF token)\n' >&2
  printf '  2. Use an existing local folder that already has the model\n' >&2
  printf '  3. Skip model setup for now (you can download later via the Web UI)\n' >&2

  while [[ -z "$choice" ]]; do
    read -r -p "Choose 1, 2, or 3 [3]: " choice
    choice="${choice:-3}"
    case "$choice" in
      1)
        log "The official model page is:"
        printf '  %s\n' "$HF_MODEL_URL"
        printf 'You must sign in and click Agree on that page before the token will work.\n'

        if prompt_yes_no "Open the model page in your browser now?" "y"; then
          open "$HF_MODEL_URL"
        fi

        if ! prompt_yes_no "Have you already accepted the terms on that page?" "n"; then
          fail "Accept the model terms first, then re-run this script."
        fi

        read -r -s -p "Paste your Hugging Face access token: " hf_token
        printf '\n'
        if [[ -z "$hf_token" ]]; then
          fail "A non-empty Hugging Face token is required for the download path."
        fi

        model_dir="$(prompt_with_default "Project Models folder" "$DEFAULT_MODELS_DIR")"
        download_model_snapshot "$model_dir" "$hf_token"
        ;;
      2)
        model_dir="$(prompt_with_default "Project Models folder" "$DEFAULT_MODELS_DIR")"
        if [[ ! -d "$model_dir" ]]; then
          fail "Models folder not found: $model_dir"
        fi
        ;;
      3)
        model_dir="$DEFAULT_MODELS_DIR"
        mkdir -p "$model_dir"
        warn "Skipping model setup. The app config will still point IRIS_MODEL_DIR at $model_dir"
        ;;
      *)
        printf 'Please choose 1, 2, or 3.\n' >&2
        choice=""
        ;;
    esac
  done

  RESOLVED_MODEL_DIR="$model_dir"
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
  local output_dir="${storage_root}/outputs"
  local upload_dir="${storage_root}/uploads"
  local thumb_dir="${storage_root}/thumbs"
  local db_path="${storage_root}/app.db"

  mkdir -p "$output_dir" "$upload_dir" "$thumb_dir"

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

  log "Quick start will install npm packages, prepare iris.c inside this repo, configure .env, and optionally launch the app."

  local iris_dir
  iris_dir="$(prompt_with_default "Local iris.c checkout" "$DEFAULT_IRIS_DIR")"
  prepare_iris_checkout "$iris_dir"

  local model_dir
  resolve_model_dir
  model_dir="$RESOLVED_MODEL_DIR"

  log "Installing npm dependencies"
  (cd "$ROOT_DIR" && npm install)

  write_env_file "$iris_dir/iris" "$model_dir"

  log "Setup complete."
  printf '\nNext environment values:\n'
  printf '  IRIS_BIN=%s\n' "$iris_dir/iris"
  printf '  IRIS_MODEL_DIR=%s\n' "$model_dir"

  log "Starting the app... Web UI: http://localhost:3000  API: http://127.0.0.1:8787"
  cd "$ROOT_DIR"
  npm run dev
}

main "$@"
