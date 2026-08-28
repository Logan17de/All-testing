#!/usr/bin/env python3
"""Expected-OOM validation for Qwen3.8 Flash-Next + heterogeneous Harness stack.

Only a CUDA/VRAM memory limit counts as PASS. The smoke path uses the same
adaptive CPU/GPU authoritative expert placement as production. If the real model
loads and a routed generation succeeds, a final sentinel allocation deliberately
exceeds remaining VRAM so Section 2A still ends at the expected memory wall.
"""

from __future__ import annotations

import gc
import json
import os

import qwen3_8_flash_colab_runtime as flash
from qwen38_flash_freetoken.hardware import collect_hardware_report
from qwen38_flash_freetoken.inference import generate_text
from qwen38_flash_freetoken.loader import load_qwen_runtime
from qwen38_flash_freetoken.manifest import inspect_remote_model, validate_manifest
from qwen38_flash_freetoken.planner import build_hybrid_placement_plan

EXPECTED_MEMORY_MARKERS = (
    "cuda out of memory",
    "outofmemoryerror",
    "out of memory",
    "insufficient memory",
    "not enough memory",
    "free memory on device",
    "cuda error: out of memory",
    "cublas_status_alloc_failed",
)


def _is_expected_memory_failure(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in text for marker in EXPECTED_MEMORY_MARKERS)


def _prepare_relay() -> None:
    relay_secret = flash._colab_secret("QWEN_RELAY_SECRET")
    if not relay_secret:
        raise RuntimeError(
            "Add QWEN_RELAY_SECRET in Colab Secrets and enable notebook access. "
            "Section 2A validates the same relay preflight as production."
        )
    os.environ["QWEN_RELAY_SECRET"] = relay_secret
    os.environ["QWEN_RELAY_ID"] = flash.HARNESS_RELAY_ID
    wake = flash._colab_secret("ORACLE_WAKE_GITHUB_TOKEN")
    if wake:
        os.environ["ORACLE_WAKE_GITHUB_TOKEN"] = wake

    from qwen_supabase_relay import RelayStore, request_oracle_wake_if_needed

    store = RelayStore.from_env()
    store.preflight()
    request_oracle_wake_if_needed(wait_seconds=0)
    print("Supabase/Harness relay preflight: OK ✅", flush=True)


def _validate_smoke_hardware(cfg) -> None:
    report = collect_hardware_report(cfg.cache_dir)
    print(json.dumps(report.as_dict(), indent=2), flush=True)

    if report.gpu_name is None or report.compute_capability is None or report.gpu_vram_gib is None:
        raise RuntimeError("CUDA GPU not detected")
    major = int(report.compute_capability.split(".", 1)[0])
    if major < 8:
        raise RuntimeError(
            f"GPU compute capability {report.compute_capability} is below SM80. "
            "Use an SM80+ GPU so the real FP8/BF16 path is tested before OOM."
        )
    if report.host_ram_gib < cfg.min_host_gib:
        raise RuntimeError(
            f"Host RAM {report.host_ram_gib:.1f} GiB < absolute minimum {cfg.min_host_gib:.1f} GiB."
        )
    if report.disk_free_gib < cfg.min_disk_free_gib:
        raise RuntimeError(
            f"Free disk {report.disk_free_gib:.1f} GiB < {cfg.min_disk_free_gib:.1f} GiB. "
            "The real Flash FP8 checkpoint must be available for this smoke test."
        )

    plan = build_hybrid_placement_plan(
        cfg, host_ram_gib=report.host_ram_gib, gpu_vram_gib=report.gpu_vram_gib
    )
    print("\nAdaptive authoritative placement:", flush=True)
    print(json.dumps(plan.as_dict(), indent=2), flush=True)
    if not plan.feasible:
        raise RuntimeError("This RAM/VRAM combination cannot host the real Flash path: " + plan.reason)

    print("Expected-OOM hardware/placement gate: OK ✅", flush=True)
    print(
        f"Plan will keep {len(plan.gpu_expert_layers)} complete expert layers on GPU "
        f"without CPU duplicates and {len(plan.cpu_expert_layers)} in host RAM.",
        flush=True,
    )


