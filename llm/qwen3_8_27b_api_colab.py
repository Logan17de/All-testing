#!/usr/bin/env python3
"""Colab launcher for Qwen3.8-27B as an OpenAI-compatible API for DeepSeek Harness.

All real setup logic lives in this GitHub module. The Colab notebook only installs
this package from GitHub and calls main().
"""

from __future__ import annotations

import os
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

# Stable versions verified for the current Colab Python 3.13 runtime and Qwen3.8.
VLLM_VERSION = "0.27.1"
TRANSFORMERS_VERSION = "5.15.0"

MODEL_ROOT = Path("/content/models")
LOG_ROOT = Path("/content/qwen_api_logs")
API_ENV_FILE = Path("/content/qwen_api.env")
PORT = 8000

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
PERCENT_RE = re.compile(r"(?:^|\s)(100|[1-9]?\d)%")


def run(cmd: list[str], *, check: bool = True, capture: bool = False):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def install_dependencies() -> None:
    print("\n[1/7] Installing Qwen3.8-compatible runtime...", flush=True)
    print(f"      Python: {sys.version.split()[0]}", flush=True)
    print(f"      vLLM: {VLLM_VERSION} (stable)", flush=True)
    print(f"      Transformers: {TRANSFORMERS_VERSION}", flush=True)

    # Qwen's current model card recommends the normal PyPI vLLM package.
    # Avoid the nightly index here: it is unnecessary for Qwen3.8-27B and can
    # fail dependency resolution on Colab even when stable vLLM works.
    run([
        sys.executable,
        "-m",
        "pip",
        "install",
        "-U",
        f"vllm=={VLLM_VERSION}",
        f"transformers=={TRANSFORMERS_VERSION}",
        "huggingface_hub[hf_xet]",
        "openai",
        "requests",
    ])

    version = run([
        sys.executable,
        "-c",
        (
            "import vllm, transformers, torch; "
            "print('vLLM:', vllm.__version__); "
            "print('Transformers:', transformers.__version__); "
            "print('Torch:', torch.__version__); "
            "print('CUDA available:', torch.cuda.is_available())"
        ),
    ], capture=True)
    print(version.stdout.strip(), flush=True)


def gpu_info() -> tuple[str, int]:
    if shutil.which("nvidia-smi") is None:
        raise RuntimeError(
            "No NVIDIA GPU detected. In Colab choose Runtime > Change runtime type > GPU."
        )

    result = run([
        "nvidia-smi",
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ], capture=True)
    first = result.stdout.strip().splitlines()[0]
    name, mem_mib = [part.strip() for part in first.rsplit(",", 1)]
    return name, int(mem_mib)


def choose_model(vram_mib: int) -> tuple[str, int]:
    # BF16 weights are ~55.6 GB. An A100 80 GB leaves enough room for a
    # practical 32K agent context plus runtime/KV cache.
    if vram_mib >= 70_000:
        return BF16_MODEL, 32768

    # Official FP8 checkpoint is ~31 GB.
    if vram_mib >= 38_000:
        return FP8_MODEL, 16384

    raise RuntimeError(
        f"Detected only {vram_mib / 1024:.1f} GiB VRAM. "
        "Use >=40 GB for the official FP8 checkpoint or >=80 GB for BF16."
    )


def get_hf_token() -> str | None:
    # Qwen3.8 is public. Use a token only if the caller explicitly exported one.
    # Do not query a missing Colab Secret, because Colab can block/warn while
    # trying to fetch an unset secret.
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")


def download_model(model_id: str, token: str | None) -> Path:
    print(f"\n[3/7] Preparing {model_id}...", flush=True)
    from huggingface_hub import snapshot_download

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    local_dir = MODEL_ROOT / model_id.split("/")[-1]

    if local_dir.exists():
        print(f"      Existing cache found: {local_dir}", flush=True)
        print("      Verifying/reusing cached files; already-downloaded shards are not fetched again.", flush=True)

    snapshot_download(
        repo_id=model_id,
        local_dir=str(local_dir),
        token=token,
    )
    print(f"Model ready at: {local_dir}", flush=True)
    return local_dir


