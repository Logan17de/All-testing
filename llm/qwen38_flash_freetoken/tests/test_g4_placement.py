from qwen38_flash_freetoken.config import RuntimeConfig
from qwen38_flash_freetoken.planner import build_hybrid_placement_plan


def test_g4_177_ram_96_vram_plan_is_feasible():
    cfg = RuntimeConfig()
    plan = build_hybrid_placement_plan(cfg, host_ram_gib=176.9, gpu_vram_gib=95.6)
    assert plan.feasible, plan.reason
    assert len(plan.gpu_expert_layers) == 24
    assert len(plan.cpu_expert_layers) == 24
    assert plan.gpu_permanent_expert_gib > 50
    assert plan.host_headroom_gib >= cfg.host_safety_gib
    assert plan.recommended_cache_gib >= cfg.min_dynamic_cache_gib


def test_old_a100_167_ram_80_vram_plan_is_rejected():
    cfg = RuntimeConfig()
    plan = build_hybrid_placement_plan(cfg, host_ram_gib=167.1, gpu_vram_gib=80.0)
    assert not plan.feasible
