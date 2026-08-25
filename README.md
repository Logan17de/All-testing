# All-testing — TTS Benchmarks

Colab-first experiments for evaluating speech models for AIKO.

## Notebooks

### Qwen3-TTS

- `tts/Qwen3_TTS_Colab.ipynb` — direct Qwen3-TTS 1.7B Japanese generation, RTF, latency, VRAM.
- `tts/Qwen3_TTS_Live_vLLM_Colab.ipynb` — vLLM-Omni API serving, **true chunked PCM streaming**, TTFB measurement, browser streaming demo.

### IndexTTS-2.5

- `tts/IndexTTS25_Colab.ipynb` — direct IndexTTS-2.5 Japanese voice cloning, emotion, Kana pronunciation control, RTF, VRAM.
- `tts/IndexTTS25_API_Colab.ipynb` — vLLM-Omni serving, API latency and concurrency tests.

> Current vLLM-Omni support for IndexTTS-2.5 can expose `stream=true`, but the response is non-chunked. Do not compare its first HTTP content time directly with Qwen's true PCM streaming TTFB.

### Comparison

- `tts/Qwen_vs_Index_Benchmark.ipynb` — common AIKO Japanese test phrases and a results sheet.

## Recommended order

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

## Models

- Qwen: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- Index: `IndexTeam/IndexTTS-2.5`

## Important notes

- Qwen3-TTS is Apache-2.0.
- IndexTTS-2.5 uses the Bilibili Model Use License. Review the current license before commercial deployment.
- IndexTTS voice cloning requires a reference recording. Only use recordings you have permission to clone.
- Colab runtimes can change. The notebooks print GPU/Python/Torch details at the top so benchmark results remain attributable to a specific runtime.
