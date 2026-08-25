#!/usr/bin/env python3
"""Colab launcher for Qwen3.8-27B as an OpenAI-compatible API for DeepSeek Harness.

Design goals:
- All implementation stays in GitHub; Colab only imports and calls main().
- Use Qwen3.8-27B BF16 on an A100 80 GB with the full native 262,144 context.
- Use the official ngrok Python SDK for a durable HTTPS endpoint.
- Never print API IS READY until public /v1/models and streamed chat both pass.
- Reuse an already-running matching vLLM server on notebook reruns.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BF16_MODEL = "Qwen/Qwen3.8-27B"
FP8_MODEL = "Qwen/Qwen3.8-27B-FP8"
SERVED_MODEL_NAME = "qwen3.8-27b"
NATIVE_CONTEXT = 262_144

VLLM_VERSION = "0.27.1"
TRANSFORMERS_VERSION = "5.15.0"
TORCHVISION_VERSION = "0.28.0"
PYTORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu130"

GPU_MEMORY_UTILIZATION = "0.95"
KV_CACHE_DTYPE = "fp8"

MODEL_ROOT = Path("/content/models")
LOG_ROOT = Path("/content/qwen_api_logs")
API_ENV_FILE = Path("/content/qwen_api.env")
SERVER_STATE_FILE = Path("/content/qwen_server_state.json")
VLLM_PID_FILE = Path("/content/qwen_vllm.pid")
PORT = 8000


def run(cmd: list[str], *, check: bool = True, capture: bool = False, echo: bool = True):
    if echo:
        print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def colab_secret(name: str) -> str | None:
    value = os.environ.get(name)
    if value and value.strip():
        return value.strip()
    try:
        from google.colab import userdata  # type: ignore
        value = userdata.get(name)
        if value and value.strip():
            return value.strip()
    except Exception:
        pass
    return None


def require_ngrok_token() -> str:
    """Fail before any expensive work if ngrok credentials are missing."""
    print("[0/7] Checking public-tunnel credentials...", flush=True)
    token = colab_secret("NGROK_AUTHTOKEN")
    if token:
        print("      NGROK_AUTHTOKEN: found ✅", flush=True)
        return token
    raise RuntimeError(
        "NGROK_AUTHTOKEN is not available. Add it in Colab -> Secrets (key icon), "
        "name it NGROK_AUTHTOKEN, enable Notebook access, then rerun. "
        "The launcher checks this before loading Qwen so GPU time is not wasted."
    )


def install_dependencies() -> None:
    print("\n[1/7] Preparing Qwen3.8 + ngrok runtime...", flush=True)
    print(f"      Python: {sys.version.split()[0]}")
    print(f"      vLLM: {VLLM_VERSION}")
    print(f"      Transformers: {TRANSFORMERS_VERSION}")
    print(f"      Torchvision: {TORCHVISION_VERSION}")
    print("      Tunnel: official ngrok Python SDK")

    run([
        sys.executable, "-m", "pip", "install", "-U",
        f"vllm=={VLLM_VERSION}",
        f"transformers=={TRANSFORMERS_VERSION}",
        "huggingface_hub[hf_xet]",
        "requests",
        "ngrok",
        "nest_asyncio",
    ])

    # Colab can ship optional Torch wheels compiled for a different CUDA version.
    run([
        sys.executable, "-m", "pip", "uninstall", "-y", "torchaudio", "torchtext"
    ], check=False)

    # vLLM's Qwen3.8 architecture inspection imports Qwen3-VL code, so a
    # Torch-matched torchvision wheel is required even for language-only serving.
    run([
        sys.executable, "-m", "pip", "install", "-U", "--force-reinstall", "--no-deps",
        f"torchvision=={TORCHVISION_VERSION}", "--index-url", PYTORCH_CUDA_INDEX,
    ])

    print("\n      Verifying runtime...", flush=True)
    verify = run([
        sys.executable, "-c",
        (
            "import torch, torchvision, transformers, vllm, ngrok; "
            "print('Torch:', torch.__version__); "
            "print('Torch CUDA:', torch.version.cuda); "
            "print('Torchvision:', torchvision.__version__); "
            "print('Transformers:', transformers.__version__); "
            "print('vLLM:', vllm.__version__); "
            "print('CUDA available:', torch.cuda.is_available()); "
            "import vllm.model_executor.models.qwen3_5; "
            "print('Qwen3.8 vLLM module: OK'); "
            "print('ngrok SDK: OK')"
        ),
    ], capture=True)
    print(verify.stdout.strip(), flush=True)


def gpu_info() -> tuple[str, int]:
    if shutil.which("nvidia-smi") is None:
        raise RuntimeError("No NVIDIA GPU detected. Choose a GPU runtime in Colab.")
    result = run([
        "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"
    ], capture=True)
    first = result.stdout.strip().splitlines()[0]
    name, mem_mib = [part.strip() for part in first.rsplit(",", 1)]
    return name, int(mem_mib)


def choose_model(vram_mib: int) -> tuple[str, int]:
    if vram_mib >= 70_000:
        return BF16_MODEL, NATIVE_CONTEXT
    if vram_mib >= 38_000:
        return FP8_MODEL, 16_384
    raise RuntimeError(
        f"Detected only {vram_mib / 1024:.1f} GiB VRAM. "
        "Use >=40 GB for the FP8 checkpoint or >=80 GB for BF16."
    )


def download_model(model_id: str) -> Path:
    print(f"\n[3/7] Preparing {model_id}...", flush=True)
    from huggingface_hub import snapshot_download

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    local_dir = MODEL_ROOT / model_id.split("/")[-1]
    if local_dir.exists():
        print(f"      Existing model directory: {local_dir}")
        print("      Reusing cached shards; only missing files will download.")
    snapshot_download(repo_id=model_id, local_dir=str(local_dir))
    print(f"      Model ready: {local_dir}", flush=True)
    return local_dir


def gpu_memory_status() -> str:
    try:
        result = subprocess.run([
            "nvidia-smi", "--query-gpu=memory.used,memory.total",
            "--format=csv,noheader,nounits"
        ], text=True, capture_output=True, timeout=3)
        used, total = [int(x.strip()) for x in result.stdout.splitlines()[0].split(",")]
        return f"VRAM {used / 1024:.1f}/{total / 1024:.1f} GiB"
    except Exception:
        return "VRAM ?"


def _tail(path: Path, lines: int = 120) -> str:
    if not path.exists():
        return "(log file not created)"
    return "\n".join(path.read_text(errors="ignore").splitlines()[-lines:])


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _kill_process_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(2)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def cleanup_stale_vllm() -> None:
    """Release port 8000 if an old/untracked server is still there."""
    if VLLM_PID_FILE.exists():
        try:
            pid = int(VLLM_PID_FILE.read_text().strip())
            if _pid_alive(pid):
                _kill_process_group(pid)
        except Exception:
            pass
        VLLM_PID_FILE.unlink(missing_ok=True)

    if _port_open(PORT):
        print(f"      Releasing stale process on port {PORT}...", flush=True)
        if shutil.which("fuser"):
            subprocess.run(
                ["fuser", "-k", "-KILL", f"{PORT}/tcp"],
                check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.run(
                ["pkill", "-KILL", "-f", f"vllm serve .*--port {PORT}"],
                check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        time.sleep(3)

    if _port_open(PORT):
        raise RuntimeError(f"Port {PORT} is still occupied after cleanup.")

    SERVER_STATE_FILE.unlink(missing_ok=True)


def _write_server_state(pid: int, api_key: str, model_id: str, max_model_len: int) -> None:
    SERVER_STATE_FILE.write_text(json.dumps({
        "pid": pid,
        "api_key": api_key,
        "model_id": model_id,
        "max_model_len": max_model_len,
        "kv_cache_dtype": KV_CACHE_DTYPE,
    }))


def try_reuse_server(model_id: str, max_model_len: int) -> tuple[int, str] | None:
    """Reuse a healthy matching vLLM server after tunnel/code reruns."""
    if not SERVER_STATE_FILE.exists():
        return None
    try:
        import requests
        state = json.loads(SERVER_STATE_FILE.read_text())
        pid = int(state["pid"])
        api_key = str(state["api_key"])
        if state.get("model_id") != model_id:
            return None
        if int(state.get("max_model_len", 0)) != max_model_len:
            return None
        if state.get("kv_cache_dtype") != KV_CACHE_DTYPE:
            return None
        if not _pid_alive(pid) or not _port_open(PORT):
            return None

        response = requests.get(
            f"http://127.0.0.1:{PORT}/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=5,
        )
        if not response.ok:
            return None
        ids = [item.get("id") for item in response.json().get("data", [])]
        if SERVED_MODEL_NAME not in ids:
            return None

        VLLM_PID_FILE.write_text(str(pid))
        print(f"\n[4/7] Reusing existing vLLM server ✅ | PID {pid} | {gpu_memory_status()}")
        return pid, api_key
    except Exception:
        return None


def start_vllm(model_dir: Path, api_key: str, max_model_len: int) -> subprocess.Popen:
    print("\n[4/7] Starting vLLM OpenAI-compatible API...", flush=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = LOG_ROOT / "vllm.log"
    log_handle = log_path.open("w")

    cmd = [
        "vllm", "serve", str(model_dir),
        "--served-model-name", SERVED_MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--api-key", api_key,
        "--gpu-memory-utilization", GPU_MEMORY_UTILIZATION,
        "--max-model-len", str(max_model_len),
        "--kv-cache-dtype", KV_CACHE_DTYPE,
        "--enable-prefix-caching",
        "--enable-auto-tool-choice",
        "--tool-call-parser", "qwen3_coder",
        "--reasoning-parser", "qwen3",
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
    VLLM_PID_FILE.write_text(str(proc.pid))
    return proc


def wait_for_server(api_key: str, proc: subprocess.Popen, timeout_s: int = 1200) -> None:
    print("\n[5/7] Waiting for the local vLLM API...", flush=True)
    import requests

    started = time.time()
    deadline = started + timeout_s
    log_path = LOG_ROOT / "vllm.log"
    last_error = "not checked yet"

    while time.time() < deadline:
        if proc.poll() is not None:
            VLLM_PID_FILE.unlink(missing_ok=True)
            raise RuntimeError(
                f"vLLM exited early with code {proc.returncode}.\n\n{_tail(log_path)}"
            )
        try:
            response = requests.get(
                f"http://127.0.0.1:{PORT}/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=4,
            )
            if response.ok:
                elapsed = int(time.time() - started)
                print(f"      Local /v1/models: OK ✅ | {elapsed}s | {gpu_memory_status()}")
                return
            last_error = f"HTTP {response.status_code}: {response.text[:200]}"
        except Exception as exc:
            last_error = str(exc)

        elapsed = int(time.time() - started)
        print(
            f"\r      Loading Qwen... {elapsed:4d}s | {gpu_memory_status()}",
            end="", flush=True,
        )
        time.sleep(3)

    print()
    raise RuntimeError(
        f"vLLM did not become ready within {timeout_s}s. Last API error: {last_error}\n\n{_tail(log_path)}"
    )


def _resolve_maybe_awaitable(value: Any) -> Any:
    """ngrok SDK may return an awaitable inside Jupyter's running event loop."""
    if not inspect.isawaitable(value):
        return value
    import nest_asyncio
    nest_asyncio.apply()
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(value)


