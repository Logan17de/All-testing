from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from typing import Any, Hashable, Iterable


@dataclass(slots=True)
class CacheEntry:
    key: Hashable
    payload: Any
    nbytes: int
    last_used: int


@dataclass(frozen=True, slots=True)
class CacheStats:
    capacity_bytes: int
    used_bytes: int
    entries: int
    hits: int
    misses: int
    evictions: int

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0


class GlobalLRUExpertCache:
    """Byte-budgeted global LRU keyed by (layer, expert).

    This CPU-side metadata implementation is the correctness/reference path. The
    optimized CUDA-graph phase should move route lookup/victim selection on-device,
    but keeping this implementation makes cache semantics directly testable.
    """

    def __init__(self, capacity_bytes: int):
        if capacity_bytes <= 0:
            raise ValueError("capacity_bytes must be positive")
        self.capacity_bytes = int(capacity_bytes)
        self._items: OrderedDict[Hashable, CacheEntry] = OrderedDict()
        self._used = 0
        self._clock = 0
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._lock = RLock()

    def __contains__(self, key: Hashable) -> bool:
        return key in self._items

    def get(self, key: Hashable) -> Any | None:
        with self._lock:
            entry = self._items.get(key)
            self._clock += 1
            if entry is None:
                self._misses += 1
                return None
            self._hits += 1
            entry.last_used = self._clock
            self._items.move_to_end(key)
            return entry.payload

    def peek(self, key: Hashable) -> Any | None:
        entry = self._items.get(key)
        return None if entry is None else entry.payload

    def put(self, key: Hashable, payload: Any, nbytes: int) -> list[CacheEntry]:
        if nbytes <= 0:
            raise ValueError("nbytes must be positive")
        if nbytes > self.capacity_bytes:
            raise ValueError("single expert is larger than the cache")
        evicted: list[CacheEntry] = []
        with self._lock:
            self._clock += 1
            old = self._items.pop(key, None)
            if old is not None:
                self._used -= old.nbytes
            while self._used + nbytes > self.capacity_bytes and self._items:
                _, victim = self._items.popitem(last=False)
                self._used -= victim.nbytes
                self._evictions += 1
                evicted.append(victim)
            entry = CacheEntry(key, payload, int(nbytes), self._clock)
            self._items[key] = entry
            self._used += int(nbytes)
        return evicted

    def remove(self, key: Hashable) -> Any | None:
        with self._lock:
            entry = self._items.pop(key, None)
            if entry is None:
                return None
            self._used -= entry.nbytes
            return entry.payload

    def clear(self) -> list[Any]:
        with self._lock:
            values = [entry.payload for entry in self._items.values()]
            self._items.clear()
            self._used = 0
            return values

    def plan(self, keys: Iterable[Hashable]) -> tuple[list[Hashable], list[Hashable]]:
        hits, misses = [], []
        for key in dict.fromkeys(keys):
            if key in self._items:
                hits.append(key)
            else:
                misses.append(key)
        return hits, misses

    def validate(self) -> None:
        with self._lock:
            assert self._used == sum(x.nbytes for x in self._items.values())
            assert self._used <= self.capacity_bytes
            assert len(self._items) == len(set(self._items.keys()))

    def stats(self) -> CacheStats:
        return CacheStats(
            capacity_bytes=self.capacity_bytes,
            used_bytes=self._used,
            entries=len(self._items),
            hits=self._hits,
            misses=self._misses,
            evictions=self._evictions,
        )
