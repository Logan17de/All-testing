from __future__ import annotations

import os
import secrets
import time

from .config import RuntimeConfig
from .loader import load_qwen_runtime
from .serve import start_server_thread


def _colab_secret(name: str) -> str | None:
    value = os.environ.get(name)
    if value and value.strip():
        return value.strip()
    try:
        from google.colab import userdata  # type: ignore
        value = userdata.get(name)
        return value.strip() if value and value.strip() else None
    except Exception:
        return None



def serve_loaded_to_harness(loaded, cfg: RuntimeConfig | None = None) -> None:
    """Attach an already-loaded runtime to the existing outbound-only Harness relay."""
    cfg = cfg or loaded.runtime.cfg
    relay_secret = _colab_secret("QWEN_RELAY_SECRET")
    if not relay_secret:
        raise RuntimeError("Add QWEN_RELAY_SECRET in Colab Secrets and enable notebook access")
    os.environ["QWEN_RELAY_SECRET"] = relay_secret
    os.environ["QWEN_RELAY_ID"] = _colab_secret("QWEN_RELAY_ID") or "qwen3-8-27b"
    wake = _colab_secret("ORACLE_WAKE_GITHUB_TOKEN")
    if wake:
        os.environ["ORACLE_WAKE_GITHUB_TOKEN"] = wake

    from qwen_supabase_relay import RelayStore, request_oracle_wake_if_needed
    from qwen3_8_27b_supabase_colab import QwenRelayWorker
    store = RelayStore.from_env()
    store.preflight()
    request_oracle_wake_if_needed(wait_seconds=0)
    api_key = secrets.token_urlsafe(32)
    start_server_thread(loaded, api_key, port=8000)
    import requests
    for _ in range(120):
        try:
            r = requests.get(
                "http://127.0.0.1:8000/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=2,
            )
            if r.ok:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise RuntimeError("Local FreeToken API did not become ready")
    QwenRelayWorker(store, api_key, cfg.max_context_tokens).run()

def run_colab_harness_worker(cfg: RuntimeConfig | None = None) -> None:
    """Load the custom runtime, expose private localhost OpenAI API, then reuse the repo's outbound Supabase relay."""
    cfg = cfg or RuntimeConfig()
    relay_secret = _colab_secret("QWEN_RELAY_SECRET")
    if not relay_secret:
        raise RuntimeError("Add QWEN_RELAY_SECRET in Colab Secrets and enable notebook access")
    os.environ["QWEN_RELAY_SECRET"] = relay_secret
    os.environ["QWEN_RELAY_ID"] = _colab_secret("QWEN_RELAY_ID") or "qwen3-8-27b"
    wake = _colab_secret("ORACLE_WAKE_GITHUB_TOKEN")
    if wake:
        os.environ["ORACLE_WAKE_GITHUB_TOKEN"] = wake

    from qwen_supabase_relay import RelayStore, request_oracle_wake_if_needed
    from qwen3_8_27b_supabase_colab import QwenRelayWorker, StartupLease

    store = RelayStore.from_env()
    store.preflight()
    request_oracle_wake_if_needed(wait_seconds=0)
    startup_id = f"flash-ft-starting-{secrets.token_hex(4)}"
    lease = StartupLease(store, startup_id)
    lease.start()
    try:
        loaded = load_qwen_runtime(cfg)
        api_key = secrets.token_urlsafe(32)
        start_server_thread(loaded, api_key, port=8000)
        # Wait until Uvicorn binds before handing the endpoint to the existing relay worker.
        import requests
        for _ in range(120):
            try:
                r = requests.get(
                    "http://127.0.0.1:8000/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=2,
                )
                if r.ok:
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("Local FreeToken API did not become ready")
        lease.stop(mark_offline=True)
        worker = QwenRelayWorker(store, api_key, cfg.max_context_tokens)
        worker.run()
    finally:
        try:
            lease.stop(mark_offline=True)
        except Exception:
            pass
