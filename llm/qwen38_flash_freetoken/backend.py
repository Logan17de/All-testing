from __future__ import annotations

from .fp8 import cpu_reference_expert_forward, dequantize_fp8, payload_nbytes
from .qstar import qstar_split

_BACKEND_NAME = "freetoken"


def _expert_positions(top_k_index, expert: int):
    import torch
    return torch.where(top_k_index == expert)


def _apply_cached_expert(experts, hidden_states, top_k_index, top_k_weights, expert: int, view):
    import torch
    import torch.nn.functional as F

    token_idx, top_k_pos = _expert_positions(top_k_index, expert)
    if token_idx.numel() == 0:
        return None, None
    current = hidden_states[token_idx].to(torch.bfloat16)
    block = tuple(getattr(experts, "block_size", (128, 128)) or (128, 128))
    if view.cache_format == "bf16":
        gu = view.gate_up
        down = view.down
    else:
        gu = dequantize_fp8(view.gate_up, view.gate_up_scale, block, torch.bfloat16)
        down = dequantize_fp8(view.down, view.down_scale, block, torch.bfloat16)
    gate_up = F.linear(current, gu)
    activated = experts._apply_gate(gate_up)
    out = F.linear(activated, down)
    out = out * top_k_weights[token_idx, top_k_pos, None].to(out.dtype)
    return token_idx, out


def _apply_raw_fp8_expert(experts, hidden_states, top_k_index, top_k_weights, expert: int, view):
    """A100-safe prefill path: full layer is FP8-resident; dequantize one used expert at a time."""
    import torch
    import torch.nn.functional as F

    token_idx, top_k_pos = _expert_positions(top_k_index, expert)
    if token_idx.numel() == 0:
        return None, None
    block = tuple(getattr(experts, "block_size", (128, 128)) or (128, 128))
    gu = dequantize_fp8(view.gate_up_proj[expert], view.gate_up_proj_scale_inv[expert], block, torch.bfloat16)
    down = dequantize_fp8(view.down_proj[expert], view.down_proj_scale_inv[expert], block, torch.bfloat16)
    current = hidden_states[token_idx].to(torch.bfloat16)
    gate_up = F.linear(current, gu)
    activated = experts._apply_gate(gate_up)
    out = F.linear(activated, down)
    out = out * top_k_weights[token_idx, top_k_pos, None].to(out.dtype)
    return token_idx, out


def _cpu_expert(experts, hidden_states, top_k_index, top_k_weights, expert: int):
    token_idx, top_k_pos = _expert_positions(top_k_index, expert)
    if token_idx.numel() == 0:
        return expert, None, None
    cpu_out = cpu_reference_expert_forward(experts, hidden_states[token_idx], expert)
    weights = top_k_weights[token_idx, top_k_pos].detach().cpu().to(cpu_out.dtype)
    return expert, token_idx.detach().cpu(), cpu_out * weights[:, None]


