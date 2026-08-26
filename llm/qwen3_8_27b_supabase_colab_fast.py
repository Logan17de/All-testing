#!/usr/bin/env python3
"""A100-80GB single-user speed profile for the existing Qwen Supabase worker.

This module intentionally reuses the existing relay, heartbeat, Oracle lease,
job processing, and Harness-facing model name from qwen3_8_27b_supabase_colab.
Only the local vLLM/model profile and local benchmark are specialized here.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import qwen3_8_27b_supabase_colab as base

PROFILE_ID = "a100-fp8-mtp3-single-user-v1"
MODEL_ID = base.FP8_MODEL
MAX_MODEL_LEN = base.NATIVE_CONTEXT
KV_CACHE_DTYPE = "fp8"
MTP_TOKENS = 3
ATTENTION_BACKEND = "FLASHINFER"
MAX_NUM_SEQS = 1
MAX_NUM_BATCHED_TOKENS = 16_384
GPU_MEMORY_UTILIZATION = os.environ.get("QWEN_GPU_MEMORY_UTILIZATION", "0.93")
COMPILATION_CONFIG = {"cudagraph_mode": "FULL_AND_PIECEWISE"}
BENCHMARK_FILE = Path("/content/qwen_benchmark_results.json")
BENCHMARK_MAX_TOKENS = 256


def install_dependencies() -> None:
    """Install the stable vLLM build plus its FlashInfer extra."""
    print("\n[1/7] Preparing optimized Qwen3.8 runtime...", flush=True)
    base.run([
        sys.executable,
        "-m",
        "pip",
        "install",
        "-U",
        f"vllm[flashinfer]=={base.VLLM_VERSION}",
        f"transformers=={base.TRANSFORMERS_VERSION}",
        "huggingface_hub[hf_xet]",
        "requests",
        "supabase",
    ])

    print("\n      Removing optional Torch packages that can conflict with Colab CUDA...", flush=True)
    base.run(
        [sys.executable, "-m", "pip", "uninstall", "-y", "torchaudio", "torchtext"],
        check=False,
    )

    print("\n      Installing matching Torchvision CUDA 13.0 wheel...", flush=True)
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

    verify = base.run([
        sys.executable,
        "-c",
        (
            "import torch, torchvision, transformers, vllm, supabase, flashinfer; "
            "print('Torch:', torch.__version__, 'CUDA:', torch.version.cuda); "
            "print('Torchvision:', torchvision.__version__); "
            "print('Transformers:', transformers.__version__); "
            "print('vLLM:', vllm.__version__); "
            "print('FlashInfer:', getattr(flashinfer, '__version__', 'installed')); "
            "print('CUDA available:', torch.cuda.is_available()); "
            "import vllm.model_executor.models.qwen3_5; "
            "import vllm.model_executor.models.qwen3_5_mtp; "
            "print('Qwen3.8 + native MTP modules: OK')"
        ),
    ], capture=True)
    print(verify.stdout.strip(), flush=True)


def choose_model(vram_mib: int) -> tuple[str, int]:
    """This profile is deliberately A100-80GB-only."""
    if vram_mib < 70_000:
        raise RuntimeError(
            f"This speed profile requires an ~80 GB GPU; detected {vram_mib / 1024:.1f} GiB."
        )
    return MODEL_ID, MAX_MODEL_LEN


def _state() -> dict[str, Any] | None:
    if not base.SERVER_STATE_FILE.exists():
        return None
    try:
        value = json.loads(base.SERVER_STATE_FILE.read_text())
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def try_reuse_server(model_id: str, max_model_len: int) -> tuple[int, str] | None:
    state = _state()
    if state is None:
        return None
    try:
        pid = int(state["pid"])
        api_key = str(state["api_key"])
        checks = (
            state.get("optimization_profile") == PROFILE_ID,
            state.get("model_id") == model_id,
            int(state.get("max_model_len", 0)) == max_model_len,
            state.get("kv_cache_dtype") == KV_CACHE_DTYPE,
            int(state.get("mtp_tokens", 0)) == MTP_TOKENS,
            state.get("attention_backend") == ATTENTION_BACKEND,
            state.get("vllm_version") == base.VLLM_VERSION,
        )
        if not all(checks):
            return None
        if not base._pid_alive(pid) or not base._port_open() or not base._local_models(api_key):
            return None
        print(
            f"\n[4/7] Reusing optimized vLLM server ✅ | PID {pid} | {base.gpu_memory_status()}",
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
    """Start the low-concurrency A100 FP8 + FP8-KV + MTP3 vLLM profile."""
    print("\n[4/7] Starting optimized private local vLLM API...", flush=True)
    base.LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_handle = (base.LOG_ROOT / "vllm.log").open("w")

    speculative_config = {
        "method": "mtp",
        "num_speculative_tokens": MTP_TOKENS,
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
        GPU_MEMORY_UTILIZATION,
        "--max-model-len",
        str(max_model_len),
        "--max-num-seqs",
        str(MAX_NUM_SEQS),
        "--max-num-batched-tokens",
        str(MAX_NUM_BATCHED_TOKENS),
        "--kv-cache-dtype",
        KV_CACHE_DTYPE,
        "--enable-chunked-prefill",
        "--enable-prefix-caching",
        "--speculative-config",
        json.dumps(speculative_config, separators=(",", ":")),
        "--attention-backend",
        ATTENTION_BACKEND,
        "--compilation-config",
        json.dumps(COMPILATION_CONFIG, separators=(",", ":")),
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
        "kv_cache_dtype": KV_CACHE_DTYPE,
        "optimization_profile": PROFILE_ID,
        "mtp_tokens": MTP_TOKENS,
        "attention_backend": ATTENTION_BACKEND,
        "vllm_version": base.VLLM_VERSION,
        "max_num_seqs": MAX_NUM_SEQS,
        "max_num_batched_tokens": MAX_NUM_BATCHED_TOKENS,
        "gpu_memory_utilization": GPU_MEMORY_UTILIZATION,
        "compilation_config": COMPILATION_CONFIG,
    }))
    return proc


def _benchmark_payload(max_tokens: int) -> dict[str, Any]:
    prefix = (
        "This is a deterministic local inference benchmark for a coding model. "
        "Discuss compiler optimization, memory locality, API latency, and GPU inference. "
    )
    prompt = (prefix * 96) + (
        "\nWrite a continuous technical explanation. Keep going until the output token limit. "
        "Do not use tools and do not stop early."
    )
    return {
        "model": base.SERVED_MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    }


def _consume_stream(api_key: str, payload: dict[str, Any]) -> dict[str, float | int]:
    import requests

    url = f"http://127.0.0.1:{base.PORT}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}"}
    started = time.perf_counter()
    first_output_at: float | None = None
    completion_tokens = 0

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
    return {
        "ttft_s": ttft,
        "total_latency_s": total,
        "completion_tokens": completion_tokens,
        "output_tok_s": decode_tokens / decode,
        "end_to_end_tok_s": completion_tokens / total,
    }


def _read_benchmark_results() -> dict[str, Any]:
    if not BENCHMARK_FILE.exists():
        return {}
    try:
        value = json.loads(BENCHMARK_FILE.read_text())
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _write_benchmark_result(label: str, result: dict[str, Any]) -> None:
    all_results = _read_benchmark_results()
    all_results[label] = result
    BENCHMARK_FILE.write_text(json.dumps(all_results, indent=2, sort_keys=True))


def _print_comparison() -> None:
    results = _read_benchmark_results()
    before = results.get("before")
    after = results.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return

    before_tps = float(before["output_tok_s"])
    after_tps = float(after["output_tok_s"])
    before_ttft = float(before["ttft_s"])
    after_ttft = float(after["ttft_s"])
    speedup = after_tps / before_tps if before_tps > 0 else 0.0
    ttft_change = ((after_ttft / before_ttft) - 1.0) * 100.0 if before_ttft > 0 else 0.0

    print("\n      ===== LOCAL vLLM BEFORE / AFTER =====")
    print(f"      BEFORE TTFT       : {before_ttft:.3f} s")
    print(f"      AFTER  TTFT       : {after_ttft:.3f} s ({ttft_change:+.1f}%)")
    print(f"      BEFORE output     : {before_tps:.2f} tok/s")
    print(f"      AFTER  output     : {after_tps:.2f} tok/s")
    print(f"      Decode speedup    : {speedup:.2f}x")
    print("      =====================================\n")


def benchmark_running_server(label: str = "manual") -> dict[str, Any] | None:
    """Benchmark the current localhost vLLM server without touching the relay."""
    state = _state()
    if state is None:
        print("No existing local vLLM server state found; benchmark skipped.")
        return None
    try:
        pid = int(state["pid"])
        api_key = str(state["api_key"])
    except Exception:
        print("Existing server state is incomplete; benchmark skipped.")
        return None
    if not base._pid_alive(pid) or not base._port_open() or not base._local_models(api_key):
        print("No healthy local vLLM server is running; benchmark skipped.")
        return None

    print(f"\n      Benchmark [{label}] warm-up...", flush=True)
    warmup = _benchmark_payload(32)
    _consume_stream(api_key, warmup)

    print(f"      Benchmark [{label}] measuring TTFT + decode speed...", flush=True)
    measured = _consume_stream(api_key, _benchmark_payload(BENCHMARK_MAX_TOKENS))
    result: dict[str, Any] = {
        **measured,
        "label": label,
        "model_id": state.get("model_id", "unknown"),
        "optimization_profile": state.get("optimization_profile", "legacy"),
        "vllm_version": state.get("vllm_version", "unknown"),
        "kv_cache_dtype": state.get("kv_cache_dtype", "unknown"),
    }
    _write_benchmark_result(label, result)
    print(
        f"      {label}: TTFT {float(result['ttft_s']):.3f}s | "
        f"output {float(result['output_tok_s']):.2f} tok/s | "
        f"{int(result['completion_tokens'])} output tokens",
        flush=True,
    )
    _print_comparison()
    return result


def capture_legacy_before_if_available() -> None:
    """Capture the old BF16/legacy server before it is replaced, when possible."""
    state = _state()
    if state is None or state.get("optimization_profile") == PROFILE_ID:
        return
    if "before" in _read_benchmark_results():
        print("\n      Existing BEFORE benchmark found; keeping it.", flush=True)
        return
    print("\n      Legacy local vLLM server detected — capturing BEFORE benchmark first.", flush=True)
    try:
        benchmark_running_server("before")
    except Exception as exc:
        print(f"      BEFORE benchmark skipped: {exc}", flush=True)


def _runtime_summary_from_log() -> None:
    log_path = base.LOG_ROOT / "vllm.log"
    if not log_path.exists():
        return
    text = log_path.read_text(errors="ignore")
    cache_match = re.search(r"GPU KV cache size:\s*([\d,]+)\s*tokens", text)
    concurrency_match = re.search(
        r"Maximum concurrency for\s*262,?144\s*tokens per request:\s*([\d.]+)x",
        text,
    )
    backend_lines = [
        line.strip()
        for line in text.splitlines()
        if "attention backend" in line.lower() and "Using" in line
    ]

    print("\n      Optimized runtime summary:")
    print(f"      weights            : official FP8 ({MODEL_ID})")
    print(f"      max context        : {MAX_MODEL_LEN:,}")
    print(f"      KV cache           : {KV_CACHE_DTYPE}")
    print(f"      MTP draft tokens   : {MTP_TOKENS}")
    print(f"      attention backend  : {ATTENTION_BACKEND}")
    print(f"      CUDA graph mode    : {COMPILATION_CONFIG['cudagraph_mode']}")
    print(f"      max active seqs    : {MAX_NUM_SEQS}")
    print(f"      prefill token cap  : {MAX_NUM_BATCHED_TOKENS:,}")
    print(f"      GPU memory target  : {GPU_MEMORY_UTILIZATION}")
    if cache_match:
        cache_tokens = int(cache_match.group(1).replace(",", ""))
        print(f"      GPU KV capacity    : {cache_tokens:,} tokens")
        if cache_tokens < MAX_MODEL_LEN:
            raise RuntimeError(
                f"vLLM reported only {cache_tokens:,} KV tokens, below the required {MAX_MODEL_LEN:,}."
            )
    if concurrency_match:
        print(f"      262K concurrency   : {concurrency_match.group(1)}x")
    if backend_lines:
        print(f"      backend log        : {backend_lines[-1][-180:]}")
    print(f"      current VRAM       : {base.gpu_memory_status()}")


def main() -> None:
    # Keep the existing Supabase/Oracle/Harness architecture exactly as-is.
    base.load_relay_env()
    from qwen_supabase_relay import RelayStore, request_oracle_wake_if_needed

    relay = RelayStore.from_env()
    relay.preflight()
    print("      Growing-Trader relay RPC/auth: OK ✅")

    worker_id = f"colab-{__import__('uuid').uuid4().hex[:10]}"
    startup_lease = base.StartupLease(relay, worker_id)
    handoff_to_worker = False
    startup_lease.start()
    request_oracle_wake_if_needed(wait_seconds=0)

    try:
        # If an older BF16 server is still alive in this Colab runtime, measure
        # it before replacing it. This gives a real apples-to-apples baseline.
        capture_legacy_before_if_available()

        install_dependencies()

        print("\n[2/7] Verifying A100 80GB...", flush=True)
        gpu_name, vram_mib = base.gpu_info()
        model_id, max_model_len = choose_model(vram_mib)
        print(f"      GPU: {gpu_name} ({vram_mib / 1024:.1f} GiB)")
        print(f"      Model: {model_id}")
        print(f"      Context: {max_model_len:,}")
        print(f"      KV cache: {KV_CACHE_DTYPE}")
        print(f"      Native MTP: {MTP_TOKENS} speculative tokens")
        print(f"      Attention: {ATTENTION_BACKEND} (FP8-KV-compatible on A100)")

        model_dir = base.download_model(model_id)

        reused = try_reuse_server(model_id, max_model_len)
        if reused:
            _, api_key = reused
        else:
            base.cleanup_old_server()
            api_key = "sk-colab-" + secrets.token_urlsafe(32)
            proc = start_vllm(model_dir, api_key, max_model_len, model_id)
            base.wait_for_server(api_key, proc)

        _runtime_summary_from_log()

        # Measure the optimized server locally before exposing the worker as
        # ready. This does not traverse Supabase or Oracle.
        try:
            benchmark_running_server("after")
        except Exception as exc:
            print(f"      AFTER benchmark warning: {exc}", flush=True)

        worker = base.QwenRelayWorker(
            relay,
            api_key,
            max_model_len,
            worker_id=worker_id,
        )

        startup_lease.stop(mark_offline=False)
        worker.heartbeat("online", f"{base.gpu_memory_status()} | optimized FP8 MTP3 ready")
        handoff_to_worker = True
        worker.run_forever()
    finally:
        if not handoff_to_worker:
            startup_lease.stop(mark_offline=True)


if __name__ == "__main__":
    main()
