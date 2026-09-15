# MiniMax H3 + ComfyUI Extender (Colab)

This is the main MiniMax H3 **ComfyUI in Colab** setup, exposed at **https://comfy.zetbros.com** through the existing named Cloudflare Tunnel.

## Current notebook execution order

1. Mount Drive, retain the GPU/VRAM settings, and fetch `minimax-h3-colab`.
2. Install real ComfyUI, H3 Extender, latent upscaler code, Director, VideoHelperSuite, KJNodes and Pixaroma. No model-download cell runs yet.
3. Read `CF_TUNNEL_TOKEN` with Colab `userdata`. A raw `eyJ...` token or a pasted install command is accepted; the command is never executed.
4. Start/reuse ComfyUI on **127.0.0.1:8188**, require HTTP 200 and ComfyUI JSON from `/system_stats`, then start one cloudflared connector in this runtime. Wait for `Registered tunnel connection` before displaying `OPEN COMFYUI`.
5. **Stop by default.** Open the URL, complete Access login if prompted, and confirm the real canvas, menus and live UI connection work. Then change `PROCEED_WITH_H3_MODEL_DOWNLOADS = False` to `True` in Section 6 and rerun that cell. Registration/local health alone do not prove browser success.
6. Run Section 7 for the original eight H3 download entries, unchanged. This cell checks approval and current preflight health itself, even when run directly. A failed/interrupted download cannot authorize the final restart.
7. Run Section 8: restart only ComfyUI, wait for HTTP 200, and display `FINAL READY` at the same URL. The connector remains running. Refresh the browser to reload model choices.

The original notebook remains the production notebook. Setup, model filenames/repositories, workflows, Drive persistence and GPU settings are preserved. Rerunning preflight resets the notebook approval; no automatic UI approval or generation is performed.

### Launcher and diagnostics

`launch_comfy.sh` and the notebook share the small standard-library `comfy_preflight.py` helper. Actions are `preflight` (default), `check`, `restart` and `diagnostics`. The launcher retains its existing VRAM options and rejects ports other than 8188. Process cleanup checks the runtime's Linux PID/network namespaces and UID; ComfyUI cleanup additionally requires its exact root and port. No remote/Windows connectors are managed. A launch lock prevents overlapping starts.

Run the notebook's Diagnostics cell after Section 2, including while downloads are paused. It prints the curl HTTP result, `ss` listener for 8188, connector PIDs and the last 50 lines of both logs. It does not need models or a token. Log output is redacted; process arguments are never printed.

The launcher passes the token through the documented [`TUNNEL_TOKEN` environment variable](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token), equivalent to `--token`, so it is absent from process arguments. No permanent OS service is installed.

After generation, save/download completed outputs before disconnecting and deleting the Colab runtime. The user controls those actions. Offline regression checks: `python -m pytest video/minimax_h3_comfy/tests/test_preflight.py -q`; these use mocks and temporary text fixtures, with no HTTP test server, GPU, tunnel connection or model download.

The sections below retain the optional optimized profiles and workflow tools. The current notebook's eight-entry model list is authoritative for its default download phase.

The older `video/minimax_h3/` direct runner is intentionally left untouched.

## Recommended hardware

1. **RTX PRO 6000 Blackwell 96 GB (G4)** — use `ref2va-blackwell-fp8`
2. **A100 80 GB** — use `ref2va-a100-int8`
3. **L4 24 GB** — use `ref2va-int8` + `normalvram`/`lowvram`
4. **T4 16 GB** — testing only; use `ref2va-int8` + `lowvram`

The Colab notebook detects the GPU for VRAM reservation. The optional G4 profile below uses the official FP8-scaled Ref2VA diffusion model plus the NVFP4 Qwen3-VL encoder; the current notebook retains its existing fixed model list.

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
- `download_ltx_models.py` — installs LTX-2.5 models plus the official ComfyUI T2V/I2V/FLF2V workflows into the **same** `/content/ComfyUI`
- `prepare_workflow.py` — creates the optimized Full Batch workflow plus a safe Clip-by-Clip fallback
- `launch_comfy.sh` — starts ComfyUI with the existing memory defaults and runs the Cloudflare preflight
- `comfy_preflight.py` — shared process control, local health checks and redacted diagnostics

## G4 model profile

```text
diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors
text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
vae/minimax_h3_video_vae_fp16.safetensors
vae/minimax_h3_audio_vae_fp32.safetensors
loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
```

