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
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from .buffer import LiveBuffer
from .kis_client import KIS_KST, KisApiError, KisClient, KisRateLimitError
from .kis_models import KisBrokers, KisOrderbook, KisTrade
from .session_gate import market_phase as _market_phase
from .session_gate import should_run_now as _should_poll_now
from .snapshot import LiveSnapshot
from .writer import LiveWriter

_log = logging.getLogger(__name__)


def _now_ms() -> int:
    """Module-level for monkeypatch in tests."""
    return int(datetime.now(UTC).timestamp() * 1000)


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

            # Typed builders (SR-1): the (KisOrderbook, list[KisTrade],
            # KisBrokers) inputs flow into the snapshot through a typed seam, so
            # a KIS field rename is a type error here rather than a zeroed
            # parquet column at promote. JSONL output is byte-identical to the
            # old hand-rolled model_dump()+phase path (pinned by test_snapshot).
            snaps = [
                LiveSnapshot.from_orderbook(ob, phase=phase),
                LiveSnapshot.from_trades(trades, t_ms=ob.t_ms, phase=phase),
                LiveSnapshot.from_brokers(brokers, t_ms=ob.t_ms, phase=phase),
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

        ADR-0064: the loop body (gate + cycle) is wrapped so a transient raise
        — a flaky calendar/KRX call, a bug in a cycle — logs and continues to
        the next tick instead of silently killing the task. Before this guard,
        a single unhandled exception ended live capture for the whole process
        while ``get_status()`` still reported ``running=true`` (the task object
        was retained, so even the "exception never retrieved" warning was
        suppressed). ``CancelledError`` (BaseException, not Exception) is NOT
        caught, so ``stop_live_poller``'s cancel still terminates the loop.
        Mirrors the supervised ``today-promoter`` loop in lifecycle.py.
        """
        while True:
            start = _now_ms()
            try:
                if not _should_poll_now(start):
                    await asyncio.sleep(1.0)
                    continue
                await self.run_one_cycle()
                elapsed_s = (_now_ms() - start) / 1000.0
                await asyncio.sleep(max(0.0, self._cfg.cycle_seconds - elapsed_s))
            except Exception:  # noqa: BLE001 — one bad tick must not kill capture
                _log.exception("live.poller.run_forever_tick_failed")
                # Back off one cycle window so a hard-looping failure (e.g. the
                # gate raising every call) doesn't spin the CPU or spam the log.
                await asyncio.sleep(self._cfg.cycle_seconds)
