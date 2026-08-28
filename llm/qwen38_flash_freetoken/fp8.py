from __future__ import annotations

from math import ceil


def tensor_nbytes(tensor) -> int:
    return tensor.numel() * tensor.element_size()


def payload_nbytes(*tensors) -> int:
    return sum(tensor_nbytes(t) for t in tensors if t is not None)


def expand_block_scales(scale, out_features: int, in_features: int, block_size=(128, 128)):
    """Expand a 2-D fine-grained FP8 scale matrix to weight shape.

    Used by the correctness/reference and current SM80 dequant paths. The later
    fused A100 kernel should apply block scales without materializing this matrix.
    """
    import torch

    bn, bk = block_size
    if scale.ndim != 2:
        raise ValueError(f"expected 2-D scale, got {tuple(scale.shape)}")
    expanded = scale.repeat_interleave(bn, dim=0).repeat_interleave(bk, dim=1)
    return expanded[:out_features, :in_features]


def dequantize_fp8(weight, scale_inv, block_size=(128, 128), dtype=None):
    import torch

    if dtype is None:
        dtype = torch.bfloat16
    scale = expand_block_scales(scale_inv.float(), weight.shape[-2], weight.shape[-1], block_size)
    return (weight.float() * scale).to(dtype)


def cpu_reference_expert_forward(experts, hidden_states, expert_idx: int):
    """Very slow but exact-structure CPU fallback for correctness experiments.

    It is intentionally not presented as the performance CPU kernel. The production
    phase needs a vectorized/compiled GEMV/GEMM implementation; this path proves that
    q* CPU/GPU result merging preserves model semantics.
    """
    import torch
    import torch.nn.functional as F

    block = tuple(getattr(experts, "block_size", (128, 128)) or (128, 128))
    gu = dequantize_fp8(
        experts.gate_up_proj[expert_idx].detach().cpu(),
        experts.gate_up_proj_scale_inv[expert_idx].detach().cpu(),
        block,
        torch.bfloat16,
    )
    down = dequantize_fp8(
        experts.down_proj[expert_idx].detach().cpu(),
        experts.down_proj_scale_inv[expert_idx].detach().cpu(),
        block,
        torch.bfloat16,
    )
    x = hidden_states.detach().to("cpu", dtype=torch.bfloat16)
    projected = F.linear(x, gu)
    y = experts._apply_gate(projected)
    return F.linear(y, down)
