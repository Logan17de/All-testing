import qwen3_8_flash_supabase_colab_oom_smoke as smoke


def test_expected_cuda_oom_is_accepted():
    exc = RuntimeError("CUDA out of memory while allocating tensor")
    assert smoke._is_expected_memory_failure(exc)


def test_non_memory_failure_is_not_accepted():
    exc = RuntimeError("unknown experts implementation: freetoken")
    assert not smoke._is_expected_memory_failure(exc)
