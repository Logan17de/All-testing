#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
mkdir -p "$LOG_DIR"

pkill -f "python.*main.py.*--port $PORT" >/dev/null 2>&1 || true
pkill -f "cloudflared tunnel" >/dev/null 2>&1 || true

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

# Quick Tunnels can fail over QUIC in some hosted notebook networks.
# Force HTTP/2/TCP and remove any accidental local cloudflared config that can
# disable TryCloudflare quick tunnels.
if [[ -f "$HOME/.cloudflared/config.yml" ]]; then
  mv "$HOME/.cloudflared/config.yml" "$HOME/.cloudflared/config.yml.disabled-for-colab" || true
fi
if [[ -f "$HOME/.cloudflared/config.yaml" ]]; then
  mv "$HOME/.cloudflared/config.yaml" "$HOME/.cloudflared/config.yaml.disabled-for-colab" || true
fi

nohup cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" \
  >"$LOG_DIR/cloudflared.log" 2>&1 &
echo $! >"$LOG_DIR/cloudflared.pid"

PUBLIC_URL=""
for _ in $(seq 1 90); do
  PUBLIC_URL="$(grep -oE 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$LOG_DIR/cloudflared.log" | head -n1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 1
done

echo
if [[ -n "$PUBLIC_URL" ]]; then
  echo "Tunnel created: $PUBLIC_URL"
  echo "Checking it from the Colab runtime..."
  STATUS="$(curl -L -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "$PUBLIC_URL" || true)"
  if [[ "$STATUS" =~ ^(200|301|302|307|308)$ ]]; then
    echo "COMFYUI_URL=$PUBLIC_URL"
    echo "Public tunnel check passed (HTTP $STATUS)."
  else
    echo "WARNING: public tunnel check returned HTTP ${STATUS:-failed}."
    echo "Use the Colab iframe fallback in the next notebook cell."
    echo "COMFYUI_URL=$PUBLIC_URL"
  fi
else
  echo "WARNING: Tunnel URL was not created."
  echo "Use the Colab iframe fallback in the next notebook cell."
  echo "Cloudflare log: $LOG_DIR/cloudflared.log"
fi

echo "ComfyUI log: $LOG_DIR/comfyui.log"
