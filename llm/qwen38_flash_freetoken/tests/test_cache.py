from qwen38_flash_freetoken.cache import GlobalLRUExpertCache


def test_lru_evicts_oldest_and_preserves_invariants():
    c = GlobalLRUExpertCache(3)
    c.put((0, 0), "a", 1)
    c.put((0, 1), "b", 1)
    c.put((0, 2), "c", 1)
    assert c.get((0, 0)) == "a"  # refresh a
    evicted = c.put((0, 3), "d", 1)
    assert [e.key for e in evicted] == [(0, 1)]
    assert c.peek((0, 1)) is None
    assert c.peek((0, 0)) == "a"
    c.validate()
