"""Shutdown spans retain the original exception and resource ordering."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import contextmanager
from typing import TypeVar

log = logging.getLogger(__name__)
T = TypeVar("T")


@contextmanager
def shutdown_phase(name: str, *, account_id: int | None = None,
                   stream_index: int | None = None, epoch: str | None = None):
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
        log.info("reload.shutdown_phase phase=%s elapsed_ms=%.1f outcome=%s "
                 "pid=%d account_id=%s stream_index=%s epoch=%s",
                 name, (time.monotonic() - started) * 1000, outcome, os.getpid(), account_id, stream_index, epoch)


async def finish_shutdown(task: asyncio.Task[T]) -> T:
    """Keep cleanup owned until terminal completion, then propagate caller cancellation."""
    cancelled = None
    while not task.done():
        try:
            await asyncio.wait((task,))
        except asyncio.CancelledError as error:
            cancelled = error
    result = task.result()
    if cancelled is not None:
        raise cancelled
    return result
