"""Persisted 30-second KIS REST recorder for capture-enabled watchlist targets."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from hoga.live.buffer import LiveBuffer
from hoga.live.kis_client import KisApiError, KisAuthError, KisRateLimitError
from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade
from hoga.live.lifecycle import get_signal_alert_monitor
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
        backoff_cycles: int = 3,
    ) -> None:
        self._resolve_kis = kis_resolver
        self._buffer = buffer
        self._writer = make_rest30_writer(data_dir)
        self._date_fn = date_fn
        self._now_ms = now_ms_fn or (lambda: int(time.time() * 1000))
        self._phase_fn = phase_fn
        self._interval_s = interval_s
        self._backoff_cycles = max(0, backoff_cycles)
        self._targets: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._last_cycle_ms: int | None = None
        self._last_error: str | None = None
        self._last_error_count = 0
        self._closed_snapshotted_once: set[str] = set()
        self._trade_seen: dict[str, tuple[str, Counter[tuple[int, int, int, int]]]] = {}
        self._backoff_remaining = 0

    def set_targets(self, codes: set[str]) -> None:
        self._targets = set(codes)
        self._closed_snapshotted_once &= self._targets
        for code in list(self._trade_seen):
            if code not in self._targets:
                del self._trade_seen[code]

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
        if self._backoff_remaining > 0:
            self._backoff_remaining -= 1
            self._last_cycle_ms = self._now_ms()
            return

        phase = self._phase_fn()
        targets = set(self._targets)
        closed = phase == "closed"
        if closed:
            targets -= self._closed_snapshotted_once
        else:
            self._closed_snapshotted_once.clear()

        if not targets:
            self._last_cycle_ms = self._now_ms()
            self._last_error_count = 0
            self._last_error = None
            return

        kis = self._resolve_kis()
        if kis is None:
            self._last_cycle_ms = self._now_ms()
            self._last_error = "kis_unavailable"
            self._last_error_count = 1 if self._targets else 0
            return

        error_count = 0
        last_error: str | None = None
        for code in sorted(targets):
            try:
                await self._fetch_write_publish(code, kis, phase=phase)
                if closed:
                    self._closed_snapshotted_once.add(code)
            except Exception as e:  # noqa: BLE001
                error_count += 1
                last_error = f"{type(e).__name__}: {e}"
                if isinstance(e, (KisAuthError, KisRateLimitError)):
                    self._backoff_remaining = max(
                        self._backoff_remaining,
                        self._backoff_cycles,
                    )
                if isinstance(e, KisApiError):
                    _log.warning(
                        "live.rest30.api_code_failed code=%s error=%s",
                        code,
                        e.msg_cd,
                    )
                else:
                    _log.exception("live.rest30.code_failed code=%s", code)

        await self._writer.fsync_all()
        self._last_cycle_ms = self._now_ms()
        self._last_error = last_error
        self._last_error_count = error_count

    async def _fetch_write_publish(
        self,
        code: str,
        kis: KisRestCaptureProto,
        *,
        phase: str,
    ) -> None:
        now_ms = self._now_ms()
        date = self._date_fn()

        ob = await kis.fetch_orderbook(code)
        monitor = get_signal_alert_monitor()
        if monitor is not None:
            monitor.ingest_orderbook(
                code=code,
                name=code,
                t_ms=ob.t_ms,
                total_ask_qty=ob.total_ask_qty,
                source="rest",
            )
        trades = await kis.fetch_trades(code)
        brokers = await kis.fetch_brokers(code)
        trades = self._dedupe_trades(code, date, trades)

        snapshots = [
            ob_to_snapshot(ob, phase=phase),
            *trades_to_snapshots(trades, phase=phase),
            brokers_to_snapshot(brokers, now_ms=now_ms, phase=phase),
        ]
        await self._writer.append(date, code, snapshots)
        await self._buffer.publish(code, snapshots, now_ms=now_ms)

    def _dedupe_trades(
        self,
        code: str,
        date: str,
        trades: list[KisTrade],
    ) -> list[KisTrade]:
        seen_date, seen = self._trade_seen.get(code, (date, Counter()))
        if seen_date != date:
            seen = Counter()
        emitted_this_batch: Counter[tuple[int, int, int, int]] = Counter()
        fresh: list[KisTrade] = []
        for trade in trades:
            key = (trade.t_ms, trade.price, trade.qty, trade.side)
            emitted_this_batch[key] += 1
            if emitted_this_batch[key] <= seen[key]:
                continue
            fresh.append(trade)
        for key, count in emitted_this_batch.items():
            seen[key] = max(seen[key], count)
        self._trade_seen[code] = (date, seen)
        return fresh
