#!/usr/bin/env python3
"""
Colab-first launcher for Qwen3.8-27B as an OpenAI-compatible API.

What it does:
1. Detects the Colab GPU/VRAM.
2. Chooses the original BF16 checkpoint on ~80 GB GPUs, or official FP8 on ~40 GB GPUs.
3. Downloads the model from Hugging Face.
4. Generates a fresh API key for this runtime.
5. Starts a vLLM OpenAI-compatible server.
6. Creates a temporary Cloudflare tunnel so the API can be called outside Colab.
7. Prints API_URL, API_KEY, and MODEL.

The API exists only while the Colab runtime is alive.
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

MODEL_ROOT = Path("/content/models")
LOG_ROOT = Path("/content/qwen_api_logs")
API_ENV_FILE = Path("/content/qwen_api.env")
PORT = 8000


def run(cmd: list[str], *, check: bool = True, capture: bool = False):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        capture_output=capture,
    )


def install_dependencies() -> None:
    print("\n[1/7] Installing/updating runtime dependencies...", flush=True)
    run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "-U",
            "vllm",
            "huggingface_hub[hf_xet]",
            "openai",
            "requests",
        ]
    )


def gpu_info() -> tuple[str, int]:
    if shutil.which("nvidia-smi") is None:
        raise RuntimeError(
            "No NVIDIA GPU detected. In Colab choose Runtime > Change runtime type > GPU."
        )

    result = run(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
        capture=True,
    )
    first_line = result.stdout.strip().splitlines()[0]
    name, mem_mib = [part.strip() for part in first_line.rsplit(",", 1)]
    return name, int(mem_mib)


def choose_model(vram_mib: int) -> tuple[str, int]:
    # Full BF16 checkpoint is ~55.6 GB, so reserve space for runtime + KV cache.
    if vram_mib >= 70_000:
        return BF16_MODEL, 32768

    # Official FP8 checkpoint is ~30.9 GB.
    if vram_mib >= 38_000:
        return FP8_MODEL, 16384

    raise RuntimeError(
        f"Detected only {vram_mib / 1024:.1f} GiB VRAM. "
        "This launcher intentionally uses only Qwen's official checkpoints. "
        "Use a >=40 GB Colab GPU for the official FP8 model, or an >=80 GB GPU "
        "for the original BF16 model."
    )


def get_hf_token() -> str | None:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        return token

    try:
        from google.colab import userdata  # type: ignore

        return userdata.get("HF_TOKEN")
    except Exception:
        return None


def download_model(model_id: str, token: str | None) -> Path:
    print(f"\n[3/7] Downloading {model_id}...", flush=True)
    from huggingface_hub import snapshot_download

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    local_dir = MODEL_ROOT / model_id.split("/")[-1]
    snapshot_download(
        repo_id=model_id,
        local_dir=str(local_dir),
        token=token,
    )
    print(f"Model ready at: {local_dir}", flush=True)
    return local_dir


def wait_for_server(api_key: str, timeout_s: int = 1200) -> None:
    print("\n[5/7] Waiting for vLLM API to become ready...", flush=True)
    import requests

    deadline = time.time() + timeout_s
    headers = {"Authorization": f"Bearer {api_key}"}
    last_error = None

    while time.time() < deadline:
        try:
            response = requests.get(
                f"http://127.0.0.1:{PORT}/v1/models",
                headers=headers,
                timeout=5,
            )
            if response.ok:
                print("vLLM is ready.", flush=True)
                return
            last_error = f"HTTP {response.status_code}: {response.text[:200]}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(5)

    log_file = LOG_ROOT / "vllm.log"
    tail = ""
    if log_file.exists():
        tail = "\n".join(log_file.read_text(errors="ignore").splitlines()[-80:])
    raise RuntimeError(
        f"vLLM did not become ready within {timeout_s}s. Last error: {last_error}\n"
        f"Last vLLM log lines:\n{tail}"
    )


def start_vllm(model_dir: Path, api_key: str, max_model_len: int) -> subprocess.Popen:
    print("\n[4/7] Starting vLLM OpenAI-compatible API...", flush=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = LOG_ROOT / "vllm.log"
    log_handle = log_path.open("w")

    cmd = [
        "vllm",
        "serve",
        str(model_dir),
        "--served-model-name",
        SERVED_MODEL_NAME,
        "--host",
        "0.0.0.0",
        "--port",
        str(PORT),
        "--api-key",
        api_key,
        "--gpu-memory-utilization",
        "0.92",
        "--max-model-len",
        str(max_model_len),
    ]

    print("+", " ".join(cmd), flush=True)
    proc = subprocess.Popen(
        cmd,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    return proc


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
        raise RuntimeError(f"Unsupported CPU architecture for cloudflared: {arch}")

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

    proc = subprocess.Popen(
        [
            str(cloudflared),
            "tunnel",
            "--url",
            f"http://127.0.0.1:{PORT}",
            "--no-autoupdate",
        ],
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )

    pattern = re.compile(r"https://[-a-z0-9]+\.trycloudflare\.com")
    deadline = time.time() + 90

    while time.time() < deadline:
        if proc.poll() is not None:
            break
        if log_path.exists():
            text = log_path.read_text(errors="ignore")
            match = pattern.search(text)
            if match:
                return proc, match.group(0)
        time.sleep(1)

    tail = ""
    if log_path.exists():
        tail = "\n".join(log_path.read_text(errors="ignore").splitlines()[-80:])
    raise RuntimeError(f"Could not create Cloudflare tunnel.\n{tail}")


def smoke_test(api_url: str, api_key: str) -> str:
    print("\n[7/7] Sending a test request...", flush=True)
    from openai import OpenAI

    client = OpenAI(base_url=api_url, api_key=api_key)
    response = client.chat.completions.create(
        model=SERVED_MODEL_NAME,
        messages=[
            {
                "role": "user",
                "content": "Reply with exactly: Qwen API is online",
            }
        ],
        max_tokens=32,
        temperature=0,
    )
    return response.choices[0].message.content or ""


def main() -> None:
    install_dependencies()

    print("\n[2/7] Detecting GPU...", flush=True)
    gpu_name, vram_mib = gpu_info()
    model_id, max_model_len = choose_model(vram_mib)
    print(f"GPU: {gpu_name}", flush=True)
    print(f"VRAM: {vram_mib / 1024:.1f} GiB", flush=True)
    print(f"Selected model: {model_id}", flush=True)
    print(f"API max context: {max_model_len:,} tokens", flush=True)

    hf_token = get_hf_token()
    if hf_token:
        print("HF_TOKEN found (Colab secret/environment).", flush=True)
    else:
        print("HF_TOKEN not found; Qwen model is public, continuing anonymously.", flush=True)

    model_dir = download_model(model_id, hf_token)

    api_key = "sk-colab-" + secrets.token_urlsafe(32)
    vllm_proc = start_vllm(model_dir, api_key, max_model_len)

    try:
        wait_for_server(api_key)
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

    print("\n" + "=" * 72)
    print("QWEN3.8-27B COLAB API IS READY")
    print("=" * 72)
    print(f"API_URL : {api_url}")
    print(f"API_KEY : {api_key}")
    print(f"MODEL   : {SERVED_MODEL_NAME}")
    print(f"SOURCE  : {model_id}")
    print(f"TEST    : {test_text}")
    print(f"ENV FILE: {API_ENV_FILE}")
    print("=" * 72)
    print(
        "\nKeep this Colab runtime running. The URL and API key stop working "
        "when the runtime ends. Do NOT commit the generated key to GitHub."
    )

    # Keep references alive in this process until it exits.
    _ = tunnel_proc


if __name__ == "__main__":
    main()
