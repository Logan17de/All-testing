from __future__ import annotations

from contextlib import contextmanager

from .fp8 import dequantize_fp8


@contextmanager
def keep_prequantized_fp8_storage_on_a100():
    """Prevent Transformers from globally dequantizing an FP8 checkpoint on SM80.

    Transformers intentionally converts FP8 checkpoints to BF16 below SM89 because
    its normal FP8 execution backend targets newer GPUs. Our runtime has a different
    contract: keep the checkpoint compressed, move routed experts as FP8 bytes, then
    execute them as BF16 on A100. We therefore suppress *only* that capability gate
    during model loading and immediately convert CUDA-resident non-expert FP8Linear
    modules to ordinary BF16 Linear modules before any forward pass.
    """
    import torch
    from transformers.quantizers.quantizer_finegrained_fp8 import FineGrainedFP8HfQuantizer

    original = FineGrainedFP8HfQuantizer.validate_environment

    def patched(self, *args, **kwargs):
        if self.pre_quantized and torch.cuda.is_available() and torch.cuda.get_device_capability()[0:2] == (8, 0):
            original_get_cc = torch.cuda.get_device_capability
            try:
                torch.cuda.get_device_capability = lambda *a, **k: (8, 9)  # type: ignore[assignment]
                return original(self, *args, **kwargs)
            finally:
                torch.cuda.get_device_capability = original_get_cc  # type: ignore[assignment]
        return original(self, *args, **kwargs)

    FineGrainedFP8HfQuantizer.validate_environment = patched
    try:
        yield
    finally:
        FineGrainedFP8HfQuantizer.validate_environment = original


def _set_submodule(root, name: str, module) -> None:
    if "." not in name:
        setattr(root, name, module)
        return
    parent_name, attr = name.rsplit(".", 1)
    parent = root.get_submodule(parent_name)
    setattr(parent, attr, module)


def convert_cuda_fp8_linears_to_bf16(model) -> int:
    """Convert every CUDA-resident FP8Linear except routed FP8Experts to nn.Linear BF16."""
    import torch
    from transformers.integrations.finegrained_fp8 import FP8Linear

    replacements = []
    for name, module in model.named_modules():
        if not isinstance(module, FP8Linear):
            continue
        if module.weight.device.type != "cuda":
            continue
        replacements.append((name, module))

    for name, module in replacements:
        block = tuple(module.block_size or (module.out_features, module.in_features))
        weight = dequantize_fp8(module.weight.detach(), module.weight_scale_inv.detach(), block, torch.bfloat16)
        new = torch.nn.Linear(
            module.in_features,
            module.out_features,
            bias=module.bias is not None,
            device=module.weight.device,
            dtype=torch.bfloat16,
        )
        with torch.no_grad():
            new.weight.copy_(weight)
            if module.bias is not None:
                new.bias.copy_(module.bias.to(torch.bfloat16))
        new.requires_grad_(False)
        _set_submodule(model, name, new)
        del weight
    torch.cuda.empty_cache()
    return len(replacements)


def remove_accelerate_hooks_from_experts(model) -> int:
    """Leave expert parameters on CPU but stop Accelerate from moving GPU activations to CPU."""
    try:
        from accelerate.hooks import remove_hook_from_module
    except Exception:
        return 0
    count = 0
    for name, module in model.named_modules():
        if name.endswith(".mlp.experts") and hasattr(module, "_hf_hook"):
            remove_hook_from_module(module, recurse=False)
            count += 1
    return count
