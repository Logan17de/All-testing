from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class GenerationResult:
    text: str
    prompt_tokens: int
    completion_tokens: int
    ttft_s: float | None
    elapsed_s: float

    @property
    def tokens_per_second(self) -> float:
        return self.completion_tokens / self.elapsed_s if self.elapsed_s else 0.0


def build_chat_inputs(tokenizer, messages, tools=None):
    import torch

    kwargs = dict(tokenize=True, add_generation_prompt=True, return_tensors="pt")
    if tools:
        kwargs["tools"] = tools
    ids = tokenizer.apply_chat_template(messages, **kwargs)
    if isinstance(ids, dict):
        return {k: v.to("cuda") if hasattr(v, "to") else v for k, v in ids.items()}
    if ids.ndim == 1:
        ids = ids.unsqueeze(0)
    return {"input_ids": ids.to("cuda")}


def generate_text(loaded, messages, *, tools=None, max_new_tokens=256, temperature=0.0) -> GenerationResult:
    import torch

    inputs = build_chat_inputs(loaded.tokenizer, messages, tools=tools)
    prompt_tokens = int(inputs["input_ids"].shape[-1])
    do_sample = temperature > 0
    started = time.perf_counter()
    with torch.inference_mode():
        out = loaded.model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=do_sample,
            temperature=temperature if do_sample else None,
            use_cache=True,
        )
    elapsed = time.perf_counter() - started
    generated = out[0, prompt_tokens:]
    text = loaded.tokenizer.decode(generated, skip_special_tokens=True)
    return GenerationResult(
        text=text,
        prompt_tokens=prompt_tokens,
        completion_tokens=int(generated.numel()),
        ttft_s=None,
        elapsed_s=elapsed,
    )
