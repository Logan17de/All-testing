from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

from .config import GIB, RuntimeConfig


@dataclass(frozen=True, slots=True)
class ModelManifest:
    model_id: str
    model_type: str
    num_layers: int
    num_experts: int
    top_k: int
    hidden_size: int
    moe_intermediate_size: int
    max_position_embeddings: int
    quant_method: str | None
    weight_block_size: tuple[int, int] | None
    repo_files_gib: float | None
    ple_layer_ids: tuple[int, ...]

    def as_dict(self) -> dict:
        return asdict(self)


def inspect_remote_model(cfg: RuntimeConfig) -> ModelManifest:
    from transformers import AutoConfig

    config = AutoConfig.from_pretrained(cfg.model_id, revision=cfg.revision, trust_remote_code=True)
    text = getattr(config, "text_config", config)
    qcfg = getattr(config, "quantization_config", None) or getattr(text, "quantization_config", None) or {}
    if not isinstance(qcfg, dict) and hasattr(qcfg, "to_dict"):
        qcfg = qcfg.to_dict()
    block = qcfg.get("weight_block_size") if isinstance(qcfg, dict) else None
    block_tuple = tuple(block) if block else None

    repo_size = None
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(cfg.model_id, revision=cfg.revision, files_metadata=True)
        sizes = [getattr(s, "size", None) for s in info.siblings]
        sizes = [int(x) for x in sizes if x is not None]
        if sizes:
            repo_size = sum(sizes) / GIB
    except Exception:
        pass

    return ModelManifest(
        model_id=cfg.model_id,
        model_type=str(getattr(text, "model_type", "unknown")),
        num_layers=int(getattr(text, "num_hidden_layers")),
        num_experts=int(getattr(text, "num_experts")),
        top_k=int(getattr(text, "num_experts_per_tok")),
        hidden_size=int(getattr(text, "hidden_size")),
        moe_intermediate_size=int(getattr(text, "moe_intermediate_size")),
        max_position_embeddings=int(getattr(text, "max_position_embeddings")),
        quant_method=qcfg.get("quant_method") if isinstance(qcfg, dict) else None,
        weight_block_size=block_tuple,
        repo_files_gib=repo_size,
        ple_layer_ids=tuple(int(x) for x in (getattr(text, "ple_layer_ids", None) or ())),
    )


def validate_manifest(manifest: ModelManifest, cfg: RuntimeConfig) -> list[str]:
    checks = {
        "num_layers": (manifest.num_layers, cfg.num_layers),
        "num_experts": (manifest.num_experts, cfg.num_experts),
        "top_k": (manifest.top_k, cfg.top_k),
        "hidden_size": (manifest.hidden_size, cfg.hidden_size),
        "moe_intermediate_size": (manifest.moe_intermediate_size, cfg.moe_intermediate_size),
    }
    errors = [f"{name}: checkpoint={actual}, runtime={expected}" for name, (actual, expected) in checks.items() if actual != expected]
    if manifest.quant_method and "fp8" not in manifest.quant_method.lower():
        errors.append(f"expected FP8 checkpoint, quant_method={manifest.quant_method}")
    if errors:
        raise RuntimeError("Qwen checkpoint architecture drift detected: " + "; ".join(errors))
    return [f"{k}=OK({v[0]})" for k, v in checks.items()]
