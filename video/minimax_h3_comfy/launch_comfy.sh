#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
PORT="${COMFY_PORT:-8188}"
LOG_DIR="${H3_LOG_DIR:-/content/h3_comfy_logs}"
VRAM_MODE="${H3_VRAM_MODE:-auto}"
RESERVE_VRAM_GB="${H3_RESERVE_VRAM_GB:-4}"
PREVIEW_METHOD="${H3_PREVIEW_METHOD:-none}"
mkdir -p "$LOG_DIR"

# Long video sampling can fragment the CUDA allocator across clips. Expandable
# segments let PyTorch reuse/free large blocks more gracefully on Colab GPUs.
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export CUDA_MODULE_LOADING="${CUDA_MODULE_LOADING:-LAZY}"

VRAM_ARGS=()
case "$VRAM_MODE" in
  highvram) VRAM_ARGS+=(--highvram) ;;
  # Legacy notebooks set normalvram. Modern ComfyUI has no such CLI flag;
  # leave its default memory manager enabled rather than forcing highvram.
  auto|default|normalvram) ;;
  lowvram) VRAM_ARGS+=(--lowvram) ;;
  *) echo "ERROR: H3_VRAM_MODE must be auto, default, normalvram, highvram, or lowvram"; exit 2 ;;
esac
VRAM_ARGS+=(--reserve-vram "$RESERVE_VRAM_GB" --preview-method "$PREVIEW_METHOD")

COMFY_ARGS=(--listen 0.0.0.0 --port "$PORT" --disable-auto-launch "${VRAM_ARGS[@]}")

# Launch or reuse ComfyUI. The notebook's legacy normalvram setting is accepted.
if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null 2>&1; then
  echo "✅ Existing ComfyUI is healthy on port $PORT; reusing it."
else
  # Validate with the installed ComfyUI parser before loading CUDA or models.
  # Do not use --help for validation: argparse can exit before rejecting flags.
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

# Keep ComfyUI alive when refreshing the public tunnel.
pkill -f "cloudflared tunnel" >/dev/null 2>&1 || true
pkill -f "lt --port $PORT" >/dev/null 2>&1 || true
pkill -f "free.pinggy.io" >/dev/null 2>&1 || true

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
  tail -n 100 "$LOG_DIR/pinggy.log" || true
  exit 4
fi

echo "Checking remote ComfyUI HTTP endpoint..."
HTTP_STATUS="$(curl -A 'h3-colab-health/1.0' -sS -o /tmp/h3_remote_stats.json -w '%{http_code}' \
  --connect-timeout 15 --max-time 25 "$PUBLIC_URL/system_stats" || true)"
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "ERROR: Tunnel URL exists but /system_stats returned HTTP ${HTTP_STATUS:-failed}."
  tail -n 100 "$LOG_DIR/pinggy.log" || true
  exit 5
fi

python -m pip install -q websocket-client >/dev/null 2>&1
WS_URL="${PUBLIC_URL/https:\/\//wss://}/ws?clientId=h3-colab-tunnel-test"
if ! python - "$WS_URL" <<'PY'
import sys
import websocket
ws = websocket.create_connection(sys.argv[1], timeout=20)
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
echo "Recommended workflow: MiniMax_H3_G4_Optimized_FullBatch.json"
echo "OOM fallback:          MiniMax_H3_G4_Optimized_Safe_ClipByClip.json"
echo "Keep this Colab runtime running while you use ComfyUI."
echo "ComfyUI log: $LOG_DIR/comfyui.log"
echo "Pinggy log:  $LOG_DIR/pinggy.log"
