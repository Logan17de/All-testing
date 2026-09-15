# MiniMax H3 + ComfyUI on Colab — private Tailscale access

The production notebook runs ComfyUI on Colab's GPU and exposes it privately to your Tailscale-connected PC. Models, inputs, outputs and workflow state stay on local runtime disk. Download wanted results directly from ComfyUI before deleting the runtime.

## Current notebook execution order

1. Sections 0–2: local storage, existing GPU settings, fetch `minimax-h3-colab`.
2. Section 3: install ComfyUI and the original H3 custom nodes. No model weights yet.
3. Section 4: install the checksum-verified Tailscale 1.102.4 static binaries and start one managed userspace daemon. Open the sign-in link and use the same account as the PC. No auth key, Cloudflare token or public domain is required. Finish any device approval first.
4. Section 5: verify Tailscale sign-in, start/reuse ComfyUI at `127.0.0.1:8188`, check `/system_stats`, and configure private TCP forwarding on Tailscale port 8188. Open the printed `http://100.x.x.x:8188/` address by pasting it into your PC browser's address bar. Traffic is encrypted by Tailscale. Access follows the tailnet's device policy; no public Funnel is enabled.
5. Section 6: **stop by default**. Confirm the real canvas, menus and live connection work before changing `PROCEED_WITH_H3_MODEL_DOWNLOADS` to `True`.
6. Section 7: download the original eight H3 model entries. The cell independently checks approval, local backend health, Tailscale login and the exact private forwarding route. Failed downloads cannot authorize restart.
7. Section 8: restart only ComfyUI, retaining the private connection. Refresh the same address to reload models.

### Already-running Colab session

If ComfyUI and models are already installed locally, run **Sections 0, 2, 4 and 5** in the updated notebook using that same runtime. Skip reinstalling or downloading weights already present. Section 5 reuses a healthy ComfyUI process. Legacy Drive symlinks are handled as documented below; conversion never copies old Drive models into the runtime.

Existing Cloudflare connections are left untouched during migration. Fresh sessions started by this notebook use only Tailscale. The private address does not use `comfy.zetbros.com`.

### New sessions and troubleshooting

Tailscale binaries/socket are under `/content/h3_tailscale`, outside the helper directory replaced by Section 2. Identity state is held only in memory (`--state=mem:`). A new runtime or daemon restart needs sign-in again and may get a different address. Section 4 reuses the existing managed process and login within the same runtime. Keep Tailscale connected on the PC.

Section 4 waits up to 45 seconds for registration and returns as soon as a sign-in link or authenticated state is available. It reuses an existing pending link, preserves redacted CLI failure details, and stops only its short-lived CLI waiter. If an older version failed after eight seconds with no sign-in URL, rerun Sections 2 and 4 in the same runtime; do not reinstall ComfyUI or download models. If Section 4 prints a login link, complete sign-in before Section 5. `NeedsMachineAuth` means device approval is required in the Tailscale admin console. Do not post pending login URLs or auth keys in chat; diagnostic logs redact them. If a port-forwarding configuration conflicts, inspect it rather than resetting unrelated routes.

Use the notebook Diagnostics cell to read local health, process IDs, Tailscale state and redacted logs. It does not install, restart, download models or queue generation. Local checks cannot prove full browser compatibility or a fast direct peer connection. After opening the UI, test uploads, live status and downloading a result. On the PC, `tailscale ping <Colab-IP>` identifies whether the path is direct or relayed; faster performance is not assumed.

### Launcher and offline checks

The standard-library helper `comfy_preflight.py` supports `tailscale-login`, `preflight`, `check`, `restart`, `local-storage` and `diagnostics`. A shared lock serializes launcher actions. The notebook sets `H3_ACCESS_METHOD=tailscale`; standalone legacy scripts retain the Cloudflare default for compatibility. ComfyUI's GPU settings, custom nodes and eight model entries are unchanged.

Static Tailscale archives come from https://pkgs.tailscale.com/stable/ and are checked against pinned SHA-256 hashes before extracting only the expected two binaries. No OS service, public Funnel, exit node or subnet route is configured in Colab. The private TCP forwarder preserves HTTP/WebSocket requests without rewriting ComfyUI code.

Run offline regressions with `python -m pytest video/minimax_h3_comfy/tests/test_preflight.py -q`. They cover model gates, process reuse, pending sign-in, checksum failures, exact private route validation and log redaction. They do not run a real Colab GPU or claim a live browser/generation test.

References: [userspace networking](https://tailscale.com/docs/concepts/userspace-networking), [Serve TCP forwarding](https://tailscale.com/docs/reference/tailscale-cli/serve), [ephemeral nodes](https://tailscale.com/docs/features/ephemeral-nodes).

The sections below retain the existing optional profiles and workflow tools. The notebook's eight-entry model list remains authoritative for its default download phase.

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
- `launch_comfy.sh` — starts ComfyUI with the existing memory defaults and runs the selected private-access preflight
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

MODEL_ROOT = '/content/ComfyUI/models'
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

Models, inputs, output, temporary previews, workflow state and caches use the Colab VM's local disk. The notebook never mounts Google Drive and the installer no longer supports Drive persistence. Download each wanted result directly from its ComfyUI workflow output, and export any workflow JSON you want to keep, before disconnecting and deleting the runtime.

```text
/content/ComfyUI/
├── models/
├── input/
├── output/
├── temp/
└── user/default/workflows/
```

A fresh runtime needs its local weights downloaded again, after the UI approval gate.

### Existing sessions that used Drive

The updated installer and preflight replace legacy data-directory symlinks with local directories. The original targets are never deleted or copied. An active generation queue prevents conversion. If ComfyUI is idle, only its process is stopped before conversion; the tunnel stays running. Existing local files and model weights are retained.

To switch an already-installed session without reinstalling or redownloading local weights: download any wanted existing results first, run Section 2 to fetch the new helpers, then run this cell:

```python
import sys, importlib
sys.path.insert(0, '/content/minimax_h3_comfy')
import comfy_preflight
importlib.reload(comfy_preflight)
comfy_preflight.run_launcher('local-storage')
```

Then rerun Sections 4 and 5 to open ComfyUI using local storage. Previously linked user settings/workflows and outputs are no longer loaded automatically; upload a saved workflow if needed. The notebook does not unmount Drive or manage other applications using it; it stops using it.

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
