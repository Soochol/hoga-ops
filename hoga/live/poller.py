"""Live Poller — watchlist 전체를 N초마다 KIS에서 pull.

Per-cycle work:
  1. Sort codes by _last_success_cycle (starvation guard, Eng C6).
  2. Determine market phase: regular (09:00-15:30) or after_hours_closing
     (15:30-16:00) — Audit-1.
  3. For each code: fetch ob+trades (phase-specific) + brokers in parallel,
     handle rate limits with exponential backoff + retry, write to JSONL.
  4. fsync_all once at the end.

ADR-0038: this module is hot-path. No pyarrow / polars imports allowed.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from .kis_client import KIS_KST, KisApiError, KisClient, KisRateLimitError
from .kis_models import KisOrderbook
from .snapshot import LiveSnapshot, SnapshotKind
from .writer import LiveWriter

_log = logging.getLogger(__name__)

# Audit-4: exponential backoff sequence on EGW00201. Total retries = 3.
_BACKOFF_SECONDS = (1.0, 2.0, 4.0)


def _now_ms() -> int:
    """Module-level for monkeypatch in tests."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _market_phase(t_ms: int) -> str:
    """Returns 'regular' or 'after_hours_closing' (Audit-1).

    regular: 09:00-15:30 KST
    after_hours_closing: 15:30-16:00 KST
    Outside 09:00-16:00 returns 'regular' as a safe default — Poller scheduler
    is responsible for not calling run_one_cycle outside market hours.
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    if h == 15 and m >= 30:
        return "after_hours_closing"
    return "regular"


@dataclass(frozen=True)
class LivePollerConfig:
    codes_fn: Callable[[], list[str]]
    date_fn: Callable[[], str]
    cycle_seconds: float = 10.0


class LivePoller:
    def __init__(
        self, kis: KisClient, writer: LiveWriter, cfg: LivePollerConfig
    ):
        self._kis = kis
        self._writer = writer
        self._cfg = cfg
        self._last_cycle_lag_ms = 0
        self._last_tick_ms: int | None = None
        self._kis_calls_today = 0
        self._calls_reset_date_kst: str | None = None
        # Starvation guard (Eng C6)
        self._last_success_cycle: dict[str, int] = {}
        self._cycle_counter = 0

    @property
    def last_cycle_lag_ms(self) -> int:
        return self._last_cycle_lag_ms

    @property
    def last_tick_ms(self) -> int | None:
        return self._last_tick_ms

    @property
    def kis_calls_today(self) -> int:
        return self._kis_calls_today

    def _reset_daily_counter_if_needed(self) -> None:
        today_kst = datetime.fromtimestamp(_now_ms() / 1000, tz=KIS_KST).strftime("%Y%m%d")
        if self._calls_reset_date_kst != today_kst:
            self._kis_calls_today = 0
            self._calls_reset_date_kst = today_kst

    def _ordered_codes(self) -> list[str]:
        """Starvation-aware order — least-recently-successful first (Eng C6)."""
        codes = list(self._cfg.codes_fn())
        return sorted(codes, key=lambda c: self._last_success_cycle.get(c, -1))

    async def _fetch_with_backoff(self, code: str, phase: str) -> tuple[KisOrderbook, list, object] | None:
        """Fetch ob+trades+brokers with retry on EGW00201 (Audit-4).

        Returns None after exhausting retries.
        """
        for attempt, backoff in enumerate(_BACKOFF_SECONDS):
            try:
                if phase == "after_hours_closing":
                    ob_task = self._kis.fetch_overtime_orderbook(code)
                    trades_task = self._kis.fetch_overtime_trades(code)
                else:
                    ob_task = self._kis.fetch_orderbook(code)
                    trades_task = self._kis.fetch_trades(code)
                brokers_task = self._kis.fetch_brokers(code)
                ob, trades, brokers = await asyncio.gather(ob_task, trades_task, brokers_task)
                return ob, trades, brokers
            except KisRateLimitError:
                _log.warning(
                    "live.poller.rate_limited code=%s attempt=%d backoff_s=%s",
                    code, attempt + 1, backoff,
                )
                # Don't sleep on the last attempt — we're about to give up
                if attempt < len(_BACKOFF_SECONDS) - 1:
                    await asyncio.sleep(backoff)
            except KisApiError as e:
                _log.error("live.poller.kis_error code=%s msg_cd=%s", code, e.msg_cd)
                return None
        _log.error("live.poller.rate_limit_giveup code=%s", code)
        return None

    async def run_one_cycle(self) -> None:
        start_ms = _now_ms()
        self._reset_daily_counter_if_needed()
        self._cycle_counter += 1
        date = self._cfg.date_fn()
        phase = _market_phase(start_ms)

        for code in self._ordered_codes():
            result = await self._fetch_with_backoff(code, phase)
            if result is None:
                continue
            ob, trades, brokers = result
            self._kis_calls_today += 3
            self._last_success_cycle[code] = self._cycle_counter

            ob_payload = ob.model_dump()
            ob_payload["phase"] = phase
            trades_payload: dict = {
                "trades": [t.model_dump() for t in trades],
                "phase": phase,
            }
            brokers_payload = brokers.model_dump()
            brokers_payload["phase"] = phase

            snaps = [
                LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.OB, payload=ob_payload),
                LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.TRADE, payload=trades_payload),
                LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.BROKER, payload=brokers_payload),
            ]
            await self._writer.append(date, code, snaps)

        await self._writer.fsync_all()
        self._last_tick_ms = _now_ms()
        elapsed_ms = self._last_tick_ms - start_ms
        self._last_cycle_lag_ms = max(0, elapsed_ms - int(self._cfg.cycle_seconds * 1000))

    async def run_forever(self) -> None:
        """Loop run_one_cycle, sleeping the remainder of each cycle window."""
        while True:
            start = _now_ms()
            await self.run_one_cycle()
            elapsed_s = (_now_ms() - start) / 1000.0
            await asyncio.sleep(max(0.0, self._cfg.cycle_seconds - elapsed_s))