def start_ngrok_tunnel(token: str):
    """Start an official ngrok HTTP endpoint to the local vLLM server."""
    print("\n[6/7] Creating ngrok HTTPS endpoint...", flush=True)
    import ngrok

    # Close listeners left by earlier executions in this notebook process.
    try:
        _resolve_maybe_awaitable(ngrok.disconnect())
    except Exception:
        try:
            _resolve_maybe_awaitable(ngrok.kill())
        except Exception:
            pass

    listener = _resolve_maybe_awaitable(
        ngrok.forward(f"127.0.0.1:{PORT}", authtoken=token)
    )
    public_base = str(listener.url()).rstrip("/")
    if not public_base.startswith("https://"):
        raise RuntimeError(f"ngrok returned a non-HTTPS endpoint: {public_base}")
    print(f"      Public endpoint: {public_base}")
    return listener, public_base


def _response_diag(response) -> str:
    content_type = response.headers.get("content-type", "")
    body = response.text[:500].replace("\n", " ").replace("\r", " ")
    return (
        f"HTTP {response.status_code}; final_url={response.url}; "
        f"content-type={content_type!r}; body={body!r}"
    )


def verify_public_api(api_url: str, api_key: str) -> str:
    """Prove the exact public endpoint supports auth, JSON discovery and SSE."""
    print("\n[7/7] Verifying public API + Harness-style streaming...", flush=True)
    import requests

    auth = {"Authorization": f"Bearer {api_key}"}

    response = requests.get(
        f"{api_url}/models",
        headers={**auth, "Accept": "application/json"},
        timeout=30,
        allow_redirects=True,
    )
    if not response.ok:
        raise RuntimeError("Public /v1/models failed: " + _response_diag(response))
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError(
            "Public /v1/models returned HTTP 2xx but not JSON: " + _response_diag(response)
        ) from exc

    ids = [item.get("id") for item in data.get("data", [])]
    if SERVED_MODEL_NAME not in ids:
        raise RuntimeError(f"Public /v1/models did not advertise {SERVED_MODEL_NAME!r}; got {ids}")
    print(f"      /v1/models: OK ({SERVED_MODEL_NAME})")

    payload = {
        "model": SERVED_MODEL_NAME,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 16,
        "temperature": 0,
        "stream": True,
    }
    collected: list[str] = []
    saw_event = False
    saw_done = False

    with requests.post(
        f"{api_url}/chat/completions",
        headers={
            **auth,
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        },
        json=payload,
        stream=True,
        timeout=(30, 180),
        allow_redirects=True,
    ) as response:
        if not response.ok:
            raise RuntimeError("Public streamed chat failed: " + _response_diag(response))
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" not in content_type.lower():
            raise RuntimeError("Public chat was not SSE: " + _response_diag(response))

        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            line = raw_line.strip()
            if not line.startswith("data:"):
                continue
            saw_event = True
            data_text = line[5:].strip()
            if data_text == "[DONE]":
                saw_done = True
                break
            try:
                event = json.loads(data_text)
            except json.JSONDecodeError:
                continue
            for choice in event.get("choices", []):
                delta = choice.get("delta") or {}
                piece = delta.get("content")
                if piece:
                    collected.append(piece)

    if not saw_event or not saw_done:
        raise RuntimeError(
            f"SSE verification incomplete: saw_event={saw_event}, saw_done={saw_done}"
        )
    print("      Streaming SSE: OK ✅")
    return "".join(collected).strip() or "stream completed"


