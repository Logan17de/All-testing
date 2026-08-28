from __future__ import annotations

import json
import re
import secrets
import threading
import time
import uuid
from dataclasses import asdict
from typing import Any

from .inference import generate_text

SERVED_MODEL_NAME = "qwen3.8-27b"
_TOOL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def _normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for msg in messages:
        m = dict(msg)
        content = m.get("content")
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") in {"text", "input_text"}:
                    parts.append(str(item.get("text", "")))
                elif isinstance(item, dict) and item.get("type") in {"image_url", "input_image"}:
                    raise ValueError("This FreeToken experiment is text-only; image input is disabled")
            m["content"] = "\n".join(x for x in parts if x)
        out.append(m)
    return out


def _parse_tool_calls(text: str) -> tuple[str, list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []
    for match in _TOOL_RE.finditer(text):
        try:
            obj = json.loads(match.group(1))
        except Exception:
            continue
        name = obj.get("name") or obj.get("function", {}).get("name")
        args = obj.get("arguments", obj.get("function", {}).get("arguments", {}))
        if not name:
            continue
        if isinstance(args, str):
            args_str = args
        else:
            args_str = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
        calls.append(
            {
                "id": f"call_{uuid.uuid4().hex[:24]}",
                "type": "function",
                "function": {"name": str(name), "arguments": args_str},
            }
        )
    content = _TOOL_RE.sub("", text).strip()
    return content, calls


def create_app(loaded, api_key: str | None = None):
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.responses import JSONResponse, StreamingResponse

    app = FastAPI(title="Qwen3.8 Flash FreeToken Colab")
    key = api_key or secrets.token_urlsafe(24)

    def auth(authorization: str | None) -> None:
        if authorization != f"Bearer {key}":
            raise HTTPException(status_code=401, detail="invalid API key")

    @app.get("/health")
    def health(authorization: str | None = Header(default=None)):
        auth(authorization)
        return {
            "ok": True,
            "model": SERVED_MODEL_NAME,
            "backend": "qwen38-flash-freetoken",
            "runtime": loaded.runtime.stats.as_dict(),
        }

    @app.get("/metrics")
    def metrics(authorization: str | None = Header(default=None)):
        auth(authorization)
        return loaded.runtime.stats.as_dict()

    @app.get("/v1/models")
    def models(authorization: str | None = Header(default=None)):
        auth(authorization)
        return {"object": "list", "data": [{"id": SERVED_MODEL_NAME, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/chat/completions")
    def chat(payload: dict[str, Any], authorization: str | None = Header(default=None)):
        auth(authorization)
        try:
            messages = _normalize_messages(payload.get("messages") or [])
            tools = payload.get("tools")
            max_tokens = int(payload.get("max_completion_tokens") or payload.get("max_tokens") or 256)
            temperature = float(payload.get("temperature", 0.0) or 0.0)
            result = generate_text(
                loaded,
                messages,
                tools=tools,
                max_new_tokens=max_tokens,
                temperature=temperature,
            )
            content, tool_calls = _parse_tool_calls(result.text)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc

        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        finish = "tool_calls" if tool_calls else "stop"
        message: dict[str, Any] = {"role": "assistant", "content": content or None}
        if tool_calls:
            message["tool_calls"] = tool_calls
        usage = {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_tokens": result.prompt_tokens + result.completion_tokens,
        }

        if not payload.get("stream", False):
            return JSONResponse(
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": SERVED_MODEL_NAME,
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                    "usage": usage,
                    "freetoken_metrics": loaded.runtime.stats.as_dict(),
                }
            )

        def events():
            first = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": SERVED_MODEL_NAME,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
            yield "data: " + json.dumps(first, ensure_ascii=False) + "\n\n"
            if content:
                chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": SERVED_MODEL_NAME,
                    "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
                }
                yield "data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n"
            for idx, call in enumerate(tool_calls):
                chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": SERVED_MODEL_NAME,
                    "choices": [{
                        "index": 0,
                        "delta": {"tool_calls": [{
                            "index": idx,
                            "id": call["id"],
                            "type": "function",
                            "function": call["function"],
                        }]},
                        "finish_reason": None,
                    }],
                }
                yield "data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n"
            final = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": SERVED_MODEL_NAME,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                "usage": usage,
            }
            yield "data: " + json.dumps(final, ensure_ascii=False) + "\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    app.state.api_key = key
    return app


def run_server(loaded, api_key: str, host="127.0.0.1", port=8000) -> None:
    import uvicorn
    uvicorn.run(create_app(loaded, api_key), host=host, port=port, log_level="info")


def start_server_thread(loaded, api_key: str, host="127.0.0.1", port=8000) -> threading.Thread:
    thread = threading.Thread(
        target=run_server,
        args=(loaded, api_key, host, port),
        daemon=True,
        name="qwen38-ft-api",
    )
    thread.start()
    return thread
