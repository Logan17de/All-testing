#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
VRAM_MODE="${H3_VRAM_MODE:-auto}"
RESERVE_VRAM_GB="${H3_RESERVE_VRAM_GB:-4}"
PREVIEW_METHOD="${H3_PREVIEW_METHOD:-none}"
PUBLIC_URL="${CLOUDFLARE_COMFY_URL:-https://comfy.zetbros.com}"
mkdir -p "$LOG_DIR"

export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export CUDA_MODULE_LOADING="${CUDA_MODULE_LOADING:-LAZY}"

VRAM_ARGS=()
case "$VRAM_MODE" in
  highvram) VRAM_ARGS+=(--highvram) ;;
  auto|default|normalvram) ;;
  lowvram) VRAM_ARGS+=(--lowvram) ;;
  *) echo "ERROR: invalid H3_VRAM_MODE"; exit 2 ;;
esac
VRAM_ARGS+=(--reserve-vram "$RESERVE_VRAM_GB" --preview-method "$PREVIEW_METHOD")
COMFY_ARGS=(--listen 127.0.0.1 --port "$PORT" --disable-auto-launch "${VRAM_ARGS[@]}")

if ! curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
  echo "Starting ComfyUI on port $PORT..."
  pkill -f "python.*main.py.*--port $PORT" >/dev/null 2>&1 || true
  (
    cd "$COMFY_ROOT"
    exec nohup python main.py "${COMFY_ARGS[@]}"
  ) >"$LOG_DIR/comfyui.log" 2>&1 </dev/null &
  COMFY_PID=$!
  echo "$COMFY_PID" >"$LOG_DIR/comfyui.pid"

  for _ in $(seq 1 90); do
    curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1 && break
    kill -0 "$COMFY_PID" 2>/dev/null || { tail -n 100 "$LOG_DIR/comfyui.log" || true; exit 3; }
    sleep 2
  done
fi

curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1 || { echo "ERROR: ComfyUI is not healthy"; exit 3; }
echo "✅ ComfyUI is healthy."

if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_TUNNEL_TOKEN is not set."
  exit 4
fi
command -v cloudflared >/dev/null 2>&1 || { echo "ERROR: cloudflared is not installed"; exit 5; }

pkill -f "cloudflared.*tunnel" >/dev/null 2>&1 || true
rm -f "$LOG_DIR/cloudflared.log"
nohup cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" >"$LOG_DIR/cloudflared.log" 2>&1 </dev/null &
CF_PID=$!
echo "$CF_PID" >"$LOG_DIR/cloudflared.pid"

for _ in $(seq 1 60); do
  kill -0 "$CF_PID" 2>/dev/null || { tail -n 100 "$LOG_DIR/cloudflared.log" || true; exit 6; }
  grep -Eq "Registered tunnel connection|Connection .* registered|Tunnel connection" "$LOG_DIR/cloudflared.log" && break
  sleep 1
done

echo "✅ Cloudflare Tunnel is running."
echo "🌐 OPEN COMFYUI HERE: $PUBLIC_URL"
echo "Closing/reloading the browser does not cancel a queued generation."
echo "Generation continues while the Colab VM remains alive."
