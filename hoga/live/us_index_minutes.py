"""Bounded KIS cash-index minute snapshots, never a historical date cursor.

Keep vendor post-close corrections, gaps and fractional points. NY timestamps
are real instants; unlike daily candles these must not use a KST display anchor.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime

import httpx
from pydantic import BaseModel, Field

from hoga.live.kis_errors import KisApiError, KisAuthError, KisRateLimitError, KisTransportError
from hoga.live.us_daily_candles import NY, UsDailyBar, UsDailyStatus, parse_bar

MINUTE_TIMEFRAMES = ("1m", "3m", "5m", "10m", "15m", "30m", "60m")
_MANUAL_RETRY_COOLDOWN_S = 2


def index_refresh_interval_ms(now: datetime) -> int:
    """Polling budget, NOT a holiday/early-close calendar or session assertion."""
    local = now.astimezone(NY)
    return 2000 if local.weekday() not in {5, 6} and (9, 30) <= (local.hour, local.minute) < (17, 20) else 60_000


class UsMinuteMetadata(BaseModel):
    market_timezone: str = "America/New_York"
    source: str = "kis"
    history_scope: str = "latest_snapshot"
    delay_status: str = "unverified"
    session_scope: str = "vendor_regular_including_postclose_corrections"
    available_from_ms: int | None = None
    available_to_ms: int | None = None
    last_successful_check_at_ms: int | None = None
    refresh_status: UsDailyStatus = "normal"
    messages: list[str] = Field(default_factory=list)
    refresh_interval_ms: int = 60_000
    current_daily_candle: UsDailyBar | None = None


def parse_snapshot(body: dict) -> list[UsDailyBar]:
    if body.get("rt_cd") != "0" or not isinstance(body.get("output2"), list):
        raise ValueError("invalid KIS minute envelope")
    seen: dict[int, UsDailyBar] = {}
    for row in body["output2"]:
        if not isinstance(row, dict):
            raise ValueError("invalid KIS minute row")
        if not row or all(v in (None, "", "0", "0.00", "00000000", "000000") for v in row.values()):
            continue
        bar = parse_bar(row, fields=("stck_bsop_date", "optn_oprc", "optn_hgpr", "optn_lwpr", "optn_prpr", "cntg_vol"))
        clock = str(row["stck_cntg_hour"])
        if len(clock) != len("HHMMSS") or not clock.isdigit() or clock[-2:] != "00":
            raise ValueError("invalid KIS minute clock")
        local = datetime.strptime(bar.trading_date + clock, "%Y%m%d%H%M%S").replace(tzinfo=NY)
        bar = bar.model_copy(update={"t_ms": int(local.timestamp() * 1000), "volume": 0})
        if bar.t_ms in seen and seen[bar.t_ms] != bar:
            raise ValueError("conflicting KIS minute timestamps")
        seen[bar.t_ms] = bar
    return sorted(seen.values(), key=lambda b: b.t_ms)


def aggregate_minutes(bars: list[UsDailyBar], timeframe: str) -> list[UsDailyBar]:
    """NY 09:30 aligned buckets. Omit cut prefixes and internal missing minutes.

    Only the final contiguous bucket may be provisional. Never fill vendor gaps
    or treat the first returned minute as a multi-minute opening price.
    """
    size = int(timeframe[:-1])
    if size == 1:
        return bars
    groups: dict[tuple[str, int], list[UsDailyBar]] = {}
    for bar in bars:
        local = datetime.fromtimestamp(bar.t_ms / 1000, NY)
        offset = local.hour * 60 + local.minute - (9 * 60 + 30)
        start_ms = bar.t_ms - (offset % size) * 60_000
        groups.setdefault((bar.trading_date, start_ms), []).append(bar)
    result = []
    for (_, start_ms), rows in groups.items():
        if rows[0].t_ms != start_ms or any(b.t_ms != start_ms + i * 60_000 for i, b in enumerate(rows)):
            continue
        if len(rows) != size and rows[-1] is not bars[-1]:
            continue
        result.append(rows[0].model_copy(update={
            "high": max(b.high for b in rows), "low": min(b.low for b in rows), "close": rows[-1].close,
        }))
    return result


def current_daily_candle(body: dict, bars: list[UsDailyBar], code: str, now: datetime) -> UsDailyBar | None:
    """Use full-day vendor OHLC only when tied to today's minute snapshot."""
    quote = body.get("output1")
    if not bars or bars[-1].trading_date != now.astimezone(NY).strftime("%Y%m%d") or not quote:
        return None
    if not isinstance(quote, dict):
        raise ValueError("invalid index day snapshot")
    if quote.get("stck_shrn_iscd") != code:
        raise ValueError("index day snapshot subject mismatch")
    daily = parse_bar({**quote, "date": bars[-1].trading_date}, fields=(
        "date", "ovrs_prod_oprc", "ovrs_prod_hgpr", "ovrs_prod_lwpr", "ovrs_nmix_prpr", "acml_vol"))
    if daily.close != bars[-1].close:
        raise ValueError("index day/minute snapshot mismatch")
    return daily.model_copy(update={"volume": 0})


