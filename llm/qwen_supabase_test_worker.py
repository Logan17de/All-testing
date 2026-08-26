#!/usr/bin/env python3
"""No-GPU test worker for the Qwen Harness relay.

This validates only the transport path:
Harness -> public/bridge API -> Growing-Trader Supabase -> this Colab worker -> back.
It never imports vLLM, Torch, CUDA, Hugging Face, or a model. Every request
returns the assistant text `succeed` using OpenAI-compatible response shapes.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

from qwen_supabase_relay import (
    CONTEXT_WINDOW,
    MODEL_ID,
    RelayStore,
    request_oracle_wake_if_needed,
)

QUEUE_POLL_SECONDS = 0.35
HEARTBEAT_SECONDS = 5.0


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
    print("[TEST 1/3] Checking Growing-Trader relay secret...", flush=True)
    secret = colab_secret("QWEN_RELAY_SECRET")
    relay_id = colab_secret("QWEN_RELAY_ID") or "qwen3-8-27b"
    wake_token = colab_secret("ORACLE_WAKE_GITHUB_TOKEN")
    if not secret:
        raise RuntimeError(
            "QWEN_RELAY_SECRET is missing. Add it in Colab Secrets, enable Notebook access, then rerun."
        )
    os.environ["QWEN_RELAY_SECRET"] = secret
    os.environ["QWEN_RELAY_ID"] = relay_id
    if wake_token:
        os.environ["ORACLE_WAKE_GITHUB_TOKEN"] = wake_token
    print(f"         Relay ID: {relay_id}")
    print("         Secret: found ✅")
    print(f"         Oracle auto-wake: {'enabled ✅' if wake_token else 'not configured'}")


def _stream_events() -> list[str]:
    completion_id = "chatcmpl-relay-test-" + uuid.uuid4().hex[:12]
    common = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": MODEL_ID,
    }
    first = {
        **common,
        "choices": [{
            "index": 0,
            "delta": {"role": "assistant", "content": "succeed"},
            "finish_reason": None,
        }],
    }
    final = {
        **common,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    return [
        "data: " + json.dumps(first, separators=(",", ":")),
        "data: " + json.dumps(final, separators=(",", ":")),
        "data: [DONE]",
    ]


def _nonstream_response() -> dict[str, Any]:
    return {
        "id": "chatcmpl-relay-test-" + uuid.uuid4().hex[:12],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "succeed"},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1},
    }


class TestWorker:
    def __init__(self, store: RelayStore):
        self.store = store
        self.worker_id = f"colab-test-{uuid.uuid4().hex[:10]}"
        self.last_heartbeat = 0.0

    def heartbeat(self, status: str = "online", detail: str | None = None) -> None:
        now = time.time()
        if status == "online" and now - self.last_heartbeat < HEARTBEAT_SECONDS:
            return
        self.store.upsert_worker(
            self.worker_id,
            status,
            model=MODEL_ID,
            context_window=CONTEXT_WINDOW,
            detail=detail or "NO-GPU TEST WORKER — every request returns succeed",
        )
        self.last_heartbeat = now

    def process(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        try:
            # Decode the real request to prove the entire request transport path works.
            request_payload = self.store.decode_job_payload(job)
            wants_stream = bool(request_payload.get("stream", False))

            if wants_stream:
                self.store.append_chunk(
                    job_id,
                    0,
                    {"type": "sse", "lines": _stream_events()},
                )
            else:
                self.store.append_chunk(
                    job_id,
                    0,
                    {"type": "response", "response": _nonstream_response()},
                )

            self.store.set_job_status(job_id, "done")
            print(f"\n         Request {job_id} -> succeed ✅", flush=True)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            try:
                self.store.append_chunk(job_id, 0, {"type": "error", "message": message})
                self.store.set_job_status(job_id, "error", message)
            except Exception:
                pass
            print(f"\n         Request {job_id} failed: {message}", flush=True)

    def run_forever(self) -> None:
        print("\n[TEST 3/3] TEST WORKER READY — NO GPU / NO MODEL")
        print(f"           Worker ID: {self.worker_id}")
        print("           Every Harness message will return exactly: succeed")
        print("           Leave this cell running while testing Harness.\n", flush=True)

        next_idle = 0.0
        try:
            while True:
                self.heartbeat()
                job = self.store.claim_job(self.worker_id)
                if job:
                    print(f"\n         Received Harness job {job['id']}...", flush=True)
                    self.process(job)
                    continue
                if time.time() >= next_idle:
                    print("\r         Online | waiting for Harness request...", end="", flush=True)
                    next_idle = time.time() + 5
                time.sleep(QUEUE_POLL_SECONDS)
        except KeyboardInterrupt:
            print("\nTest worker stopped.")
        finally:
            try:
                self.heartbeat("offline", "test worker stopped")
            except Exception:
                pass


def main() -> None:
    load_relay_env()
    print("\n[TEST 2/3] Verifying Growing-Trader relay RPC/auth...", flush=True)
    store = RelayStore.from_env()
    store.preflight()
    print("           Relay RPC/auth: OK ✅")

    # Wake Oracle if it is currently powered off. The test worker's heartbeat
    # then keeps the shared VM alive through the same lifecycle policy as Qwen.
    request_oracle_wake_if_needed(wait_seconds=0)

    print("           GPU required: NO ✅")
    print("           vLLM/model required: NO ✅")
    TestWorker(store).run_forever()


if __name__ == "__main__":
    main()
