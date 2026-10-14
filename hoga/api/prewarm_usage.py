"""Measure prewarm demand overlap, not cache hits or frontend visibility.

One JSON log per completed prewarm build or range bundle. Data-root identity
separates worktrees; PID is diagnostic only because workers share the same cache.
No cache reads, scans, timers, background threads, or extra persistence layer.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)
MARKER = "prewarm_usage "


def record_usage(
    data_dir: Path, *, event: str, code: str, venue: str,
    dates: list[dict[str, object]], elapsed_ms: float | None = None,
) -> None:
    if not dates or not log.isEnabledFor(logging.INFO):
        return
    payload = {
        "v": 1, "event": event, "at_ns": time.time_ns(), "pid": os.getpid(),
        "data_dir": str(data_dir.absolute()), "code": code, "venue": venue,
        "dates": dates,
    }
    if elapsed_ms is not None:
        payload["elapsed_ms"] = round(elapsed_ms, 3)
    log.info("%s%s", MARKER, json.dumps(payload, separators=(",", ":")))
