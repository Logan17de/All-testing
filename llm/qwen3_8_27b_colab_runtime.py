#!/usr/bin/env python3
"""Colab-safe bootstrap for the Qwen3.8 vLLM nightly runtime.

The important rule here is that the GPU/runtime packages are installed before
Supabase/relay code is imported by the worker.  Colab can keep modules such as
Pillow loaded in the notebook kernel; upgrading their files in-place and then
importing torchvision in that same process can produce a mixed PIL install
(`ImageText.py` from one version and `_typing.py` from another).  Runtime
verification therefore happens in a fresh child Python process, and Pillow is
reinstalled once after uv finishes so its on-disk files are internally
consistent.
"""

from __future__ import annotations

import importlib.metadata as metadata
import re
import shutil
import sys
from pathlib import Path

import qwen3_8_27b_supabase_colab_fast as fast
import qwen3_8_27b_supabase_colab_fast_nightly as nightly

base = fast.base

PROFILE_ID = "a100-fp8-mtp3-single-user-nightly-colab-v1"


def _installed_version(distribution: str) -> str | None:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


def prepare_runtime() -> None:
    """Install/repair the CUDA-13 Qwen3.8 runtime before worker imports use it."""
    print("\n[1/7] Preparing Colab-safe MTP-compatible Qwen3.8 runtime...", flush=True)

    base.run([sys.executable, "-m", "pip", "install", "-U", "uv"])
    uv = shutil.which("uv")
    if uv is None:
        candidate = Path(sys.executable).parent / "uv"
        if candidate.exists():
            uv = str(candidate)
    if uv is None:
        raise RuntimeError("uv installed but its executable was not found")

    base.run([
        uv,
        "pip",
        "install",
        "--system",
        "-U",
        "vllm[flashinfer]",
        "transformers>=5.8.0",
        "huggingface_hub[hf_xet]",
        "requests",
        "supabase",
        "--torch-backend=auto",
        "--extra-index-url",
        nightly.VLLM_NIGHTLY_INDEX,
    ])

    print("\n      Removing optional Torch packages that can conflict with Colab CUDA...", flush=True)
    base.run(
        [sys.executable, "-m", "pip", "uninstall", "-y", "torchaudio", "torchtext"],
        check=False,
    )

    base.run([
        sys.executable,
        "-m",
        "pip",
        "install",
        "-U",
        "--force-reinstall",
        "--no-deps",
        f"torchvision=={base.TORCHVISION_VERSION}",
        "--index-url",
        base.PYTORCH_CUDA_INDEX,
    ])

    # uv/pip can replace Pillow while the Colab kernel still has old PIL
    # modules in memory.  Repair the files on disk, but never import PIL in this
    # process.  The verifier and vLLM server use fresh Python processes.
    pillow_version = _installed_version("Pillow")
    if pillow_version:
        print(f"\n      Repairing Pillow {pillow_version} on disk for fresh subprocesses...", flush=True)
        base.run([
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "--force-reinstall",
            "--no-deps",
            f"Pillow=={pillow_version}",
        ])

    verify = base.run([
        sys.executable,
        "-c",
        (
            "import PIL, torch, torchvision, transformers, vllm, flashinfer; "
            "from PIL import Image, ImageFont; "
            "import vllm.model_executor.models.qwen3_5; "
            "import vllm.model_executor.models.qwen3_5_mtp; "
            "print('Torch:', torch.__version__, 'CUDA:', torch.version.cuda); "
            "print('Torchvision:', torchvision.__version__); "
            "print('Transformers:', transformers.__version__); "
            "print('vLLM nightly:', vllm.__version__); "
            "print('FlashInfer:', getattr(flashinfer, '__version__', 'installed')); "
            "print('Pillow:', PIL.__version__, 'OK'); "
            "print('CUDA available:', torch.cuda.is_available()); "
            "print('Qwen3.8 + native MTP modules: OK'); "
            "print('__QWEN_VLLM_VERSION__=' + str(vllm.__version__))"
        ),
    ], capture=True)
    print(verify.stdout.strip(), flush=True)

    match = re.search(r"^__QWEN_VLLM_VERSION__=(.+)$", verify.stdout, re.MULTILINE)
    if match is None:
        raise RuntimeError("Runtime verifier did not report the installed vLLM version")
    version = match.group(1).strip()
    if nightly._release_tuple(version) < nightly.MIN_MTP_RELEASE:
        raise RuntimeError(
            "Qwen3.8 native MTP requires the gated-DeltaNet speculative fix in "
            f"vLLM 0.27.2+ nightly; installed {version}."
        )

    base.VLLM_VERSION = version
    fast.PROFILE_ID = PROFILE_ID
    nightly.PROFILE_ID = PROFILE_ID


def _runtime_already_prepared() -> None:
    print("\n[1/7] Runtime already prepared before relay startup ✅", flush=True)


def apply_overrides() -> None:
    """Apply nightly inference settings while preventing a second live upgrade."""
    nightly._install_overrides()
    nightly.PROFILE_ID = PROFILE_ID
    fast.PROFILE_ID = PROFILE_ID
    fast.install_dependencies = _runtime_already_prepared


def main() -> None:
    # Install first.  Only after the environment is stable do we let fast.main()
    # import/use Supabase, requests and the rest of the relay stack.
    prepare_runtime()
    apply_overrides()
    fast.main()


# Convenience exports used by the notebook.
benchmark_running_server = nightly.benchmark_running_server


if __name__ == "__main__":
    main()
