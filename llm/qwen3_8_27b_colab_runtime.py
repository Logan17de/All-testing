#!/usr/bin/env python3
"""Colab-safe bootstrap for the Qwen3.8 vLLM nightly multimodal runtime.

The important rule here is that the GPU/runtime packages are installed before
Supabase/relay code is imported by the worker. Colab can keep modules such as
Pillow loaded in the notebook kernel; upgrading their files in-place and then
importing torchvision in that same process can produce a mixed PIL install.
Runtime verification therefore happens in a fresh child Python process, and
Pillow is reinstalled once after uv finishes so its on-disk files are internally
consistent.

This runtime deliberately uses the full Qwen3.8 VLM instead of vLLM's
``--language-model-only`` mode. OpenAI-compatible image_url inputs therefore
travel unchanged through Harness -> Supabase -> Colab -> vLLM. A real in-memory
PNG request is executed before the worker is exposed as ready.

vLLM nightly wheels do not always use a monotonically increasing public release
number. A dev wheel can contain the required Qwen3.5/Qwen3.8 VLM + MTP
implementation while still reporting a base version below a later stable
release. The bootstrap therefore treats successful imports of the actual Qwen
VLM/MTP modules as the compatibility gate, and uses the numeric version only as
informational data.
"""

from __future__ import annotations

import base64
import importlib.metadata as metadata
import io
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import qwen3_8_27b_supabase_colab_fast as fast
import qwen3_8_27b_supabase_colab_fast_nightly as nightly

base = fast.base

PROFILE_ID = "a100-fp8-mtp3-vlm-single-user-nightly-colab-v3"
MM_LIMITS = {"image": 8, "video": 0}


def _installed_version(distribution: str) -> str | None:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


def prepare_runtime() -> None:
    """Install/repair the CUDA-13 nightly Qwen3.8 VLM runtime before worker imports."""
    print("\n[1/7] Preparing Colab-safe multimodal Qwen3.8 nightly runtime...", flush=True)

    base.run([sys.executable, "-m", "pip", "install", "-U", "uv"])
    uv = shutil.which("uv")
    if uv is None:
        candidate = Path(sys.executable).parent / "uv"
        if candidate.exists():
            uv = str(candidate)
    if uv is None:
        raise RuntimeError("uv installed but its executable was not found")

    # vLLM explicitly recommends uv for nightly indices. Unlike pip, uv gives
    # the extra index priority, so a development/nightly wheel is not silently
    # replaced by a numerically newer stable PyPI release.
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
    # modules in memory. Repair the files on disk, but never import PIL in this
    # process. The verifier and vLLM server use fresh Python processes.
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

    # This fresh interpreter is the real compatibility test. Importing the
    # conditional-generation class proves that the full image-capable Qwen VLM
    # is present; qwen3_5_mtp proves the speculative implementation is present.
    verify = base.run([
        sys.executable,
        "-c",
        (
            "import PIL, torch, torchvision, transformers, vllm, flashinfer; "
            "from PIL import Image, ImageFont; "
            "from vllm.model_executor.models.qwen3_5 import Qwen3_5ForConditionalGeneration; "
            "import vllm.model_executor.models.qwen3_5_mtp; "
            "print('Torch:', torch.__version__, 'CUDA:', torch.version.cuda); "
            "print('Torchvision:', torchvision.__version__); "
            "print('Transformers:', transformers.__version__); "
            "print('vLLM nightly:', vllm.__version__); "
            "print('FlashInfer:', getattr(flashinfer, '__version__', 'installed')); "
            "print('Pillow:', PIL.__version__, 'OK'); "
            "print('CUDA available:', torch.cuda.is_available()); "
            "print('Qwen3.8 VLM + native MTP modules: OK'); "
            "print('__QWEN_VLLM_VERSION__=' + str(vllm.__version__))"
        ),
    ], capture=True)
    print(verify.stdout.strip(), flush=True)

    match = re.search(r"^__QWEN_VLLM_VERSION__=(.+)$", verify.stdout, re.MULTILINE)
    if match is None:
        raise RuntimeError("Runtime verifier did not report the installed vLLM version")
    version = match.group(1).strip()

    # Do NOT reject a capability-verified dev nightly solely because its base
    # version string is numerically below MIN_MTP_RELEASE.
    try:
        if nightly._release_tuple(version) < nightly.MIN_MTP_RELEASE:
            print(
                f"      vLLM version label {version} is below the nominal "
                f"{'.'.join(map(str, nightly.MIN_MTP_RELEASE))} gate, but the required "
                "Qwen3.8 VLM + native MTP modules imported successfully — continuing ✅",
                flush=True,
            )
    except Exception:
        print(f"      vLLM dev version: {version} (VLM capability check passed) ✅", flush=True)

    base.VLLM_VERSION = version
    fast.PROFILE_ID = PROFILE_ID
    nightly.PROFILE_ID = PROFILE_ID


def _runtime_already_prepared() -> None:
    print("\n[1/7] Multimodal nightly runtime already prepared before relay startup ✅", flush=True)


