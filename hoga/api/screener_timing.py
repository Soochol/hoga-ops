from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar

log = logging.getLogger(__name__)
_SLOW_PHASE_MS = 1000
_scan: ContextVar[tuple[str, str] | None] = ContextVar('screener_monitor_scan', default=None)


@contextmanager
def phase(name):
    scan = _scan.get()
    if scan is None:
        yield
        return
    started = time.monotonic()
    outcome = 'completed'
    try:
        yield
    except asyncio.CancelledError:
        outcome = 'cancelled'
        raise
    except BaseException:
        outcome = 'failed'
        raise
    finally:
        elapsed = (time.monotonic() - started) * 1000
        level = (logging.INFO if elapsed >= _SLOW_PHASE_MS or outcome != 'completed' or name == 'total'
                 else logging.DEBUG)
        log.log(level, 'screener.monitor.phase monitor_id=%s scan_id=%s phase=%s elapsed_ms=%.1f outcome=%s',
                *scan, name, elapsed, outcome)


@contextmanager
def monitor_scan(monitor_id):
    token = _scan.set((monitor_id, uuid.uuid4().hex))
    try:
        with phase('total'):
            yield
    finally:
        _scan.reset(token)
