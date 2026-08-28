#!/usr/bin/env python3
"""Drop-in Colab launcher for Qwen3.8 Flash-Next using the existing Qwen Harness slot.

This intentionally preserves the existing Windows/Harness identity:
- model id: qwen3.8-27b
- relay id: qwen3-8-27b
- local bridge: http://127.0.0.1:8787/v1

Only the Colab inference backend changes. The existing Windows bridge, Supabase
relay, provider configuration, affinity header and model selection can stay as-is.
"""

from __future__ import annotations

import json
import os

from qwen38_flash_freetoken.config import RuntimeConfig
from qwen38_flash_freetoken.hardware import collect_hardware_report, validate_colab_target
from qwen38_flash_freetoken.manifest import inspect_remote_model, validate_manifest
from qwen38_flash_freetoken.relay import run_colab_harness_worker

HARNESS_MODEL_ID = "qwen3.8-27b"
HARNESS_RELAY_ID = "qwen3-8-27b"
HARNESS_BASE_URL = "http://127.0.0.1:8787/v1"
HARNESS_CONTEXT_WINDOW = 262_144
HARNESS_MAX_TOKENS = 32_768


def _colab_secret(name: str) -> str | None:
    value = os.environ.get(name)
    if value and value.strip():
        return value.strip()
    try:
        from google.colab import userdata  # type: ignore

        value = userdata.get(name)
        return value.strip() if value and value.strip() else None
    except Exception:
        return None


def load_optional_hf_token() -> None:
    token = _colab_secret("HF_TOKEN")
    if token:
        os.environ["HF_TOKEN"] = token
        os.environ["HUGGING_FACE_HUB_TOKEN"] = token
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def build_config() -> RuntimeConfig:
    """Build the Flash runtime while advertising the same Harness context slot."""
    return RuntimeConfig(
        cache_dir="/content/hf_cache",
        local_model_dir="/content/qwen38_flash_next_fp8",
        expert_cache_gib=42.0,
        cache_format="bf16",
        max_context_tokens=HARNESS_CONTEXT_WINDOW,
        max_new_tokens=HARNESS_MAX_TOKENS,
        text_only=True,
        drop_vision_after_load=True,
    )


def preflight(*, inspect_checkpoint: bool = True) -> RuntimeConfig:
    """Validate A100/RAM/disk and optionally verify the remote architecture."""
    load_optional_hf_token()
    os.environ.setdefault("QWEN_RELAY_ID", HARNESS_RELAY_ID)
    cfg = build_config()

    report = collect_hardware_report(cfg.cache_dir)
    print(json.dumps(report.as_dict(), indent=2))
    problems = validate_colab_target(cfg, strict=False)
    if problems:
        print("\nPreflight problems:")
        for problem in problems:
            print(" -", problem)
    validate_colab_target(cfg, strict=True)

    if inspect_checkpoint:
        manifest = inspect_remote_model(cfg)
        print("\nRemote checkpoint:")
        print(json.dumps(manifest.as_dict(), indent=2))
        checks = validate_manifest(manifest, cfg)
        print("Architecture checks:")
        for check in checks:
            print(" -", check)

    print("\nHarness compatibility:")
    print(f"  model id : {HARNESS_MODEL_ID}")
    print(f"  relay id : {HARNESS_RELAY_ID}")
    print(f"  base URL : {HARNESS_BASE_URL}")
    print(f"  context  : {HARNESS_CONTEXT_WINDOW:,}")
    print("  Windows/Harness changes required: NONE ✅")
    return cfg


def main() -> None:
    """Start Qwen Flash as a drop-in replacement for the old Qwen3.8-27B worker."""
    load_optional_hf_token()
    os.environ.setdefault("QWEN_RELAY_ID", HARNESS_RELAY_ID)
    cfg = build_config()
    print("\nQwen3.8 Flash-Next → existing Harness Qwen slot")
    print(f"  Harness model : {HARNESS_MODEL_ID}")
    print(f"  Relay ID      : {os.environ['QWEN_RELAY_ID']}")
    print(f"  Windows URL   : {HARNESS_BASE_URL}")
    print("  Backend       : Qwen3.8-Flash-Next-FP8 + FreeToken-style offload")
    print("  Local Harness configuration remains unchanged ✅\n")
    run_colab_harness_worker(cfg)


if __name__ == "__main__":
    main()
