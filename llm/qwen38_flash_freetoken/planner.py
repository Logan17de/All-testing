from __future__ import annotations

from dataclasses import dataclass, asdict
from math import ceil

from .config import GIB, RuntimeConfig


@dataclass(frozen=True, slots=True)
class MemoryPlan:
    expert_weight_bytes_fp8: int
    expert_scale_bytes: int
    expert_bytes_fp8: int
    expert_bytes_bf16: int
    routed_expert_pool_gib: float
    ngram_host_estimate_gib: float
    fp8_cache_slots: int
    bf16_cache_slots: int
    fp8_cache_fraction: float
    bf16_cache_fraction: float
    notes: tuple[str, ...]

    def as_dict(self) -> dict:
        return asdict(self)


def estimate_expert_bytes(cfg: RuntimeConfig) -> tuple[int, int]:
    # gate_up: [2I, H], down: [H, I], one byte/FP8 element.
    raw = (2 * cfg.moe_intermediate_size * cfg.hidden_size) + (
        cfg.hidden_size * cfg.moe_intermediate_size
    )
    # Fine-grained 128x128 block scales, float32.
    gu_scale = ceil(2 * cfg.moe_intermediate_size / cfg.fp8_block_n) * ceil(
        cfg.hidden_size / cfg.fp8_block_k
    ) * 4
    down_scale = ceil(cfg.hidden_size / cfg.fp8_block_n) * ceil(
        cfg.moe_intermediate_size / cfg.fp8_block_k
    ) * 4
    return raw, gu_scale + down_scale


def build_memory_plan(cfg: RuntimeConfig, ngram_host_gib: float = 95.4) -> MemoryPlan:
    raw, scales = estimate_expert_bytes(cfg)
    fp8_expert = raw + scales
    bf16_expert = raw * 2
    total_experts = cfg.num_layers * cfg.num_experts
    pool = fp8_expert * total_experts / GIB
    slots_fp8 = cfg.cache_bytes // fp8_expert
    slots_bf16 = cfg.cache_bytes // bf16_expert
    notes = (
        "The n-gram estimate defaults to ~95 GiB because the current Transformers Qwen4Exp implementation explicitly treats the giant embedding as host-resident and comments that it is ~95 GiB.",
        "A100 has no native FP8 Tensor Cores; routed weights stay FP8 in host memory/over PCIe, while the default GPU cache dequantizes each admitted expert once and executes native BF16 GEMMs.",
        "Actual allocation is measured after model load; estimates are only admission-planning inputs.",
    )
    return MemoryPlan(
        expert_weight_bytes_fp8=raw,
        expert_scale_bytes=scales,
        expert_bytes_fp8=fp8_expert,
        expert_bytes_bf16=bf16_expert,
        routed_expert_pool_gib=pool,
        ngram_host_estimate_gib=ngram_host_gib,
        fp8_cache_slots=int(slots_fp8),
        bf16_cache_slots=int(slots_bf16),
        fp8_cache_fraction=min(1.0, slots_fp8 / total_experts),
        bf16_cache_fraction=min(1.0, slots_bf16 / total_experts),
        notes=notes,
    )
