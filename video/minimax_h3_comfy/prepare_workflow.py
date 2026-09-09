#!/usr/bin/env python3
"""Build stable MiniMax H3 Extender workflows for Colab/G4 Blackwell."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

PROFILE_MODELS = {
    "ref2va-blackwell-fp8": {
        "clip": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        "unet": "minimax_h3_ref2va_pruned_fp8_scaled.safetensors",
        "lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    },
    "ref2va-int8": {
        "clip": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        "unet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    },
    "ref2va-a100-int8": {
        "clip": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        "unet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    },
}


def _patch(data: dict, models: dict, run_mode: str, megapixels: float) -> dict:
    data = copy.deepcopy(data)
    patched = {}

    for node in data.get("nodes", []):
        node_type = node.get("type")
        values = node.get("widgets_values")
        if not isinstance(values, list):
            continue

        if node_type == "CLIPLoader" and values:
            values[0] = models["clip"]
            patched["CLIPLoader"] = patched.get("CLIPLoader", 0) + 1

        elif node_type == "UNETLoader" and values:
            values[0] = models["unet"]
            if len(values) > 1:
                values[1] = "default"
            patched["UNETLoader"] = patched.get("UNETLoader", 0) + 1

        elif node_type == "LoraLoaderModelOnly" and values:
            values[0] = models["lora"]
            if len(values) > 1:
                values[1] = 1.0
            patched["LoraLoaderModelOnly"] = patched.get("LoraLoaderModelOnly", 0) + 1

        elif node_type == "ImageScaleToTotalPixels" and len(values) >= 3:
            # 0.60 MP + 32-pixel grid is a stable starting point for 10 s clips.
            values[0] = "lanczos"
            values[1] = float(megapixels)
            values[2] = 32
            patched["ImageScaleToTotalPixels"] = patched.get("ImageScaleToTotalPixels", 0) + 1

        elif node_type == "MiniMaxH3Extender" and len(values) >= 10:
            # Keep the 4-step Turbo path and continuity settings, but choose the
            # requested execution mode. Full Batch uses the Extender's disk cache
            # between clips instead of requiring all long-clip latents to survive
            # as one giant in-memory batch.
            values[0] = run_mode
            values[3] = "match"
            values[4] = 4
            values[5] = "euler"
            values[6] = "simple"
            values[7] = 1.0
            values[8] = "22"
            values[9] = 0
            patched["MiniMaxH3Extender"] = patched.get("MiniMaxH3Extender", 0) + 1

    data.setdefault("extra", {}).setdefault("h3_colab_profile", {})
    data["extra"]["h3_colab_profile"].update({
        "profile": next((k for k, v in PROFILE_MODELS.items() if v == models), "custom"),
        "run_mode": run_mode,
        "megapixels": float(megapixels),
        "canvas_multiple": 32,
        "steps": 4,
        "context_length": 22,
    })
    return data, patched


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", default="/content/ComfyUI")
    parser.add_argument("--profile", choices=sorted(PROFILE_MODELS), default="ref2va-blackwell-fp8")
    parser.add_argument("--megapixels", type=float, default=0.60)
    parser.add_argument("--mode", choices=["full_batch", "clip_by_clip"], default="full_batch")
    parser.add_argument("--name", default="MiniMax_H3_G4_Optimized_FullBatch.json")
    parser.add_argument("--also-safe", action="store_true", help="Also write a clip-by-clip fallback workflow.")
    args = parser.parse_args()

    root = Path(args.comfy_root)
    src = root / "custom_nodes/ComfyUI_MiniMax_H3_Extender/Workflow/MiniMax_Extender.json"
    out_dir = root / "user/default/workflows"
    dst = out_dir / args.name

    if not src.exists():
        raise SystemExit(f"Extender workflow not found: {src}. Run install_comfy_h3.sh first.")
    if not 0.20 <= args.megapixels <= 1.50:
        raise SystemExit("For this Colab helper, --megapixels must be between 0.20 and 1.50.")

    original = json.loads(src.read_text(encoding="utf-8"))
    models = PROFILE_MODELS[args.profile]
    data, patched = _patch(original, models, args.mode, args.megapixels)

    out_dir.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Workflow ready: {dst}")
    print("Patched:", patched)

    if args.also_safe:
        safe_name = "MiniMax_H3_G4_Optimized_Safe_ClipByClip.json"
        safe, _ = _patch(original, models, "clip_by_clip", args.megapixels)
        safe_dst = out_dir / safe_name
        safe_dst.write_text(json.dumps(safe, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"Safe fallback ready: {safe_dst}")


if __name__ == "__main__":
    main()
