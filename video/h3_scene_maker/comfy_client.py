from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any

import requests


class ComfyClient:
    def __init__(self, base_url: str, workflow_path: str | Path, bindings: dict[str, dict[str, str]]):
        self.base_url = base_url.rstrip("/")
        self.workflow_path = Path(workflow_path)
        self.bindings = bindings

    def _load_workflow(self) -> dict[str, Any]:
        return json.loads(self.workflow_path.read_text(encoding="utf-8"))

    @staticmethod
    def _set_input(workflow: dict, binding: dict, value: Any) -> None:
        node_id = str(binding["node_id"])
        input_name = binding["input"]
        workflow[node_id]["inputs"][input_name] = value

    def build_prompt(self, *, prompt: str, seed: int, output_prefix: str) -> dict:
        workflow = copy.deepcopy(self._load_workflow())
        self._set_input(workflow, self.bindings["prompt"], prompt)
        self._set_input(workflow, self.bindings["seed"], int(seed))
        self._set_input(workflow, self.bindings["output_prefix"], output_prefix)
        return workflow

    def queue(self, workflow: dict) -> str:
        response = requests.post(self.base_url + "/prompt", json={"prompt": workflow}, timeout=60)
        response.raise_for_status()
        return response.json()["prompt_id"]

    def wait(self, prompt_id: str, poll_seconds: float = 2.0, timeout_seconds: float = 3600.0) -> dict:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            response = requests.get(self.base_url + f"/history/{prompt_id}", timeout=30)
            response.raise_for_status()
            history = response.json()
            if prompt_id in history:
                return history[prompt_id]
            time.sleep(poll_seconds)
        raise TimeoutError(f"ComfyUI prompt {prompt_id} exceeded {timeout_seconds}s")

    def first_video_output(self, history: dict) -> str:
        for node in history.get("outputs", {}).values():
            for key in ("videos", "gifs", "images"):
                for item in node.get(key, []) or []:
                    filename = item.get("filename")
                    if filename and filename.lower().endswith((".mp4", ".webm", ".mov")):
                        subfolder = item.get("subfolder", "")
                        return str(Path(subfolder) / filename)
        raise RuntimeError("No video output found in ComfyUI history. Adjust output parsing for your workflow.")