def main() -> None:
    # Deliberately check this first: a missing tunnel token must not consume GPU time.
    ngrok_token = require_ngrok_token()
    install_dependencies()

    print("\n[2/7] Detecting GPU...", flush=True)
    gpu_name, vram_mib = gpu_info()
    model_id, max_model_len = choose_model(vram_mib)
    print(f"      GPU: {gpu_name}")
    print(f"      VRAM: {vram_mib / 1024:.1f} GiB")
    print(f"      Model: {model_id}")
    print(f"      Context: {max_model_len:,}")
    print(f"      KV cache: {KV_CACHE_DTYPE}")
    print(f"      GPU target: {float(GPU_MEMORY_UTILIZATION) * 100:.0f}%")

    model_dir = download_model(model_id)

    reused = try_reuse_server(model_id, max_model_len)
    if reused is not None:
        vllm_pid, api_key = reused
        vllm_proc = None
    else:
        cleanup_stale_vllm()
        api_key = "sk-colab-" + secrets.token_urlsafe(32)
        vllm_proc = start_vllm(model_dir, api_key, max_model_len)
        try:
            wait_for_server(api_key, vllm_proc)
        except Exception:
            if vllm_proc.poll() is None:
                _kill_process_group(vllm_proc.pid)
            VLLM_PID_FILE.unlink(missing_ok=True)
            SERVER_STATE_FILE.unlink(missing_ok=True)
            raise
        vllm_pid = vllm_proc.pid
        _write_server_state(vllm_pid, api_key, model_id, max_model_len)

    listener = None
    try:
        listener, public_base = start_ngrok_tunnel(ngrok_token)
        api_url = public_base + "/v1"
        test_text = verify_public_api(api_url, api_key)
    except Exception:
        # Keep a healthy Qwen server alive. A tunnel/config retry should not reload 55 GB.
        print("\nPublic tunnel verification failed; keeping local Qwen/vLLM alive for the next rerun.")
        raise

    API_ENV_FILE.write_text(
        f"QWEN_API_URL={api_url}\n"
        f"QWEN_API_KEY={api_key}\n"
        f"QWEN_MODEL={SERVED_MODEL_NAME}\n"
        f"QWEN_SOURCE_MODEL={model_id}\n"
        f"QWEN_CONTEXT_WINDOW={max_model_len}\n"
        f"QWEN_KV_CACHE_DTYPE={KV_CACHE_DTYPE}\n"
    )

    print("\n" + "=" * 72)
    print("QWEN3.8-27B COLAB API IS READY")
    print("=" * 72)
    print(f"API_URL : {api_url}")
    print(f"API_KEY : {api_key}")
    print(f"MODEL   : {SERVED_MODEL_NAME}")
    print(f"SOURCE  : {model_id}")
    print(f"CONTEXT : {max_model_len:,} tokens")
    print(f"KV CACHE: {KV_CACHE_DTYPE}")
    print("TUNNEL  : ngrok (public /models + SSE verified)")
    print(f"TEST    : {test_text}")
    print(f"ENV FILE: {API_ENV_FILE}")
    print("=" * 72)
    print("Keep this Colab runtime alive while Harness is using the API.")

    # Keep a strong reference to the listener for this notebook process.
    _ = listener


if __name__ == "__main__":
    main()
