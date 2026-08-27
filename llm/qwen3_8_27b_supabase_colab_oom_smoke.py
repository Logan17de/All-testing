#!/usr/bin/env python3
"""Cheap expected-OOM validation for the production Qwen3.8-27B FP8 stack.

This mode deliberately uses the real production model, context, MTP, attention,
linear backend, compile settings, Supabase preflight, and Oracle lease.  The only
production guard it relaxes is the 80 GB VRAM requirement.  On a compatible but
undersized GPU (recommended: L4 24 GB), reaching a VRAM/KV-capacity failure is a
PASS because it proves the code path got as far as real model initialization.
"""

from __future__ import annotations

import re
from pathlib import Path

import qwen3_8_27b_supabase_colab_fast as fast
import qwen3_8_27b_supabase_colab_fast_nightly as nightly

base = fast.base

EXPECTED_MEMORY_MARKERS = (
    "cuda out of memory",
    "outofmemoryerror",
    "out of memory",
    "insufficient memory",
    "not enough memory",
    "free memory on device",
    "no available memory for the cache blocks",
    "kv cache is not enough",
    "kv cache memory",
    "larger than the maximum number of tokens that can be stored in kv cache",
    "gpu memory utilization",
)


def _gpu_compute_capability() -> tuple[int, int]:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("Expected-OOM smoke test requires an NVIDIA GPU runtime")
    return tuple(int(x) for x in torch.cuda.get_device_capability())  # type: ignore[return-value]


def choose_model(vram_mib: int) -> tuple[str, int]:
    """Use the real 27B FP8/262K profile on an intentionally undersized GPU."""
    major, minor = _gpu_compute_capability()
    if major < 8:
        raise RuntimeError(
            "This GPU is SM%d%d. The exact FP8/Marlin production path needs an SM80+ "
            "GPU for a meaningful expected-OOM test. Use the cheapest available SM80+ "
            "runtime (L4 24 GB is recommended); a T4 can fail on kernel compatibility "
            "before it reaches the intended VRAM limit." % (major, minor)
        )
    if vram_mib >= 70_000:
        raise RuntimeError(
            "Expected-OOM mode is for a cheap undersized GPU. This runtime has enough "
            "VRAM for the production path; use the normal A100 section instead."
        )

    print("\n      EXPECTED-OOM SMOKE MODE ✅", flush=True)
    print(f"      GPU capability: SM{major}{minor}", flush=True)
    print(f"      GPU VRAM      : {vram_mib / 1024:.1f} GiB", flush=True)
    print(f"      Real model    : {fast.MODEL_ID}", flush=True)
    print(f"      Real context  : {fast.MAX_MODEL_LEN:,}", flush=True)
    print("      Success target: vLLM reaches VRAM/KV-capacity failure", flush=True)
    return fast.MODEL_ID, fast.MAX_MODEL_LEN


def _combined_failure_text(exc: BaseException) -> str:
    parts = [f"{type(exc).__name__}: {exc}"]
    log_path = base.LOG_ROOT / "vllm.log"
    if log_path.exists():
        try:
            parts.append(log_path.read_text(errors="ignore")[-40_000:])
        except Exception:
            pass
    return "\n".join(parts)


def _is_expected_memory_failure(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in EXPECTED_MEMORY_MARKERS)


def main() -> None:
    # Install the exact production-nightly overrides first, then relax only the
    # A100-size gate. Everything else remains identical to the real worker.
    nightly._install_overrides()
    fast.choose_model = choose_model

    try:
        fast.main()
    except Exception as exc:
        failure = _combined_failure_text(exc)
        if _is_expected_memory_failure(failure):
            print("\n============================================================", flush=True)
            print("EXPECTED VRAM LIMIT REACHED ✅  —  SMOKE TEST PASSED", flush=True)
            print("============================================================", flush=True)
            print(
                "The real Qwen3.8 FP8 production stack reached model/KV memory "
                "initialization on this undersized GPU. Use A100 only for the final "
                "fit, benchmark, and long-context validation.",
                flush=True,
            )
            return
        raise

    raise RuntimeError(
        "Expected-OOM smoke mode unexpectedly reached a ready worker. Use a smaller "
        "compatible GPU or stop this test and use the production section."
    )


if __name__ == "__main__":
    main()
