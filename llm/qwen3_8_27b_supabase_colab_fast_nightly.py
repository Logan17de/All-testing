#!/usr/bin/env python3
"""MTP-compatible A100 speed profile for the existing Qwen relay worker.

This layer keeps the current Supabase / Oracle / Harness architecture untouched.
It upgrades only the local vLLM runtime used by the optimized FP8 worker and
adds MTP acceptance metrics to the localhost benchmark.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import qwen3_8_27b_supabase_colab_fast as fast

base = fast.base

PROFILE_ID = "a100-fp8-mtp3-single-user-nightly-v2"
VLLM_NIGHTLY_INDEX = os.environ.get(
    "QWEN_VLLM_NIGHTLY_INDEX",
    "https://wheels.vllm.ai/nightly/cu130",
)
MIN_MTP_RELEASE = (0, 27, 2)
LINEAR_BACKEND = "marlin"
PER_REQUEST_SPEC_METRICS = "summary"


def _release_tuple(version: str) -> tuple[int, int, int]:
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
    if match is None:
        raise RuntimeError(f"Could not parse vLLM version: {version}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def install_dependencies() -> None:
    """Install a CUDA-13 vLLM nightly new enough for Qwen3.8 GDN + MTP."""
    print("\n[1/7] Preparing MTP-compatible Qwen3.8 runtime...", flush=True)

    # vLLM documents uv for nightly wheels because pip's index resolution can
    # silently prefer the released PyPI build instead of the development wheel.
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
        VLLM_NIGHTLY_INDEX,
    ])

    print("\n      Removing optional Torch packages that can conflict with Colab CUDA...", flush=True)
    base.run(
        [sys.executable, "-m", "pip", "uninstall", "-y", "torchaudio", "torchtext"],
        check=False,
    )

    # Keep the text/VLM import surface consistent with the existing notebook.
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

    import torch
    import torchvision
    import transformers
    import vllm
    import flashinfer

    version = str(vllm.__version__)
    if _release_tuple(version) < MIN_MTP_RELEASE:
        raise RuntimeError(
            "Qwen3.8 native MTP requires the gated-DeltaNet speculative fix in "
            f"vLLM 0.27.2+ nightly; installed {version}."
        )

    # The original optimized module uses this value for server-state reuse.
    base.VLLM_VERSION = version
    fast.PROFILE_ID = PROFILE_ID

    print(f"      Torch: {torch.__version__} | CUDA: {torch.version.cuda}")
    print(f"      Torchvision: {torchvision.__version__}")
    print(f"      Transformers: {transformers.__version__}")
    print(f"      vLLM nightly: {version} ✅")
    print(f"      FlashInfer: {getattr(flashinfer, '__version__', 'installed')}")
    print(f"      CUDA available: {torch.cuda.is_available()}")

    # Fail before model loading if the nightly wheel does not contain the
    # Qwen3.5/3.8 MTP implementation expected by this profile.
    __import__("vllm.model_executor.models.qwen3_5")
    __import__("vllm.model_executor.models.qwen3_5_mtp")
    print("      Qwen3.8 + native MTP modules: OK ✅", flush=True)


def try_reuse_server(model_id: str, max_model_len: int) -> tuple[int, str] | None:
    state = fast._state()
    if state is None:
        return None
    try:
        pid = int(state["pid"])
        api_key = str(state["api_key"])
        checks = (
            state.get("optimization_profile") == PROFILE_ID,
            state.get("model_id") == model_id,
            int(state.get("max_model_len", 0)) == max_model_len,
            state.get("kv_cache_dtype") == fast.KV_CACHE_DTYPE,
            int(state.get("mtp_tokens", 0)) == fast.MTP_TOKENS,
            state.get("attention_backend") == fast.ATTENTION_BACKEND,
            state.get("linear_backend") == LINEAR_BACKEND,
            state.get("vllm_version") == base.VLLM_VERSION,
        )
        if not all(checks):
            return None
        if not base._pid_alive(pid) or not base._port_open() or not base._local_models(api_key):
            return None
        print(
            f"\n[4/7] Reusing MTP-compatible optimized vLLM server ✅ | "
            f"PID {pid} | {base.gpu_memory_status()}",
            flush=True,
        )
        return pid, api_key
    except Exception:
        return None


def start_vllm(
    model_dir: Path,
    api_key: str,
    max_model_len: int,
    model_id: str,
) -> subprocess.Popen:
    """Start FP8 W8A16/Marlin + FP8-KV + MTP3 for a single A100 user."""
    print("\n[4/7] Starting MTP-compatible optimized private vLLM API...", flush=True)
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
        PER_REQUEST_SPEC_METRICS,
        "--attention-backend",
        fast.ATTENTION_BACKEND,
        # Ampere does not have native Hopper-style FP8 tensor-core W8A8. vLLM
        # serves FP8 weights as W8A16 on SM80, where Marlin is the intended path.
        "--linear-backend",
        LINEAR_BACKEND,
        "--compilation-config",
        json.dumps(fast.COMPILATION_CONFIG, separators=(",", ":")),
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "qwen3_coder",
        "--reasoning-parser",
        "qwen3",
        "--language-model-only",
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
        "linear_backend": LINEAR_BACKEND,
        "vllm_version": base.VLLM_VERSION,
        "max_num_seqs": fast.MAX_NUM_SEQS,
        "max_num_batched_tokens": fast.MAX_NUM_BATCHED_TOKENS,
        "gpu_memory_utilization": fast.GPU_MEMORY_UTILIZATION,
        "compilation_config": fast.COMPILATION_CONFIG,
    }))
    return proc


def _consume_stream(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Measure localhost TTFT/decode and capture per-request MTP acceptance."""
    import requests

    url = f"http://127.0.0.1:{base.PORT}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}"}
    started = time.perf_counter()
    first_output_at: float | None = None
    completion_tokens = 0
    spec: dict[str, Any] | None = None

    with requests.post(
        url,
        headers=headers,
        json=payload,
        stream=True,
        timeout=(30, 1800),
    ) as response:
        response.raise_for_status()
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            line = raw_line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                continue

            usage = event.get("usage")
            if isinstance(usage, dict) and usage.get("completion_tokens") is not None:
                completion_tokens = int(usage["completion_tokens"])

            metrics = event.get("metrics")
            if isinstance(metrics, dict):
                maybe_spec = metrics.get("speculative_decoding")
                if isinstance(maybe_spec, dict):
                    spec = maybe_spec

            choices = event.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            visible = (
                delta.get("content")
                or delta.get("reasoning_content")
                or delta.get("tool_calls")
            )
            if visible and first_output_at is None:
                first_output_at = time.perf_counter()

    ended = time.perf_counter()
    if first_output_at is None:
        raise RuntimeError("Benchmark received no streamed model output")
    if completion_tokens <= 0:
        raise RuntimeError("Benchmark stream did not include completion token usage")

    ttft = first_output_at - started
    total = ended - started
    decode = max(ended - first_output_at, 1e-9)
    decode_tokens = max(completion_tokens - 1, 1)
    result: dict[str, Any] = {
        "ttft_s": ttft,
        "total_latency_s": total,
        "completion_tokens": completion_tokens,
        "output_tok_s": decode_tokens / decode,
        "end_to_end_tok_s": completion_tokens / total,
    }
    if spec is not None:
        for key in (
            "mean_acceptance_length",
            "draft_acceptance_rate",
            "num_spec_steps",
            "num_accepted_draft_tokens",
            "num_draft_tokens",
            "num_spec_tokens",
        ):
            if key in spec:
                result[f"mtp_{key}"] = spec[key]
    return result


