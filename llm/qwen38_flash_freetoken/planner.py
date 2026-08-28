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


@dataclass(frozen=True, slots=True)
class HybridPlacementPlan:
    feasible: bool
    gpu_expert_layers: tuple[int, ...]
    cpu_expert_layers: tuple[int, ...]
    expert_layer_gib: float
    total_expert_pool_gib: float
    gpu_permanent_expert_gib: float
    host_expert_gib: float
    ngram_host_gib: float
    estimated_host_weight_gib: float
    host_headroom_gib: float
    prefill_reserve_gib: float
    gpu_nonexpert_reserve_gib: float
    context_cache_reserve_gib: float
    gpu_safety_gib: float
    recommended_cache_gib: float
    gpu_headroom_after_cache_gib: float
    reason: str

    def as_dict(self) -> dict:
        return asdict(self)


def estimate_expert_bytes(cfg: RuntimeConfig) -> tuple[int, int]:
    # gate_up: [2I, H], down: [H, I], one byte/FP8 element.
    raw = (2 * cfg.moe_intermediate_size * cfg.hidden_size) + (
        cfg.hidden_size * cfg.moe_intermediate_size
    )
    gu_scale = ceil(2 * cfg.moe_intermediate_size / cfg.fp8_block_n) * ceil(
        cfg.hidden_size / cfg.fp8_block_k
    ) * 4
    down_scale = ceil(cfg.hidden_size / cfg.fp8_block_n) * ceil(
        cfg.moe_intermediate_size / cfg.fp8_block_k
    ) * 4
    return raw, gu_scale + down_scale


def estimate_context_cache_gib(cfg: RuntimeConfig) -> float:
    """Conservative batch-1 VRAM reserve for the configured total context length.

    Qwen3.8 Flash is hybrid GDN + QSA, so only the 12 QSA layers grow a normal
    sequence-length KV history. The GDN layers keep recurrent state. The estimate
    includes QSA K+V, one MTP attention layer, the QSA indexer key history, and an
    explicit state/allocator margin. It intentionally assumes BF16 cache storage.
    """
    tokens = max(1, int(cfg.max_context_tokens))
    b = max(1, int(cfg.kv_cache_dtype_bytes))

    qsa_kv = (
        tokens
        * cfg.qsa_layers
        * 2  # K + V
        * cfg.qsa_kv_heads
        * cfg.qsa_head_dim
        * b
        / GIB
    )
    mtp_kv = (
        tokens
        * cfg.mtp_cache_layers
        * 2
        * cfg.qsa_kv_heads
        * cfg.qsa_head_dim
        * b
        / GIB
    )
    # The QSA indexer is MQA: one shared key head per QSA layer. We reserve its
    # complete history even though the implementation may compress it further.
    indexer = (
        tokens
        * cfg.qsa_layers
        * cfg.qsa_indexer_kv_heads
        * cfg.qsa_indexer_head_dim
        * b
        / GIB
    )
    total = qsa_kv + mtp_kv + indexer + cfg.context_state_safety_gib
    # Quarter-GiB rounding makes the printed plan stable and leaves a small pad.
    return ceil(total * 4.0) / 4.0


def build_memory_plan(cfg: RuntimeConfig, ngram_host_gib: float | None = None) -> MemoryPlan:
    raw, scales = estimate_expert_bytes(cfg)
    fp8_expert = raw + scales
    bf16_expert = raw * 2
    total_experts = cfg.num_layers * cfg.num_experts
    pool = fp8_expert * total_experts / GIB
    slots_fp8 = cfg.cache_bytes // fp8_expert
    slots_bf16 = cfg.cache_bytes // bf16_expert
    ngram = cfg.ngram_host_estimate_gib if ngram_host_gib is None else ngram_host_gib
    notes = (
        "The current Qwen4Exp implementation keeps the giant PLE/ngram embedding host-resident; budget ~95 GiB unless live measurements say otherwise.",
        "Routed experts remain checkpoint FP8 for storage/PCIe; complete G4/Blackwell GPU-authoritative banks can execute with native FP8 grouped kernels.",
        "The hybrid planner separately reserves long-context KV/indexer/GDN state VRAM before assigning the dynamic expert cache.",
        "Adaptive placement can move complete expert layers permanently to GPU with no CPU duplicate when host RAM is constrained.",
    )
    return MemoryPlan(
        expert_weight_bytes_fp8=raw,
        expert_scale_bytes=scales,
        expert_bytes_fp8=fp8_expert,
        expert_bytes_bf16=bf16_expert,
        routed_expert_pool_gib=pool,
        ngram_host_estimate_gib=ngram,
        fp8_cache_slots=int(slots_fp8),
        bf16_cache_slots=int(slots_bf16),
        fp8_cache_fraction=min(1.0, slots_fp8 / total_experts),
        bf16_cache_fraction=min(1.0, slots_bf16 / total_experts),
        notes=notes,
    )


