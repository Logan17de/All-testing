#!/usr/bin/env python3
"""Local OpenAI-compatible bridge for DeepSeek Harness.

Run on the Windows machine that runs Harness. Harness talks only to 127.0.0.1;
this process exchanges jobs with the Colab worker through Growing-Trader
Supabase over ordinary outbound HTTPS.
"""

from __future__ import annotations

import getpass
import json
import os
import time
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from qwen_supabase_relay import CONTEXT_WINDOW, MODEL_ID, RelayError, RelayStore

HOST = "127.0.0.1"
PORT = int(os.environ.get("QWEN_BRIDGE_PORT", "8787"))
LOCAL_API_KEY = os.environ.get("QWEN_BRIDGE_API_KEY", "local-qwen")
POLL_SECONDS = float(os.environ.get("QWEN_RELAY_POLL_SECONDS", "0.18"))
JOB_TIMEOUT_SECONDS = int(os.environ.get("QWEN_RELAY_JOB_TIMEOUT", "3600"))

app = FastAPI(title="Qwen Harness Supabase Bridge", version="1.0")
_store: RelayStore | None = None


def store() -> RelayStore:
    global _store
    if _store is None:
        _store = RelayStore.from_env()
        _store.preflight()
    return _store


def _check_local_auth(request: Request) -> None:
    if not LOCAL_API_KEY:
        return
    supplied = request.headers.get("authorization", "")
    if supplied != f"Bearer {LOCAL_API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid local bridge API key")


def _worker_or_503() -> dict[str, Any]:
    try:
        worker = store().get_live_worker(max_age_seconds=30)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Supabase relay unavailable: {exc}") from exc
    if not worker:
        raise HTTPException(
            status_code=503,
            detail="No live Colab Qwen worker. Start the Colab notebook and wait for WORKER READY.",
        )
    return worker


@app.get("/health")
def health() -> dict[str, Any]:
    worker = store().get_live_worker(max_age_seconds=30)
    return {
        "ok": bool(worker),
        "bridge": f"http://{HOST}:{PORT}",
        "relay_id": store().config.relay_id,
        "worker": worker,
    }


@app.get("/v1/models")
def models(request: Request) -> dict[str, Any]:
    _check_local_auth(request)
    worker = _worker_or_503()
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "created": 0,
                "owned_by": "local-colab",
                "context_window": int(worker.get("context_window") or CONTEXT_WINDOW),
            }
        ],
    }


def _error_sse(message: str) -> str:
    body = {"error": {"message": message, "type": "relay_error", "code": "relay_error"}}
    return "data: " + json.dumps(body, separators=(",", ":")) + "\n\n"


def _stream_job(job: dict[str, Any]) -> Iterator[str]:
    relay = store()
    job_id = str(job["id"])
    last_seq = -1
    deadline = time.time() + JOB_TIMEOUT_SECONDS
    final_status: str | None = None
    final_error: str | None = None
    last_status_check = 0.0

    try:
        while time.time() < deadline:
            rows = relay.fetch_chunks(job_id, last_seq)
            for row in rows:
                seq = int(row["seq"])
                if seq <= last_seq:
                    continue
                last_seq = seq
                payload = row.get("payload") or {}
                kind = payload.get("type")

                if kind == "sse":
                    for line in payload.get("lines") or []:
                        if not isinstance(line, str):
                            continue
                        yield line.rstrip("\r\n") + "\n\n"
                        if line.strip() == "data: [DONE]":
                            final_status = "done"
                            return
                elif kind == "error":
                    final_status = "error"
                    final_error = str(payload.get("message") or "Colab worker failed")
                    yield _error_sse(final_error)
                    yield "data: [DONE]\n\n"
                    return

            now = time.time()
            if now - last_status_check >= 1.0:
                status_row = relay.get_job(job_id)
                if status_row:
                    final_status = str(status_row.get("status") or "")
                    final_error = status_row.get("error")
                    if final_status == "error":
                        yield _error_sse(final_error or "Colab worker failed")
                        yield "data: [DONE]\n\n"
                        return
                    if final_status == "cancelled":
                        return
                    if final_status == "done" and not rows:
                        yield "data: [DONE]\n\n"
                        return
                last_status_check = now

            time.sleep(POLL_SECONDS)

        relay.cancel_job(job_id)
        yield _error_sse(f"Relay job timed out after {JOB_TIMEOUT_SECONDS}s")
        yield "data: [DONE]\n\n"
    except GeneratorExit:
        relay.cancel_job(job_id)
        raise
    except Exception as exc:
        relay.cancel_job(job_id)
        yield _error_sse(f"Bridge relay failure: {exc}")
        yield "data: [DONE]\n\n"
    finally:
        if final_status in {"done", "error", "cancelled"}:
            relay.cleanup_job(job_id)


def _wait_nonstream(job: dict[str, Any]) -> JSONResponse:
    relay = store()
    job_id = str(job["id"])
    last_seq = -1
    deadline = time.time() + JOB_TIMEOUT_SECONDS
    try:
        while time.time() < deadline:
            rows = relay.fetch_chunks(job_id, last_seq)
            for row in rows:
                last_seq = max(last_seq, int(row["seq"]))
                payload = row.get("payload") or {}
                if payload.get("type") == "response":
                    return JSONResponse(payload.get("response") or {})
                if payload.get("type") == "error":
                    return JSONResponse(
                        {"error": {"message": payload.get("message") or "Worker failed"}},
                        status_code=502,
                    )
            status_row = relay.get_job(job_id)
            if status_row and status_row.get("status") == "error":
                return JSONResponse(
                    {"error": {"message": status_row.get("error") or "Worker failed"}},
                    status_code=502,
                )
            time.sleep(POLL_SECONDS)
        relay.cancel_job(job_id)
        return JSONResponse({"error": {"message": "Relay job timed out"}}, status_code=504)
    finally:
        relay.cleanup_job(job_id)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    _check_local_auth(request)
    _worker_or_503()

    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Request body must be JSON") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")

    # Preserve Harness tool/reasoning/sampling fields; only normalize model ID.
    payload["model"] = MODEL_ID
    wants_stream = bool(payload.get("stream", False))

    try:
        job = store().create_job(payload)
    except RelayError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if wants_stream:
        return StreamingResponse(
            _stream_job(job),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    return _wait_nonstream(job)


def _ensure_relay_secret() -> None:
    if (os.environ.get("QWEN_RELAY_SECRET") or "").strip():
        return
    print("QWEN_RELAY_SECRET is not set in this terminal.")
    secret = getpass.getpass("Paste the dedicated Qwen relay secret (hidden): ").strip()
    if not secret:
        raise SystemExit("QWEN_RELAY_SECRET cannot be empty")
    os.environ["QWEN_RELAY_SECRET"] = secret


def main() -> None:
    from dotenv import load_dotenv
    import uvicorn

    load_dotenv()
    _ensure_relay_secret()

    relay = store()
    relay.preflight()
    worker = relay.get_live_worker(max_age_seconds=30)

    print("\nQwen Harness local bridge")
    print(f"  Base URL : http://{HOST}:{PORT}/v1")
    print(f"  API key  : {LOCAL_API_KEY or '(disabled)'}")
    print(f"  Model    : {MODEL_ID}")
    print(f"  Context  : {CONTEXT_WINDOW:,}")
    print(f"  Relay ID : {relay.config.relay_id}")
    print(f"  Colab    : {'ONLINE ✅' if worker else 'not online yet'}")
    print("\nKeep this terminal open while using Harness.\n")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