def freetoken_fp8_experts_forward(self, hidden_states, top_k_index, top_k_weights):
    """FP8-storage/BF16-compute FreeToken-style backend for A100.

    All router-selected contributions are executed. `gpu_fill` is the default
    production-experiment path; `hybrid_reference` additionally validates q* exact
    CPU/GPU merging using a deliberately slow CPU implementation.
    """
    import torch

    runtime = getattr(self, "_freetoken_runtime", None)
    layer = getattr(self, "_freetoken_layer_id", None)
    if runtime is None or layer is None:
        raise RuntimeError("FreeToken backend used before runtime.bind_model(model)")

    num_tokens = hidden_states.shape[0]
    is_prefill = num_tokens >= runtime.cfg.prefill_threshold_tokens
    unique = torch.unique(top_k_index).detach().cpu().tolist()
    unique = [int(e) for e in unique if 0 <= int(e) < self.num_experts]
    runtime.stats.routed_pairs += int(top_k_index.numel())
    runtime.stats.unique_experts += len(unique)
    runtime.trace_route(layer, unique, prefill=is_prefill)

    if is_prefill and runtime.prefill_buffers is not None:
        view = runtime.get_prefill_view(layer, self)
        final = torch.zeros_like(hidden_states)
        for expert in unique:
            token_idx, out = _apply_raw_fp8_expert(self, hidden_states, top_k_index, top_k_weights, expert, view)
            if out is not None:
                final.index_add_(0, token_idx, out.to(final.dtype))
        # Seed the global decode cache from the final prompt token without any
        # extra PCIe transfer. This avoids a completely cold first decode token.
        warm_ids = torch.unique(top_k_index[-1]).detach().cpu().tolist()
        for expert in (int(e) for e in warm_ids if 0 <= int(e) < self.num_experts):
            runtime.cache.admit_from_gpu_fp8(
                (layer, expert),
                view.gate_up_proj[expert], view.gate_up_proj_scale_inv[expert],
                view.down_proj[expert], view.down_proj_scale_inv[expert],
            )
        return final

    runtime.stats.decode_layers += 1
    hits: list[tuple[int, int]] = []
    misses: list[int] = []
    for expert in unique:
        key = (layer, expert)
        slot = runtime.cache.lookup(key)
        if slot is None:
            misses.append(expert)
        else:
            hits.append((expert, slot))
    runtime.stats.cache_hits += len(hits)
    runtime.stats.cache_misses += len(misses)

    cpu_ids: tuple[int, ...] = ()
    gpu_fill_ids: tuple[int, ...] = tuple(misses)
    if (
        runtime.cfg.mode == "hybrid_reference"
        and runtime.cfg.enable_cpu_reference
        and runtime.bandwidth is not None
        and misses
    ):
        split = qstar_split(
            misses,
            runtime.bandwidth.pcie_h2d_gbps,
            runtime.bandwidth.host_effective_gbps,
            priority_order=misses,
        )
        gpu_fill_ids, cpu_ids = split.gpu_fill, split.cpu_execute

    cpu_futures = {
        e: runtime.cpu_pool.submit(_cpu_expert, self, hidden_states, top_k_index, top_k_weights, e)
        for e in cpu_ids
    }
    runtime.stats.cpu_experts += len(cpu_ids)

    for expert in gpu_fill_ids:
        key = (layer, expert)
        before = runtime.cache.evictions
        slot = runtime.cache.admit(key, self, expert, stream=runtime.copy_stream, pin_staging=False)
        runtime.copy_stream.synchronize()
        runtime.stats.evictions += runtime.cache.evictions - before
        runtime.stats.gpu_fills += 1
        # PCIe traffic is checkpoint FP8 + scales even when the GPU cache stores BF16.
        runtime.stats.h2d_bytes += payload_nbytes(
            self.gate_up_proj[expert], self.gate_up_proj_scale_inv[expert],
            self.down_proj[expert], self.down_proj_scale_inv[expert],
        )
        hits.append((expert, slot))

    final = torch.zeros_like(hidden_states)
    for expert, slot in hits:
        token_idx, out = _apply_cached_expert(
            self, hidden_states, top_k_index, top_k_weights, expert, runtime.cache.view(slot)
        )
        if out is not None:
            final.index_add_(0, token_idx, out.to(final.dtype))

    for _, future in cpu_futures.items():
        _, token_idx_cpu, out_cpu = future.result()
        if out_cpu is None:
            continue
        token_idx = token_idx_cpu.to(hidden_states.device)
        out = out_cpu.to(hidden_states.device, dtype=final.dtype)
        runtime.stats.d2h_bytes += hidden_states[token_idx].numel() * hidden_states.element_size()
        runtime.stats.h2d_bytes += out.numel() * out.element_size()
        final.index_add_(0, token_idx, out)

    return final


def register_backend() -> None:
    from transformers.integrations.moe import ALL_EXPERTS_FUNCTIONS
    if _BACKEND_NAME not in ALL_EXPERTS_FUNCTIONS._global_mapping:
        ALL_EXPERTS_FUNCTIONS.register(_BACKEND_NAME, freetoken_fp8_experts_forward)
    try:
        from transformers.integrations.finegrained_fp8 import ALL_FP8_EXPERTS_FUNCTIONS
        if _BACKEND_NAME not in ALL_FP8_EXPERTS_FUNCTIONS._global_mapping:
            ALL_FP8_EXPERTS_FUNCTIONS.register(_BACKEND_NAME, freetoken_fp8_experts_forward)
    except ImportError:
        pass
