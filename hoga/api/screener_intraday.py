from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.live import kis_access, kiwoom_access, kiwoom_multi_quote, kiwoom_rest_runtime

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

        # PR-D(#1040) 칼 컷오버 — 소스는 키움 `ka10095` 다. 쿨다운 스코프 정렬은
        # 더 필요 없다: 키움 유량은 **TR별**이라 같은 api_id 를 쓰는 호출자끼리
        # 자동으로 같은 버킷을 공유한다(#1015). 계정 차원이 사라졌기 때문이다.
        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            return _empty(["intraday_kis_unavailable"])

        try:
            quotes = await kiwoom_access.run_with_capacity(
                kiwoom_rest_runtime.ensure_scheduler(),
                key=("screener-intraday", today, unique_codes),
                api_id="ka10095",
                priority="background",
                client=client,
                fetch_fn=lambda c: kiwoom_multi_quote.fetch_multi_price(
                    c, list(unique_codes)
                ),
            )
        except Exception:  # noqa: BLE001 — 업스트림 경계. 삼키는 게 아니라
            # intraday_quote_fetch_failed 로 응답에 실어 프론트가 표시한다.
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