def _spread_layers(total: int, count: int) -> tuple[int, ...]:
    """Deterministically spread permanent layers across depth."""
    if count <= 0:
        return ()
    if count >= total:
        return tuple(range(total))
    return tuple((i * total) // count for i in range(count))


def build_hybrid_placement_plan(
    cfg: RuntimeConfig,
    *,
    host_ram_gib: float,
    gpu_vram_gib: float,
) -> HybridPlacementPlan:
    """Plan authoritative expert-layer placement without CPU/GPU duplication.

    We first move only enough complete expert banks to GPU to make host RAM safe.
    VRAM is then reserved for ordinary model components, full-layer prefill buffers,
    the configured long-context KV/state budget and allocator safety. Only the
    remainder is offered to the global dynamic expert cache.
    """
    raw, scales = estimate_expert_bytes(cfg)
    one_expert = raw + scales
    layer_gib = one_expert * cfg.num_experts / GIB
    pool_gib = layer_gib * cfg.num_layers
    ngram = cfg.ngram_host_estimate_gib

    host_budget_for_experts = host_ram_gib - ngram - cfg.host_safety_gib
    move_gib = max(0.0, pool_gib - host_budget_for_experts)
    required_gpu_layers = (
        min(cfg.num_layers, int(ceil(move_gib / layer_gib - 1e-12)))
        if move_gib > 0
        else 0
    )

    gpu_layers = _spread_layers(cfg.num_layers, required_gpu_layers)
    gpu_perm = len(gpu_layers) * layer_gib
    host_experts = pool_gib - gpu_perm
    estimated_host = ngram + host_experts
    host_headroom = host_ram_gib - estimated_host

    prefill = (
        2.0 * layer_gib
        if (cfg.enable_prefill_double_buffer and len(gpu_layers) < cfg.num_layers)
        else 0.0
    )
    context_reserve = estimate_context_cache_gib(cfg)
    fixed_gpu = (
        gpu_perm
        + cfg.gpu_nonexpert_reserve_gib
        + context_reserve
        + cfg.gpu_safety_gib
        + prefill
    )
    cache_cap = max(0.0, gpu_vram_gib - fixed_gpu)
    recommended_cache = min(cfg.expert_cache_gib, cache_cap)
    gpu_headroom = gpu_vram_gib - fixed_gpu - recommended_cache

    feasible = True
    reasons: list[str] = []
    if host_headroom < cfg.host_safety_gib - 1e-6:
        feasible = False
        reasons.append(
            f"host placement leaves {host_headroom:.1f} GiB headroom; target is {cfg.host_safety_gib:.1f} GiB"
        )
    if required_gpu_layers > cfg.num_layers:
        feasible = False
        reasons.append("required GPU expert layers exceed model depth")
    if cache_cap < cfg.min_dynamic_cache_gib:
        feasible = False
        reasons.append(
            f"only {cache_cap:.1f} GiB remains for dynamic cache after reserving "
            f"{context_reserve:.1f} GiB for {cfg.max_context_tokens:,}-token context; "
            f"minimum cache is {cfg.min_dynamic_cache_gib:.1f} GiB"
        )
    if fixed_gpu > gpu_vram_gib:
        feasible = False
        reasons.append(f"fixed GPU placement needs {fixed_gpu:.1f} GiB > {gpu_vram_gib:.1f} GiB")

    cpu_layers = tuple(i for i in range(cfg.num_layers) if i not in set(gpu_layers))
    reason = "OK" if feasible else "; ".join(reasons)
    return HybridPlacementPlan(
        feasible=feasible,
        gpu_expert_layers=gpu_layers,
        cpu_expert_layers=cpu_layers,
        expert_layer_gib=layer_gib,
        total_expert_pool_gib=pool_gib,
        gpu_permanent_expert_gib=gpu_perm,
        host_expert_gib=host_experts,
        ngram_host_gib=ngram,
        estimated_host_weight_gib=estimated_host,
        host_headroom_gib=host_headroom,
        prefill_reserve_gib=prefill,
        gpu_nonexpert_reserve_gib=cfg.gpu_nonexpert_reserve_gib,
        context_cache_reserve_gib=context_reserve,
        gpu_safety_gib=cfg.gpu_safety_gib,
        recommended_cache_gib=recommended_cache,
        gpu_headroom_after_cache_gib=gpu_headroom,
        reason=reason,
    )
