"""Background collector for stock-level KIS program-trade rows."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hoga.api.watchlist import load_document
from hoga.api.watchlist_projection import capture_ordered_codes

from . import kis_access
from .kis_client import KisClient
from .error_policy import classify_live_error, format_live_error
from .program_trade_store import ProgramTradeStore
from .session_gate import ws_capture_window

log = logging.getLogger(__name__)


@dataclass(slots=True)
class ProgramTradeCollectorStatus:
    running: bool = False
    targets: tuple[str, ...] = ()
    last_cycle_ms: int | None = None
    last_error: str | None = None
    last_error_kind: str | None = None
    last_error_code: str | None = None
    last_error_count: int = 0


class KisRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: kis_access.KisRequestPriority,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ): ...


class ProgramTradeCollector:
    def __init__(
        self,
        *,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int],
        scheduler: KisRestScheduler | None = None,
        should_collect_fn: Callable[[int], bool] = ws_capture_window,
        poll_interval_s: float = 30.0,
    ) -> None:
        self.data_dir = data_dir
        self.store = ProgramTradeStore(data_dir, poll_interval_ms=int(poll_interval_s * 1000))
        self._date_fn = date_fn
        self._now_ms_fn = now_ms_fn
        self._scheduler = scheduler
        self._should_collect_fn = should_collect_fn
        self._poll_interval_s = poll_interval_s
        self.status = ProgramTradeCollectorStatus()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="program-trade-collector")
        self.status.running = True

    async def stop(self) -> None:
        task = self._task
        self.status.running = False
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception:
                log.exception("program_trade.collector.cycle_failed")
            await asyncio.sleep(self._poll_interval_s)

    async def run_once(self) -> None:
        self.status.last_error = None
        self.status.last_error_kind = None
        self.status.last_error_code = None
        self.status.last_error_count = 0
        doc = load_document(self.data_dir)
        codes = capture_ordered_codes(doc)
        self.status.targets = tuple(codes)
        date = self._date_fn()
        observed_at_ms = self._now_ms_fn()
        if not self._should_collect_fn(observed_at_ms):
            self.status.last_cycle_ms = observed_at_ms
            return

        for code in codes:
            try:
                rows = await kis_access.run_with_capacity(
                    self._scheduler,
                    data_dir=self.data_dir,
                    role="background",
                    key=("program-trade", code),
                    endpoint=kis_access.KisRestEndpoint.PROGRAM_TRADE,
                    priority="background",
                    cooldown_scope="program-trade",
                    fetch_fn=lambda client, code=code: client.fetch_program_trade_by_stock(code),
                )
                self.store.merge_response(
                    code=code,
                    date=date,
                    rows=rows,
                    observed_at_ms=observed_at_ms,
                )
            except Exception as e:  # noqa: BLE001 — per-code failures must stay local.
                policy = classify_live_error(e)
                self.status.last_error = f"{code}: {format_live_error(e)}"
                self.status.last_error_kind = policy.kind
                self.status.last_error_code = policy.code
                self.status.last_error_count += 1
                log_msg = "program_trade.collector.code_failed code=%s kind=%s error=%s"
                if policy.include_traceback:
                    log.error(log_msg, code, policy.kind, policy.code, exc_info=True)
                else:
                    log.warning(log_msg, code, policy.kind, policy.code)

        self.status.last_cycle_ms = observed_at_ms
