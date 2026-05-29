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
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal

from .buffer import LiveBuffer
from .kis_client import KIS_KST, KisApiError, KisClient, KisRateLimitError
from .kis_models import KisBrokers, KisOrderbook, KisTrade
from .snapshot import LiveSnapshot, SnapshotKind
from .writer import LiveWriter

_log = logging.getLogger(__name__)

def _now_ms() -> int:
    """Module-level for monkeypatch in tests."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _market_phase(t_ms: int) -> Literal["regular", "after_hours_closing", "closed"]:
    """KRX session phase by clock alone (no calendar awareness).

    regular: 09:00-15:30 KST
    after_hours_closing: 15:30-16:00 KST
    closed: everything else

    Calendar-aware gating (holidays, weekends) lives in :func:`_should_poll_now`
    so the phase predicate stays pure and reusable from non-poller contexts.
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    if h == 15 and m >= 30:
        return "after_hours_closing"
    if 9 <= h < 16:
        return "regular"
    return "closed"


def _should_poll_now(t_ms: int) -> bool:
    """Calendar + clock gate: True only when KRX is *probably* trading right now.

    Lenient on missing calendar data — when :func:`calendar.is_trading_day`
    returns None (KRX creds missing, pykrx flaked), defer to the clock alone.
    Losing live capture for a transient KRX outage is a worse failure than
    the noise from a brief burst of HTTP_500s on a stale day.
    """
    if _market_phase(t_ms) == "closed":
        return False
    from hoga.api.calendar import is_trading_day
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    verdict = is_trading_day(kst.strftime("%Y%m%d"))
    return verdict is not False


@dataclass(frozen=True)
class LivePollerConfig:
    codes_fn: Callable[[], list[str]]
    date_fn: Callable[[], str]
    cycle_seconds: float = 20.0


class LivePoller:
    def __init__(
        self,
        kis: KisClient,
        writer: LiveWriter,
        cfg: LivePollerConfig,
        *,
        buffer: LiveBuffer | None = None,
    ):
        self._kis = kis
        self._writer = writer
        self._cfg = cfg
        self._buffer = buffer
        self._last_cycle_lag_ms = 0
        self._last_tick_ms: int | None = None
        self._kis_calls_today = 0
        self._calls_reset_date_kst: str | None = None
        # Starvation guard (Eng C6)
        self._last_success_cycle: dict[str, int] = {}
        self._cycle_counter = 0
        # Diagnostic only: per-code KisApiError streak. Surfaced in the
        # error log so a week of production data can answer "do we need
        # ADR-0042-style quarantine on the hot path?". Increments on
        # KisApiError, resets on a successful cycle. Not touched by rate-
        # limit or unexpected-exception paths — those are system-wide
        # signals, not per-code defects.
        self._consecutive_fails: dict[str, int] = {}

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

    async def _fetch_with_backoff(
        self, code: str, phase: str
    ) -> tuple[KisOrderbook, list[KisTrade], KisBrokers] | None:
        """Fetch ob+trades+brokers for one code per phase. Returns None on
        any failure so the cycle moves on to the next code.

        EGW00201 retry was originally implemented here (Audit-4: 1s/2s/4s
        backoff for up to 3 retries). It has been moved INTO ``KisClient._get``
        (ADR-0050) so every KIS caller — poller, /past-candles, /past-daily-
        candles — receives the same retry contract automatically. From the
        poller's view: a successful retry inside the client is invisible
        (just a longer wall-clock); only an exhausted retry surfaces here
        as ``KisRateLimitError``, which now means "client gave up too" and
        the right move is to drop this code from this cycle and try again
        next tick.
        """
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
            _log.warning("live.poller.rate_limit_giveup code=%s", code)
            return None
        except KisApiError as e:
            streak = self._consecutive_fails.get(code, 0) + 1
            self._consecutive_fails[code] = streak
            _log.error(
                "live.poller.kis_error code=%s msg_cd=%s streak=%d",
                code, e.msg_cd, streak,
            )
            return None
        except Exception:  # noqa: BLE001 — one bad cycle must not kill the poller task
            _log.exception("live.poller.unexpected_error code=%s", code)
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
            self._consecutive_fails.pop(code, None)

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
            if self._buffer is not None:
                await self._buffer.publish(code, snaps)

        await self._writer.fsync_all()
        self._last_tick_ms = _now_ms()
        elapsed_ms = self._last_tick_ms - start_ms
        self._last_cycle_lag_ms = max(0, elapsed_ms - int(self._cfg.cycle_seconds * 1000))

    async def run_forever(self) -> None:
        """Loop run_one_cycle, sleeping the remainder of each cycle window.

        When KRX is closed (off-hours, weekends, holidays), sleep 1s between
        gate checks instead of running a cycle — at market open the first
        cycle lands within ~1s, avoiding ~10s of missed opening-session data
        that a coarser tick would lose.
        """
        while True:
            start = _now_ms()
            if not _should_poll_now(start):
                await asyncio.sleep(1.0)
                continue
            await self.run_one_cycle()
            elapsed_s = (_now_ms() - start) / 1000.0
            await asyncio.sleep(max(0.0, self._cfg.cycle_seconds - elapsed_s))