_original_benchmark = fast.benchmark_running_server


def benchmark_running_server(label: str = "manual") -> dict[str, Any] | None:
    result = _original_benchmark(label)
    if result is None:
        return None
    acceptance = result.get("mtp_draft_acceptance_rate")
    mean_len = result.get("mtp_mean_acceptance_length")
    if acceptance is not None:
        print(
            f"      MTP acceptance: {float(acceptance) * 100.0:.1f}% | "
            f"mean accepted length: {float(mean_len):.2f}" if mean_len is not None
            else f"      MTP acceptance: {float(acceptance) * 100.0:.1f}%",
            flush=True,
        )
    return result


def _runtime_summary_from_log() -> None:
    fast._runtime_summary_from_log()
    print(f"      vLLM runtime       : {base.VLLM_VERSION} (nightly, MTP-compatible)")
    print(f"      FP8 linear backend : {LINEAR_BACKEND} (A100 W8A16)")
    print(f"      spec metrics       : {PER_REQUEST_SPEC_METRICS}")


def _install_overrides() -> None:
    fast.PROFILE_ID = PROFILE_ID
    fast.install_dependencies = install_dependencies
    fast.try_reuse_server = try_reuse_server
    fast.start_vllm = start_vllm
    fast._consume_stream = _consume_stream
    fast.benchmark_running_server = benchmark_running_server
    fast._runtime_summary_from_log = _runtime_summary_from_log


def main() -> None:
    _install_overrides()
    fast.main()


if __name__ == "__main__":
    main()
