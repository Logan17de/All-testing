#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
mkdir -p "$LOG_DIR"

pkill -f "python.*main.py.*--port $PORT" >/dev/null 2>&1 || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" >/dev/null 2>&1 || true

echo "Starting ComfyUI on port $PORT..."
(
  cd "$COMFY_ROOT"
  nohup python main.py --listen 0.0.0.0 --port "$PORT" --disable-auto-launch \
    >"$LOG_DIR/comfyui.log" 2>&1 &
  echo $! >"$LOG_DIR/comfyui.pid"
)

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
  echo "ComfyUI did not become ready. Last log lines:"
  tail -n 80 "$LOG_DIR/comfyui.log" || true
  exit 3
fi

echo "ComfyUI is ready locally: http://127.0.0.1:$PORT"

nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" \
  >"$LOG_DIR/cloudflared.log" 2>&1 &
echo $! >"$LOG_DIR/cloudflared.pid"

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$LOG_DIR/cloudflared.log" | head -n1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 1
done

echo
if [[ -n "$PUBLIC_URL" ]]; then
  echo "COMFYUI_URL=$PUBLIC_URL"
  echo "Open that URL in your browser."
else
  echo "Tunnel URL not found yet. Inspect: $LOG_DIR/cloudflared.log"
fi
echo "ComfyUI log: $LOG_DIR/comfyui.log"
