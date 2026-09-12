#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
H3_DRIVE_ROOT="${H3_DRIVE_ROOT:-}"
H3_PERSIST_MODELS="${H3_PERSIST_MODELS:-0}"
H3_PERSIST_OUTPUT="${H3_PERSIST_OUTPUT:-1}"
EXTENDER_DIR="$COMFY_ROOT/custom_nodes/ComfyUI_MiniMax_H3_Extender"
LATENT_UPSCALER_DIR="$COMFY_ROOT/custom_nodes/Comfyui_Minimax_h3_latent_Upscaler"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== MiniMax H3 + ComfyUI setup =="
python --version
nvidia-smi || true

python -m pip install -q -U pip setuptools wheel

if [[ -d "$COMFY_ROOT/.git" ]]; then
  echo "Updating ComfyUI..."
  git -C "$COMFY_ROOT" pull --ff-only
else
  echo "Cloning ComfyUI..."
  rm -rf "$COMFY_ROOT"
  git clone --depth 1 https://github.com/Comfy-Org/ComfyUI.git "$COMFY_ROOT"
fi

python -m pip install -q -r "$COMFY_ROOT/requirements.txt"
python -m pip install -q -U "huggingface_hub[hf_xet]" requests imageio-ffmpeg websocket-client

mkdir -p "$COMFY_ROOT/custom_nodes"

if [[ -d "$EXTENDER_DIR/.git" ]]; then
  echo "Updating MiniMax H3 Extender..."
  # Our UI compatibility patch modifies extender.js; reset that generated patch
  # before updating so rerunning the setup cell in one Colab session is safe.
  git -C "$EXTENDER_DIR" reset --hard HEAD >/dev/null
  git -C "$EXTENDER_DIR" pull --ff-only
else
  echo "Installing MiniMax H3 Extender..."
  git clone --depth 1 https://github.com/tritant/ComfyUI_MiniMax_H3_Extender.git "$EXTENDER_DIR"
fi
if [[ -f "$EXTENDER_DIR/requirements.txt" ]]; then
  python -m pip install -q -r "$EXTENDER_DIR/requirements.txt"
fi

# Required by H3_Local_OpenSource_MaxQuality_T2V.json.
# Provides the MinimaxH3LatentUpscaler3D node.
if [[ -d "$LATENT_UPSCALER_DIR/.git" ]]; then
  echo "Updating MiniMax H3 Latent Upscaler..."
  git -C "$LATENT_UPSCALER_DIR" pull --ff-only
else
  echo "Installing MiniMax H3 Latent Upscaler..."
  git clone --depth 1 https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git "$LATENT_UPSCALER_DIR"
fi
if [[ -f "$LATENT_UPSCALER_DIR/requirements.txt" ]]; then
  python -m pip install -q -r "$LATENT_UPSCALER_DIR/requirements.txt"
fi

if [[ -f "$SCRIPT_DIR/patch_extender_ui.py" ]]; then
  python "$SCRIPT_DIR/patch_extender_ui.py" "$EXTENDER_DIR/web/extender.js"
fi

if [[ -n "$H3_DRIVE_ROOT" ]]; then
  if [[ ! -d "/content/drive/MyDrive" ]]; then
    echo "ERROR: Google Drive is not mounted. Mount Drive first or unset H3_DRIVE_ROOT."
    exit 2
  fi

  mkdir -p "$H3_DRIVE_ROOT"/{models,output,user}

  if [[ "$H3_PERSIST_MODELS" == "1" ]]; then
    echo "Using Drive-backed ComfyUI model folders: $H3_DRIVE_ROOT/models"
    echo "NOTE: local VM model storage is faster; Drive-backed weights are for convenience only."
    # Keep every model family used by H3 + LTX in the same Drive-backed model root.
    for sub in diffusion_models text_encoders vae loras checkpoints latent_upscale_models model_patches; do
      mkdir -p "$H3_DRIVE_ROOT/models/$sub"
      rm -rf "$COMFY_ROOT/models/$sub"
      ln -s "$H3_DRIVE_ROOT/models/$sub" "$COMFY_ROOT/models/$sub"
    done
  fi

  if [[ "$H3_PERSIST_OUTPUT" == "1" ]]; then
    echo "Using Drive-backed ComfyUI output/user data."
    rm -rf "$COMFY_ROOT/output" "$COMFY_ROOT/user"
    ln -s "$H3_DRIVE_ROOT/output" "$COMFY_ROOT/output"
    ln -s "$H3_DRIVE_ROOT/user" "$COMFY_ROOT/user"
  fi
fi

mkdir -p \
  "$COMFY_ROOT/models/diffusion_models" \
  "$COMFY_ROOT/models/text_encoders" \
  "$COMFY_ROOT/models/vae" \
  "$COMFY_ROOT/models/loras" \
  "$COMFY_ROOT/models/checkpoints" \
  "$COMFY_ROOT/models/latent_upscale_models" \
  "$COMFY_ROOT/models/model_patches" \
  "$COMFY_ROOT/input" \
  "$COMFY_ROOT/output" \
  "$COMFY_ROOT/user/default/workflows"

# Remove stale bytecode after updating custom nodes in a reused runtime.
find "$EXTENDER_DIR" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$LATENT_UPSCALER_DIR" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

echo
echo "Setup complete."
echo "ComfyUI:          $COMFY_ROOT"
echo "Extender:         $EXTENDER_DIR"
echo "Latent Upscaler:  $LATENT_UPSCALER_DIR"
git -C "$EXTENDER_DIR" log -1 --oneline || true
git -C "$LATENT_UPSCALER_DIR" log -1 --oneline || true
