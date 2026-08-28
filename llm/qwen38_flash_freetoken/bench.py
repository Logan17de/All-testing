from __future__ import annotations

import json
import random
import time
from collections import Counter

from .cache import GlobalLRUExpertCache
from .config import RuntimeConfig
from .planner import build_memory_plan
from .qstar import qstar_fetch_count


def simulate_routes(
    cfg: RuntimeConfig,
    *,
    tokens: int = 10000,
    cache_fraction: float = 0.20,
    hot_fraction: float = 0.10,
    hot_probability: float = 0.75,
    seed: int = 0,
) -> dict:
    """Synthetic locality smoke test for global LRU mechanics (not a model benchmark)."""
    rng = random.Random(seed)
    total = cfg.num_layers * cfg.num_experts
    slots = max(1, int(total * cache_fraction))
    cache = GlobalLRUExpertCache(slots)  # one byte per synthetic slot
    hot_per_layer = max(cfg.top_k, int(cfg.num_experts * hot_fraction))
    for _ in range(tokens):
        for layer in range(cfg.num_layers):
            routed = set()
            while len(routed) < cfg.top_k:
                if rng.random() < hot_probability:
                    e = rng.randrange(hot_per_layer)
                else:
                    e = rng.randrange(cfg.num_experts)
                routed.add(e)
            for e in routed:
                key = layer * cfg.num_experts + e
                if cache.get(key) is None:
                    cache.put(key, True, 1)
    st = cache.stats()
    return {
        "tokens": tokens,
        "cache_fraction": cache_fraction,
        "hit_rate": st.hit_rate,
        "hits": st.hits,
        "misses": st.misses,
        "evictions": st.evictions,
    }


def qstar_table(pcie: float, host: float, max_misses: int = 10) -> list[dict]:
    return [
        {"misses": m, "gpu_fill": qstar_fetch_count(m, pcie, host), "cpu": m - qstar_fetch_count(m, pcie, host)}
        for m in range(1, max_misses + 1)
    ]
