#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/content/ComfyUI}"
H3_DRIVE_ROOT="${H3_DRIVE_ROOT:-}"
H3_PERSIST_MODELS="${H3_PERSIST_MODELS:-0}"
H3_PERSIST_OUTPUT="${H3_PERSIST_OUTPUT:-1}"
EXTENDER_DIR="$COMFY_ROOT/custom_nodes/ComfyUI_MiniMax_H3_Extender"
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
python -m pip install -q -U "huggingface_hub[hf_xet]" requests imageio-ffmpeg

mkdir -p "$COMFY_ROOT/custom_nodes"
if [[ -d "$EXTENDER_DIR/.git" ]]; then
  echo "Updating MiniMax H3 Extender..."
  git -C "$EXTENDER_DIR" pull --ff-only
else
  echo "Installing MiniMax H3 Extender..."
  git clone --depth 1 https://github.com/tritant/ComfyUI_MiniMax_H3_Extender.git "$EXTENDER_DIR"
fi
if [[ -f "$EXTENDER_DIR/requirements.txt" ]]; then
  python -m pip install -q -r "$EXTENDER_DIR/requirements.txt"
fi

# Current ComfyUI Nodes 2.0 can collapse the Extender DOM timeline to roughly
# one fixed card width after Add/Remove Clip. Keep the upstream 318 px cards and
# horizontal scrolling, but force the timeline host to use the full node width.
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
    echo "Using Drive-backed H3 model folders: $H3_DRIVE_ROOT/models"
    for sub in diffusion_models text_encoders vae loras; do
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
  "$COMFY_ROOT/input" \
  "$COMFY_ROOT/output" \
  "$COMFY_ROOT/user/default/workflows"

echo
echo "Setup complete."
echo "ComfyUI:  $COMFY_ROOT"
echo "Extender: $EXTENDER_DIR"
