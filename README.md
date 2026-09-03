# All-testing — AI Model Benchmarks & Colab Tests

Colab-first experiments for testing AI models and serving local/open models through temporary APIs.

## Video

### MiniMax H3

- `video/MiniMax_H3_Colab.ipynb` — thin Colab launcher: clone branch, copy the H3 runner to `/content`, install dependencies, upload references, and run text/keyframe/omni-reference tests.
- `video/minimax_h3/run_h3.py` — one CLI for H3 `t2va`, `fl2va`, and `ref2va`, including native video+audio export.
- `video/minimax_h3/setup.sh` — installs the current H3 Diffusers integration and dependencies.
- `video/minimax_h3/upload.py` — simple Colab uploader for image/video/audio references.

The H3 runner loads only the requested workflow and automatically chooses BF16 offload or the supported INT8 offload path based on the runtime. For Colab, use an A100 + High RAM.

### MiniMax H3 — ComfyUI long-video path

- `video/MiniMax_H3_ComfyUI_Colab.ipynb` — Colab launcher for **ComfyUI + MiniMax H3 Extender**, including optional Drive-backed models/output, current upstream workflow preparation, and a Cloudflare browser URL.
- `video/minimax_h3_comfy/` — setup, model downloader, workflow normalizer, launcher, and usage notes for continuous multi-clip H3 generation.

Start with the Extender workflow when testing **continuous/consistent long video**. The older direct runner remains useful for raw single-shot H3 tests.

## LLM API

### Qwen3.8-27B

- `llm/Qwen3_8_27B_API_Colab.ipynb` — one-click Colab launcher. Pulls the latest repo, detects GPU VRAM, downloads Qwen3.8-27B, starts an OpenAI-compatible vLLM API, creates a temporary HTTPS tunnel, generates an API key, and prints the connection details.
- `llm/qwen3_8_27b_api_colab.py` — launcher used by the notebook.

GPU selection is automatic:

- ~80 GB VRAM → `Qwen/Qwen3.8-27B` (original BF16 checkpoint)
- ~40 GB VRAM → `Qwen/Qwen3.8-27B-FP8` (official FP8 checkpoint)
- <40 GB VRAM → exits instead of silently switching to an unofficial community quantization

At the end of a successful run the notebook prints:

```text
API_URL : https://<temporary-id>.trycloudflare.com/v1
API_KEY : sk-colab-<random-key>
MODEL   : qwen3.8-27b
```

The URL and key work only while the Colab runtime remains alive. Never commit the generated API key to GitHub.

## TTS Notebooks

### Qwen3-TTS

- `tts/Qwen3_TTS_Colab.ipynb` — direct Qwen3-TTS 1.7B Japanese generation, RTF, latency, VRAM.
- `tts/Qwen3_TTS_Live_vLLM_Colab.ipynb` — vLLM-Omni API serving, **true chunked PCM streaming**, TTFB measurement, browser streaming demo.

### IndexTTS-2.5

- `tts/IndexTTS25_Colab.ipynb` — direct IndexTTS-2.5 Japanese voice cloning, emotion, Kana pronunciation control, RTF, VRAM.
- `tts/IndexTTS25_API_Colab.ipynb` — vLLM-Omni serving, API latency and concurrency tests.

> Current vLLM-Omni support for IndexTTS-2.5 can expose `stream=true`, but the response is non-chunked. Do not compare its first HTTP content time directly with Qwen's true PCM streaming TTFB.

### Comparison

- `tts/Qwen_vs_Index_Benchmark.ipynb` — common AIKO Japanese test phrases and a results sheet.

## Recommended TTS order

1. Run `Qwen3_TTS_Colab.ipynb`.
2. Start a **fresh Colab runtime** and run `Qwen3_TTS_Live_vLLM_Colab.ipynb`.
3. Start a **fresh Colab runtime** and run `IndexTTS25_Colab.ipynb`.
4. Start a **fresh Colab runtime** and run `IndexTTS25_API_Colab.ipynb`.
5. Put the measured results into `Qwen_vs_Index_Benchmark.ipynb`.

## What we measure

- cold model load time
- warm generation latency
- audio duration
- real-time factor (RTF)
- peak GPU VRAM
- first audio latency
- concurrency
- Japanese pronunciation
- emotional naturalness
- speaker consistency

## TTS Models

- Qwen: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- Index: `IndexTeam/IndexTTS-2.5`

## Important notes

- Qwen3-TTS is Apache-2.0.
- IndexTTS-2.5 uses the Bilibili Model Use License. Review the current license before commercial deployment.
- IndexTTS voice cloning requires a reference recording. Only use recordings you have permission to clone.
- Colab runtimes can change. The notebooks print GPU/Python/Torch details at the top so benchmark results remain attributable to a specific runtime.
