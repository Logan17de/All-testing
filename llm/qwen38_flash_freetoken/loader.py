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
from .hardware import collect_hardware_report, profile_bandwidth, validate_colab_target
from .manifest import inspect_remote_model, validate_manifest
from .planner import HybridPlacementPlan, build_hybrid_placement_plan
from .runtime import FreeTokenRuntime


@dataclass(slots=True)
class LoadedRuntime:
    model: Any
    tokenizer: Any
    runtime: FreeTokenRuntime
    manifest: Any
    placement: HybridPlacementPlan


def build_device_map(
    cfg: RuntimeConfig,
    *,
    ple_layer_ids: tuple[int, ...] = (),
    gpu_expert_layers: tuple[int, ...] = (),
) -> dict[str, int | str]:
    """Place whole expert banks either CPU-authoritative or GPU-authoritative."""
    gpu_layers = set(int(x) for x in gpu_expert_layers)
    device_map: dict[str, int | str] = {"": 0, "model.visual": "cpu"}
    for i in range(cfg.num_layers):
        device_map[f"model.language_model.layers.{i}.mlp.experts"] = (
            0 if i in gpu_layers else "cpu"
        )
    for ple_id in ple_layer_ids:
        layer = int(ple_id) - 1
        if 0 <= layer < cfg.num_layers:
            device_map[
                f"model.language_model.layers.{layer}.ple.ple_embedding.ngram_embedding"
            ] = "cpu"
    return device_map


def _placement_for_current_machine(cfg: RuntimeConfig) -> HybridPlacementPlan:
    report = collect_hardware_report(cfg.cache_dir)
    if report.gpu_vram_gib is None:
        raise RuntimeError("CUDA GPU not detected")
    plan = build_hybrid_placement_plan(
        cfg,
        host_ram_gib=report.host_ram_gib,
        gpu_vram_gib=report.gpu_vram_gib,
    )
    if not plan.feasible:
        raise RuntimeError("Adaptive expert placement is not feasible: " + plan.reason)
    return plan


def load_qwen_runtime(
    cfg: RuntimeConfig | None = None,
    *,
    measure_bandwidth: bool = True,
    strict_hardware: bool = True,
) -> LoadedRuntime:
    import json
    import torch

    cfg = cfg or RuntimeConfig()
    validate_colab_target(cfg, strict=strict_hardware)
    manifest = inspect_remote_model(cfg)
    validate_manifest(manifest, cfg)
    register_backend()

    placement = _placement_for_current_machine(cfg)
    cfg.gpu_expert_layers = placement.gpu_expert_layers
    cfg.expert_cache_gib = max(
        cfg.min_dynamic_cache_gib,
        min(cfg.expert_cache_gib, placement.recommended_cache_gib),
    )

    print("Adaptive expert placement:")
    print(json.dumps(placement.as_dict(), indent=2))
    print(
        f"GPU-authoritative expert layers: {len(placement.gpu_expert_layers)}/{cfg.num_layers} "
        f"({placement.gpu_permanent_expert_gib:.1f} GiB, no CPU duplicate)"
    )
    print(
        f"CPU-authoritative expert layers: {len(placement.cpu_expert_layers)}/{cfg.num_layers} "
        f"({placement.host_expert_gib:.1f} GiB)"
    )
    print(f"Dynamic expert-cache budget: {cfg.expert_cache_gib:.1f} GiB")

    from transformers import AutoModelForImageTextToText, AutoTokenizer

    device_map = build_device_map(
        cfg,
        ple_layer_ids=manifest.ple_layer_ids,
        gpu_expert_layers=placement.gpu_expert_layers,
    )
    print("Loading Qwen3.8-Flash-Next FP8 with hybrid authoritative expert placement...")
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

    removed = remove_accelerate_hooks_from_experts(model)
    print(f"Detached Accelerate execution hooks from {removed} expert banks.")

    cc = torch.cuda.get_device_capability()
    if cc < (8, 9):
        # A100/SM80: checkpoint stays compressed, but ordinary FP8 linear compute
        # needs our BF16 fallback. Routed expert banks remain FP8 storage.
        converted = convert_cuda_fp8_linears_to_bf16(model)
        print(f"SM{cc[0]}{cc[1]} fallback: converted {converted} CUDA non-expert FP8 linears to BF16.")
    else:
        # Ada/Hopper and newer can keep the ordinary checkpoint FP8 path native.
        print(f"SM{cc[0]}{cc[1]} native FP8 path: ordinary CUDA FP8 linears remain compressed ✅")

    tokenizer = AutoTokenizer.from_pretrained(
        cfg.model_id,
        revision=cfg.revision,
        cache_dir=cfg.cache_dir,
        trust_remote_code=True,
    )
    bandwidth = profile_bandwidth() if measure_bandwidth else None
    runtime = FreeTokenRuntime.from_loaded_model(model, cfg, bandwidth=bandwidth)
    model.eval()
    return LoadedRuntime(
        model=model,
        tokenizer=tokenizer,
        runtime=runtime,
        manifest=manifest,
        placement=placement,
    )
