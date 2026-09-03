#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
mkdir -p "$LOG_DIR"

# Reuse a healthy ComfyUI process instead of restarting it every time we change
# tunnel providers. This avoids unnecessary model/UI reloads during Colab tests.
if curl -fsS "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
  echo "✅ Existing ComfyUI is healthy on port $PORT; reusing it."
else
  echo "Starting ComfyUI on port $PORT..."
  pkill -f "python.*main.py.*--port $PORT" >/dev/null 2>&1 || true
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
fi

# Kill only previous tunnel helpers. Keep ComfyUI itself alive.
pkill -f "cloudflared tunnel" >/dev/null 2>&1 || true
pkill -f "lt --port $PORT" >/dev/null 2>&1 || true
pkill -f "free.pinggy.io" >/dev/null 2>&1 || true

# Pinggy uses an SSH reverse tunnel over port 443 and does not require an account
# for a temporary free URL. It works better for full web apps that need WebSockets.
if ! command -v ssh >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq openssh-client >/dev/null
fi

rm -f "$LOG_DIR/pinggy.log"
echo "Creating Pinggy tunnel..."
nohup ssh \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -p 443 \
  -R0:127.0.0.1:"$PORT" \
  free.pinggy.io \
  >"$LOG_DIR/pinggy.log" 2>&1 &
echo $! >"$LOG_DIR/pinggy.pid"

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[-A-Za-z0-9.]+(pinggy\.link|pinggy-free\.link)' "$LOG_DIR/pinggy.log" | head -n1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "ERROR: Pinggy did not return a public URL."
  echo "Pinggy log:"
  tail -n 100 "$LOG_DIR/pinggy.log" || true
  exit 4
fi

# Verify that public HTTP traffic reaches the actual ComfyUI backend.
echo "Checking remote ComfyUI HTTP endpoint..."
HTTP_STATUS="$(curl -A 'h3-colab-health/1.0' -sS -o /tmp/h3_remote_stats.json -w '%{http_code}' \
  --connect-timeout 15 --max-time 25 "$PUBLIC_URL/system_stats" || true)"
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "ERROR: Tunnel URL exists but /system_stats returned HTTP ${HTTP_STATUS:-failed}."
  tail -n 100 "$LOG_DIR/pinggy.log" || true
  exit 5
fi

# Verify the same WebSocket endpoint the ComfyUI frontend uses.
python -m pip install -q websocket-client >/dev/null 2>&1
WS_URL="${PUBLIC_URL/https:\/\//wss://}/ws?clientId=h3-colab-tunnel-test"
if ! python - "$WS_URL" <<'PY'
import sys
import websocket

url = sys.argv[1]
ws = websocket.create_connection(url, timeout=20)
ws.close()
print("WebSocket OK")
PY
then
  echo "ERROR: HTTP works but the ComfyUI WebSocket cannot pass through this tunnel."
  exit 6
fi

echo
echo "============================================================"
echo "✅ COMFYUI HTTP CHECK: PASSED"
echo "✅ COMFYUI WEBSOCKET CHECK: PASSED"
echo "🌐 OPEN COMFYUI HERE: $PUBLIC_URL"
echo "============================================================"
echo "Pinggy free tunnels may show a one-time browser screening page; choose Continue."
echo "No IP/password is required."
echo "Keep this Colab runtime running while you use ComfyUI."
echo "ComfyUI log: $LOG_DIR/comfyui.log"
echo "Pinggy log:  $LOG_DIR/pinggy.log"
