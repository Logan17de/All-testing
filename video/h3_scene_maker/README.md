# H3 Scene Maker

LLM-directed long-form video generation around **ComfyUI + MiniMax H3**.

The user provides only:

- a story / screenplay idea
- character reference images
- optional environment / style references
- target duration

The system then works in a loop:

```text
Story + Characters
        ↓
Multimodal LLM (Director)
        ↓
LEVEL 0 — Story beats / continuity bible
        ↓
LEVEL 1 — Scenes (30–180 s each)
        ↓
LEVEL 2 — H3 clips (5–10 s each)
        ↓
ComfyUI + MiniMax H3
        ↓
Generated clip
        ↓
Extract 1 frame / second + first/last seam frames
        ↓
Multimodal LLM (Continuity Reviewer)
        ↓
   ┌──── PASS ────→ commit clip → update memory → next clip
   │
   └──── FAIL ────→ correction prompt → regenerate only this clip
```

A 30-minute result is therefore never planned or rendered as one giant job. It is built as a chain of small, validated clips.

## Design goals

1. **Character identity stays stable.** Reference images and a compact character bible are repeated where needed.
2. **Continuity is explicit.** The LLM tracks wardrobe, props, location, time-of-day, camera direction, positions, action state and dialogue state.
3. **The reviewer sees the result.** It samples one frame per second from every generated clip and checks the first/last transition against the previous accepted clip.
4. **Only bad clips are retried.** Accepted clips are immutable checkpoints.
5. **Long projects are resumable.** Every accepted clip, review and continuity state is written to disk.
6. **The LLM is not trusted as a pixel-perfect judge.** It performs semantic/visual consistency review, not optical-flow or frame-level artifact detection.

## Folder layout

```text
h3_scene_maker/
├── README.md
├── requirements.txt
├── config.example.json
├── story.example.json
├── scene_maker.py              # main orchestration loop
├── director.py                 # hierarchical story/scene/clip planning
├── reviewer.py                 # multimodal continuity review
├── frame_sampler.py            # 1 frame/sec + seam-frame extraction
├── comfy_client.py             # ComfyUI /prompt API client
├── llm_client.py               # OpenAI-compatible multimodal client
├── models.py                   # project/state schemas
├── prompts.py                  # director/reviewer system prompts
└── workflows/
    └── README.md               # where exported Comfy API workflow goes
```

## Hierarchical planning

### Level 0 — Story plan

The LLM expands the user's story into major beats while preserving the requested ending and target runtime.

Example for a 30-minute sequence:

```text
00:00–04:00  arrival / setup
04:00–09:00  discovery
09:00–15:00  pursuit
15:00–21:00  confrontation
21:00–27:00  resolution
27:00–30:00  final beat
```

### Level 1 — Scene plan

Only the next scene is expanded in detail. This prevents a 30-minute prompt from becoming stale as generations deviate from the initial plan.

### Level 2 — Clip plan

Only the next 5–10 second H3 clip is authored. The director receives the **actual accepted state** from the prior clip before writing the next one.

## Continuity memory

`project_state.json` should stay compact. It stores facts, not entire old prompts:

```json
{
  "characters": {
    "aiko": {
      "wardrobe": "cream jacket, blue skirt",
      "hair": "long black ponytail",
      "carrying": ["red umbrella"],
      "screen_position": "center-left"
    }
  },
  "location": "Shinjuku side street",
  "time": "late evening",
  "weather": "light rain",
  "camera": {
    "side": "camera faces north",
    "height": "eye level",
    "lens_feel": "35mm"
  },
  "action_state": "Aiko has just opened the cafe door"
}
```

The reviewer may propose state updates, but the director owns the canonical continuity bible.

## Reviewer scores

Each generated clip receives scores from 0–1:

- `identity`
- `wardrobe_props`
- `environment`
- `camera_spatial`
- `action_continuity`
- `seam_continuity`
- `prompt_fulfillment`

Default acceptance rule:

```text
identity >= 0.88
seam_continuity >= 0.80
average >= 0.82
no critical_error
```

These thresholds are configurable.

## Retry policy

A failed clip is not blindly regenerated with the same prompt. The reviewer returns structured corrections such as:

```json
{
  "problems": [
    "jacket changed from cream to black",
    "camera crossed to the opposite side of the street"
  ],
  "correction_prompt": "Preserve the cream jacket exactly. Continue from the previous camera side; do not cross the axis."
}
```

The director merges those corrections into the next attempt. After `max_retries`, generation pauses for human review instead of wasting GPU time.

## ComfyUI workflow contract

Export the working H3 workflow using **Save (API Format)** and put it at:

```text
video/h3_scene_maker/workflows/h3_api.json
```

`config.json` then maps the important node IDs / input names used by `comfy_client.py`:

- positive prompt
- seed
- duration / frame count
- reference inputs
- output prefix

The first version deliberately keeps this adapter generic so we can use H3 Extender, H3 Multishot, or another future Comfy workflow without rewriting the director/reviewer logic.

## Run model

```bash
pip install -r requirements.txt
cp config.example.json config.json
python scene_maker.py --story story.example.json --config config.json
```

For Colab, ComfyUI can run on the same runtime and `comfy_base_url` can simply be `http://127.0.0.1:8188`.

## Important limitation

The multimodal LLM can spot **semantic continuity** surprisingly well: changed face, clothing, props, weather, environment, camera side, missing characters, action resets, etc. It cannot reliably detect every temporal defect such as tiny hand warps between adjacent frames, flicker, or physically incorrect motion. Those should eventually be handled by dedicated CV checks (face embeddings, optical flow / flicker metrics, pose tracking) alongside the LLM reviewer.
