#!/usr/bin/env python3
"""Install LTX video models and official ComfyUI workflows into the existing Colab ComfyUI.

This intentionally REUSES the same ComfyUI installation used by the MiniMax H3 notebook.
It does not clone or launch a second ComfyUI instance.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request

from huggingface_hub import hf_hub_download


# Official LTX-2.5 ComfyUI model set used by Comfy-Org's current T2V/I2V templates.
LTX25 = [
    (
        "Lightricks/LTX-2.5",
        "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
        "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    ),
    (
        "Lightricks/LTX-2.5",
        "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
        "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    ),
    (
        "Lightricks/LTX-2.5",
        "vae/ltx-2.5-video-vae-bf16.safetensors",
        "vae/ltx-2.5-video-vae-bf16.safetensors",
    ),
    (
        "Lightricks/LTX-2.5",
        "vae/ltx-2.5-audio-vae-bf16.safetensors",
        "vae/ltx-2.5-audio-vae-bf16.safetensors",
    ),
    (
        "Lightricks/LTX-2.5",
        "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
        "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    ),
    # Tiny optional model patch; useful for auto-duration workflows.
    (
        "Lightricks/LTX-2.5",
        "model_patches/ltx-2.5-duration-head-bf16.safetensors",
        "model_patches/ltx-2.5-duration-head-bf16.safetensors",
    ),
]

# Prompt enhancer used by the official LTX-2.5 template. Kept separate so it can be skipped.
LTX25_PROMPT_ENHANCER = (
    "Comfy-Org/gemma-4",
    "text_encoders/gemma4_e2b_it_int8_convrot.safetensors",
    "text_encoders/gemma4_e2b_it_int8_convrot.safetensors",
)

# Optional LTX-2.3 set. This is NOT required for LTX-2.5 T2V, but is useful if you
# also want the older 2.3 workflow family in the same ComfyUI runtime.
LTX23 = [
    (
        "Lightricks/LTX-2.3-fp8",
        "ltx-2.3-22b-dev-fp8.safetensors",
        "checkpoints/ltx-2.3-22b-dev-fp8.safetensors",
    ),
    (
        "Comfy-Org/ltx-2.3",
        "split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
        "loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
    ),
    (
        "Comfy-Org/ltx-2",
        "split_files/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors",
        "loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors",
    ),
    (
        "Comfy-Org/ltx-2",
        "split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors",
        "text_encoders/gemma_3_12B_it_fp4_mixed.safetensors",
    ),
    (
        "Lightricks/LTX-2.3",
        "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
        "latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    ),
]

WORKFLOWS_25 = {
    "LTX_2.5_T2V.json": "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_ltx2_5_t2v.json",
    "LTX_2.5_I2V.json": "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_ltx2_5_i2v.json",
    "LTX_2.5_FLF2V.json": "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_ltx2_5_flf2v.json",
}

WORKFLOWS_23 = {
    "LTX_2.3_T2V.json": "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_ltx2_3_t2v.json",
}


def _download_model(repo_id: str, filename: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 1024 * 1024:
        print(f"[skip] {target.relative_to(target.parents[1]) if len(target.parents) > 1 else target.name}")
        return

    print(f"[download] {repo_id} :: {filename}")
    # Stage each file separately, then move it into the exact ComfyUI model folder.
    # This avoids repo-specific directory layouts leaking into ComfyUI/models/.
    with tempfile.TemporaryDirectory(prefix="ltx_hf_") as td:
        downloaded = Path(
            hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=td,
                token=os.environ.get("HF_TOKEN") or None,
            )
        )
        shutil.move(str(downloaded), str(target))

    if not target.exists() or target.stat().st_size < 1024 * 1024:
        raise RuntimeError(f"Model download did not produce a valid file: {target}")


def _install_workflows(workflow_dir: Path, entries: dict[str, str]) -> None:
    workflow_dir.mkdir(parents=True, exist_ok=True)
    for name, url in entries.items():
        target = workflow_dir / name
        print(f"[workflow] {name}")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read()
        if len(data) < 1000:
            raise RuntimeError(f"Workflow download looks invalid: {url}")
        target.write_bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", default="/content/ComfyUI")
    parser.add_argument("--model-root", default=None)
    parser.add_argument(
        "--skip-prompt-enhancer",
        action="store_true",
        help="Skip the optional Gemma 4 prompt enhancer (~extra model download).",
    )
    parser.add_argument(
        "--install-ltx23",
        action="store_true",
        help="Also install the optional LTX-2.3 T2V model set/workflow.",
    )
    parser.add_argument("--skip-workflows", action="store_true")
    args = parser.parse_args()

    comfy_root = Path(args.comfy_root).expanduser().resolve()
    model_root = Path(args.model_root or (comfy_root / "models")).expanduser().resolve()
    workflow_dir = comfy_root / "user" / "default" / "workflows"

    if not comfy_root.exists():
        raise SystemExit(
            f"ComfyUI not found at {comfy_root}. Run the existing H3 Colab install cell first; "
            "this script intentionally does not create a second ComfyUI installation."
        )

    for folder in [
        "diffusion_models",
        "text_encoders",
        "vae",
        "loras",
        "checkpoints",
        "latent_upscale_models",
        "model_patches",
    ]:
        (model_root / folder).mkdir(parents=True, exist_ok=True)

    print("\n== LTX-2.5 for existing ComfyUI ==")
    print("ComfyUI root:", comfy_root)
    print("Model root  :", model_root)
    print("HF token    :", "present" if os.environ.get("HF_TOKEN") else "not in env / will use cached HF login if available")
    print(
        "NOTE: Lightricks/LTX-2.5 is gated. Accept its Hugging Face license once and provide HF_TOKEN in Colab.\n"
    )

    for repo_id, filename, target_rel in LTX25:
        _download_model(repo_id, filename, model_root / target_rel)

    if not args.skip_prompt_enhancer:
        _download_model(
            LTX25_PROMPT_ENHANCER[0],
            LTX25_PROMPT_ENHANCER[1],
            model_root / LTX25_PROMPT_ENHANCER[2],
        )

    if args.install_ltx23:
        print("\n== Optional LTX-2.3 ==")
        for repo_id, filename, target_rel in LTX23:
            _download_model(repo_id, filename, model_root / target_rel)

    if not args.skip_workflows:
        print("\n== Official ComfyUI workflows ==")
        _install_workflows(workflow_dir, WORKFLOWS_25)
        if args.install_ltx23:
            _install_workflows(workflow_dir, WORKFLOWS_23)

    print("\nLTX install complete.")
    print("Open these inside the SAME ComfyUI runtime:")
    for name in WORKFLOWS_25:
        print(" -", name)
    if args.install_ltx23:
        for name in WORKFLOWS_23:
            print(" -", name)


if __name__ == "__main__":
    main()
