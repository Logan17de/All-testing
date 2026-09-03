#!/usr/bin/env python3
"""Download official MiniMax H3 model sets for the Colab workflows."""

from __future__ import annotations

import argparse
from pathlib import Path
from huggingface_hub import hf_hub_download

REPO_ID = "Comfy-Org/MiniMax-H3"

COMMON_REF2VA = [
    "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "vae/minimax_h3_video_vae_fp16.safetensors",
    "vae/minimax_h3_audio_vae_fp32.safetensors",
    "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
]
COMMON_FL2VA = [
    "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "vae/minimax_h3_video_vae_fp16.safetensors",
    "vae/minimax_h3_audio_vae_fp32.safetensors",
    "loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
]

PROFILES = {
    # Legacy/general low-footprint profile. NVFP4 is compact, but Ampere/A100
    # does not execute FP4 natively.
    "ref2va-int8": COMMON_REF2VA + [
        "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    ],
    "fl2va-int8": COMMON_FL2VA + [
        "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    ],
    # A100/Ampere benchmark profile: keep the pruned INT8 ConvRot diffusion
    # model and use the official INT8 ConvRot Qwen3-VL encoder instead of FP4.
    "ref2va-a100-int8": COMMON_REF2VA + [
        "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    ],
    "fl2va-a100-int8": COMMON_FL2VA + [
        "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    ],
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", default="/content/ComfyUI")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="ref2va-int8")
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
            print(f"[skip] {filename}")
            continue
        print(f"[download] {filename}")
        hf_hub_download(repo_id=REPO_ID, filename=filename, local_dir=str(model_root))

    print("MiniMax H3 model set is ready.")


if __name__ == "__main__":
    main()
