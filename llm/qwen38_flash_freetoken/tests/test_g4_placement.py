from qwen38_flash_freetoken.config import RuntimeConfig
from qwen38_flash_freetoken.planner import (
    build_hybrid_placement_plan,
    estimate_context_cache_gib,
)


def test_g4_177_ram_96_vram_plan_is_feasible_at_262k():
    cfg = RuntimeConfig(max_context_tokens=262_144)
    plan = build_hybrid_placement_plan(cfg, host_ram_gib=176.9, gpu_vram_gib=95.6)
    assert plan.feasible, plan.reason
    assert len(plan.gpu_expert_layers) == 24
    assert len(plan.cpu_expert_layers) == 24
    assert plan.gpu_permanent_expert_gib > 50
    assert plan.host_headroom_gib >= cfg.host_safety_gib
    assert 9.0 <= plan.context_cache_reserve_gib <= 11.0
    assert plan.recommended_cache_gib >= cfg.min_dynamic_cache_gib


def test_262k_context_cache_budget_is_about_ten_gib():
    cfg = RuntimeConfig(max_context_tokens=262_144)
    reserve = estimate_context_cache_gib(cfg)
    assert 9.0 <= reserve <= 11.0


def test_short_context_needs_less_cache_reserve():
    short = RuntimeConfig(max_context_tokens=32_768)
    long = RuntimeConfig(max_context_tokens=262_144)
    assert estimate_context_cache_gib(short) < estimate_context_cache_gib(long)


def test_old_a100_167_ram_80_vram_plan_is_rejected_at_262k():
    cfg = RuntimeConfig(max_context_tokens=262_144)
    plan = build_hybrid_placement_plan(cfg, host_ram_gib=167.1, gpu_vram_gib=80.0)
    assert not plan.feasible
