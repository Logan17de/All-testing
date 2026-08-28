import pytest

from qwen38_flash_freetoken.qstar import qstar_fetch_count, qstar_split


def test_qstar_reference_example():
    assert qstar_fetch_count(8, 25.0, 60.0) == 3
    split = qstar_split(range(8), 25.0, 60.0)
    assert len(split.gpu_fill) == 3
    assert len(split.cpu_execute) == 5


def test_qstar_all_fetch_when_pcie_saturates_host():
    assert qstar_fetch_count(7, 60.0, 50.0) == 7


def test_empty_split():
    assert qstar_split([], 10, 20).gpu_fill == ()


def test_invalid_bandwidth():
    with pytest.raises(ValueError):
        qstar_fetch_count(2, 0, 20)
