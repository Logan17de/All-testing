from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from math import ceil
from pathlib import Path
from threading import Lock
from typing import Any

from .config import GIB, RuntimeConfig
from .gpu_cache import GPUExpertSlotCache
from .metrics import RuntimeStats
from .qstar import BandwidthProfile


@dataclass(slots=True)
class LayerView:
    gate_up_proj: Any
    gate_up_proj_scale_inv: Any
    down_proj: Any
    down_proj_scale_inv: Any
    num_experts: int
    hidden_dim: int
    intermediate_dim: int
    act_fn: Any
    block_size: tuple[int, int]
    activation_scheme: str
    has_gate: bool = True
    has_bias: bool = False
    is_transposed: bool = False
    is_concatenated: bool = True

    def _apply_gate(self, proj_out):
        gate, up = proj_out.chunk(2, dim=-1)
        return self.act_fn(gate) * up


class FullLayerDoubleBuffer:
    """Two GPU FP8 layer buffers plus one host staging bank."""

    def __init__(self, cfg: RuntimeConfig, device="cuda"):
        import torch

        self.cfg = cfg
        self.device = torch.device(device)
        self.copy_stream = torch.cuda.Stream(device=self.device)
        self._events = [torch.cuda.Event(), torch.cuda.Event()]
        self._loaded: list[int | None] = [None, None]
        self._futures: dict[int, Any] = {}
        self._lock = Lock()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ft-prefill")
        E, H, I = cfg.num_experts, cfg.hidden_size, cfg.moe_intermediate_size
        bn, bk = cfg.fp8_block_n, cfg.fp8_block_k
        gs = (E, ceil(2 * I / bn), ceil(H / bk))
        ds = (E, ceil(H / bn), ceil(I / bk))
        self.gate_up = torch.empty((2, E, 2 * I, H), dtype=torch.float8_e4m3fn, device=self.device)
        self.gate_scale = torch.empty((2, *gs), dtype=torch.float32, device=self.device)
        self.down = torch.empty((2, E, H, I), dtype=torch.float8_e4m3fn, device=self.device)
        self.down_scale = torch.empty((2, *ds), dtype=torch.float32, device=self.device)

        self.staging_pinned = True
        try:
            self.stage_gate_up = torch.empty((E, 2 * I, H), dtype=torch.float8_e4m3fn, pin_memory=True)
            self.stage_gate_scale = torch.empty(gs, dtype=torch.float32, pin_memory=True)
            self.stage_down = torch.empty((E, H, I), dtype=torch.float8_e4m3fn, pin_memory=True)
            self.stage_down_scale = torch.empty(ds, dtype=torch.float32, pin_memory=True)
        except (RuntimeError, torch.OutOfMemoryError):
            self.staging_pinned = False
            self.stage_gate_up = torch.empty((E, 2 * I, H), dtype=torch.float8_e4m3fn)
            self.stage_gate_scale = torch.empty(gs, dtype=torch.float32)
            self.stage_down = torch.empty((E, H, I), dtype=torch.float8_e4m3fn)
            self.stage_down_scale = torch.empty(ds, dtype=torch.float32)

    @property
    def bytes_allocated(self) -> int:
        return sum(
            x.numel() * x.element_size()
            for x in (self.gate_up, self.gate_scale, self.down, self.down_scale)
        )

    def _stage_and_copy(self, buf: int, layer_id: int, experts) -> None:
        import torch

        if experts.gate_up_proj.device.type != "cpu":
            raise RuntimeError("Full-layer prefill staging is only valid for CPU-authoritative expert banks")
        self.stage_gate_up.copy_(experts.gate_up_proj.detach())
        self.stage_gate_scale.copy_(experts.gate_up_proj_scale_inv.detach())
        self.stage_down.copy_(experts.down_proj.detach())
        self.stage_down_scale.copy_(experts.down_proj_scale_inv.detach())
        with torch.cuda.stream(self.copy_stream):
            self.gate_up[buf].copy_(self.stage_gate_up, non_blocking=self.staging_pinned)
            self.gate_scale[buf].copy_(self.stage_gate_scale, non_blocking=self.staging_pinned)
            self.down[buf].copy_(self.stage_down, non_blocking=self.staging_pinned)
            self.down_scale[buf].copy_(self.stage_down_scale, non_blocking=self.staging_pinned)
            self._events[buf].record(self.copy_stream)
        self.copy_stream.synchronize()
        self._loaded[buf] = layer_id

    def prefetch(self, layer_id: int, experts) -> None:
        if experts.gate_up_proj.device.type != "cpu":
            return
        buf = layer_id & 1
        with self._lock:
            if self._loaded[buf] == layer_id:
                return
            fut = self._futures.get(layer_id)
            if fut is None:
                self._futures[layer_id] = self._worker.submit(
                    self._stage_and_copy, buf, layer_id, experts
                )

    def acquire(self, layer_id: int, experts) -> LayerView:
        import torch

        buf = layer_id & 1
        self.prefetch(layer_id, experts)
        fut = self._futures.pop(layer_id, None)
        if fut is not None:
            fut.result()
        torch.cuda.current_stream(self.device).wait_event(self._events[buf])
        return LayerView(
            gate_up_proj=self.gate_up[buf],
            gate_up_proj_scale_inv=self.gate_scale[buf],
            down_proj=self.down[buf],
            down_proj_scale_inv=self.down_scale[buf],
            num_experts=experts.num_experts,
            hidden_dim=experts.hidden_dim,
            intermediate_dim=experts.intermediate_dim,
            act_fn=experts.act_fn,
            block_size=tuple(getattr(experts, "block_size", (128, 128)) or (128, 128)),
            activation_scheme=getattr(experts, "activation_scheme", "dynamic"),
        )

    def close(self) -> None:
        self._worker.shutdown(wait=False, cancel_futures=True)


