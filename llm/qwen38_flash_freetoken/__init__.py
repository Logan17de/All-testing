"""Qwen3.8-Flash-Next FreeToken-style heterogeneous inference research runtime."""

from .config import RuntimeConfig
from .qstar import BandwidthProfile, MissSplit, qstar_split

__all__ = ["RuntimeConfig", "BandwidthProfile", "MissSplit", "qstar_split"]
__version__ = "0.1.0"
