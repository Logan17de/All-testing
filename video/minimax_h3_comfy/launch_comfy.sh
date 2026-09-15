#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
VRAM_MODE="${H3_VRAM_MODE:-auto}"
RESERVE_VRAM_GB="${H3_RESERVE_VRAM_GB:-4}"
PREVIEW_METHOD="${H3_PREVIEW_METHOD:-none}"
mkdir -p "$LOG_DIR"

export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export CUDA_MODULE_LOADING="${CUDA_MODULE_LOADING:-LAZY}"

VRAM_ARGS=()
case "$VRAM_MODE" in
  highvram) VRAM_ARGS+=(--highvram) ;;
  auto|default|normalvram) ;;
  lowvram) VRAM_ARGS+=(--lowvram) ;;
  *) echo "ERROR: H3_VRAM_MODE must be auto, default, normalvram, highvram, or lowvram"; exit 2 ;;
esac
VRAM_ARGS+=(--reserve-vram "$RESERVE_VRAM_GB" --preview-method "$PREVIEW_METHOD")

# Both access methods forward to the fixed local ComfyUI port.
if [[ "$PORT" != "8188" ]]; then
  echo "ERROR: ComfyUI access requires COMFY_PORT=8188."
  exit 2
fi
export COMFY_ROOT H3_LOG_DIR="$LOG_DIR"
export H3_COMFY_VRAM_ARGS
H3_COMFY_VRAM_ARGS="$(python -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "${VRAM_ARGS[@]}")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default: preflight only. Restart leaves the selected access connector running.
exec python "$SCRIPT_DIR/comfy_preflight.py" "${1:-preflight}"
