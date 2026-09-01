#!/usr/bin/env bash
set -euo pipefail

echo "Installing MiniMax H3 Colab dependencies..."
python -m pip install -q -U pip wheel setuptools

# H3 is currently in Diffusers main/PR integration rather than the stable wheel.
python -m pip install -q -U \
  "git+https://github.com/huggingface/diffusers.git@refs/pull/14355/head" \
  "transformers" \
  "accelerate" \
  "huggingface_hub" \
  "hf_xet" \
  "safetensors" \
  "av" \
  "imageio" \
  "imageio-ffmpeg" \
  "soundfile" \
  "Pillow" \
  "sentencepiece" \
  "protobuf" \
  "torchao"

mkdir -p /content/hf_cache /content/minimax_h3/inputs
export HF_HOME=/content/hf_cache

echo
echo "Dependencies installed."
echo "Model files will download on the first run and stay cached under /content/hf_cache for this runtime."
python /content/minimax_h3/run_h3.py --check
