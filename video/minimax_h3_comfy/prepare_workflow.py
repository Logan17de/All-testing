#!/usr/bin/env python3
"""Copy the current Extender workflow into ComfyUI and normalize it for our Colab model profile."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULTS = {
    "clip": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "unet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", default="/content/ComfyUI")
    parser.add_argument("--name", default="MiniMax_H3_Extender_Colab.json")
    args = parser.parse_args()

    root = Path(args.comfy_root)
    src = root / "custom_nodes/ComfyUI_MiniMax_H3_Extender/Workflow/MiniMax_Extender.json"
    dst = root / "user/default/workflows" / args.name

    if not src.exists():
        raise SystemExit(f"Extender workflow not found: {src}. Run install_comfy_h3.sh first.")

    data = json.loads(src.read_text(encoding="utf-8"))
    patched = {"CLIPLoader": 0, "UNETLoader": 0, "LoraLoaderModelOnly": 0}

    for node in data.get("nodes", []):
        node_type = node.get("type")
        values = node.get("widgets_values")
        if not isinstance(values, list) or not values:
            continue
        if node_type == "CLIPLoader":
            values[0] = DEFAULTS["clip"]
            patched[node_type] += 1
        elif node_type == "UNETLoader":
            values[0] = DEFAULTS["unet"]
            patched[node_type] += 1
        elif node_type == "LoraLoaderModelOnly":
            values[0] = DEFAULTS["lora"]
            patched[node_type] += 1

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"Workflow ready: {dst}")
    print("Patched model selectors:", patched)


if __name__ == "__main__":
    main()
