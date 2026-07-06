"""Opt-in performance diagnostics for local debugging."""

from __future__ import annotations

import os
import time


def enabled() -> bool:
    return os.environ.get("HOGA_PERF_DEBUG", "").lower() in {"1", "true", "yes", "on"}


def now() -> float:
    return time.perf_counter()


def elapsed_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000