class FreeTokenRuntime:
    """Per-model heterogeneous MoE runtime used by the custom Transformers backend."""

    def __init__(
        self,
        cfg: RuntimeConfig,
        cache: GPUExpertSlotCache,
        bandwidth: BandwidthProfile | None = None,
        prefill_buffers: FullLayerDoubleBuffer | None = None,
    ):
        import torch

        self.cfg = cfg
        self.cache = cache
        self.bandwidth = bandwidth
        self.prefill_buffers = prefill_buffers
        self.stats = RuntimeStats()
        self.expert_modules: dict[int, Any] = {}
        self.gpu_resident_layers: set[int] = set()
        self.cpu_resident_layers: set[int] = set()
        self.copy_stream = torch.cuda.Stream()
        threads = cfg.cpu_threads if cfg.cpu_threads > 0 else max(
            1, min(8, (__import__("os").cpu_count() or 2) // 2)
        )
        self.cpu_pool = ThreadPoolExecutor(max_workers=threads, thread_name_prefix="ft-cpu")
        self._trace_handle = None
        if cfg.route_trace_path:
            Path(cfg.route_trace_path).parent.mkdir(parents=True, exist_ok=True)
            self._trace_handle = open(cfg.route_trace_path, "a", encoding="utf-8")

    @classmethod
    def from_loaded_model(
        cls,
        model,
        cfg: RuntimeConfig,
        bandwidth: BandwidthProfile | None = None,
    ) -> "FreeTokenRuntime":
        import torch
        from .planner import estimate_expert_bytes

        free_bytes, _ = torch.cuda.mem_get_info()
        raw, scales = estimate_expert_bytes(cfg)
        cache_expert_bytes = (raw + scales) if cfg.cache_format == "fp8" else (raw * 2)
        prefill_reserve = 0
        if cfg.enable_prefill_double_buffer and len(cfg.gpu_expert_layers) < cfg.num_layers:
            # Full-layer buffers are always checkpoint FP8 + scales, even when
            # the decode cache stores BF16.
            prefill_reserve = 2 * cfg.num_experts * (raw + scales)
        usable = max(0, free_bytes - int(cfg.gpu_safety_gib * GIB) - prefill_reserve)
        requested = min(cfg.cache_bytes, usable)
        slots = max(1, requested // cache_expert_bytes)
        cache = GPUExpertSlotCache(
            slots=slots,
            hidden=cfg.hidden_size,
            intermediate=cfg.moe_intermediate_size,
            block=(cfg.fp8_block_n, cfg.fp8_block_k),
            cache_format=cfg.cache_format,
        )
        prefill = None
        if cfg.enable_prefill_double_buffer and len(cfg.gpu_expert_layers) < cfg.num_layers:
            try:
                prefill = FullLayerDoubleBuffer(cfg)
            except torch.OutOfMemoryError:
                torch.cuda.empty_cache()
                prefill = None
        rt = cls(cfg, cache, bandwidth=bandwidth, prefill_buffers=prefill)
        rt.bind_model(model)
        return rt

    def bind_model(self, model) -> int:
        matched = 0
        pattern = re.compile(r"(?:^|\.)layers\.(\d+)\.mlp\.experts$")
        for name, module in model.named_modules():
            if not (
                hasattr(module, "gate_up_proj")
                and hasattr(module, "down_proj")
                and hasattr(module, "num_experts")
            ):
                continue
            m = pattern.search(name)
            if m is None:
                continue
            layer = int(m.group(1))
            module._freetoken_runtime = self
            module._freetoken_layer_id = layer
            self.expert_modules[layer] = module
            if module.gate_up_proj.device.type == "cuda":
                self.gpu_resident_layers.add(layer)
            else:
                self.cpu_resident_layers.add(layer)
            matched += 1
        if matched != self.cfg.num_layers:
            raise RuntimeError(
                f"Expected {self.cfg.num_layers} routed-expert modules but bound {matched}. "
                "The upstream Qwen/Transformers module layout may have changed."
            )
        return matched

    def trace_route(self, layer: int, ids: list[int], prefill: bool) -> None:
        if self._trace_handle is None:
            return
        import json

        self._trace_handle.write(
            json.dumps(
                {
                    "layer": layer,
                    "experts": ids,
                    "prefill": prefill,
                    "residency": "gpu" if layer in self.gpu_resident_layers else "cpu",
                }
            )
            + "\n"
        )
        self._trace_handle.flush()

    def _next_cpu_layer(self, layer: int) -> int | None:
        for nxt in range(layer + 1, self.cfg.num_layers):
            if nxt in self.cpu_resident_layers:
                return nxt
        return None

    def get_prefill_view(self, layer: int, experts):
        if self.prefill_buffers is None or layer in self.gpu_resident_layers:
            return None
        view = self.prefill_buffers.acquire(layer, experts)
        nxt = self._next_cpu_layer(layer)
        if nxt is not None:
            self.prefill_buffers.prefetch(nxt, self.expert_modules[nxt])
        self.stats.prefill_layers += 1
        return view

    def close(self) -> None:
        self.cpu_pool.shutdown(wait=False, cancel_futures=True)
        if self.prefill_buffers is not None:
            self.prefill_buffers.close()
        if self._trace_handle is not None:
            self._trace_handle.close()
            self._trace_handle = None