def _start_multimodal_vllm(
    model_dir: Path,
    api_key: str,
    max_model_len: int,
    model_id: str,
) -> subprocess.Popen:
    """Start Qwen3.8-27B as a full VLM while retaining the optimized text path."""
    print("\n[4/7] Starting multimodal MTP-compatible private vLLM API...", flush=True)
    base.LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_handle = (base.LOG_ROOT / "vllm.log").open("w")

    speculative_config = {
        "method": "mtp",
        "num_speculative_tokens": fast.MTP_TOKENS,
    }
    cmd = [
        "vllm",
        "serve",
        str(model_dir),
        "--served-model-name",
        base.SERVED_MODEL_NAME,
        "--host",
        "127.0.0.1",
        "--port",
        str(base.PORT),
        "--api-key",
        api_key,
        "--gpu-memory-utilization",
        fast.GPU_MEMORY_UTILIZATION,
        "--max-model-len",
        str(max_model_len),
        "--max-num-seqs",
        str(fast.MAX_NUM_SEQS),
        "--max-num-batched-tokens",
        str(fast.MAX_NUM_BATCHED_TOKENS),
        "--kv-cache-dtype",
        fast.KV_CACHE_DTYPE,
        "--enable-chunked-prefill",
        "--enable-prefix-caching",
        "--speculative-config",
        json.dumps(speculative_config, separators=(",", ":")),
        "--per-request-spec-decode-metrics",
        nightly.PER_REQUEST_SPEC_METRICS,
        "--attention-backend",
        fast.ATTENTION_BACKEND,
        "--linear-backend",
        nightly.LINEAR_BACKEND,
        "--compilation-config",
        json.dumps(fast.COMPILATION_CONFIG, separators=(",", ":")),
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "qwen3_coder",
        "--reasoning-parser",
        "qwen3",
        # IMPORTANT: do not pass --language-model-only. vLLM documents that
        # flag as disabling every multimodal input. Keep the vision tower loaded.
        "--limit-mm-per-prompt",
        json.dumps(MM_LIMITS, separators=(",", ":")),
    ]

    printable = cmd.copy()
    printable[printable.index("--api-key") + 1] = "***REDACTED***"
    print("+ " + " ".join(printable), flush=True)
    proc = subprocess.Popen(
        cmd,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    base.VLLM_PID_FILE.write_text(str(proc.pid))
    base.SERVER_STATE_FILE.write_text(json.dumps({
        "pid": proc.pid,
        "api_key": api_key,
        "model_id": model_id,
        "max_model_len": max_model_len,
        "kv_cache_dtype": fast.KV_CACHE_DTYPE,
        "optimization_profile": PROFILE_ID,
        "mtp_tokens": fast.MTP_TOKENS,
        "attention_backend": fast.ATTENTION_BACKEND,
        "linear_backend": nightly.LINEAR_BACKEND,
        "vllm_version": base.VLLM_VERSION,
        "max_num_seqs": fast.MAX_NUM_SEQS,
        "max_num_batched_tokens": fast.MAX_NUM_BATCHED_TOKENS,
        "gpu_memory_utilization": fast.GPU_MEMORY_UTILIZATION,
        "compilation_config": fast.COMPILATION_CONFIG,
        "multimodal_enabled": True,
        "mm_limits": MM_LIMITS,
    }))
    return proc


def _make_test_image_data_url() -> str:
    """Create a tiny deterministic PNG without touching disk or the network."""
    from PIL import Image

    image = Image.new("RGB", (64, 64), (230, 30, 30))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return "data:image/png;base64," + encoded


def _verify_multimodal_server(api_key: str) -> None:
    """Fail startup unless the live vLLM endpoint really accepts image_url input."""
    import requests

    payload = {
        "model": base.SERVED_MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What is the dominant color in this image? Answer briefly."},
                    {"type": "image_url", "image_url": {"url": _make_test_image_data_url()}},
                ],
            }
        ],
        "temperature": 0.0,
        "max_tokens": 16,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    response = requests.post(
        f"http://127.0.0.1:{base.PORT}/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=payload,
        timeout=(30, 300),
    )
    if not response.ok:
        raise RuntimeError(
            "Qwen multimodal startup check failed: "
            f"vLLM HTTP {response.status_code}: {response.text[:2000]}"
        )
    body = response.json()
    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError(f"Qwen multimodal startup check returned no choices: {body}")
    message = choices[0].get("message") or {}
    visible = message.get("content") or message.get("reasoning_content")
    if not visible:
        raise RuntimeError(f"Qwen multimodal startup check returned no model output: {body}")
    preview = " ".join(str(visible).split())[:120]
    print(f"      Image input smoke test: OK ✅ | {preview}", flush=True)


def apply_overrides() -> None:
    """Apply nightly inference settings and replace text-only serve with full VLM serve."""
    nightly._install_overrides()
    nightly.PROFILE_ID = PROFILE_ID
    fast.PROFILE_ID = PROFILE_ID
    fast.install_dependencies = _runtime_already_prepared
    fast.start_vllm = _start_multimodal_vllm

    # fast.main() calls this after the local server is ready but BEFORE creating
    # the relay worker. Making the image smoke test part of this hook means a
    # broken multimodal runtime aborts startup rather than falsely reporting READY.
    nightly_summary = fast._runtime_summary_from_log

    def _summary_and_vision_check() -> None:
        nightly_summary()
        state = fast._state()
        if state is None or not state.get("multimodal_enabled"):
            raise RuntimeError("Multimodal vLLM server state is missing")
        _verify_multimodal_server(str(state["api_key"]))
        print(f"      multimodal input   : images enabled (up to {MM_LIMITS['image']} per request) ✅")
        print("      video input        : disabled")

    fast._runtime_summary_from_log = _summary_and_vision_check


def main() -> None:
    # Install first. Only after the environment is stable do we let fast.main()
    # import/use Supabase, requests and the rest of the relay stack.
    prepare_runtime()
    apply_overrides()
    fast.main()


# Convenience export used by the notebook.
benchmark_running_server = nightly.benchmark_running_server


if __name__ == "__main__":
    main()