def gpu_memory_status() -> str:
    try:
        result = subprocess.run([
            "nvidia-smi",
            "--query-gpu=memory.used,memory.total",
            "--format=csv,noheader,nounits",
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
        (15, "Reading model config", ("model config", "architecture", "qwen3_5")),
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
        "--gpu-memory-utilization", "0.92",
        "--max-model-len", str(max_model_len),
        "--enable-auto-tool-choice",
        "--tool-call-parser", "qwen3_coder",
        "--reasoning-parser", "qwen3",
        "--language-model-only",
    ]

    # Never print the generated API key in the command line output.
    safe_cmd = cmd.copy()
    key_idx = safe_cmd.index("--api-key") + 1
    safe_cmd[key_idx] = "***REDACTED***"
    print("+ " + " ".join(safe_cmd), flush=True)

    return subprocess.Popen(
        cmd,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def wait_for_server(api_key: str, proc: subprocess.Popen, timeout_s: int = 1200) -> None:
    print("\n[5/7] Loading Qwen and waiting for the API...", flush=True)
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
                f"vLLM exited early with code {proc.returncode}.\n\n"
                f"Last vLLM log lines:\n{_tail(log_path)}"
            )

        new_text, offset = _read_new(log_path, offset)
        if new_text:
            percent, stage = _infer_stage(new_text, percent, stage)

        now = time.time()
        if now >= next_check:
            try:
                response = requests.get(
                    f"http://127.0.0.1:{PORT}/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=4,
                )
                if response.ok:
                    print(
                        f"\r[5/7] [{_progress_bar(100)}] 100%  API ready ✅                    "
                        f"| {_elapsed(started)} | {gpu_memory_status()}" + " " * 10,
                        flush=True,
                    )
                    return
                last_error = f"HTTP {response.status_code}"
            except Exception as exc:
                last_error = str(exc)
            next_check = now + 4

        print(
            f"\r[5/7] [{_progress_bar(percent)}] {percent:3d}%  {stage:<28} "
            f"| {_elapsed(started)} | {gpu_memory_status()}" + " " * 10,
            end="",
            flush=True,
        )
        time.sleep(1)

    print()
    raise RuntimeError(
        f"vLLM did not become ready within {timeout_s}s. Last API error: {last_error}\n\n"
        f"Last vLLM log lines:\n{_tail(log_path)}"
    )


def install_cloudflared() -> Path:
    existing = shutil.which("cloudflared")
    if existing:
        return Path(existing)

    arch = subprocess.check_output(["uname", "-m"], text=True).strip()
    if arch in {"x86_64", "amd64"}:
        package_arch = "amd64"
    elif arch in {"aarch64", "arm64"}:
        package_arch = "arm64"
    else:
        raise RuntimeError(f"Unsupported CPU architecture: {arch}")

    dest = Path("/content/cloudflared")
    url = (
        "https://github.com/cloudflare/cloudflared/releases/latest/download/"
        f"cloudflared-linux-{package_arch}"
    )
    run(["curl", "-L", "--fail", "--silent", "--show-error", url, "-o", str(dest)])
    dest.chmod(0o755)
    return dest


def start_tunnel() -> tuple[subprocess.Popen, str]:
    print("\n[6/7] Creating temporary public HTTPS tunnel...", flush=True)
    cloudflared = install_cloudflared()
    log_path = LOG_ROOT / "cloudflared.log"
    log_handle = log_path.open("w")

    proc = subprocess.Popen([
        str(cloudflared),
        "tunnel",
        "--url", f"http://127.0.0.1:{PORT}",
        "--no-autoupdate",
    ], stdout=log_handle, stderr=subprocess.STDOUT, text=True, start_new_session=True)

    pattern = re.compile(r"https://[-a-z0-9]+\.trycloudflare\.com")
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        if log_path.exists():
            match = pattern.search(log_path.read_text(errors="ignore"))
            if match:
                return proc, match.group(0)
        time.sleep(1)

    raise RuntimeError(f"Could not create Cloudflare tunnel.\n{_tail(log_path, 80)}")


def smoke_test(api_url: str, api_key: str) -> str:
    print("\n[7/7] Sending a test request...", flush=True)
    from openai import OpenAI

    client = OpenAI(base_url=api_url, api_key=api_key)
    response = client.chat.completions.create(
        model=SERVED_MODEL_NAME,
        messages=[{"role": "user", "content": "Reply with exactly: Qwen API is online"}],
        max_tokens=32,
        temperature=0,
    )
    return response.choices[0].message.content or ""


def main() -> None:
    install_dependencies()

    print("\n[2/7] Detecting GPU...", flush=True)
    gpu_name, vram_mib = gpu_info()
    model_id, max_model_len = choose_model(vram_mib)
    print(f"GPU: {gpu_name}")
    print(f"VRAM: {vram_mib / 1024:.1f} GiB")
    print(f"Selected model: {model_id}")
    print(f"API max context: {max_model_len:,} tokens")

    hf_token = get_hf_token()
    if hf_token:
        print("HF_TOKEN found in environment.")
    else:
        print("HF_TOKEN not set; Qwen is public, continuing anonymously.")

    model_dir = download_model(model_id, hf_token)
    api_key = "sk-colab-" + secrets.token_urlsafe(32)
    vllm_proc = start_vllm(model_dir, api_key, max_model_len)

    try:
        wait_for_server(api_key, vllm_proc)
        tunnel_proc, public_base = start_tunnel()
    except Exception:
        if vllm_proc.poll() is None:
            vllm_proc.terminate()
        raise

    api_url = public_base.rstrip("/") + "/v1"
    API_ENV_FILE.write_text(
        f"QWEN_API_URL={api_url}\n"
        f"QWEN_API_KEY={api_key}\n"
        f"QWEN_MODEL={SERVED_MODEL_NAME}\n"
        f"QWEN_SOURCE_MODEL={model_id}\n"
    )

    try:
        test_text = smoke_test(api_url, api_key)
    except Exception as exc:
        test_text = f"Smoke test failed, but server/tunnel are running: {exc}"

    print("\n" + "=" * 76)
    print("QWEN3.8-27B COLAB API IS READY")
    print("=" * 76)
    print(f"API_URL : {api_url}")
    print(f"API_KEY : {api_key}")
    print(f"MODEL   : {SERVED_MODEL_NAME}")
    print(f"SOURCE  : {model_id}")
    print(f"TEST    : {test_text}")
    print(f"ENV FILE: {API_ENV_FILE}")
    print("=" * 76)
    print("HARNESS SETTINGS")
    print(f"Base URL : {api_url}")
    print(f"API Key  : {api_key}")
    print(f"Model ID : {SERVED_MODEL_NAME}")
    print("Protocol : OpenAI-compatible / Chat Completions")
    print("=" * 76)
    print("\nKeep this Colab runtime running while Harness is using the model.")

    # Keep references alive in this process. The subprocesses also run in their
    # own sessions, so the API remains available after main() finishes.
    _ = (vllm_proc, tunnel_proc)


if __name__ == "__main__":
    main()
