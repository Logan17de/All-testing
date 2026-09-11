# LTX-2.5 in the existing MiniMax H3 Colab ComfyUI

This setup intentionally reuses the same `/content/ComfyUI` server and Pinggy/MCP path as the MiniMax H3 notebook. Do **not** install a second ComfyUI.

## One-time Hugging Face access

LTX-2.5 is gated on Hugging Face.

1. Accept the model license at `https://huggingface.co/Lightricks/LTX-2.5`.
2. Add a Colab secret named `HF_TOKEN` with a Hugging Face read token.

## Colab cell

Run this after the normal **Install / update ComfyUI + Director stack** cell and before launching ComfyUI:

```python
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

# Optional: add the older LTX-2.3 text-to-video model family too.
INSTALL_LTX23 = False
if INSTALL_LTX23:
    cmd.append('--install-ltx23')

subprocess.run(cmd, check=True)
```

## Installed LTX-2.5 models

```text
ComfyUI/models/
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

## Official workflows installed

The downloader copies the current Comfy-Org templates into `ComfyUI/user/default/workflows/`:

- `LTX_2.5_T2V.json`
- `LTX_2.5_I2V.json`
- `LTX_2.5_FLF2V.json`

### T2V — text to synchronized video + audio

```text
Prompt
  │
  ├─ optional Prompt Enhance
  │      └─ Gemma 4 E2B prompt enhancer
  │
  └─ Gemma 4 12B LTX-2.5 text encoder
         │
         ▼
LTX-2.5 conditioning + duration / resolution / FPS
         │
         ▼
LTX-2.5 22B distilled INT8 ConvRot transformer
         │
         ▼
Distilled sampler (8-step path / CFG≈1)
         │
         ├─ video latent
         └─ audio latent
              │
              ▼
Two-stage latent spatial upscale (2×)
         │
         ├─ Video VAE decode
         └─ Audio VAE + vocoder decode
              │
              ▼
Synchronized VIDEO + AUDIO
              │
              ▼
SaveVideo
```

Recommended first test:

```text
duration: 5 sec
width:    1280
height:   720
fps:      24
prompt_enhance: off for exact prompts / on for short rough prompts
```

For YouTube B-roll, describe the action chronologically, then camera movement, environment/lighting, and sound in the same prompt.

### I2V — animate one of our generated Episode 2 images

```text
Load Image
   │
   ├─ image conditions first frame
   │
Prompt ──> optional Prompt Enhance ──> Gemma 4 LTX encoder
   │                                      │
   └──────────────────────────────────────┘
                     │
                     ▼
           LTX-2.5 distilled model
                     │
                     ▼
                 sampler
                     │
                     ▼
             latent upscale
                     │
              ┌──────┴──────┐
              ▼             ▼
          Video VAE      Audio VAE
              └──────┬──────┘
                     ▼
                 SaveVideo
```

Use I2V when Codex/image generation already created the desired newspaper/map composition and LTX only needs to add natural camera or environmental motion.

### FLF2V — connect a known start and end composition

```text
First Frame ─┐
             ├─> LTX first/last-frame conditioning
Last Frame ──┘                 │
Prompt ──> Gemma 4 encoder ────┘
                               │
                               ▼
                    LTX-2.5 distilled model
                               │
                               ▼
                           sampler
                               │
                               ▼
                       Video + Audio decode
                               │
                               ▼
                           SaveVideo
```

Use FLF2V when a shot must begin on one designed state and land on another, such as:

- newspaper wall → clean map
- clean map → highlighted chokepoint
- oil headline → producer-inflation evidence card

## Episode 2 usage split

For the documentary workflow:

- **DaVinci/Fusion**: newspaper movement, masks, selective blur, keyword highlights, route overlays, infographic animation.
- **LTX-2.5 T2V**: generated cinematic B-roll that does not need exact factual typography.
- **LTX-2.5 I2V**: animate one of the generated stills when organic motion is useful.
- **LTX-2.5 FLF2V**: bridge two predesigned visual states.
- Do not ask LTX to invent factual text, market numbers, newspaper dates, maps, or statistics. Keep those in Illustrator/Fusion assets.

## Why INT8 ConvRot

The official ComfyUI templates support the Comfy-specific INT8 ConvRot transformer and Gemma 4 encoder. They substantially reduce model memory versus the BF16 pair and are the best default for the existing Colab workflow. On an A100/G4 runtime there is enough headroom for the two-stage workflow while preserving the same ComfyUI instance used by H3.