The weights are downloaded at runtime and are **not committed to Git**.

## LTX-2.5 text-to-video in the same Colab ComfyUI

LTX-2.5 is natively supported by current ComfyUI, so **do not install a second ComfyUI**. The existing setup cell already updates `/content/ComfyUI` from the current ComfyUI repository.

Before downloading LTX-2.5:

1. Open `https://huggingface.co/Lightricks/LTX-2.5` once and click **Agree and Access**.
2. Add a Colab secret named `HF_TOKEN` containing a Hugging Face read token.
3. Run the normal H3 notebook through preflight, personally verify the full UI, and approve downloads in Section 6.
4. Only then run the following optional extra cell:

```python
if (globals().get('PROCEED_WITH_H3_MODEL_DOWNLOADS') is not True
        or globals().get('H3_PREFLIGHT_COMPLETE') is not True):
    raise SystemExit('Verify the ComfyUI UI and approve downloads in Section 6 first.')
import os, subprocess, sys
from google.colab import userdata

try:
    token = userdata.get('HF_TOKEN')
    if token:
        os.environ['HF_TOKEN'] = token
except Exception:
    pass

MODEL_ROOT = f'{DRIVE_ROOT}/models' if PERSIST_MODELS_TO_DRIVE else '/content/ComfyUI/models'
cmd = [
    sys.executable,
    '/content/minimax_h3_comfy/download_ltx_models.py',
    '--comfy-root', '/content/ComfyUI',
    '--model-root', MODEL_ROOT,
]

# Optional: also install the much larger LTX-2.3 T2V set.
INSTALL_LTX23 = False
if INSTALL_LTX23:
    cmd.append('--install-ltx23')

subprocess.run(cmd, check=True)
```

### LTX-2.5 files installed by default

```text
models/
├── diffusion_models/
│   └── ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors
├── text_encoders/
│   ├── gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors
│   └── gemma4_e2b_it_int8_convrot.safetensors
├── vae/
│   ├── ltx-2.5-video-vae-bf16.safetensors
│   └── ltx-2.5-audio-vae-bf16.safetensors
├── latent_upscale_models/
│   └── ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors
└── model_patches/
    └── ltx-2.5-duration-head-bf16.safetensors
```

The INT8 ConvRot transformer/text encoder are the official ComfyUI-oriented lower-memory variants. The prompt-enhancer Gemma file is included so the official template can use `prompt_enhance` without another download.

### LTX workflows installed automatically

The installer downloads the current official Comfy-Org templates into `/content/ComfyUI/user/default/workflows/`:

- `LTX_2.5_T2V.json` — text → synchronized video/audio
- `LTX_2.5_I2V.json` — first image + prompt → synchronized video/audio
- `LTX_2.5_FLF2V.json` — first frame + last frame + prompt → connected video/audio
- `LTX_2.3_T2V.json` — only when `--install-ltx23` is enabled

For the YouTube pipeline, start with **LTX_2.5_T2V** for generated B-roll and **LTX_2.5_I2V** when animating a generated still. Use **FLF2V** when you already know both the beginning and ending composition.

## Colab defaults

Model weights stay on the Colab VM by default because loading large video-model weights through Google Drive/FUSE is much slower. Output, user state and Extender caches remain Drive-backed so completed work survives runtime resets.

```text
MyDrive/MiniMax_H3_ComfyUI/
├── output/
└── user/
```

Set `PERSIST_MODELS_TO_DRIVE = True` only when avoiding model downloads matters more than model-load speed.

## Workflows available through the optional preparation tools

- `MiniMax_H3_G4_Optimized_FullBatch.json` — first choice
- `MiniMax_H3_G4_Optimized_Safe_ClipByClip.json` — OOM fallback
- `LTX_2.5_T2V.json` — official LTX-2.5 text-to-video
- `LTX_2.5_I2V.json` — official LTX-2.5 image-to-video
- `LTX_2.5_FLF2V.json` — official LTX-2.5 first/last-frame-to-video

For Full Batch, keep 10-second clips at 0.60 MP for the first test. If an exact project still OOMs, use the Clip-by-Clip workflow without changing prompts or references.

## Continuity

Validated clips remain part of the Extender's continuous motion chain. Keep the same `subject_definitions` mapping at the start of every clip prompt, then describe only the new action/camera progression for that clip.

## API later

The same server supports ComfyUI's HTTP `/prompt` API. Current operation remains manual upload and queueing by the user; this preflight change does not enable automatic generation.
