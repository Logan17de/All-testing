# MiniMax H3 + ComfyUI Extender (Colab)

This is the optimized long-video path for MiniMax H3. It runs **ComfyUI in Colab**, installs the current `ComfyUI_MiniMax_H3_Extender`, prepares OOM-resistant workflows, and exposes ComfyUI through a temporary Pinggy URL.

The older `video/minimax_h3/` direct runner is intentionally left untouched.

## Recommended hardware

1. **RTX PRO 6000 Blackwell 96 GB (G4)** — use `ref2va-blackwell-fp8`
2. **A100 80 GB** — use `ref2va-a100-int8`
3. **L4 24 GB** — use `ref2va-int8` + `normalvram`/`lowvram`
4. **T4 16 GB** — testing only; use `ref2va-int8` + `lowvram`

The Colab notebook detects the GPU and chooses a profile automatically. For G4, the default workflow uses the official FP8-scaled Ref2VA diffusion model plus the NVFP4 Qwen3-VL encoder.

## Why the G4 workflow is different

The previous workflow combined `full_batch`, 10-second clips and roughly **0.90 MP** frames. That can push long H3 activations over the edge even with a large GPU.

The new G4 starting profile uses:

- `full_batch` with the Extender's disk-backed motion cache
- **0.60 MP** canvas budget
- **32-pixel** H3 canvas alignment
- Lanczos reference scaling
- 4-step Turbo LoRA
- Euler + simple scheduler
- context length 22
- ComfyUI `normalvram` by default with VRAM headroom
- PyTorch expandable CUDA allocator segments
- latent preview disabled during long generation

After a successful full run, try 0.75 MP. Only move back toward 0.90 MP after proving the exact clip length and reference mix fits.

## Files

- `../MiniMax_H3_ComfyUI_Colab.ipynb` — main Colab notebook
- `install_comfy_h3.sh` — installs/updates ComfyUI and the latest H3 Extender
- `download_models.py` — downloads GPU-specific H3 model profiles
- `prepare_workflow.py` — creates the optimized Full Batch workflow plus a safe Clip-by-Clip fallback
- `launch_comfy.sh` — starts ComfyUI with memory-safe defaults and exposes it through Pinggy

## G4 model profile

```text
diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors
text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
vae/minimax_h3_video_vae_fp16.safetensors
vae/minimax_h3_audio_vae_fp32.safetensors
loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
```

The weights are downloaded at runtime and are **not committed to Git**.

## Colab defaults

Model weights stay on the Colab VM by default because loading large H3 weights through Google Drive/FUSE is much slower. Output, user state and Extender caches remain Drive-backed so completed work survives runtime resets.

```text
MyDrive/MiniMax_H3_ComfyUI/
├── output/
└── user/
```

Set `PERSIST_MODELS_TO_DRIVE = True` only when avoiding model downloads matters more than model-load speed.

## Workflows created by the notebook

- `MiniMax_H3_G4_Optimized_FullBatch.json` — first choice
- `MiniMax_H3_G4_Optimized_Safe_ClipByClip.json` — OOM fallback

For Full Batch, keep 10-second clips at 0.60 MP for the first test. If an exact project still OOMs, use the Clip-by-Clip workflow without changing prompts or references.

## Continuity

Validated clips remain part of the Extender's continuous motion chain. Keep the same `subject_definitions` mapping at the start of every clip prompt, then describe only the new action/camera progression for that clip.

## API later

Once the UI workflow is stable, the same Colab server can be automated through ComfyUI's HTTP `/prompt` API.
