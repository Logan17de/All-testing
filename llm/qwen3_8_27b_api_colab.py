#!/usr/bin/env python3
"""
Colab-first launcher for Qwen3.8-27B as an OpenAI-compatible API.

What it does:
1. Detects the Colab GPU/VRAM.
2. Chooses the original BF16 checkpoint on ~80 GB GPUs, or official FP8 on ~40 GB GPUs.
3. Downloads the model from Hugging Face.
4. Generates a fresh API key for this runtime.
5. Starts a vLLM OpenAI-compatible server with live startup progress.
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

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
TQDM_PERCENT_RE = re.compile(r"(?:^|\s)(\d{1,3})%\|")


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
    # Keep pip visible so Colab never looks frozen during large package installs.
    run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-U",
            "--progress-bar",
            "on",
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


def gpu_memory_status() -> str:
    """Return a compact live VRAM usage string without failing the launcher."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            check=False,
            text=True,
            capture_output=True,
            timeout=3,
        )
        used, total = [int(x.strip()) for x in result.stdout.strip().splitlines()[0].split(",")]
        return f"VRAM {used / 1024:.1f}/{total / 1024:.1f} GiB"
    except Exception:
        return "VRAM n/a"


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


def _read_new_log_text(log_file: Path, offset: int) -> tuple[str, int]:
    if not log_file.exists():
        return "", offset
    try:
        with log_file.open("r", errors="ignore") as handle:
            handle.seek(offset)
            text = handle.read()
            return text, handle.tell()
    except Exception:
        return "", offset


def _progress_from_log(text: str, current_percent: int, current_stage: str) -> tuple[int, str]:
    """Map vLLM log activity to an approximate startup percentage and stage."""
    clean = ANSI_RE.sub("", text)
    lower = clean.lower()
    percent = current_percent
    stage = current_stage

    # When vLLM/tqdm exposes real checkpoint loading progress, use it within
    # the model-weight portion of the startup bar (25% -> 72%).
    tqdm_matches = TQDM_PERCENT_RE.findall(clean)
    if tqdm_matches:
        shard_pct = max(0, min(100, int(tqdm_matches[-1])))
        percent = max(percent, 25 + int(shard_pct * 0.47))
        stage = f"Loading model weights ({shard_pct}%)"

    stages = [
        (8, "Launching vLLM process", ["api server", "vllm serve"]),
        (15, "Initializing inference engine", ["initializing a v1 llm engine", "initializing llm engine", "engine core"]),
        (22, "Reading model configuration", ["model config", "resolved architecture", "using model"]),
        (25, "Loading model weights", ["loading model", "loading weights", "safetensors"]),
        (73, "Model weights loaded", ["loading weights took", "model loading took", "weights loaded"]),
        (79, "Preparing KV cache", ["available kv cache", "gpu kv cache", "kv cache size", "kv cache memory"]),
        (86, "Initializing attention/cache", ["cache blocks", "profiling run", "memory profiling"]),
        (91, "Compiling CUDA graphs", ["capturing cuda graphs", "cuda graph", "torch.compile", "compilation"]),
        (96, "Starting HTTP API server", ["application startup", "uvicorn", "route", "openai-compatible"]),
        (99, "API server responding", ["application startup complete", "running on http", "started server process"]),
    ]

    for candidate_percent, candidate_stage, needles in stages:
        if any(needle in lower for needle in needles) and candidate_percent >= percent:
            percent = candidate_percent
            stage = candidate_stage

    return percent, stage


def _progress_bar(percent: int, width: int = 24) -> str:
    percent = max(0, min(100, percent))
    filled = int(width * percent / 100)
    return "█" * filled + "░" * (width - filled)


def _format_elapsed(seconds: float) -> str:
    seconds = int(seconds)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _print_startup_progress(percent: int, stage: str, started_at: float) -> None:
    line = (
        f"\r[5/7] [{_progress_bar(percent)}] {percent:3d}%  "
        f"{stage:<32} | {_format_elapsed(time.time() - started_at)} | {gpu_memory_status()}"
    )
    # Padding clears remnants from a longer previous status line.
    print(line + " " * 12, end="", flush=True)


def _vllm_log_tail(lines: int = 100) -> str:
    log_file = LOG_ROOT / "vllm.log"
    if not log_file.exists():
        return "(vLLM log file was not created)"
    return "\n".join(log_file.read_text(errors="ignore").splitlines()[-lines:])


def wait_for_server(
    api_key: str,
    proc: subprocess.Popen,
    timeout_s: int = 1200,
) -> None:
    print("\n[5/7] Loading Qwen and waiting for the API...", flush=True)
    print("      Live startup progress below (percentage is stage-based unless vLLM reports weight-loading %).")
    import requests

    started_at = time.time()
    deadline = started_at + timeout_s
    headers = {"Authorization": f"Bearer {api_key}"}
    log_file = LOG_ROOT / "vllm.log"
    log_offset = 0
    last_error = None
    percent = 3
    stage = "Starting process"
    next_http_check = 0.0

    while time.time() < deadline:
        if proc.poll() is not None:
            print()  # finish the in-place progress line
            raise RuntimeError(
                f"vLLM exited early with code {proc.returncode}.\n\n"
                f"Last vLLM log lines:\n{_vllm_log_tail()}"
            )

        new_text, log_offset = _read_new_log_text(log_file, log_offset)
        if new_text:
            percent, stage = _progress_from_log(new_text, percent, stage)

        now = time.time()
        if now >= next_http_check:
            try:
                response = requests.get(
                    f"http://127.0.0.1:{PORT}/v1/models",
                    headers=headers,
                    timeout=3,
                )
                if response.ok:
                    _print_startup_progress(100, "API ready ✅", started_at)
                    print("\n      vLLM is ready.", flush=True)
                    return
                last_error = f"HTTP {response.status_code}: {response.text[:200]}"
            except Exception as exc:
                last_error = str(exc)
            next_http_check = now + 3

        _print_startup_progress(percent, stage, started_at)
        time.sleep(1)

    print()
    raise RuntimeError(
        f"vLLM did not become ready within {timeout_s}s. Last error: {last_error}\n\n"
        f"Last vLLM log lines:\n{_vllm_log_tail()}"
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

    # Do not print the generated API key as part of the command line.
    safe_cmd = cmd.copy()
    key_index = safe_cmd.index("--api-key") + 1
    safe_cmd[key_index] = "<generated-key>"
    print("+", " ".join(safe_cmd), flush=True)
    print(f"  vLLM detailed log: {log_path}", flush=True)

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
                print("      Tunnel ready ✅", flush=True)
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
