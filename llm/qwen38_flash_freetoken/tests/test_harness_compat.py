from qwen3_8_flash_colab_runtime import (
    HARNESS_BASE_URL,
    HARNESS_CONTEXT_WINDOW,
    HARNESS_MODEL_ID,
    HARNESS_RELAY_ID,
    build_config,
)
from qwen38_flash_freetoken.serve import SERVED_MODEL_NAME


def test_flash_reuses_existing_harness_identity():
    cfg = build_config()
    assert HARNESS_MODEL_ID == "qwen3.8-27b"
    assert SERVED_MODEL_NAME == HARNESS_MODEL_ID
    assert HARNESS_RELAY_ID == "qwen3-8-27b"
    assert HARNESS_BASE_URL == "http://127.0.0.1:8787/v1"
    assert HARNESS_CONTEXT_WINDOW == 262_144
    assert cfg.max_context_tokens == HARNESS_CONTEXT_WINDOW
    assert cfg.model_id == "Qwen/Qwen3.8-Flash-Next-FP8"
    assert cfg.text_only is True
