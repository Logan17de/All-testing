from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .a100_storage import (
    convert_cuda_fp8_linears_to_bf16,
    keep_prequantized_fp8_storage_on_a100,
    remove_accelerate_hooks_from_experts,
)
from .backend import register_backend
from .config import RuntimeConfig
from .hardware import profile_bandwidth, validate_colab_target
from .manifest import inspect_remote_model, validate_manifest
from .runtime import FreeTokenRuntime


@dataclass(slots=True)
class LoadedRuntime:
    model: Any
    tokenizer: Any
    runtime: FreeTokenRuntime
    manifest: Any


def build_device_map(cfg: RuntimeConfig, *, ple_layer_ids: tuple[int, ...] = ()) -> dict[str, int | str]:
    # Default all ordinary model components to A100. Routed expert pools are host
    # authoritative. Vision is host-resident because this experiment is text-only.
    device_map: dict[str, int | str] = {"": 0, "model.visual": "cpu"}
    for i in range(cfg.num_layers):
        device_map[f"model.language_model.layers.{i}.mlp.experts"] = "cpu"
    # PLE layer IDs are 1-based in Qwen config. Explicit placement matters because
    # this experiment uses an explicit device_map (rather than Accelerate auto-map).
    # Qwen itself moves only the lookup IDs to the embedding device and moves the
    # selected vectors back to the active device.
    for ple_id in ple_layer_ids:
        layer = int(ple_id) - 1
        if 0 <= layer < cfg.num_layers:
            device_map[
                f"model.language_model.layers.{layer}.ple.ple_embedding.ngram_embedding"
            ] = "cpu"
    return device_map


def load_qwen_runtime(
    cfg: RuntimeConfig | None = None,
    *,
    measure_bandwidth: bool = True,
    strict_hardware: bool = True,
) -> LoadedRuntime:
    import torch

    cfg = cfg or RuntimeConfig()
    validate_colab_target(cfg, strict=strict_hardware)
    manifest = inspect_remote_model(cfg)
    validate_manifest(manifest, cfg)
    register_backend()

    from transformers import AutoModelForImageTextToText, AutoTokenizer

    device_map = build_device_map(cfg, ple_layer_ids=manifest.ple_layer_ids)
    print("Loading Qwen3.8-Flash-Next FP8 with routed experts kept in host RAM...")
    with keep_prequantized_fp8_storage_on_a100():
        model = AutoModelForImageTextToText.from_pretrained(
            cfg.model_id,
            revision=cfg.revision,
            cache_dir=cfg.cache_dir,
            device_map=device_map,
            low_cpu_mem_usage=True,
            dtype=torch.bfloat16,
            trust_remote_code=True,
            experts_implementation="freetoken",
        )

    # Critical: CPU device-map hooks would otherwise move hidden states to CPU before
    # calling our expert backend. Parameters stay on CPU after hooks are removed.
    removed = remove_accelerate_hooks_from_experts(model)
    print(f"Detached Accelerate execution hooks from {removed} expert banks.")

    # A100 cannot execute the normal fine-grained FP8 path. Keep routed experts FP8
    # in host RAM, but turn all ordinary CUDA FP8 linears into native BF16 linears.
    converted = convert_cuda_fp8_linears_to_bf16(model)
    print(f"Converted {converted} CUDA non-expert FP8 Linear modules to BF16 compute.")

    tokenizer = AutoTokenizer.from_pretrained(
        cfg.model_id, revision=cfg.revision, cache_dir=cfg.cache_dir, trust_remote_code=True
    )
    bandwidth = profile_bandwidth() if measure_bandwidth else None
    runtime = FreeTokenRuntime.from_loaded_model(model, cfg, bandwidth=bandwidth)
    model.eval()
    return LoadedRuntime(model=model, tokenizer=tokenizer, runtime=runtime, manifest=manifest)