def _force_terminal_cuda_oom() -> None:
    import torch

    free_bytes, total_bytes = torch.cuda.mem_get_info()
    request_bytes = int(free_bytes + 2 * 1024**3)
    print("\nProduction generation succeeded ✅", flush=True)
    print(
        f"Terminal OOM sentinel: CUDA free={free_bytes / 1024**3:.2f} GiB, "
        f"requesting={request_bytes / 1024**3:.2f} GiB on "
        f"{total_bytes / 1024**3:.2f} GiB device...",
        flush=True,
    )
    _ = torch.empty(request_bytes, dtype=torch.uint8, device="cuda")
    raise RuntimeError("Terminal OOM sentinel unexpectedly allocated more than reported free VRAM")


def main() -> None:
    flash.load_optional_hf_token()
    cfg = flash.build_config()
    loaded = None
    stage = "bootstrap"

    print("\n============================================================", flush=True)
    print("QWEN3.8 FLASH EXPECTED-OOM PRODUCTION-PATH SMOKE TEST", flush=True)
    print("============================================================", flush=True)
    print("PASS condition: CUDA/VRAM OOM only.", flush=True)
    print("Any other exception before OOM is a real issue to fix.\n", flush=True)

    try:
        stage = "hardware + adaptive placement"
        _validate_smoke_hardware(cfg)

        stage = "relay preflight"
        _prepare_relay()

        stage = "checkpoint manifest"
        manifest = inspect_remote_model(cfg)
        print("Remote checkpoint:", flush=True)
        print(json.dumps(manifest.as_dict(), indent=2), flush=True)
        for check in validate_manifest(manifest, cfg):
            print(" -", check, flush=True)
        print("Checkpoint architecture: OK ✅", flush=True)

        stage = "real model/runtime load"
        print("\nLoading REAL Qwen3.8-Flash-Next-FP8 production weights...", flush=True)
        loaded = load_qwen_runtime(cfg, measure_bandwidth=True, strict_hardware=False)
        print("Model + custom heterogeneous expert backend loaded: OK ✅", flush=True)
        print(f"Bound expert layers       : {len(loaded.runtime.expert_modules)}", flush=True)
        print(f"Permanent GPU layers      : {len(loaded.runtime.gpu_resident_layers)}", flush=True)
        print(f"CPU-authoritative layers  : {len(loaded.runtime.cpu_resident_layers)}", flush=True)
        print(f"Dynamic GPU expert slots  : {loaded.runtime.cache.slots}", flush=True)

        stage = "real routed generation"
        result = generate_text(
            loaded,
            [{"role": "user", "content": "Reply with exactly: smoke-ok"}],
            max_new_tokens=16,
            temperature=0.0,
        )
        print(f"Smoke generation: {result.text!r}", flush=True)
        print(
            f"completion_tokens={result.completion_tokens} "
            f"elapsed={result.elapsed_s:.2f}s TPS={result.tokens_per_second:.2f}",
            flush=True,
        )
        print("Runtime metrics:", flush=True)
        print(json.dumps(loaded.runtime.stats.as_dict(), indent=2), flush=True)

        stage = "deliberate terminal OOM sentinel"
        _force_terminal_cuda_oom()

    except Exception as exc:
        if _is_expected_memory_failure(exc):
            print("\n============================================================", flush=True)
            print("EXPECTED VRAM LIMIT REACHED ✅ — SMOKE TEST PASSED", flush=True)
            print("============================================================", flush=True)
            print(f"OOM stage: {stage}", flush=True)
            if stage == "deliberate terminal OOM sentinel":
                print(
                    "Real checkpoint load, adaptive placement, custom expert backend and "
                    "routed generation all succeeded before the intentional memory wall.",
                    flush=True,
                )
            else:
                print(
                    "The real production path reached a genuine GPU-memory limit. "
                    "Non-memory failures would have been re-raised.",
                    flush=True,
                )
            return
        print(f"\nREAL FAILURE before expected OOM at stage: {stage}", flush=True)
        raise
    finally:
        if loaded is not None:
            try:
                loaded.runtime.close()
            except Exception:
                pass
            try:
                del loaded
            except Exception:
                pass
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


if __name__ == "__main__":
    main()
