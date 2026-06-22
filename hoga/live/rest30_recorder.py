"""Persisted 30-second KIS REST recorder for capture-enabled watchlist targets."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from hoga.live.buffer import LiveBuffer
from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade
from hoga.live.rest30_writer import make_rest30_writer
from hoga.live.rest_buffer_build import brokers_to_snapshot, ob_to_snapshot, trades_to_snapshots

_log = logging.getLogger(__name__)


@runtime_checkable
class KisRestCaptureProto(Protocol):
    async def fetch_orderbook(self, code: str) -> KisOrderbook: ...
    async def fetch_trades(self, code: str) -> list[KisTrade]: ...
    async def fetch_brokers(self, code: str) -> KisBrokers: ...


@dataclass(frozen=True)
class Rest30sStatus:
    running: bool
    target_count: int
    targets: tuple[str, ...]
    last_cycle_ms: int | None
    last_error: str | None
    last_error_count: int
    degraded: bool


class Rest30sRecorder:
    def __init__(
        self,
        *,
        kis_resolver: Callable[[], KisRestCaptureProto | None],
        buffer: LiveBuffer,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int] | None = None,
        phase_fn: Callable[[], str],
        interval_s: float = 30.0,
    ) -> None:
        self._resolve_kis = kis_resolver
        self._buffer = buffer
        self._writer = make_rest30_writer(data_dir)
        self._date_fn = date_fn
        self._now_ms = now_ms_fn or (lambda: int(time.time() * 1000))
        self._phase_fn = phase_fn
        self._interval_s = interval_s
        self._targets: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._last_cycle_ms: int | None = None
        self._last_error: str | None = None
        self._last_error_count = 0

    def set_targets(self, codes: set[str]) -> None:
        self._targets = set(codes)

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> Rest30sStatus:
        return Rest30sStatus(
            running=self.alive,
            target_count=len(self._targets),
            targets=tuple(sorted(self._targets)),
            last_cycle_ms=self._last_cycle_ms,
            last_error=self._last_error,
            last_error_count=self._last_error_count,
            degraded=self._last_error_count > 0,
        )

    def start(self) -> None:
        if self.alive:
            return
        self._task = asyncio.create_task(self._run_loop(), name="live-rest30-recorder")

    async def stop(self) -> None:
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except Exception:
                _log.exception("live.rest30.cycle_failed")
                self._last_error = "cycle_failed"
                self._last_error_count = max(1, self._last_error_count)
            await asyncio.sleep(self._interval_s)

    async def poll_once(self) -> None:
        kis = self._resolve_kis()
        if kis is None:
            self._last_cycle_ms = self._now_ms()
            self._last_error = "kis_unavailable"
            self._last_error_count = 1 if self._targets else 0
            return

        error_count = 0
        last_error: str | None = None
        for code in sorted(self._targets):
            try:
                await self._fetch_write_publish(code, kis)
            except Exception as e:  # noqa: BLE001
                error_count += 1
                last_error = f"{type(e).__name__}: {e}"
                _log.exception("live.rest30.code_failed code=%s", code)

        await self._writer.fsync_all()
        self._last_cycle_ms = self._now_ms()
        self._last_error = last_error
        self._last_error_count = error_count

    async def _fetch_write_publish(self, code: str, kis: KisRestCaptureProto) -> None:
        now_ms = self._now_ms()
        phase = self._phase_fn()
        date = self._date_fn()

        ob = await kis.fetch_orderbook(code)
        trades = await kis.fetch_trades(code)
        brokers = await kis.fetch_brokers(code)

        snapshots = [
            ob_to_snapshot(ob, phase=phase),
            *trades_to_snapshots(trades, phase=phase),
            brokers_to_snapshot(brokers, now_ms=now_ms, phase=phase),
        ]
        await self._writer.append(date, code, snapshots)
        await self._buffer.publish(code, snapshots, now_ms=now_ms)
