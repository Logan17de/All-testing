from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path

GIB = 1024 ** 3


@dataclass(slots=True)
class RuntimeConfig:
    """Runtime defaults for the A100 80 GiB / ~250 GiB Colab target.

    The values are intentionally conservative. The model architecture is validated
    from the live checkpoint at startup instead of assuming these defaults forever.
    """

    model_id: str = "Qwen/Qwen3.8-Flash-Next-FP8"
    revision: str | None = None
    cache_dir: str = "/content/hf_cache"
    local_model_dir: str = "/content/qwen38_flash_next_fp8"

    # Qwen3.8 Flash-Next published text architecture defaults.
    num_layers: int = 48
    num_experts: int = 512
    top_k: int = 10
    hidden_size: int = 2560
    moe_intermediate_size: int = 640
    fp8_block_n: int = 128
    fp8_block_k: int = 128

    # Hardware / memory policy.
    min_gpu_gib: float = 75.0
    min_host_gib: float = 220.0
    min_disk_free_gib: float = 190.0  # official FP8 repo is ~185.5 GB (~173 GiB)
    gpu_memory_ratio: float = 0.92
    expert_cache_gib: float = 42.0
    cache_format: str = "bf16"  # bf16 recommended on A100; fp8 is capacity experiment
    prefill_buffers_gib: float = 6.0
    gpu_safety_gib: float = 6.0
    host_safety_gib: float = 20.0
    min_kv_tokens: int = 8192

    # Runtime policy.
    mode: str = "gpu_fill"  # gpu_fill | hybrid_reference
    prefill_threshold_tokens: int = 256
    enable_prefill_double_buffer: bool = True
    enable_cpu_reference: bool = False
    cpu_threads: int = 0
    text_only: bool = True
    drop_vision_after_load: bool = True
    max_new_tokens: int = 256
    max_context_tokens: int = 32768

    # Instrumentation.
    stats_interval_tokens: int = 32
    route_trace_path: str | None = None

    @property
    def cache_bytes(self) -> int:
        return int(self.expert_cache_gib * GIB)

    def as_dict(self) -> dict:
        return asdict(self)

    def local_path(self) -> Path:
        return Path(self.local_model_dir)
