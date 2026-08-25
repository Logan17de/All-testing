#!/usr/bin/env python3
"""Colab launcher for Qwen3.8-27B as an OpenAI-compatible API for DeepSeek Harness.

All setup logic lives in this GitHub module. The Colab notebook only installs
this package from GitHub, imports it, and calls main().
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import socket
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
SERVER_STATE_FILE = Path("/content/qwen_server_state.json")
VLLM_PID_FILE = Path("/content/qwen_vllm.pid")
TUNNEL_PID_FILE = Path("/content/qwen_tunnel.pid")
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
    print("      Tunnel: localhost.run HTTPS using documented JSON output")

    run([
        sys.executable, "-m", "pip", "install", "-U",
        f"vllm=={VLLM_VERSION}",
        f"transformers=={TRANSFORMERS_VERSION}",
        "huggingface_hub[hf_xet]",
        "openai",
        "requests",
    ])

    print("\n      Removing optional audio/text Torch packages that can conflict with vLLM...", flush=True)
    run([
        sys.executable, "-m", "pip", "uninstall", "-y",
        "torchaudio", "torchtext",
    ], check=False)

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
        time.sleep(2)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    except ProcessLookupError:
        pass


def _kill_saved_process_group(pid_file: Path, label: str) -> bool:
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text().strip())
    except Exception:
        pid_file.unlink(missing_ok=True)
        return False

    try:
        if _pid_alive(pid):
            print(f"      Stopping previous {label} process group (PID {pid})...", flush=True)
            _kill_process_group(pid)
            return True
        return False
    finally:
        pid_file.unlink(missing_ok=True)


def cleanup_old_tunnel() -> None:
    _kill_saved_process_group(TUNNEL_PID_FILE, "tunnel")
    subprocess.run(
        ["pkill", "-TERM", "-f", "nokey@localhost.run"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def cleanup_previous_runtime() -> None:
    """Clear an incompatible/stale vLLM server before starting a new one."""
    print("\n[4/7] Cleaning previous launcher processes...", flush=True)
    cleanup_old_tunnel()
    _kill_saved_process_group(VLLM_PID_FILE, "vLLM")
    SERVER_STATE_FILE.unlink(missing_ok=True)

    if _port_open(PORT):
        print(f"      Port {PORT} is occupied by an older server; releasing it...", flush=True)
        if shutil.which("fuser"):
            subprocess.run(
                ["fuser", "-k", "-TERM", f"{PORT}/tcp"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.run(
                ["pkill", "-TERM", "-f", f"vllm serve .*--port {PORT}"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    deadline = time.time() + 20
    while _port_open(PORT) and time.time() < deadline:
        time.sleep(1)

    if _port_open(PORT) and shutil.which("fuser"):
        subprocess.run(
            ["fuser", "-k", "-KILL", f"{PORT}/tcp"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(2)

    if _port_open(PORT):
        raise RuntimeError(
            f"Port {PORT} is still occupied after cleanup. Restart the Colab runtime once, then run all."
        )

    time.sleep(3)
    print(f"      Port {PORT}: free ✅ | {gpu_memory_status()}", flush=True)


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
            VLLM_PID_FILE.unlink(missing_ok=True)
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


def _write_server_state(pid: int, api_key: str, model_id: str, max_model_len: int) -> None:
    SERVER_STATE_FILE.write_text(json.dumps({
        "pid": pid,
        "api_key": api_key,
        "model_id": model_id,
        "max_model_len": max_model_len,
        "kv_cache_dtype": KV_CACHE_DTYPE,
    }))


def try_reuse_server(model_id: str, max_model_len: int) -> tuple[int, str] | None:
    """Reuse a matching live server so a tunnel-only rerun does not reload 55 GB."""
    if not SERVER_STATE_FILE.exists():
        return None
    try:
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

        import requests
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
        print(f"\n[4/7] Reusing existing vLLM server ✅ | PID {pid} | {gpu_memory_status()}", flush=True)
        return pid, api_key
    except Exception:
        return None


def start_public_tunnel(attempt: int) -> tuple[subprocess.Popen, str]:
    """Create localhost.run HTTPS tunnel using its documented JSON event output."""
    print(f"\n[6/7] Creating public HTTPS tunnel (attempt {attempt}/3)...", flush=True)
    cleanup_old_tunnel()
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = LOG_ROOT / f"localhost_run_{attempt}.jsonl"
    log_handle = log_path.open("w")

    # localhost.run docs recommend 127.0.0.1 when localhost/IPv6 can differ.
    # --output json is the supported machine-readable way to obtain the address;
    # do not scrape URLs from the human banner.
    cmd = [
        "ssh",
        "-T",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-R", f"80:127.0.0.1:{PORT}",
        "nokey@localhost.run",
        "--",
        "--output", "json",
    ]
    print("+ ssh -R 80:127.0.0.1:8000 nokey@localhost.run -- --output json", flush=True)
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    TUNNEL_PID_FILE.write_text(str(proc.pid))

    deadline = time.time() + 60
    offset = 0
    seen_lines: list[str] = []

    while time.time() < deadline:
        if proc.poll() is not None:
            TUNNEL_PID_FILE.unlink(missing_ok=True)
            raise RuntimeError(
                f"localhost.run exited with code {proc.returncode}.\n{_tail(log_path, 80)}"
            )

        new_text, offset = _read_new(log_path, offset)
        if new_text:
            for raw in new_text.splitlines():
                line = ANSI_RE.sub("", raw).strip()
                if not line:
                    continue
                seen_lines.append(line)
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if event.get("event") != "tcpip-forward":
                    continue
                address = event.get("address")
                if not isinstance(address, str) or not address.strip():
                    continue

                address = address.strip().rstrip("/")
                if address.startswith("http://"):
                    address = "https://" + address[len("http://"):]
                elif not address.startswith("https://"):
                    address = "https://" + address

                print(f"      Tunnel address from JSON event: {address}", flush=True)
                return proc, address
        time.sleep(0.5)

    _kill_process_group(proc.pid)
    TUNNEL_PID_FILE.unlink(missing_ok=True)
    raise RuntimeError(
        "localhost.run did not emit a tcpip-forward JSON event within 60 seconds.\n"
        + "\n".join(seen_lines[-30:])
    )


def _response_diagnostic(response) -> str:
    content_type = response.headers.get("content-type", "")
    body = response.text[:500].replace("\n", " ").replace("\r", " ")
    return (
        f"HTTP {response.status_code}; final_url={response.url}; "
        f"content-type={content_type!r}; body={body!r}"
    )


def verify_public_api(api_url: str, api_key: str, timeout_s: int = 45) -> str:
    """Verify authenticated /models and an actual OpenAI SSE stream publicly."""
    print("\n[7/7] Verifying public API + Harness-style streaming...", flush=True)
    import requests

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "qwen-harness-colab/1.0",
    }
    deadline = time.time() + timeout_s
    last_error = "not checked yet"

    while time.time() < deadline:
        try:
            response = requests.get(
                f"{api_url}/models",
                headers=headers,
                timeout=15,
                allow_redirects=True,
            )
            if response.ok:
                try:
                    data = response.json()
                except ValueError as exc:
                    raise RuntimeError(
                        "Public /models returned HTTP 2xx but not JSON: "
                        + _response_diagnostic(response)
                    ) from exc

                ids = [item.get("id") for item in data.get("data", [])]
                if SERVED_MODEL_NAME not in ids:
                    raise RuntimeError(
                        f"Public /models returned JSON but did not advertise {SERVED_MODEL_NAME!r}; got {ids}"
                    )
                print(f"      /v1/models: OK ({SERVED_MODEL_NAME})", flush=True)
                break
            last_error = _response_diagnostic(response)
        except Exception as exc:
            last_error = str(exc)
        time.sleep(2)
    else:
        raise RuntimeError(f"Public /v1/models verification failed: {last_error}")

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
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            "User-Agent": "qwen-harness-colab/1.0",
        },
        json=payload,
        stream=True,
        timeout=(15, 120),
        allow_redirects=True,
    ) as response:
        if not response.ok:
            raise RuntimeError("Public streamed chat failed: " + _response_diagnostic(response))

        content_type = response.headers.get("content-type", "")
        if "text/event-stream" not in content_type.lower():
            raise RuntimeError(
                "Public chat returned HTTP 2xx but was not SSE: "
                + _response_diagnostic(response)
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


def establish_verified_tunnel(api_key: str) -> tuple[subprocess.Popen, str, str]:
    """Retry tunnel creation without reloading Qwen if a free endpoint is bad."""
    errors: list[str] = []
    for attempt in range(1, 4):
        tunnel_proc: subprocess.Popen | None = None
        try:
            tunnel_proc, public_base = start_public_tunnel(attempt)
            api_url = public_base.rstrip("/") + "/v1"
            test_text = verify_public_api(api_url, api_key)
            return tunnel_proc, api_url, test_text
        except Exception as exc:
            errors.append(f"Attempt {attempt}: {exc}")
            print(f"      Tunnel attempt {attempt} failed: {exc}", flush=True)
            if tunnel_proc is not None and tunnel_proc.poll() is None:
                _kill_process_group(tunnel_proc.pid)
            TUNNEL_PID_FILE.unlink(missing_ok=True)
            time.sleep(2)

    raise RuntimeError(
        "All localhost.run tunnel attempts failed while the local Qwen server is still running.\n"
        + "\n\n".join(errors)
    )


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
    print("Public tunnel: localhost.run HTTPS (JSON address discovery)")

    model_dir = download_model(model_id)

    reused = try_reuse_server(model_id, max_model_len)
    if reused is not None:
        vllm_pid, api_key = reused
    else:
        cleanup_previous_runtime()
        api_key = "sk-colab-" + secrets.token_urlsafe(32)
        vllm_proc = start_vllm(model_dir, api_key, max_model_len)
        wait_for_server(api_key, vllm_proc)
        vllm_pid = vllm_proc.pid
        _write_server_state(vllm_pid, api_key, model_id, max_model_len)

    # From here on, tunnel failures do NOT unload Qwen. The next rerun can reuse
    # the same server/key and retry only the cheap public tunnel step.
    tunnel_proc, api_url, test_text = establish_verified_tunnel(api_key)

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
    print("TUNNEL  : localhost.run (JSON-discovered; /models + SSE verified)")
    print(f"TEST    : {test_text}")
    print(f"ENV FILE: {API_ENV_FILE}")
    print("=" * 72)
    print("Keep this Colab runtime alive while Harness is using the API.")

    _ = (vllm_pid, tunnel_proc)


if __name__ == "__main__":
    main()