@dataclass
class _Snapshot:
    rows: list[UsDailyBar] = field(default_factory=list)
    checked_ms: int | None = None
    retry_at: float = 0
    failed: bool = False
    manual_retry_at: float = float("-inf")
    refreshed_at: float = float("-inf")
    failures: int = 0
    daily_candle: UsDailyBar | None = None


class UsIndexMinuteService:
    """One demand-driven snapshot per supported index, shared across consumers."""

    def __init__(self, *, clock=time.monotonic, wall_clock=time.time) -> None:
        self.clock, self.wall_clock = clock, wall_clock
        self.entries: dict[str, _Snapshot] = {}
        self.pending: dict[str, asyncio.Task] = {}

    def refresh_interval_ms(self, entry: _Snapshot) -> int:
        now = datetime.fromtimestamp(self.wall_clock(), NY)
        interval = index_refresh_interval_ms(now)
        # An old/empty source on a holiday must not acquire a fast polling lease.
        # This is observed data freshness, not a guessed US trading calendar.
        if not entry.rows or entry.rows[-1].trading_date != now.strftime("%Y%m%d"):
            interval = 60_000
        if entry.failed:
            interval = max(interval, min(60_000, 2000 * 2 ** min(entry.failures - 1, 5)))
        return interval

    def retry_failed(self, code: str) -> None:
        entry = self.entries.get(code)
        now = self.clock()
        if (entry and entry.failed and code not in self.pending
                and now - entry.manual_retry_at >= _MANUAL_RETRY_COOLDOWN_S):
            entry.retry_at = 0
            entry.manual_retry_at = now

    async def get(self, code: str, timeframe: str, *, client=None, bypass=False):
        if code not in {"COMP", "SPX", "SOX", "VIX"} or timeframe not in MINUTE_TIMEFRAMES:
            raise ValueError("unsupported US minute index/period")
        entry = self.entries.setdefault(code, _Snapshot())
        if client is not None and not bypass:
            if code in self.pending:
                await asyncio.shield(self.pending[code])
            elif self.clock() >= (entry.retry_at if entry.failed else
                                  entry.refreshed_at + self.refresh_interval_ms(entry) / 1000):
                task = asyncio.create_task(self._refresh(code, client, entry))
                self.pending[code] = task
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
                await asyncio.shield(task)
        status = ("bypass" if bypass else "unconfigured" if client is None else
                  "stale" if entry.failed and entry.checked_ms is not None else "error" if entry.failed else "normal")
        return aggregate_minutes(entry.rows, timeframe), UsMinuteMetadata(
            available_from_ms=entry.rows[0].t_ms if entry.rows else None,
            available_to_ms=entry.rows[-1].t_ms if entry.rows else None,
            last_successful_check_at_ms=entry.checked_ms,
            refresh_status=status,
            refresh_interval_ms=self.refresh_interval_ms(entry),
            current_daily_candle=entry.daily_candle,
            messages=["Latest vendor window only; arbitrary date history is unavailable.",
                      "Delay is unverified. Post-close corrections are retained; the last bucket is provisional."],
        )

    async def _refresh(self, code, client, entry):
        try:
            body = await asyncio.wait_for(client.get_global_index_minute_snapshot(code), timeout=15)
            rows = parse_snapshot(body)
            if entry.rows and (not rows or rows[-1].t_ms < entry.rows[-1].t_ms):
                raise ValueError("empty or regressing index snapshot")
            daily = current_daily_candle(body, rows, code, datetime.fromtimestamp(self.wall_clock(), NY))
            if (entry.daily_candle and rows and entry.daily_candle.trading_date == rows[-1].trading_date
                    and daily is None):
                raise ValueError("missing previously available index day snapshot")
            entry.rows, entry.daily_candle = rows, daily
            entry.checked_ms = int(self.wall_clock() * 1000)
            entry.failed = False
            entry.failures = 0
        except (KisApiError, KisAuthError, KisRateLimitError, KisTransportError, httpx.HTTPError,
                TimeoutError, ValueError, KeyError, TypeError):
            entry.failed = True
            entry.failures += 1
        finally:
            entry.refreshed_at = self.clock()
            entry.retry_at = self.clock() + self.refresh_interval_ms(entry) / 1000
            self.pending.pop(code, None)

    async def aclose(self):
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()
