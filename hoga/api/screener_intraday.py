from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.live import kis_access
from hoga.live.kis_capacity_runtime import ensure_kis_capacity_scheduler

_SCHEMA = {
    "code": pl.Utf8,
    "date": pl.Date,
    "open": pl.Float64,
    "high": pl.Float64,
    "low": pl.Float64,
    "close": pl.Float64,
    "volume": pl.Int64,
}
_CODE_LEN = 6


@dataclass(frozen=True)
class IntradayDailyOverlay:
    rows: pl.DataFrame
    fetched_at_ms: int | None
    warnings: list[str]


_CACHE: dict[tuple[Path, str, tuple[str, ...]], IntradayDailyOverlay] = {}
_CACHE_AT: dict[tuple[Path, str, tuple[str, ...]], int] = {}
_LOCKS: dict[tuple[Path, str, tuple[str, ...]], asyncio.Lock] = {}


def _empty(warnings: list[str] | None = None) -> IntradayDailyOverlay:
    return IntradayDailyOverlay(
        rows=pl.DataFrame(schema=_SCHEMA),
        fetched_at_ms=None,
        warnings=warnings or [],
    )


def intraday_overlay_bypassed(data_dir: Path) -> bool:
    return kis_access.kis_rest_bypass_enabled(data_dir)


def _date(yyyymmdd: str) -> dt.date:
    return dt.datetime.strptime(yyyymmdd, "%Y%m%d").date()


def _has_valid_price_ohlc(q) -> bool:
    nums = [q.price, q.open, q.high, q.low]
    return (
        all(isinstance(v, int) and v > 0 for v in nums)
        and q.high >= max(q.open, q.price)
        and q.low <= min(q.open, q.price)
    )


async def build_intraday_overlay(
    *,
    data_dir: Path,
    codes: list[str],
    today: str,
    now_ms: int,
    ttl_ms: int = 15_000,
) -> IntradayDailyOverlay:
    unique_codes = tuple(
        sorted({c for c in codes if isinstance(c, str) and len(c) == _CODE_LEN})
    )
    if not unique_codes or intraday_overlay_bypassed(data_dir):
        warnings = ["kis_rest_bypassed_intraday_overlay_skipped"] if unique_codes else None
        return _empty(warnings)
    key = (data_dir, today, unique_codes)
    cached = _CACHE.get(key)
    cached_at = _CACHE_AT.get(key)
    if cached is not None and cached_at is not None and now_ms - cached_at <= ttl_ms:
        return cached

    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _CACHE.get(key)
        cached_at = _CACHE_AT.get(key)
        if cached is not None and cached_at is not None and now_ms - cached_at <= ttl_ms:
            return cached

        if not kis_access.has_rest_capacity(data_dir):
            return _empty(["intraday_kis_unavailable"])

        try:
            quotes = await kis_access.run_with_capacity(
                ensure_kis_capacity_scheduler(data_dir),
                data_dir=data_dir,
                key=("screener-intraday", today, unique_codes),
                endpoint=kis_access.KisRestEndpoint.QUOTES,
                priority="background",
                cooldown_scope="quotes",
                fetch_fn=lambda client: client.fetch_multi_price(list(unique_codes)),
            )
        except Exception:
            return _empty(["intraday_quote_fetch_failed"])

        rows = []
        invalid = False
        volume_unavailable = False
        d = _date(today)
        for q in quotes:
            if not _has_valid_price_ohlc(q):
                invalid = True
                continue
            if not isinstance(q.volume, int) or q.volume <= 0:
                volume_unavailable = True
                continue
            rows.append({
                "code": q.code,
                "date": d,
                "open": float(q.open),
                "high": float(q.high),
                "low": float(q.low),
                "close": float(q.price),
                "volume": int(q.volume),
            })
        warnings = []
        if invalid:
            warnings.append("intraday_quote_invalid")
        if volume_unavailable:
            warnings.append("intraday_volume_unavailable")
        overlay = IntradayDailyOverlay(
            rows=pl.DataFrame(rows, schema=_SCHEMA) if rows else pl.DataFrame(schema=_SCHEMA),
            fetched_at_ms=now_ms,
            warnings=warnings,
        )
        _CACHE[key] = overlay
        _CACHE_AT[key] = now_ms
        return overlay
