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


@dataclass
class _Snapshot:
    rows: list[UsDailyBar] = field(default_factory=list)
    checked_ms: int | None = None
    retry_at: float = 0
    failed: bool = False


class UsIndexMinuteService:
    """Three index keys, single-flight and one-minute TTL shared across periods."""

    def __init__(self, *, clock=time.monotonic, wall_clock=time.time) -> None:
        self.clock, self.wall_clock = clock, wall_clock
        self.entries: dict[str, _Snapshot] = {}
        self.pending: dict[str, asyncio.Task] = {}

    async def get(self, code: str, timeframe: str, *, client=None, bypass=False):
        if code not in {"COMP", "SPX", "SOX"} or timeframe not in MINUTE_TIMEFRAMES:
            raise ValueError("unsupported US minute index/period")
        entry = self.entries.setdefault(code, _Snapshot())
        if client is not None and not bypass:
            if code in self.pending:
                await asyncio.shield(self.pending[code])
            elif self.clock() >= entry.retry_at:
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
            messages=["Latest vendor window only; arbitrary date history is unavailable.",
                      "Delay is unverified. Post-close corrections are retained; the last bucket is provisional."],
        )

    async def _refresh(self, code, client, entry):
        try:
            body = await asyncio.wait_for(client.get_global_index_minute_snapshot(code), timeout=15)
            entry.rows = parse_snapshot(body)
            entry.checked_ms = int(self.wall_clock() * 1000)
            entry.failed = False
        except (KisApiError, KisAuthError, KisRateLimitError, KisTransportError, httpx.HTTPError,
                TimeoutError, ValueError, KeyError, TypeError):
            entry.failed = True
        finally:
            entry.retry_at = self.clock() + 60
            self.pending.pop(code, None)

    async def aclose(self):
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()
