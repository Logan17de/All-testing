#!/usr/bin/env python3
"""Colab launcher for Qwen3.8-27B as an OpenAI-compatible API for DeepSeek Harness.

All setup logic lives in this GitHub module. The Colab notebook only installs
this package from GitHub, imports it, and calls main().
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

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
PORT = 8000

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
PERCENT_RE = re.compile(r"(?:^|\s)(100|[1-9]?\d)%")


def run(cmd: list[str], *, check: bool = True, capture: bool = False, echo: bool = True):
    if echo:
        print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def install_dependencies() -> None:
    print("\n[1/7] Preparing Qwen3.8-compatible runtime...", flush=True)
    print(f"      Python: {sys.version.split()[0]}")
    print(f"      vLLM: {VLLM_VERSION}")
    print(f"      Transformers: {TRANSFORMERS_VERSION}")
    print(f"      Torchvision: {TORCHVISION_VERSION} (CUDA 13.0 wheel)")
    print("      Tunnel: localhost.run HTTPS (no signup/token)")

    run([
        sys.executable, "-m", "pip", "install", "-U",
        f"vllm=={VLLM_VERSION}",
        f"transformers=={TRANSFORMERS_VERSION}",
        "huggingface_hub[hf_xet]",
        "openai",
        "requests",
    ])

    # Colab can ship Torch ecosystem wheels built for a different CUDA version
    # than vLLM's Torch wheel. Audio/text packages are unnecessary here.
    print("\n      Removing optional audio/text Torch packages that can conflict with vLLM...", flush=True)
    run([
        sys.executable, "-m", "pip", "uninstall", "-y",
        "torchaudio", "torchtext",
    ], check=False)

    # Qwen3.8 model inspection imports Qwen3-VL code, so torchvision must exist
    # and must match the Torch/CUDA build installed by vLLM.
    print("\n      Installing Torchvision matched to vLLM's CUDA 13.0 Torch...", flush=True)
    run([
        sys.executable, "-m", "pip", "install", "-U",
        "--force-reinstall", "--no-deps",
        f"torchvision=={TORCHVISION_VERSION}",
        "--index-url", PYTORCH_CUDA_INDEX,
    ])

    print("\n      Verifying Torch / Torchvision / vLLM / Qwen3.8 runtime...", flush=True)
    verify = run([
        sys.executable, "-c",
        (
            "import torch, torchvision, transformers, vllm; "
            "print('Torch:', torch.__version__); "
            "print('Torch CUDA:', torch.version.cuda); "
            "print('Torchvision:', torchvision.__version__); "
            "print('Transformers:', transformers.__version__); "
            "print('vLLM:', vllm.__version__); "
            "print('CUDA available:', torch.cuda.is_available()); "
            "import vllm.model_executor.models.qwen3_5; "
            "print('Qwen3.8 vLLM module: OK')"
        ),
    ], capture=True)
    print(verify.stdout.strip(), flush=True)


def gpu_info() -> tuple[str, int]:
    if shutil.which("nvidia-smi") is None:
        raise RuntimeError("No NVIDIA GPU detected. In Colab choose Runtime > Change runtime type > GPU.")
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
        "Use >=40 GB for official FP8 or >=80 GB for BF16."
    )


def download_model(model_id: str) -> Path:
    print(f"\n[3/7] Preparing {model_id}...", flush=True)
    from huggingface_hub import snapshot_download

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    local_dir = MODEL_ROOT / model_id.split("/")[-1]
    if local_dir.exists():
        print(f"      Existing model directory found: {local_dir}")
        print("      Verifying/reusing cached files; only missing files will download.")
    snapshot_download(repo_id=model_id, local_dir=str(local_dir))
    print(f"Model ready at: {local_dir}", flush=True)
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


def _read_new(path: Path, offset: int) -> tuple[str, int]:
    if not path.exists():
        return "", offset
    with path.open("r", errors="ignore") as fh:
        fh.seek(offset)
        text = fh.read()
        return text, fh.tell()


def _progress_bar(percent: int, width: int = 24) -> str:
    percent = max(0, min(100, percent))
    filled = int(width * percent / 100)
    return "█" * filled + "░" * (width - filled)


def _elapsed(started: float) -> str:
    sec = int(time.time() - started)
    minute, sec = divmod(sec, 60)
    hour, minute = divmod(minute, 60)
    return f"{hour}:{minute:02d}:{sec:02d}" if hour else f"{minute:02d}:{sec:02d}"


def _infer_stage(text: str, percent: int, stage: str) -> tuple[int, str]:
    clean = ANSI_RE.sub("", text)
    lower = clean.lower()

    matches = PERCENT_RE.findall(clean)
    if matches and any(k in lower for k in ("weight", "checkpoint", "safetensor", "loading")):
        real = int(matches[-1])
        percent = max(percent, 22 + int(real * 0.50))
        stage = f"Loading model weights ({real}%)"

    stages = [
        (8, "Starting vLLM", ("api server", "vllm serve")),
        (15, "Reading model config", ("model config", "architecture", "qwen")),
        (22, "Creating inference engine", ("engine core", "llm engine", "initializing")),
        (28, "Loading model weights", ("loading model", "loading weights", "safetensors")),
        (74, "Model weights loaded", ("loading weights took", "model loading took", "weights loaded")),
        (80, "Allocating KV cache", ("kv cache", "available kv")),
        (87, "Profiling GPU memory", ("memory profiling", "profile run")),
        (92, "Compiling/warming kernels", ("torch.compile", "compilation", "cuda graph", "warmup")),
        (97, "Starting HTTP server", ("uvicorn", "application startup")),
        (99, "HTTP server started", ("application startup complete", "running on http", "started server process")),
    ]
    for candidate, label, needles in stages:
        if candidate >= percent and any(n in lower for n in needles):
            percent, stage = candidate, label
    return percent, stage


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

    return subprocess.Popen(
        cmd,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def wait_for_server(api_key: str, proc: subprocess.Popen, timeout_s: int = 1200) -> None:
    print("\n[5/7] Loading Qwen and waiting for the local API...", flush=True)
    print("      Live status comes from vLLM logs; crashes are reported immediately.", flush=True)
    import requests

    started = time.time()
    deadline = started + timeout_s
    log_path = LOG_ROOT / "vllm.log"
    offset = 0
    percent, stage = 3, "Process launched"
    last_error = "not checked yet"
    next_check = 0.0

    while time.time() < deadline:
        if proc.poll() is not None:
            print()
            raise RuntimeError(
                f"vLLM exited early with code {proc.returncode}.\n\nLast vLLM log lines:\n{_tail(log_path)}"
            )

        new_text, offset = _read_new(log_path, offset)
        if new_text:
            percent, stage = _infer_stage(new_text, percent, stage)

        now = time.time()
        if now >= next_check:
            try:
                r = requests.get(
                    f"http://127.0.0.1:{PORT}/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"}, timeout=4,
                )
                if r.ok:
                    print(
                        f"\r[5/7] [{_progress_bar(100)}] 100%  Local API ready ✅ "
                        f"| {_elapsed(started)} | {gpu_memory_status()}" + " " * 12,
                        flush=True,
                    )
                    return
                last_error = f"HTTP {r.status_code}: {r.text[:200]}"
            except Exception as exc:
                last_error = str(exc)
            next_check = now + 4

        print(
            f"\r[5/7] [{_progress_bar(percent)}] {percent:3d}%  {stage:<28} "
            f"| {_elapsed(started)} | {gpu_memory_status()}" + " " * 10,
            end="", flush=True,
        )
        time.sleep(1)

    print()
    raise RuntimeError(
        f"vLLM did not become ready within {timeout_s}s. Last API error: {last_error}\n\n"
        f"Last vLLM log lines:\n{_tail(log_path)}"
    )


def start_public_tunnel() -> tuple[subprocess.Popen, str]:
    """Create a free HTTPS tunnel with localhost.run. No account/token required."""
    print("\n[6/7] Creating zero-config public HTTPS tunnel...", flush=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = LOG_ROOT / "localhost_run.log"
    log_handle = log_path.open("w")

    # Clean up an old anonymous localhost.run tunnel from a previous rerun.
    subprocess.run(["pkill", "-f", "nokey@localhost.run"], check=False, capture_output=True)

    cmd = [
        "ssh",
        "-T",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-R", f"80:localhost:{PORT}",
        "nokey@localhost.run",
    ]
    print("+ ssh -R 80:localhost:8000 nokey@localhost.run", flush=True)
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )

    # localhost.run currently emits either *.localhost.run or *.lhr.life.
    url_pattern = re.compile(
        r"https://[a-zA-Z0-9.-]+(?:localhost\.run|lhr\.life|lhrtunnel\.link)"
    )
    deadline = time.time() + 60
    last_text = ""

    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"localhost.run tunnel exited with code {proc.returncode}.\n{_tail(log_path, 80)}"
            )

        if log_path.exists():
            last_text = log_path.read_text(errors="ignore")
            matches = url_pattern.findall(last_text)
            if matches:
                public_base = matches[-1].rstrip("/.,")
                print(f"      Public endpoint: {public_base}", flush=True)
                return proc, public_base
        time.sleep(1)

    proc.terminate()
    raise RuntimeError(
        "localhost.run did not provide a public HTTPS URL within 60 seconds.\n"
        + (last_text[-3000:] if last_text else "(no tunnel output)")
    )


def verify_public_api(api_url: str, api_key: str, timeout_s: int = 90) -> str:
    """Verify authenticated model discovery and actual SSE streaming publicly."""
    print("\n[7/7] Verifying public API + Harness-style streaming...", flush=True)
    import requests

    headers = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "qwen-harness-colab/1.0",
    }
    deadline = time.time() + timeout_s
    last_error = "not checked yet"

    while time.time() < deadline:
        try:
            response = requests.get(f"{api_url}/models", headers=headers, timeout=15)
            if response.ok:
                data = response.json()
                ids = [item.get("id") for item in data.get("data", [])]
                if SERVED_MODEL_NAME not in ids:
                    raise RuntimeError(
                        f"Public /models worked but did not advertise {SERVED_MODEL_NAME!r}; got {ids}"
                    )
                print(f"      /v1/models: OK ({SERVED_MODEL_NAME})", flush=True)
                break
            last_error = f"HTTP {response.status_code}: {response.text[:300]}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(2)
    else:
        raise RuntimeError(
            f"Public /v1/models verification failed after {timeout_s}s: {last_error}"
        )

    payload = {
        "model": SERVED_MODEL_NAME,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 16,
        "temperature": 0,
        "stream": True,
    }
    saw_event = False
    saw_done = False
    collected: list[str] = []

    with requests.post(
        f"{api_url}/chat/completions",
        headers={**headers, "Content-Type": "application/json"},
        json=payload,
        stream=True,
        timeout=(15, 120),
    ) as response:
        if not response.ok:
            raise RuntimeError(
                f"Public streamed chat failed with HTTP {response.status_code}: {response.text[:500]}"
            )

        content_type = response.headers.get("content-type", "")
        if "text/event-stream" not in content_type.lower():
            raise RuntimeError(
                f"Public chat was not SSE; Content-Type was {content_type!r}."
            )

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

    if not saw_event:
        raise RuntimeError("Public chat returned no SSE data events.")
    if not saw_done:
        raise RuntimeError("Public chat SSE stream opened but never completed with [DONE].")

    print("      Streaming SSE: OK", flush=True)
    return "".join(collected).strip() or "stream completed"


def main() -> None:
    install_dependencies()

    print("\n[2/7] Detecting GPU...", flush=True)
    gpu_name, vram_mib = gpu_info()
    model_id, max_model_len = choose_model(vram_mib)

    print(f"GPU: {gpu_name}")
    print(f"VRAM: {vram_mib / 1024:.1f} GiB")
    print(f"Selected model: {model_id}")
    print(f"API max context: {max_model_len:,} tokens")
    print(f"KV cache dtype: {KV_CACHE_DTYPE}")
    print("Prefix caching: enabled")
    print(f"GPU memory target: {float(GPU_MEMORY_UTILIZATION) * 100:.0f}%")
    print("Public tunnel: localhost.run HTTPS (no account/token)")

    model_dir = download_model(model_id)
    api_key = "sk-colab-" + secrets.token_urlsafe(32)
    vllm_proc = start_vllm(model_dir, api_key, max_model_len)
    tunnel_proc: subprocess.Popen | None = None

    try:
        wait_for_server(api_key, vllm_proc)
        tunnel_proc, public_base = start_public_tunnel()
        api_url = public_base.rstrip("/") + "/v1"
        test_text = verify_public_api(api_url, api_key)
    except Exception:
        if tunnel_proc is not None and tunnel_proc.poll() is None:
            tunnel_proc.terminate()
        if vllm_proc.poll() is None:
            vllm_proc.terminate()
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
    print("TUNNEL  : localhost.run (public /models + SSE verified)")
    print(f"TEST    : {test_text}")
    print(f"ENV FILE: {API_ENV_FILE}")
    print("=" * 72)
    print("Keep this Colab runtime alive while Harness is using the API.")

    _ = tunnel_proc


if __name__ == "__main__":
    main()
