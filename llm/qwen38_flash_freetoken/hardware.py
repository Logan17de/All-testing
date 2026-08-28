from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from pathlib import Path
from dataclasses import asdict, dataclass

from .config import GIB, RuntimeConfig
from .qstar import BandwidthProfile


@dataclass(frozen=True, slots=True)
class HardwareReport:
    python: str
    platform: str
    cpu_count: int
    host_ram_gib: float
    gpu_name: str | None
    gpu_vram_gib: float | None
    compute_capability: str | None
    cuda_runtime: str | None
    torch_version: str | None
    disk_path: str
    disk_free_gib: float

    def as_dict(self) -> dict:
        return asdict(self)


def _host_ram_bytes() -> int:
    try:
        import psutil
        return int(psutil.virtual_memory().total)
    except Exception:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        return int(pages * page_size)


def _disk_free_gib(path: str) -> float:
    import shutil
    probe = path if os.path.exists(path) else str(Path(path).parent)
    while probe and not os.path.exists(probe):
        parent = str(Path(probe).parent)
        if parent == probe:
            probe = "/"
            break
        probe = parent
    return shutil.disk_usage(probe or "/").free / GIB


def collect_hardware_report(cache_dir: str = "/content/hf_cache") -> HardwareReport:
    gpu_name = gpu_vram = cc = cuda = torch_version = None
    try:
        import torch
        torch_version = torch.__version__
        cuda = torch.version.cuda
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            gpu_name = p.name
            gpu_vram = p.total_memory / GIB
            cc = f"{p.major}.{p.minor}"
    except Exception:
        pass
    return HardwareReport(
        python=platform.python_version(),
        platform=platform.platform(),
        cpu_count=os.cpu_count() or 0,
        host_ram_gib=_host_ram_bytes() / GIB,
        gpu_name=gpu_name,
        gpu_vram_gib=gpu_vram,
        compute_capability=cc,
        cuda_runtime=cuda,
        torch_version=torch_version,
        disk_path=cache_dir,
        disk_free_gib=_disk_free_gib(cache_dir),
    )


def validate_colab_target(cfg: RuntimeConfig, strict: bool = True) -> list[str]:
    r = collect_hardware_report(cfg.cache_dir)
    problems: list[str] = []
    if r.gpu_name is None:
        problems.append("CUDA GPU not detected")
    if r.gpu_vram_gib is not None and r.gpu_vram_gib < cfg.min_gpu_gib:
        problems.append(f"GPU VRAM {r.gpu_vram_gib:.1f} GiB < target {cfg.min_gpu_gib:.1f} GiB")
    if r.host_ram_gib < cfg.min_host_gib:
        problems.append(f"Host RAM {r.host_ram_gib:.1f} GiB < minimum {cfg.min_host_gib:.1f} GiB")
    if r.disk_free_gib < cfg.min_disk_free_gib:
        problems.append(
            f"Free disk at {r.disk_path} {r.disk_free_gib:.1f} GiB < target {cfg.min_disk_free_gib:.1f} GiB "
            "(official FP8 checkpoint is about 185.5 GB / 173 GiB before cache overhead)"
        )

    if cfg.adaptive_expert_placement and r.gpu_vram_gib is not None:
        from .planner import build_hybrid_placement_plan
        plan = build_hybrid_placement_plan(
            cfg, host_ram_gib=r.host_ram_gib, gpu_vram_gib=r.gpu_vram_gib
        )
        if not plan.feasible:
            problems.append("adaptive expert placement infeasible: " + plan.reason)

    if strict and problems:
        raise RuntimeError("; ".join(problems))
    return problems


def benchmark_h2d_gbps(size_mib: int = 256, repeats: int = 12, pinned: bool = True) -> float:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    n = size_mib * 1024 * 1024
    src = torch.empty(n, dtype=torch.uint8, pin_memory=pinned)
    dst = torch.empty(n, dtype=torch.uint8, device="cuda")
    stream = torch.cuda.Stream()
    for _ in range(2):
        with torch.cuda.stream(stream):
            dst.copy_(src, non_blocking=pinned)
    stream.synchronize()
    start = torch.cuda.Event(enable_timing=True)
    end = torch.cuda.Event(enable_timing=True)
    start.record(stream)
    for _ in range(repeats):
        with torch.cuda.stream(stream):
            dst.copy_(src, non_blocking=pinned)
    end.record(stream)
    stream.synchronize()
    ms = start.elapsed_time(end)
    return (n * repeats) / (ms / 1000.0) / 1e9


def benchmark_host_copy_gbps(size_mib: int = 512, repeats: int = 6) -> float:
    import numpy as np

    n = size_mib * 1024 * 1024
    a = np.empty(n, dtype=np.uint8)
    b = np.empty_like(a)
    a.fill(7)
    t0 = time.perf_counter()
    for _ in range(repeats):
        np.copyto(b, a)
    elapsed = time.perf_counter() - t0
    return (n * repeats) / elapsed / 1e9


def profile_bandwidth() -> BandwidthProfile:
    return BandwidthProfile(
        pcie_h2d_gbps=benchmark_h2d_gbps(),
        host_effective_gbps=benchmark_host_copy_gbps(),
    )


def nvidia_smi_snapshot() -> str:
    try:
        return subprocess.check_output(["nvidia-smi", "-q"], text=True, stderr=subprocess.STDOUT, timeout=15)
    except Exception as exc:
        return f"nvidia-smi unavailable: {exc}"


def print_report() -> None:
    print(json.dumps(collect_hardware_report().as_dict(), indent=2))
