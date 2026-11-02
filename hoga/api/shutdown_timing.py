"""Shutdown spans retain the original exception and resource ordering."""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import contextmanager

log = logging.getLogger(__name__)


@contextmanager
def shutdown_phase(name: str):
    started, outcome = time.monotonic(), "completed"
    try:
        yield
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except BaseException:
        outcome = "failed"
        raise
    finally:
        log.info("reload.shutdown_phase phase=%s elapsed_ms=%.1f outcome=%s",
                 name, (time.monotonic() - started) * 1000, outcome)
