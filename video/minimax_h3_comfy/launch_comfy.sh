#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
VRAM_MODE="${H3_VRAM_MODE:-auto}"
RESERVE_VRAM_GB="${H3_RESERVE_VRAM_GB:-4}"
PREVIEW_METHOD="${H3_PREVIEW_METHOD:-none}"
PUBLIC_URL="https://comfy.zetbros.com"
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

COMFY_ARGS=(--listen 0.0.0.0 --port "$PORT" --disable-auto-launch "${VRAM_ARGS[@]}")

# Launch or reuse ComfyUI exactly as before.
if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
  echo "✅ Existing ComfyUI is healthy on port $PORT; reusing it."
else
  if ! (
    cd "$COMFY_ROOT"
    python - "${COMFY_ARGS[@]}" <<'PYCLI'
import comfy.options
comfy.options.enable_args_parsing()
import comfy.cli_args
print("ComfyUI CLI argument check: PASSED")
PYCLI
  ) >"$LOG_DIR/cli-check.log" 2>&1; then
    echo "ERROR: ComfyUI argument preflight failed. No server was started."
    cat "$LOG_DIR/cli-check.log"
    exit 2
  fi

  cat "$LOG_DIR/cli-check.log"
  echo "Starting ComfyUI on port $PORT..."
  echo "VRAM policy: $VRAM_MODE | reserved: ${RESERVE_VRAM_GB} GB | preview: $PREVIEW_METHOD"
  case "$VRAM_MODE" in
    auto|default|normalvram) echo "Using ComfyUI's default memory manager (no explicit VRAM mode flag)." ;;
  esac

  pkill -f "python.*main.py.*--port $PORT" >/dev/null 2>&1 || true
  (
    cd "$COMFY_ROOT"
    exec nohup python main.py "${COMFY_ARGS[@]}"
  ) >"$LOG_DIR/comfyui.log" 2>&1 </dev/null &
  COMFY_PID=$!
  echo "$COMFY_PID" >"$LOG_DIR/comfyui.pid"

  for _ in $(seq 1 90); do
    if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$COMFY_PID" 2>/dev/null; then
      EXIT_STATUS=0
      wait "$COMFY_PID" || EXIT_STATUS=$?
      echo "ERROR: ComfyUI exited before becoming ready (exit $EXIT_STATUS). Last log lines:"
      tail -n 100 "$LOG_DIR/comfyui.log" || true
      exit 3
    fi
    sleep 2
  done

  if ! curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
    echo "ERROR: ComfyUI did not become ready. Last log lines:"
    tail -n 100 "$LOG_DIR/comfyui.log" || true
    exit 3
  fi
  echo "✅ ComfyUI is healthy on the Colab VM."
fi

# Replace the original Pinggy public tunnel with the named Cloudflare Tunnel.
pkill -f "free.pinggy.io" >/dev/null 2>&1 || true
pkill -f "lt --port $PORT" >/dev/null 2>&1 || true
pkill -f "cloudflared.*tunnel.*run" >/dev/null 2>&1 || true

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Installing cloudflared..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) CF_ARCH="amd64" ;;
    aarch64|arm64) CF_ARCH="arm64" ;;
    *) echo "ERROR: Unsupported cloudflared architecture: $ARCH"; exit 4 ;;
  esac
  curl -fL --retry 3 --retry-delay 2 \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o /usr/local/bin/cloudflared
  chmod 0755 /usr/local/bin/cloudflared
fi

# Read the tunnel credential directly from Colab Secrets. The secret may contain
# either the raw eyJ... token or Cloudflare's full install command.
RAW_TOKEN="$(python - <<'PYTOKEN'
import re
from google.colab import userdata
raw = userdata.get('CF_TUNNEL_TOKEN') or ''
m = re.search(r'(eyJ[A-Za-z0-9._=-]+)', raw)
print(m.group(1) if m else raw.strip())
PYTOKEN
)"

if [[ -z "$RAW_TOKEN" || "$RAW_TOKEN" != eyJ* ]]; then
  echo "ERROR: Colab Secret CF_TUNNEL_TOKEN is missing or is not a Cloudflare Tunnel token."
  exit 5
fi

rm -f "$LOG_DIR/cloudflared.log"
echo "Starting Cloudflare Tunnel for $PUBLIC_URL ..."
nohup cloudflared tunnel --no-autoupdate run --token "$RAW_TOKEN" \
  >"$LOG_DIR/cloudflared.log" 2>&1 </dev/null &
CF_PID=$!
echo "$CF_PID" >"$LOG_DIR/cloudflared.pid"

REGISTERED=0
for _ in $(seq 1 60); do
  if ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "ERROR: cloudflared exited before connecting. Last log lines:"
    tail -n 100 "$LOG_DIR/cloudflared.log" || true
    exit 6
  fi
  if grep -q "Registered tunnel connection" "$LOG_DIR/cloudflared.log"; then
    REGISTERED=1
    break
  fi
  sleep 1
done

if [[ "$REGISTERED" != "1" ]]; then
  echo "ERROR: Cloudflare Tunnel did not register within 60 seconds."
  tail -n 100 "$LOG_DIR/cloudflared.log" || true
  exit 7
fi

# Local origin check: Cloudflare is configured to forward comfy.zetbros.com to
# http://127.0.0.1:8188, so this verifies the exact origin service is alive.
if ! curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
  echo "ERROR: Cloudflare connected, but the local ComfyUI origin is not responding."
  exit 8
fi

echo
echo "============================================================"
echo "✅ COMFYUI LOCAL CHECK: PASSED"
echo "✅ CLOUDFLARE TUNNEL: CONNECTED"
echo "🌐 OPEN COMFYUI HERE: $PUBLIC_URL"
echo "============================================================"
echo "Keep this Colab runtime running while you use ComfyUI."
echo "ComfyUI log:    $LOG_DIR/comfyui.log"
echo "Cloudflare log: $LOG_DIR/cloudflared.log"
