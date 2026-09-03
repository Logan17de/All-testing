#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
mkdir -p "$LOG_DIR"

# Stop only an older ComfyUI process on this port. Public tunnels are intentionally
# not part of the normal Colab path; Colab's own authenticated port proxy is used.
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
  echo "ERROR: ComfyUI did not become ready. Last log lines:"
  tail -n 100 "$LOG_DIR/comfyui.log" || true
  exit 3
fi

echo
echo "✅ ComfyUI is running and healthy."
echo "LOCAL_URL=http://127.0.0.1:$PORT"
echo "Do not open LOCAL_URL directly from your browser; it belongs to the Colab VM."
echo "Use the next Colab cell (serve_kernel_port_as_iframe) to open ComfyUI."
echo "ComfyUI log: $LOG_DIR/comfyui.log"
