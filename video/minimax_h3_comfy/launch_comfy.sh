#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
mkdir -p "$LOG_DIR"

pkill -f "python.*main.py.*--port $PORT" >/dev/null 2>&1 || true
pkill -f "cloudflared tunnel" >/dev/null 2>&1 || true
pkill -f "lt --port $PORT" >/dev/null 2>&1 || true

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
  echo "ERROR: ComfyUI did not become ready. Last log lines:"
  tail -n 100 "$LOG_DIR/comfyui.log" || true
  exit 3
fi

echo "✅ ComfyUI is healthy on the Colab VM."

# Public access: LocalTunnel is the primary Colab path. It needs no account/token
# and is a useful fallback when trycloudflare DNS or Colab iframe proxying fails.
if ! command -v lt >/dev/null 2>&1; then
  echo "Installing LocalTunnel..."
  npm install -g localtunnel >/dev/null 2>&1
fi

rm -f "$LOG_DIR/localtunnel.log"
nohup lt --port "$PORT" >"$LOG_DIR/localtunnel.log" 2>&1 &
echo $! >"$LOG_DIR/localtunnel.pid"

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[-a-zA-Z0-9]+\.loca\.lt' "$LOG_DIR/localtunnel.log" | head -n1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "ERROR: LocalTunnel URL was not created."
  echo "LocalTunnel log:"
  tail -n 80 "$LOG_DIR/localtunnel.log" || true
  exit 4
fi

# LocalTunnel may show an abuse-prevention page asking for the tunnel password.
# Their password endpoint returns the public IP expected by that page.
TUNNEL_PASSWORD="$(curl -fsS --max-time 15 https://loca.lt/mytunnelpassword 2>/dev/null || true)"
if [[ -z "$TUNNEL_PASSWORD" ]]; then
  TUNNEL_PASSWORD="$(curl -fsS --max-time 15 https://api.ipify.org 2>/dev/null || true)"
fi

echo
echo "============================================================"
echo "✅ OPEN COMFYUI HERE: $PUBLIC_URL"
if [[ -n "$TUNNEL_PASSWORD" ]]; then
  echo "🔑 If LocalTunnel asks for a password, enter: $TUNNEL_PASSWORD"
fi
echo "============================================================"
echo "Keep this Colab runtime running while you use ComfyUI."
echo "ComfyUI log:     $LOG_DIR/comfyui.log"
echo "LocalTunnel log: $LOG_DIR/localtunnel.log"
