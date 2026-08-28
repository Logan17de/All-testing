from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from math import ceil
from typing import Hashable

from .fp8 import dequantize_fp8, payload_nbytes


@dataclass(frozen=True, slots=True)
class SlotView:
    slot: int
    gate_up: object
    gate_up_scale: object | None
    down: object
    down_scale: object | None
    cache_format: str


class GPUExpertSlotCache:
    """Fixed-shape global GPU cache keyed by logical (layer, expert).

    `bf16` is the default A100 mode: experts cross PCIe in checkpoint FP8, are
    dequantized once on admission, and subsequent hits execute native BF16 GEMMs.
    `fp8` doubles cache residency but dequantizes on each use because A100 has no
    native FP8 tensor-core path.
    """

    def __init__(
        self,
        slots: int,
        hidden: int,
        intermediate: int,
        block=(128, 128),
        device="cuda",
        cache_format: str = "bf16",
    ):
        import torch

        if slots <= 0:
            raise ValueError("slots must be > 0")
        if cache_format not in {"bf16", "fp8"}:
            raise ValueError("cache_format must be bf16 or fp8")
        self.slots = int(slots)
        self.device = torch.device(device)
        self.hidden = hidden
        self.intermediate = intermediate
        self.block = tuple(block)
        self.cache_format = cache_format
        bn, bk = self.block
        gu_s0, gu_s1 = ceil(2 * intermediate / bn), ceil(hidden / bk)
        d_s0, d_s1 = ceil(hidden / bn), ceil(intermediate / bk)

        if cache_format == "bf16":
            self.gate_up = torch.empty((slots, 2 * intermediate, hidden), dtype=torch.bfloat16, device=self.device)
            self.down = torch.empty((slots, hidden, intermediate), dtype=torch.bfloat16, device=self.device)
            self.gate_up_scale = None
            self.down_scale = None
        else:
            self.gate_up = torch.empty(
                (slots, 2 * intermediate, hidden), dtype=torch.float8_e4m3fn, device=self.device
            )
            self.gate_up_scale = torch.empty((slots, gu_s0, gu_s1), dtype=torch.float32, device=self.device)
            self.down = torch.empty((slots, hidden, intermediate), dtype=torch.float8_e4m3fn, device=self.device)
            self.down_scale = torch.empty((slots, d_s0, d_s1), dtype=torch.float32, device=self.device)

        self.key_for_slot: list[Hashable | None] = [None] * slots
        self.slot_for_key: dict[Hashable, int] = {}
        self.lru: OrderedDict[Hashable, None] = OrderedDict()
        self.free_slots = list(range(slots - 1, -1, -1))
        self.hits = self.misses = self.evictions = 0

    @property
    def bytes_allocated(self) -> int:
        return payload_nbytes(self.gate_up, self.gate_up_scale, self.down, self.down_scale)

    def lookup(self, key: Hashable) -> int | None:
        slot = self.slot_for_key.get(key)
        if slot is None:
            self.misses += 1
            return None
        self.hits += 1
        self.lru.move_to_end(key)
        return slot

    def peek(self, key: Hashable) -> int | None:
        return self.slot_for_key.get(key)

    def _choose_slot(self) -> int:
        if self.free_slots:
            return self.free_slots.pop()
        victim, _ = self.lru.popitem(last=False)
        slot = self.slot_for_key.pop(victim)
        self.key_for_slot[slot] = None
        self.evictions += 1
        return slot

    def admit(self, key: Hashable, experts, expert_idx: int, stream=None, pin_staging: bool = False) -> int:
        import torch

        existing = self.slot_for_key.get(key)
        if existing is not None:
            self.lru.move_to_end(key)
            return existing
        slot = self._choose_slot()
        block = tuple(getattr(experts, "block_size", self.block) or self.block)
        copy_stream = stream or torch.cuda.current_stream(self.device)

        with torch.cuda.stream(copy_stream):
            if self.cache_format == "bf16":
                # Transfer compressed FP8+scales, then dequantize on A100 once per miss.
                gu_w = experts.gate_up_proj[expert_idx].detach().to(self.device, non_blocking=False)
                gu_s = experts.gate_up_proj_scale_inv[expert_idx].detach().to(self.device, non_blocking=False)
                d_w = experts.down_proj[expert_idx].detach().to(self.device, non_blocking=False)
                d_s = experts.down_proj_scale_inv[expert_idx].detach().to(self.device, non_blocking=False)
                self.gate_up[slot].copy_(dequantize_fp8(gu_w, gu_s, block, torch.bfloat16))
                self.down[slot].copy_(dequantize_fp8(d_w, d_s, block, torch.bfloat16))
                del gu_w, gu_s, d_w, d_s
            else:
                srcs = (
                    experts.gate_up_proj[expert_idx].detach(),
                    experts.gate_up_proj_scale_inv[expert_idx].detach(),
                    experts.down_proj[expert_idx].detach(),
                    experts.down_proj_scale_inv[expert_idx].detach(),
                )
                dsts = (self.gate_up[slot], self.gate_up_scale[slot], self.down[slot], self.down_scale[slot])
                for dst, src in zip(dsts, srcs):
                    if src.device.type != "cpu":
                        src = src.cpu()
                    if pin_staging and not src.is_pinned():
                        src = src.pin_memory()
                    dst.copy_(src, non_blocking=bool(pin_staging and src.is_pinned()))

        self.slot_for_key[key] = slot
        self.key_for_slot[slot] = key
        self.lru[key] = None
        return slot


    def admit_from_gpu_fp8(self, key: Hashable, gate_up, gate_scale, down, down_scale) -> int:
        """Seed a decode-cache slot from a full-layer GPU prefill buffer (zero PCIe)."""
        import torch
        existing = self.slot_for_key.get(key)
        if existing is not None:
            self.lru.move_to_end(key)
            return existing
        slot = self._choose_slot()
        if self.cache_format == "bf16":
            self.gate_up[slot].copy_(dequantize_fp8(gate_up, gate_scale, self.block, torch.bfloat16))
            self.down[slot].copy_(dequantize_fp8(down, down_scale, self.block, torch.bfloat16))
        else:
            self.gate_up[slot].copy_(gate_up)
            self.gate_up_scale[slot].copy_(gate_scale)
            self.down[slot].copy_(down)
            self.down_scale[slot].copy_(down_scale)
        self.slot_for_key[key] = slot
        self.key_for_slot[slot] = key
        self.lru[key] = None
        return slot

    def view(self, slot: int) -> SlotView:
        gu_s = None if self.gate_up_scale is None else self.gate_up_scale[slot]
        d_s = None if self.down_scale is None else self.down_scale[slot]
        return SlotView(slot, self.gate_up[slot], gu_s, self.down[slot], d_s, self.cache_format)

    def validate(self) -> None:
        assert len(self.slot_for_key) == len(self.lru)
        for key, slot in self.slot_for_key.items():
            assert self.key_for_slot[slot] == key
        for slot, key in enumerate(self.key_for_slot):
            if key is not None:
                assert self.slot_for_key[key] == slot
