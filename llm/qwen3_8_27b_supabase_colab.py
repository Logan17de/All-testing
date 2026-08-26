#!/usr/bin/env python3
"""Colab Qwen3.8-27B worker using an outbound-only Growing-Trader relay.

vLLM stays private on 127.0.0.1:8000. Colab only makes ordinary outbound HTTPS
calls to Supabase. No reverse tunnel or public Colab port is used.

The Colab runtime also holds a lightweight Supabase VM lease from the beginning
of startup. This lets the shared Oracle VM remain online while Qwen is still
installing/downloading/loading, without making the public gateway report the
model as ready before vLLM is actually usable.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

BF16_MODEL = "Qwen/Qwen3.8-27B"
FP8_MODEL = "Qwen/Qwen3.8-27B-FP8"
SERVED_MODEL_NAME = "qwen3.8-27b"
STARTUP_MODEL_NAME = "__qwen-starting__"
NATIVE_CONTEXT = 262_144

VLLM_VERSION = "0.27.1"
TRANSFORMERS_VERSION = "5.15.0"
TORCHVISION_VERSION = "0.28.0"
PYTORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu130"
GPU_MEMORY_UTILIZATION = "0.95"
KV_CACHE_DTYPE = "fp8"

MODEL_ROOT = Path("/content/models")
LOG_ROOT = Path("/content/qwen_api_logs")
SERVER_STATE_FILE = Path("/content/qwen_server_state.json")
VLLM_PID_FILE = Path("/content/qwen_vllm.pid")
PORT = 8000

BATCH_LINES = 16
BATCH_MAX_SECONDS = 0.75
HEARTBEAT_SECONDS = 5.0
STARTUP_HEARTBEAT_SECONDS = 10.0
QUEUE_POLL_SECONDS = 0.50


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


def load_relay_env() -> None:
    """Load relay auth and optional narrowly-scoped Oracle wake credentials."""
    print("[0/7] Checking Growing-Trader Qwen relay...", flush=True)
    secret = colab_secret("QWEN_RELAY_SECRET")
    relay_id = colab_secret("QWEN_RELAY_ID") or "qwen3-8-27b"
    if not secret:
        raise RuntimeError(
            "QWEN_RELAY_SECRET is missing. In Colab open Secrets (key icon), add "
            "QWEN_RELAY_SECRET, enable Notebook access, then rerun."
        )
    os.environ["QWEN_RELAY_SECRET"] = secret
    os.environ["QWEN_RELAY_ID"] = relay_id

    # Optional overrides. Normally not needed because the Growing-Trader URL and
    # publishable key are intentionally embedded as non-secret defaults.
    optional_url = colab_secret("SUPABASE_URL")
    optional_key = colab_secret("SUPABASE_PUBLISHABLE_KEY")
    wake_token = colab_secret("ORACLE_WAKE_GITHUB_TOKEN")
    if optional_url:
        os.environ["SUPABASE_URL"] = optional_url
    if optional_key:
        os.environ["SUPABASE_PUBLISHABLE_KEY"] = optional_key
    if wake_token:
        os.environ["ORACLE_WAKE_GITHUB_TOKEN"] = wake_token

    print(f"      Relay ID: {relay_id}")
    print("      QWEN_RELAY_SECRET: found ✅")
    print(f"      Oracle auto-wake: {'enabled ✅' if wake_token else 'not configured'}")


class StartupLease:
    """Keep Oracle alive while Colab is active but Qwen is not ready yet."""

    def __init__(self, store, worker_id: str):
        self.store = store
        self.worker_id = worker_id
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def _heartbeat(self, status: str = "online", detail: str = "Colab active | Qwen starting") -> None:
        self.store.upsert_worker(
            self.worker_id,
            status,
            model=STARTUP_MODEL_NAME,
            context_window=NATIVE_CONTEXT,
            detail=detail,
        )

    def _loop(self) -> None:
        while not self.stop_event.wait(STARTUP_HEARTBEAT_SECONDS):
            try:
                self._heartbeat()
            except Exception as exc:
                print(f"\n      Startup lease heartbeat warning: {exc}", flush=True)

    def start(self) -> None:
        self._heartbeat()
        self.thread = threading.Thread(
            target=self._loop,
            name="qwen-startup-lease",
            daemon=True,
        )
        self.thread.start()
        print("      Colab VM lease: active ✅", flush=True)

    def stop(self, *, mark_offline: bool = False) -> None:
        self.stop_event.set()
        if self.thread is not None and self.thread.is_alive():
            self.thread.join(timeout=2)
        if mark_offline:
            try:
                self._heartbeat("offline", "Colab startup stopped before Qwen became ready")
            except Exception:
                pass


def install_dependencies() -> None:
    print("\n[1/7] Preparing Qwen3.8 runtime...", flush=True)
    run([
        sys.executable, "-m", "pip", "install", "-U",
        f"vllm=={VLLM_VERSION}",
        f"transformers=={TRANSFORMERS_VERSION}",
        "huggingface_hub[hf_xet]",
        "requests",
        "supabase",
    ])

    print("\n      Removing optional Torch packages that can conflict with Colab CUDA...", flush=True)
    run([sys.executable, "-m", "pip", "uninstall", "-y", "torchaudio", "torchtext"], check=False)

    print("\n      Installing matching Torchvision CUDA 13.0 wheel...", flush=True)
    run([
        sys.executable, "-m", "pip", "install", "-U", "--force-reinstall", "--no-deps",
        f"torchvision=={TORCHVISION_VERSION}", "--index-url", PYTORCH_CUDA_INDEX,
    ])

    verify = run([
        sys.executable, "-c",
        (
            "import torch, torchvision, transformers, vllm, supabase; "
            "print('Torch:', torch.__version__, 'CUDA:', torch.version.cuda); "
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
        raise RuntimeError("No NVIDIA GPU detected. In Colab choose a GPU runtime.")
    result = run([
        "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"
    ], capture=True)
    first = result.stdout.strip().splitlines()[0]
    name, mem_mib = [part.strip() for part in first.rsplit(",", 1)]
    return name, int(mem_mib)


def gpu_memory_status() -> str:
    try:
        out = subprocess.run([
            "nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"
        ], text=True, capture_output=True, timeout=3).stdout.strip().splitlines()[0]
        used, total = [int(x.strip()) for x in out.split(",")]
        return f"VRAM {used / 1024:.1f}/{total / 1024:.1f} GiB"
    except Exception:
        return "VRAM ?"


def choose_model(vram_mib: int) -> tuple[str, int]:
    if vram_mib >= 70_000:
        return BF16_MODEL, NATIVE_CONTEXT
    if vram_mib >= 38_000:
        return FP8_MODEL, 16_384
    raise RuntimeError(
        f"Detected only {vram_mib / 1024:.1f} GiB VRAM; use >=40 GB for FP8 or >=80 GB for BF16."
    )


def download_model(model_id: str) -> Path:
    print(f"\n[3/7] Preparing {model_id}...", flush=True)
    from huggingface_hub import snapshot_download

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    local_dir = MODEL_ROOT / model_id.split("/")[-1]
    if local_dir.exists():
        print(f"      Reusing existing model directory: {local_dir}")
    snapshot_download(repo_id=model_id, local_dir=str(local_dir))
    print(f"      Model ready: {local_dir}")
    return local_dir


def _port_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _local_models(api_key: str) -> bool:
    import requests
    try:
        response = requests.get(
            f"http://127.0.0.1:{PORT}/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=5,
        )
        if not response.ok:
            return False
        ids = [item.get("id") for item in response.json().get("data", [])]
        return SERVED_MODEL_NAME in ids
    except Exception:
        return False


def try_reuse_server(model_id: str, max_model_len: int) -> tuple[int, str] | None:
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
        if not _pid_alive(pid) or not _port_open() or not _local_models(api_key):
            return None
        print(f"\n[4/7] Reusing existing vLLM server ✅ | PID {pid} | {gpu_memory_status()}")
        return pid, api_key
    except Exception:
        return None


def cleanup_old_server() -> None:
    if SERVER_STATE_FILE.exists():
        try:
            state = json.loads(SERVER_STATE_FILE.read_text())
            pid = int(state.get("pid", 0))
            if pid > 0 and _pid_alive(pid):
                try:
                    os.killpg(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                time.sleep(3)
        except Exception:
            pass
    if _port_open() and shutil.which("fuser"):
        subprocess.run(["fuser", "-k", "-TERM", f"{PORT}/tcp"], check=False, capture_output=True)
        time.sleep(3)
    if _port_open():
        raise RuntimeError(f"Port {PORT} is still occupied after vLLM cleanup")
    SERVER_STATE_FILE.unlink(missing_ok=True)
    VLLM_PID_FILE.unlink(missing_ok=True)


def start_vllm(model_dir: Path, api_key: str, max_model_len: int, model_id: str) -> subprocess.Popen:
    print("\n[4/7] Starting private local vLLM API...", flush=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    log_handle = (LOG_ROOT / "vllm.log").open("w")
    cmd = [
        "vllm", "serve", str(model_dir),
        "--served-model-name", SERVED_MODEL_NAME,
        "--host", "127.0.0.1",
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
    print("+ " + " ".join(printable))
    proc = subprocess.Popen(
        cmd,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    VLLM_PID_FILE.write_text(str(proc.pid))
    SERVER_STATE_FILE.write_text(json.dumps({
        "pid": proc.pid,
        "api_key": api_key,
        "model_id": model_id,
        "max_model_len": max_model_len,
        "kv_cache_dtype": KV_CACHE_DTYPE,
    }))
    return proc


def wait_for_server(api_key: str, proc: subprocess.Popen, timeout_s: int = 1200) -> None:
    print("\n[5/7] Waiting for Qwen local API...", flush=True)
    started = time.time()
    while time.time() - started < timeout_s:
        if proc.poll() is not None:
            log = (LOG_ROOT / "vllm.log").read_text(errors="ignore")[-12000:]
            raise RuntimeError(f"vLLM exited early with code {proc.returncode}.\n{log}")
        if _local_models(api_key):
            print(f"      Local /v1/models: OK ✅ | {int(time.time()-started)}s | {gpu_memory_status()}")
            return
        print(
            f"\r      Loading Qwen... {int(time.time()-started):4d}s | {gpu_memory_status()}",
            end="", flush=True,
        )
        time.sleep(3)
    raise RuntimeError("vLLM did not become ready within 20 minutes")


class QwenRelayWorker:
    def __init__(self, store, api_key: str, context_window: int, *, worker_id: str | None = None):
        self.store = store
        self.api_key = api_key
        self.context_window = context_window
        self.worker_id = worker_id or f"colab-{uuid.uuid4().hex[:10]}"
        self.last_heartbeat = 0.0

    def heartbeat(self, status: str = "online", detail: str | None = None) -> None:
        now = time.time()
        if status == "online" and now - self.last_heartbeat < HEARTBEAT_SECONDS:
            return
        self.store.upsert_worker(
            self.worker_id,
            status,
            model=SERVED_MODEL_NAME,
            context_window=self.context_window,
            detail=detail,
        )
        self.last_heartbeat = now

    def _flush_lines(self, job_id: str, seq: int, lines: list[str]) -> int:
        if not lines:
            return seq
        self.store.append_chunk(job_id, seq, {"type": "sse", "lines": list(lines)})
        lines.clear()
        return seq + 1

    def process(self, job: dict[str, Any]) -> None:
        import requests

        job_id = str(job["id"])
        seq = 0
        try:
            payload = self.store.decode_job_payload(job)
            payload["model"] = SERVED_MODEL_NAME
            wants_stream = bool(payload.get("stream", False))

            url = f"http://127.0.0.1:{PORT}/v1/chat/completions"
            headers = {"Authorization": f"Bearer {self.api_key}"}

            if not wants_stream:
                response = requests.post(url, headers=headers, json=payload, timeout=(30, 3600))
                if not response.ok:
                    raise RuntimeError(f"vLLM HTTP {response.status_code}: {response.text[:2000]}")
                self.store.append_chunk(job_id, seq, {"type": "response", "response": response.json()})
                self.store.set_job_status(job_id, "done")
                return

            lines: list[str] = []
            last_flush = time.time()
            cancel_check_at = time.time() + 1.0

            with requests.post(
                url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=(30, 3600),
            ) as response:
                if not response.ok:
                    raise RuntimeError(f"vLLM HTTP {response.status_code}: {response.text[:2000]}")

                for raw_line in response.iter_lines(decode_unicode=True):
                    self.heartbeat()
                    if raw_line:
                        line = raw_line.strip()
                        if line.startswith("data:"):
                            lines.append(line)

                    now = time.time()
                    if lines and (len(lines) >= BATCH_LINES or now - last_flush >= BATCH_MAX_SECONDS):
                        seq = self._flush_lines(job_id, seq, lines)
                        # Reset after the blocking Supabase upload completes.
                        # Using the pre-upload timestamp caused every buffered token
                        # to immediately trigger another one-line RPC.
                        last_flush = time.time()

                    if now >= cancel_check_at:
                        if self.store.job_cancelled(job_id):
                            self._flush_lines(job_id, seq, lines)
                            return
                        cancel_check_at = now + 1.0

            seq = self._flush_lines(job_id, seq, lines)
            self.store.set_job_status(job_id, "done")
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            try:
                self.store.append_chunk(job_id, seq, {"type": "error", "message": message})
                self.store.set_job_status(job_id, "error", message)
            except Exception:
                pass
            print(f"\n      Job {job_id} failed: {message}", flush=True)

    def run_forever(self) -> None:
        print("\n[6/7] Registering Colab worker through outbound Supabase HTTPS...", flush=True)
        self.heartbeat("online", f"{gpu_memory_status()} | waiting for Harness")
        print(f"      Worker ID: {self.worker_id}")
        print(f"      Relay ID : {self.store.config.relay_id}")
        print("      Public Colab ports/tunnels: NONE ✅")
        print("\n[7/7] WORKER READY — waiting for Harness jobs...\n", flush=True)

        idle_message_at = 0.0
        try:
            while True:
                self.heartbeat("online", f"{gpu_memory_status()} | ready")
                job = self.store.claim_job(self.worker_id)
                if job:
                    print(f"\n      Claimed job {job['id']} — sending to local Qwen...", flush=True)
                    self.process(job)
                    print(f"      Job {job['id']} finished. Waiting for next job.", flush=True)
                    continue
                if time.time() >= idle_message_at:
                    print(f"\r      Online | {gpu_memory_status()} | waiting...", end="", flush=True)
                    idle_message_at = time.time() + 5
                time.sleep(QUEUE_POLL_SECONDS)
        except KeyboardInterrupt:
            print("\nWorker stopped by user.")
        finally:
            try:
                self.heartbeat("offline", "worker stopped")
            except Exception:
                pass


def main() -> None:
    # Cell 1 installs the small relay dependency set. Validate credentials and
    # Growing-Trader RPCs before installing vLLM or touching the A100.
    load_relay_env()
    from qwen_supabase_relay import RelayStore, request_oracle_wake_if_needed

    relay = RelayStore.from_env()
    relay.preflight()
    print("      Growing-Trader relay RPC/auth: OK ✅")

    # Hold the shared VM lease immediately. The lease uses a special startup
    # model marker that the public gateway ignores for readiness, while the VM
    # shutdown workflows still treat it as proof that Colab is active.
    worker_id = f"colab-{uuid.uuid4().hex[:10]}"
    startup_lease = StartupLease(relay, worker_id)
    handoff_to_worker = False
    startup_lease.start()

    # If the Oracle VM is currently off, dispatch the existing OCI credentials
    # through a narrowly-scoped GitHub Actions wake workflow. Boot happens in
    # parallel with the expensive model/runtime preparation below.
    request_oracle_wake_if_needed(wait_seconds=0)

    try:
        install_dependencies()

        print("\n[2/7] Verifying GPU...", flush=True)
        gpu_name, vram_mib = gpu_info()
        model_id, max_model_len = choose_model(vram_mib)
        print(f"      GPU: {gpu_name} ({vram_mib / 1024:.1f} GiB)")
        print(f"      Model: {model_id}")
        print(f"      Context: {max_model_len:,}")
        print(f"      KV cache: {KV_CACHE_DTYPE}")

        model_dir = download_model(model_id)

        reused = try_reuse_server(model_id, max_model_len)
        if reused:
            _, api_key = reused
        else:
            cleanup_old_server()
            api_key = "sk-colab-" + secrets.token_urlsafe(32)
            proc = start_vllm(model_dir, api_key, max_model_len, model_id)
            wait_for_server(api_key, proc)

        worker = QwenRelayWorker(
            relay,
            api_key,
            max_model_len,
            worker_id=worker_id,
        )

        # Stop the startup heartbeat first, then atomically reuse the same row
        # as the real ready worker. The public gateway will only see the row
        # after its model field becomes qwen3.8-27b.
        startup_lease.stop(mark_offline=False)
        worker.heartbeat("online", f"{gpu_memory_status()} | ready")
        handoff_to_worker = True
        worker.run_forever()
    finally:
        if not handoff_to_worker:
            startup_lease.stop(mark_offline=True)


if __name__ == "__main__":
    main()
