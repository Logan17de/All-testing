#!/usr/bin/env python3
import argparse
import math
import os
import shutil
import sys
from pathlib import Path

MODEL_ID = "MiniMaxAI/MiniMax-H3"
FPS = 24


def gib(n: int) -> float:
    return n / (1024 ** 3)


def system_ram_gib() -> float:
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb / 1024 / 1024
    except Exception:
        pass
    return 0.0


def print_system_check() -> tuple[float, float, float]:
    import torch

    ram = system_ram_gib()
    free_disk = gib(shutil.disk_usage("/content" if Path("/content").exists() else ".").free)

    print("=== MiniMax H3 Colab check ===")
    print(f"Python      : {sys.version.split()[0]}")
    print(f"Torch       : {torch.__version__}")
    print(f"System RAM  : {ram:.1f} GiB")
    print(f"Free disk   : {free_disk:.1f} GiB")

    vram = 0.0
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        vram = gib(props.total_memory)
        print(f"GPU         : {props.name}")
        print(f"GPU VRAM    : {vram:.1f} GiB")
        print(f"CUDA        : {torch.version.cuda}")
    else:
        print("GPU         : CUDA GPU NOT FOUND")

    print()
    if vram >= 70 and ram >= 140:
        print("Recommended : BF16 + automatic CPU offload")
    elif vram >= 24 and ram >= 70:
        print("Recommended : INT8 + block/leaf offload (auto mode will choose this)")
    else:
        print("Warning     : H3 is very large. For this notebook, use an A100 and a high-RAM Colab runtime.")
        print("              Practical target: >=24 GiB VRAM, >=70 GiB system RAM, and ~160 GiB free disk.")
    return vram, ram, free_disk


def get_hf_token() -> str | None:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        return token
    try:
        from google.colab import userdata
        return userdata.get("HF_TOKEN")
    except Exception:
        return None


def login_hf_if_available() -> None:
    token = get_hf_token()
    if not token:
        print("HF token    : not found (continuing; add a Colab secret named HF_TOKEN if the model requires auth)")
        return
    from huggingface_hub import login
    login(token=token, add_to_git_credential=False)
    print("HF token    : loaded from environment/Colab Secrets")


def snap_num_frames(seconds: float) -> int:
    if not 5 <= seconds <= 15:
        raise ValueError("--seconds must be between 5 and 15.")
    raw = round(seconds * FPS)
    n = max(0, math.ceil((raw - 5) / 17))
    frames = 17 * n + 5
    max_frames = 17 * math.floor((15 * FPS - 5) / 17) + 5
    return min(frames, max_frames)


def validate_canvas(height: int, width: int) -> None:
    if height % 32 != 0 or width % 32 != 0:
        raise ValueError("--height and --width must both be multiples of 32.")


def load_pipeline(workflow: str, precision: str):
    import torch
    from diffusers import ComponentsManager, MiniMaxH3Transformer3DModel, ModularPipeline

    vram = gib(torch.cuda.get_device_properties(0).total_memory)
    ram = system_ram_gib()

    if precision == "auto":
        precision = "bf16" if (vram >= 70 and ram >= 140) else "int8"

    print(f"Workflow    : {workflow}")
    print(f"Precision   : {precision}")

    if precision == "bf16":
        manager = ComponentsManager()
        manager.enable_auto_cpu_offload(device="cuda", memory_reserve_margin="12GB")
        pipe = ModularPipeline.from_pretrained(
            MODEL_ID,
            workflow=workflow,
            components_manager=manager,
        )
        pipe.load_components(dtype=torch.bfloat16)
        return pipe

    if precision != "int8":
        raise ValueError("--precision must be auto, bf16, or int8.")

    if ram and ram < 68:
        raise RuntimeError(
            f"Only {ram:.1f} GiB system RAM detected. The supported INT8 offload recipe needs about 75 GiB. "
            "Switch Colab to a high-RAM runtime."
        )

    from diffusers import TorchAoConfig
    from diffusers.hooks import apply_group_offloading
    from torchao.quantization import Int8WeightOnlyConfig
    from transformers import Qwen3VLForConditionalGeneration
    from transformers import TorchAoConfig as TransformersTorchAoConfig

    pipe = ModularPipeline.from_pretrained(MODEL_ID, workflow=workflow)
    transformer_name = "transformer_ref" if workflow == "ref2va" else "transformer"

    transformer = MiniMaxH3Transformer3DModel.from_pretrained(
        MODEL_ID,
        subfolder=transformer_name,
        dtype=torch.bfloat16,
        quantization_config=TorchAoConfig(
            Int8WeightOnlyConfig(version=2),
            modules_to_not_convert=[
                "proj_in",
                "audio_proj_in",
                "context_embedder",
                "time_embedder",
                "time_proj",
                "token_refiner",
                "norm_out",
                "proj_out",
                "audio_proj_out",
            ],
        ),
        low_cpu_mem_usage=False,
    )

    text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        subfolder="text_encoder",
        dtype=torch.bfloat16,
        quantization_config=TransformersTorchAoConfig(
            Int8WeightOnlyConfig(version=2),
            modules_to_not_convert=[
                "model.visual",
                "model.language_model.embed_tokens",
                "model.language_model.norm",
                "lm_head",
            ],
        ),
    )

    pipe.update_components(**{transformer_name: transformer, "text_encoder": text_encoder})
    pipe.load_components(dtype=torch.bfloat16)

    transformer = getattr(pipe, transformer_name)
    transformer.requires_grad_(False)
    pipe.text_encoder.requires_grad_(False)

    offload = {
        "onload_device": torch.device("cuda"),
        "offload_device": torch.device("cpu"),
        "use_stream": True,
    }
    transformer.enable_group_offload(
        offload_type="block_level",
        num_blocks_per_group=1,
        **offload,
    )
    apply_group_offloading(
        pipe.text_encoder.model,
        offload_type="leaf_level",
        **offload,
    )
    pipe.vae.to("cuda")
    pipe.audio_vae.to("cuda")
    return pipe


