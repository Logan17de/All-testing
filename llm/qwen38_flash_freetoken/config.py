from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path

GIB = 1024 ** 3


@dataclass(slots=True)
class RuntimeConfig:
    """Runtime defaults for heterogeneous Qwen3.8 Flash-Next serving."""

    model_id: str = "Qwen/Qwen3.8-Flash-Next-FP8"
    revision: str | None = None
    cache_dir: str = "/content/hf_cache"
    local_model_dir: str = "/content/qwen38_flash_next_fp8"

    num_layers: int = 48
    num_experts: int = 512
    top_k: int = 10
    hidden_size: int = 2560
    moe_intermediate_size: int = 640
    fp8_block_n: int = 128
    fp8_block_k: int = 128

    min_gpu_gib: float = 75.0
    min_host_gib: float = 128.0
    # Official FP8 repo is ~185.5 GB (~173 GiB). 185 GiB free leaves ~12 GiB
    # above checkpoint payload for HF/Xet metadata/cache overhead without rejecting
    # the current Colab G4 disk (~188 GiB free after the runtime install).
    min_disk_free_gib: float = 185.0
    gpu_memory_ratio: float = 0.92
    expert_cache_gib: float = 42.0
    cache_format: str = "bf16"
    gpu_safety_gib: float = 5.0
    host_safety_gib: float = 24.0

    # Adaptive authoritative placement for constrained high-RAM Colab runtimes.
    adaptive_expert_placement: bool = True
    ngram_host_estimate_gib: float = 95.4
    # On G4/Blackwell ordinary model weights remain native FP8 and this experiment
    # is text-only. Ten GiB is reserved for non-expert model components; a separate
    # context reserve below protects the 262K KV/state budget from the expert cache.
    gpu_nonexpert_reserve_gib: float = 10.0
    min_dynamic_cache_gib: float = 8.0
    gpu_expert_layers: tuple[int, ...] = ()

    # Qwen3.8 Flash long-context cache geometry from the official qwen4_exp config.
    # 48 layers contain 12 QSA layers (one every 4 layers). Each QSA layer has two
    # KV heads with head_dim=256. GDN layers keep recurrent state instead of a
    # sequence-length-growing KV cache. We also reserve one MTP attention layer,
    # the QSA indexer history, and extra state/fragmentation headroom.
    qsa_layers: int = 12
    qsa_kv_heads: int = 2
    qsa_head_dim: int = 256
    qsa_indexer_kv_heads: int = 1
    qsa_indexer_head_dim: int = 128
    mtp_cache_layers: int = 1
    kv_cache_dtype_bytes: int = 2  # BF16 cache assumption
    context_state_safety_gib: float = 2.5

    mode: str = "gpu_fill"
    prefill_threshold_tokens: int = 256
    enable_prefill_double_buffer: bool = True
    enable_cpu_reference: bool = False
    cpu_threads: int = 0
    text_only: bool = True
    drop_vision_after_load: bool = True
    max_new_tokens: int = 256
    max_context_tokens: int = 32768

    stats_interval_tokens: int = 32
    route_trace_path: str | None = None

    @property
    def cache_bytes(self) -> int:
        return int(self.expert_cache_gib * GIB)

    def as_dict(self) -> dict:
        return asdict(self)

    def local_path(self) -> Path:
        return Path(self.local_model_dir)
