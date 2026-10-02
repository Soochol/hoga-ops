"""Lifespan-owned Capture Queue takeover, separate from disk-write retry.

Only an eligible instance participates. Kernel flock is the authority; owner
hints are never used to remove a lock or terminate a process. Restore runs once
after acquisition and mutations stay disabled until workers have started.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Callable
from pathlib import Path

from hoga.api import ownership
from hoga.api.captures_persistence import load_manifest
from hoga.api.models import QueueManifest

log = logging.getLogger(__name__)


class CaptureQueueRuntime:
    def __init__(
        self, data_dir: Path, *, disabled: bool,
        activate: Callable[[QueueManifest], None],
    ) -> None:
        self.data_dir = data_dir
        self.disabled = disabled
        self.activate = activate
        self.state = "disabled" if disabled else "acquiring"
        self.epoch = 0
        self.attempts = 0
        self.last_attempt_ms: int | None = None
        self.next_attempt_ms: int | None = None
        self.error: str | None = None

    @property
    def ready(self) -> bool:
        return self.state == "running" and ownership.is_owned("queue")

    def snapshot(self) -> dict[str, object]:
        return {
            "owned": ownership.is_owned("queue"),
            "disabled_by_env": self.disabled,
            "ready": self.ready,
            "state": self.state,
            "owner_epoch": self.epoch,
            "attempts": self.attempts,
            "last_attempt_ms": self.last_attempt_ms,
            "next_attempt_ms": self.next_attempt_ms,
            "error": self.error,
        }

    async def attempt(self) -> None:
        if self.disabled or self.ready or self.state == "stopping":
            return
        self.attempts += 1
        self.last_attempt_ms = int(time.time() * 1000)
        self.next_attempt_ms = None
        self.state = "acquiring"
        acquired = False
        try:
            acquired = ownership.acquire("queue", self.data_dir)
            if not acquired:
                self.state, self.error = "contended", "held_by_other"
                return
            self.state = "restoring"
            # The thread only reads. Cancellation never strands an acquiring FD
            # in a worker thread; the event loop owns that FD throughout.
            manifest = await asyncio.to_thread(load_manifest, self.data_dir, strict=True)
            self.state = "starting"
            self.activate(manifest if manifest is not None else QueueManifest(paused=False, items=[]))
            self.epoch += 1
            self.state, self.error = "running", None
            log.info("capture.queue.ready pid_epoch=%s attempts=%s", self.epoch, self.attempts)
        except Exception as exc:
            phase = self.state
            self.state = "failed"
            self.error = f"{phase}: {type(exc).__name__}: {exc}"
            log.exception("capture.queue.recovery_failed phase=%s", phase)
        finally:
            if acquired and self.state != "running":
                ownership.release("queue")

    async def run(self) -> None:
        if self.disabled:
            ownership.acquire(
                "queue", self.data_dir, available=False, unavailable_reason="disabled_by_env",
            )
        try:
            while True:
                if self.disabled or self.ready:
                    await asyncio.sleep(30)
                    continue
                await self.attempt()
                if self.ready:
                    continue
                delay = (1, 2, 5, 30)[min(max(self.attempts - 1, 0), 3)]
                delay *= random.uniform(0.9, 1.0)
                self.next_attempt_ms = int(time.time() * 1000 + delay * 1000)
                await asyncio.sleep(delay)
        finally:
            self.state = "stopping"
            self.next_attempt_ms = None
            # The lifespan stops workers before releasing ownership. Releasing
            # here would let a successor write while old workers still run.
