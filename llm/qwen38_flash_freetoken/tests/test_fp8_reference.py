import pytest


def test_block_scale_expansion():
    torch = pytest.importorskip("torch")
    from qwen38_flash_freetoken.fp8 import expand_block_scales
    s = torch.tensor([[2.0, 3.0], [4.0, 5.0]])
    x = expand_block_scales(s, 3, 3, (2, 2))
    assert x.shape == (3, 3)
    assert x[0, 0].item() == 2.0
    assert x[0, 2].item() == 3.0
    assert x[2, 0].item() == 4.0
