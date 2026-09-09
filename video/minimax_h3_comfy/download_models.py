#!/usr/bin/env python3
"""Download MiniMax H3 model sets used by the Colab workflows."""

from __future__ import annotations

import argparse
from pathlib import Path
from huggingface_hub import hf_hub_download

REPO_ID = "Comfy-Org/MiniMax-H3"

VIDEO_VAE = "vae/minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "vae/minimax_h3_audio_vae_fp32.safetensors"
REF2VA_TURBO = "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
FL2VA_TURBO = "loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"
QWEN_NVFP4 = "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
QWEN_INT8 = "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors"

PROFILES = {
    # Best default for RTX PRO 6000 Blackwell / other FP8-capable high-VRAM GPUs.
    # The FP8 diffusion model cuts model memory while the NVFP4 Qwen encoder is
    # compact enough to leave generous activation headroom for long clips.
    "ref2va-blackwell-fp8": [
        "diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors",
        QWEN_NVFP4,
        VIDEO_VAE,
        AUDIO_VAE,
        REF2VA_TURBO,
    ],
    # General/low-footprint Ref2VA profile.
    "ref2va-int8": [
        "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        QWEN_NVFP4,
        VIDEO_VAE,
        AUDIO_VAE,
        REF2VA_TURBO,
    ],
    # A100/Ampere profile: use INT8 ConvRot for both the diffusion model and Qwen.
    "ref2va-a100-int8": [
        "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        QWEN_INT8,
        VIDEO_VAE,
        AUDIO_VAE,
        REF2VA_TURBO,
    ],
    "fl2va-blackwell-fp8": [
        "diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
        QWEN_NVFP4,
        VIDEO_VAE,
        AUDIO_VAE,
        FL2VA_TURBO,
    ],
    "fl2va-int8": [
        "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        QWEN_NVFP4,
        VIDEO_VAE,
        AUDIO_VAE,
        FL2VA_TURBO,
    ],
    "fl2va-a100-int8": [
        "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        QWEN_INT8,
        VIDEO_VAE,
        AUDIO_VAE,
        FL2VA_TURBO,
    ],
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", default="/content/ComfyUI")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="ref2va-blackwell-fp8")
    parser.add_argument("--model-root", default=None)
    args = parser.parse_args()

    model_root = Path(args.model_root or (Path(args.comfy_root) / "models")).expanduser().resolve()
    model_root.mkdir(parents=True, exist_ok=True)

    print(f"Repository : {REPO_ID}")
    print(f"Profile    : {args.profile}")
    print(f"Model root : {model_root}")

    for filename in PROFILES[args.profile]:
        target = model_root / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size > 1024 * 1024:
            print(f"[skip] {filename} ({target.stat().st_size / 1024**3:.1f} GiB)")
            continue
        print(f"[download] {filename}")
        hf_hub_download(repo_id=REPO_ID, filename=filename, local_dir=str(model_root))

    marker = model_root / ".h3_profile"
    marker.write_text(args.profile + "\n", encoding="utf-8")
    print(f"MiniMax H3 model set is ready. Profile marker: {marker}")


if __name__ == "__main__":
    main()
