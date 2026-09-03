# MiniMax H3 + ComfyUI Extender (Colab)

This is the long-video path for MiniMax H3. It runs **ComfyUI in Colab**, installs the current `ComfyUI_MiniMax_H3_Extender`, prepares its workflow, and exposes ComfyUI through a temporary Cloudflare URL.

The older `video/minimax_h3/` direct runner is intentionally left untouched.

## What this path is for

- MiniMax H3 Ref2VA first
- multi-clip continuous generation
- motion-context continuity between clips
- native video/audio continuity handled by H3 Extender
- clip validation/retry instead of regenerating accepted clips
- image/video/audio references
- project/cache/output persistence when Google Drive is enabled
- later automation through ComfyUI's `/prompt` API

## Files

- `../MiniMax_H3_ComfyUI_Colab.ipynb` — main Colab notebook
- `install_comfy_h3.sh` — installs/updates ComfyUI, H3 Extender and cloudflared
- `download_models.py` — downloads the official H3 model files from `Comfy-Org/MiniMax-H3`
- `prepare_workflow.py` — copies the current Extender workflow and patches the model selectors to our Colab profile
- `launch_comfy.sh` — starts ComfyUI and prints a temporary `trycloudflare.com` URL

## First test

Use an A100 runtime if available.

1. Open the Colab notebook.
2. Mount Drive.
3. Run setup.
4. Download the `ref2va-int8` model profile.
5. Prepare the workflow.
6. Launch ComfyUI.
7. Open the printed URL.
8. In ComfyUI open `MiniMax_H3_Extender_Colab.json`.
9. Start with **2 clips**, short prompts, and one clean character reference.
10. Generate → preview → retry if needed → validate → continue.

Do not start with a 2-minute movie. First prove that clip 2 continues clip 1 correctly.

## Model profile

The default profile uses:

```text
diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors
text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
vae/minimax_h3_video_vae_fp16.safetensors
vae/minimax_h3_audio_vae_fp32.safetensors
loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
```

These are downloaded at runtime and are **not committed to Git**.

The H3 model set is large. The notebook lets you choose whether model weights themselves live on Google Drive. Output/user data can remain Drive-backed even when model weights stay in the Colab VM.

## Continuity prompt rule

For recurring characters, repeat the same subject mapping at the beginning of every clip prompt. Example:

```text
subject_definitions:
<Picture 1> is Aiko. Preserve her exact face, hairstyle, body proportions,
clothes and accessories in every clip.

Clip action:
Aiko continues walking toward the station. The camera keeps the same direction,
height and lens feeling as the previous clip.
```

Motion context carries rendered state, but explicit repeated identity/environment text helps prevent semantic drift.

## Persistence

When enabled, the notebook uses:

```text
MyDrive/MiniMax_H3_ComfyUI/
├── models/
├── output/
└── user/
```

`output/` and `user/` are useful for project/cache/output persistence. Drive-backed model storage is optional because the H3 model stack takes tens of GB.

## API later

Once the UI workflow works, the same Colab server can be automated through ComfyUI's HTTP API. Do not build the wrapper first; validate the workflow in the UI before exporting API-format JSON.
