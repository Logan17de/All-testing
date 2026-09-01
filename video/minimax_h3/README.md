# MiniMax H3 — Colab

Minimal Google Colab pipeline for the open-weight MiniMax H3 base model.

Supported modes:

- `t2va` — text -> video + native stereo audio
- `fl2va` — first frame, last frame, or both -> video + audio
- `ref2va` — ordered mixed image/video/audio references -> video + audio

The runner loads only the H3 workflow you request, so it does not download both large transformer partitions at once.

## Colab target

Use an A100 runtime and enable **High RAM** if Colab offers it.

The script automatically chooses:

- BF16 + automatic CPU offload only when there is enough VRAM **and** host RAM.
- Otherwise the official supported INT8 + block/leaf offload path.

For the first test, the default canvas is `960x544`, which the current Diffusers H3 docs call out as a much faster valid canvas than full trained `1344x768`.

The model download is large. Keep roughly 160 GB of free local disk available for one workflow/cache.

## Hugging Face access

If download authentication is required:

1. Accept the MiniMax H3 license/terms on the Hugging Face model page.
2. In Colab, add a secret named `HF_TOKEN`.
3. Allow notebook access to that secret.

`run_h3.py` reads `HF_TOKEN` automatically.

## Commands

Check runtime:

```bash
python run_h3.py --check
```

Upload inputs:

```bash
python upload.py
```

### Text -> video + audio

```bash
python run_h3.py \
  --mode t2va \
  --prompt "A cinematic night street in Tokyo, light rain, pedestrians walking naturally, realistic city ambience." \
  --seconds 5 \
  --output /content/h3_text.mp4
```

### First frame -> video + audio

```bash
python run_h3.py \
  --mode fl2va \
  --prompt "The camera slowly pushes forward while the character turns toward camera. Natural ambient audio." \
  --first-image inputs/start.png \
  --seconds 5 \
  --output /content/h3_first_frame.mp4
```

### First + last frame

```bash
python run_h3.py \
  --mode fl2va \
  --prompt "Smoothly transition from the first composition to the final composition with natural motion." \
  --first-image inputs/start.png \
  --last-image inputs/end.png \
  --seconds 5 \
  --output /content/h3_first_last.mp4
```

### Blender city + character reference

`--ref` is repeatable and keeps the order you provide.

```bash
python run_h3.py \
  --mode ref2va \
  --prompt "Use <Video 1> as the city environment and camera-motion reference. Keep the architecture and camera rhythm. Use <Picture 1> as the main character. The character walks naturally along the sidewalk while other pedestrians move through the scene. Preserve the city layout as closely as possible. Natural city ambience." \
  --ref video:inputs/city.mp4 \
  --ref image:inputs/character.png \
  --seconds 5 \
  --output /content/h3_city_character.mp4
```

### Image + video + voice/audio reference

```bash
python run_h3.py \
  --mode ref2va \
  --prompt "Use <Picture 1> for the character identity, <Video 1> for motion/camera rhythm, and <Audio 1> for voice timbre. The character walks toward camera and speaks naturally." \
  --ref image:inputs/character.png \
  --ref video:inputs/motion.mp4 \
  --ref audio:inputs/voice.wav \
  --seconds 5 \
  --output /content/h3_mixed_refs.mp4
```

## Useful flags

- `--seconds 5..15`
- `--height` / `--width` — multiples of 32
- `--steps 50` — base-quality default
- `--seed 42`
- `--precision auto|bf16|int8`

H3 internally uses 24 fps and only specific frame counts (`17*n+5`). The runner snaps the requested duration to a valid frame count while staying within the model's 5–15 second range.

## Limits for Ref2VA

- Up to 9 images
- Up to 3 videos
- Up to 3 audio clips
- Up to 12 mixed files total
- Audio cannot be the only reference type

For reference videos, the runner uses H3/Diffusers `from_file()`, preserving the source FPS and soundtrack metadata.

## Output

The result is a single `.mp4` with the generated video and H3's native generated stereo audio muxed together.
