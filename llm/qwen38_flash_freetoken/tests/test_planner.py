from qwen38_flash_freetoken.config import RuntimeConfig
from qwen38_flash_freetoken.planner import build_memory_plan, estimate_expert_bytes


def test_qwen_expert_geometry():
    cfg = RuntimeConfig()
    raw, scales = estimate_expert_bytes(cfg)
    assert raw == 4_915_200
    assert scales == 1_200


def test_bf16_cache_has_about_half_fp8_slots():
    cfg = RuntimeConfig(expert_cache_gib=1)
    p = build_memory_plan(cfg)
    assert p.fp8_cache_slots > p.bf16_cache_slots
    assert 1.9 < p.fp8_cache_slots / p.bf16_cache_slots < 2.1
