"""Background collector for stock-level KIS program-trade rows."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from hoga.api.watchlist import load_document
from hoga.api.watchlist_projection import capture_ordered_codes

from . import kis_access
from .program_trade_store import ProgramTradeStore

log = logging.getLogger(__name__)


@dataclass(slots=True)
class ProgramTradeCollectorStatus:
    running: bool = False
    targets: tuple[str, ...] = ()
    last_cycle_ms: int | None = None
    last_error: str | None = None
    last_error_count: int = 0


class ProgramTradeCollector:
    def __init__(
        self,
        *,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int],
        poll_interval_s: float = 30.0,
    ) -> None:
        self.data_dir = data_dir
        self.store = ProgramTradeStore(data_dir, poll_interval_ms=int(poll_interval_s * 1000))
        self._date_fn = date_fn
        self._now_ms_fn = now_ms_fn
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
        doc = load_document(self.data_dir)
        codes = capture_ordered_codes(doc)
        self.status.targets = tuple(codes)
        self.status.last_error = None
        self.status.last_error_count = 0
        date = self._date_fn()
        observed_at_ms = self._now_ms_fn()

        for code in codes:
            try:
                rows = await kis_access.fetch_for_role(
                    "background",
                    self.data_dir,
                    lambda client, code=code: client.fetch_program_trade_by_stock(code),
                )
                self.store.merge_response(
                    code=code,
                    date=date,
                    rows=rows,
                    observed_at_ms=observed_at_ms,
                )
            except Exception as e:  # noqa: BLE001 — per-code failures must stay local.
                self.status.last_error = f"{code}: {e}"
                self.status.last_error_count += 1
                log.warning("program_trade.collector.code_failed code=%s error=%s", code, e)

        self.status.last_cycle_ms = observed_at_ms
