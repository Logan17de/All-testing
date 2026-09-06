from __future__ import annotations

import base64
import json
import mimetypes
import os
from pathlib import Path
from typing import Any, Iterable

import requests


class MultimodalLLM:
    """Small OpenAI-style chat-completions client.

    Keep this adapter isolated: if the chosen multimodal model uses a different API,
    only this file needs to change.
    """

    def __init__(self, cfg: dict):
        self.base_url = cfg["base_url"].rstrip("/")
        self.endpoint = cfg.get("endpoint", "/chat/completions")
        self.model = cfg["model"]
        self.api_key = os.environ.get(cfg.get("api_key_env", "OPENAI_API_KEY"), "")
        self.timeout = int(cfg.get("timeout_seconds", 180))

    @staticmethod
    def _image_data_url(path: str | Path) -> str:
        path = Path(path)
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{data}"

    def json_call(
        self,
        *,
        system: str,
        user_text: str,
        images: Iterable[str | Path] = (),
        temperature: float = 0.2,
    ) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
        for image in images:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": self._image_data_url(image)},
                }
            )

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload = {
            "model": self.model,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
        }
        response = requests.post(
            self.base_url + self.endpoint,
            headers=headers,
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        body = response.json()
        text = body["choices"][0]["message"]["content"]
        if isinstance(text, list):
            text = "".join(x.get("text", "") for x in text if isinstance(x, dict))
        return json.loads(text)
