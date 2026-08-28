from __future__ import annotations

from dataclasses import dataclass, asdict
from time import perf_counter


@dataclass(slots=True)
class RuntimeStats:
    routed_pairs: int = 0
    unique_experts: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    gpu_fills: int = 0
    cpu_experts: int = 0
    h2d_bytes: int = 0
    d2h_bytes: int = 0
    evictions: int = 0
    prefill_layers: int = 0
    decode_layers: int = 0
    started_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.started_at:
            self.started_at = perf_counter()

    @property
    def hit_rate(self) -> float:
        total = self.cache_hits + self.cache_misses
        return self.cache_hits / total if total else 0.0

    def as_dict(self) -> dict:
        out = asdict(self)
        out["hit_rate"] = self.hit_rate
        out["elapsed_s"] = perf_counter() - self.started_at
        return out