def parse_ref(spec: str):
    from diffusers.modular_pipelines.minimax_h3 import (
        MiniMaxH3AudioReference,
        MiniMaxH3ImageReference,
        MiniMaxH3VideoReference,
    )

    if ":" not in spec:
        raise ValueError(f"Bad --ref '{spec}'. Use image:path, video:path, or audio:path.")
    kind, path = spec.split(":", 1)
    kind = kind.strip().lower()
    path = path.strip()

    if kind == "image":
        return "image", MiniMaxH3ImageReference.from_file(path)
    if kind == "video":
        return "video", MiniMaxH3VideoReference.from_file(path)
    if kind == "audio":
        return "audio", MiniMaxH3AudioReference.from_file(path)
    raise ValueError(f"Unknown reference type '{kind}'. Use image, video, or audio.")


def build_references(specs: list[str]):
    refs = []
    counts = {"image": 0, "video": 0, "audio": 0}
    for spec in specs:
        kind, ref = parse_ref(spec)
        counts[kind] += 1
        refs.append(ref)

    if counts["image"] > 9:
        raise ValueError("H3 supports at most 9 image references.")
    if counts["video"] > 3:
        raise ValueError("H3 supports at most 3 video references.")
    if counts["audio"] > 3:
        raise ValueError("H3 supports at most 3 audio references.")
    if len(refs) > 12:
        raise ValueError("H3 supports at most 12 mixed references total.")
    if counts["audio"] and not (counts["image"] or counts["video"]):
        raise ValueError("Audio cannot be the only Ref2VA input; add at least one image or video reference.")
    return refs


def main():
    parser = argparse.ArgumentParser(
        description="Simple Colab runner for MiniMax H3 text/keyframe/omni-reference video+audio generation."
    )
    parser.add_argument("--check", action="store_true", help="Print GPU/RAM/disk info and exit.")
    parser.add_argument("--mode", choices=["t2va", "fl2va", "ref2va"])
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--first-image", default=None)
    parser.add_argument("--last-image", default=None)
    parser.add_argument(
        "--ref",
        action="append",
        default=[],
        help="Ordered Ref2VA input. Repeat: --ref image:path --ref video:path --ref audio:path",
    )
    parser.add_argument("--seconds", type=float, default=5.0)
    parser.add_argument("--height", type=int, default=544)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--steps", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--precision", choices=["auto", "bf16", "int8"], default="auto")
    parser.add_argument("--output", default="/content/h3_output.mp4")
    args = parser.parse_args()

    if args.check:
        print_system_check()
        return

    if not args.mode or not args.prompt:
        parser.error("--mode and --prompt are required unless --check is used.")

    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU not found. In Colab: Runtime -> Change runtime type -> GPU.")

    print_system_check()
    login_hf_if_available()
    validate_canvas(args.height, args.width)
    num_frames = snap_num_frames(args.seconds)
    actual_seconds = num_frames / FPS
    print(f"Requested    : {args.seconds:.2f}s")
    print(f"Frames       : {num_frames} @ {FPS} fps (~{actual_seconds:.2f}s)")
    print(f"Canvas       : {args.width}x{args.height}")
    print(f"Steps        : {args.steps}")
    print(f"Output       : {args.output}")

    pipe = load_pipeline(args.mode, args.precision)
    generator = torch.Generator(device="cpu").manual_seed(args.seed)

    common = dict(
        prompt=args.prompt,
        num_frames=num_frames,
        height=args.height,
        width=args.width,
        num_inference_steps=args.steps,
        generator=generator,
        output=["videos", "audio", "sampling_rate"],
    )

    if args.mode == "t2va":
        if args.first_image or args.last_image or args.ref:
            raise ValueError("t2va is prompt-only. Remove --first-image/--last-image/--ref.")
        results = pipe(**common)

    elif args.mode == "fl2va":
        from diffusers.utils import load_image
        if not (args.first_image or args.last_image):
            raise ValueError("fl2va needs --first-image, --last-image, or both.")
        if args.ref:
            raise ValueError("Use ref2va for --ref inputs.")
        if args.first_image:
            common["image"] = load_image(args.first_image)
        if args.last_image:
            common["last_image"] = load_image(args.last_image)
        results = pipe(**common)

    else:
        if args.first_image or args.last_image:
            raise ValueError("Use --ref image:path for Ref2VA images; keyframes belong to fl2va.")
        if not args.ref:
            raise ValueError("ref2va needs at least one --ref image:path or --ref video:path.")
        common["references"] = build_references(args.ref)
        results = pipe(**common)

    from diffusers.utils.export_utils import encode_video

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    encode_video(
        results["videos"][0],
        fps=FPS,
        output_path=str(output),
        audio=results["audio"][0],
        audio_sample_rate=results["sampling_rate"],
    )
    print()
    print("DONE")
    print(f"Video saved : {output}")


if __name__ == "__main__":
    main()
