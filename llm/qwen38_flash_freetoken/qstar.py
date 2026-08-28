from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True, slots=True)
class BandwidthProfile:
    """Measured bandwidths used by the FreeToken q* miss policy."""

    pcie_h2d_gbps: float
    host_effective_gbps: float
    simultaneous_pcie_gbps: float | None = None
    simultaneous_cpu_gbps: float | None = None

    def validate(self) -> None:
        if self.pcie_h2d_gbps <= 0 or self.host_effective_gbps <= 0:
            raise ValueError("Bandwidth values must be positive")


@dataclass(frozen=True, slots=True)
class MissSplit:
    gpu_fill: tuple[int, ...]
    cpu_execute: tuple[int, ...]

    @property
    def fetch_count(self) -> int:
        return len(self.gpu_fill)

    @property
    def cpu_count(self) -> int:
        return len(self.cpu_execute)


def qstar_fetch_count(misses: int, pcie_h2d_gbps: float, host_effective_gbps: float) -> int:
    """Return q* ~= m * B_pcie / B_host, clamped to [1, m] for m>0.

    If PCIe can consume the host bandwidth by itself, there is no useful residual
    memory bandwidth for CPU expert evaluation and all misses are fetched.
    """

    if misses < 0:
        raise ValueError("misses must be >= 0")
    if misses == 0:
        return 0
    if pcie_h2d_gbps <= 0 or host_effective_gbps <= 0:
        raise ValueError("Bandwidth values must be positive")
    if host_effective_gbps <= pcie_h2d_gbps:
        return misses
    q = round(misses * pcie_h2d_gbps / host_effective_gbps)
    return max(1, min(misses, q))


def qstar_split(
    missing_experts: Sequence[int] | Iterable[int],
    pcie_h2d_gbps: float,
    host_effective_gbps: float,
    priority_order: Sequence[int] | None = None,
) -> MissSplit:
    missing = tuple(dict.fromkeys(int(x) for x in missing_experts))
    if not missing:
        return MissSplit((), ())

    q = qstar_fetch_count(len(missing), pcie_h2d_gbps, host_effective_gbps)
    missing_set = set(missing)
    if priority_order is None:
        ordered = list(missing)
    else:
        ordered = [int(e) for e in priority_order if int(e) in missing_set]
        if set(ordered) != missing_set:
            raise ValueError("priority_order must cover every missing expert exactly once")

    return MissSplit(tuple(ordered[:q]), tuple(ordered[q:]))
