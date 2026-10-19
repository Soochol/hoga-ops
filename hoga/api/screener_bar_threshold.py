"""Candle turnover estimates and explicitly referenced price changes."""
from __future__ import annotations

import asyncio
import bisect
import datetime as dt
import logging
import math
from dataclasses import replace
from decimal import Decimal

import polars as pl

from hoga.api import screener_bar_price, screener_exclusions, trading_days
from hoga.api.models import BarChangeMatch, BarTradeValueMatch, ScreenerOccurrence
from hoga.api.screener_bar_policy import RANGE_PARAMS, TRADE_VALUE_TYPES, lookback
from hoga.api.screener_write_lock import screener_read_lock
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

def estimate(bar) -> float | None:
    if not screener_bar_price.valid_prices(bar) or not math.isfinite(bar.volume) or bar.volume < 0:
        return None
    return (bar.open + bar.high + bar.low + bar.close) / 4 * bar.volume


def _occurrence(leaf, bar, **evidence):
    return ScreenerOccurrence(condition_id=leaf.id, condition_key=screener_exclusions.condition_key(leaf),
        date=dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat(),
        bar_start_ms=bar.start_ms, **evidence)


def turnover_records(leaf, bars, *, fetched_at_ms):
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    historical = isinstance(p, RANGE_PARAMS)
    selected = bars if historical else bars[-lookback(leaf):]
    complete = bool(selected) and (historical or len(selected) >= lookback(leaf))
    events = []
    minimum = float(Decimal(str(p.min_eok)) * 100_000_000)
    for bar in selected:
        day = dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat()
        if historical and not p.start_date <= day <= p.end_date:
            continue
        value = bar.trade_value_won
        if value is None and p.timeframe not in {"W", "M"}:
            value = estimate(bar)
        if not bar.valid or value is None or not math.isfinite(value) or value < 0:
            complete = False
            continue
        if value >= minimum:
            events.append(_occurrence(leaf, bar, bar_trade_value_match=BarTradeValueMatch(
                timeframe=p.timeframe, trade_value_won=value,
                method="daily_estimate_sum" if p.timeframe in {"W", "M"} else "ohlcv_estimate",
                is_open=bar.is_open, fetched_at_ms=fetched_at_ms)))
    if historical and not any(p.start_date <= dt.datetime.fromtimestamp(b.start_ms / 1000, KST).date().isoformat()
                              <= p.end_date for b in selected):
        complete = False
    return events, complete


def change_records(leaf, bars, *, fetched_at_ms):
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    if not bars:
        return [], False
    bar = bars[-1]
    if not bar.valid or not screener_bar_price.valid_prices(bar):
        return [], False
    reference, reference_ms = None, None
    if p.change_reference == "bar_open":
        reference, reference_ms = bar.open, bar.start_ms
    elif p.change_reference == "previous_bar":
        if len(bars) > 1 and bars[-2].valid and screener_bar_price.valid_prices(bars[-2]):
            reference, reference_ms = bars[-2].close, bars[-2].start_ms
    else:
        reference, reference_ms = bar.previous_day_close, bar.previous_day_ms
    if reference is None or reference_ms is None or not math.isfinite(reference) or reference <= 0:
        return [], False
    change = (bar.close - reference) / reference * 100
    matched = (p.lo <= change <= p.hi if p.op == "between" else
               change >= p.pct if p.op == "gte" else change <= p.pct)
    if not matched:
        return [], True
    return [_occurrence(leaf, bar, bar_change_match=BarChangeMatch(
        timeframe=p.timeframe, change_reference=p.change_reference, change_pct=change,
        close=bar.close, reference_close=reference, reference_start_ms=reference_ms,
        is_open=bar.is_open, fetched_at_ms=fetched_at_ms))], True


def _raw_references(data_dir, code, bars):
    """Require the actual prior trading day's row, never an arbitrary older close."""
    days = sorted(dt.datetime.strptime(day, "%Y%m%d").date()
                  for day in trading_days.trading_days(data_dir))
    wanted = {}
    for bar in bars:
        day = dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date()
        index = bisect.bisect_left(days, day)
        if 0 < index < len(days) and days[index] == day:
            wanted[bar.start_ms] = days[index - 1]
    path = data_dir / "screener/daily_unadjusted.parquet"
    if not wanted or not path.exists():
        return {}
    with screener_read_lock(data_dir / "screener"):
        data = (pl.scan_parquet(path).filter((pl.col("code") == code) & pl.col("date").is_in(set(wanted.values())))
                .select("date", "close").collect())
    closes = dict(data.iter_rows())
    out = {}
    for bar in bars:
        prior = wanted.get(bar.start_ms)
        value = closes.get(prior)
        if value is not None and math.isfinite(value) and value > 0:
            stamp = int(dt.datetime.combine(prior, dt.time(9), KST).timestamp() * 1000)
            out[bar.start_ms] = replace(bar, start_ms=stamp, valid=True, is_open=False, volume=0,
                                        open=value, high=value, low=value, close=value)
    return out


async def prepare_minutes(leaf, data, data_dir, code, anchor):
    if leaf.type in TRADE_VALUE_TYPES:
        return data, None  # Price adjustment with unadjusted volume would corrupt turnover.
    references = {}
    if leaf.type == "change_pct" and leaf.params.change_reference == "previous_day":
        try:
            references = await asyncio.to_thread(_raw_references, data_dir, code, data)
        except Exception:
            log.exception("스크리너 전일 종가 읽기 실패: %s", code)
    raw = [*data, *references.values()]
    adjusted, reason = await screener_bar_price.adjusted_minutes(data_dir, code, raw, anchor)
    result = adjusted[:len(data)]
    by_stamp = dict(zip(references, adjusted[len(data):], strict=True))
    if leaf.type == "change_pct" and leaf.params.change_reference == "previous_day":
        result = [replace(bar,
            previous_day_close=by_stamp[bar.start_ms].close if bar.start_ms in by_stamp
                               and by_stamp[bar.start_ms].valid else None,
            previous_day_ms=by_stamp[bar.start_ms].start_ms if bar.start_ms in by_stamp else None)
                  for bar in result]
        if any(bar.previous_day_close is None for bar in result):
            reason = reason or "missing_reference"
    return result, reason
