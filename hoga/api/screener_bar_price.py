"""Price predicates and one-anchor minute adjustment; raw volume is preserved."""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import math
from collections import OrderedDict, deque
from dataclasses import replace

from hoga.api import screener_exclusions
from hoga.api.models import BarPriceMatch, ScreenerOccurrence
from hoga.api.screener_bar_policy import lookback
from hoga.live import kiwoom_access, kiwoom_adjust_factors, kiwoom_rest_runtime, settings
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
_FACTORS: OrderedDict[tuple, kiwoom_adjust_factors.AdjustFactors] = OrderedDict()
_FLIGHTS: dict[tuple, asyncio.Task] = {}
MAX_FACTOR_ENTRIES = 512
PRICE_FIELDS = ("open", "high", "low", "close")


def valid_prices(bar) -> bool:
    values = [getattr(bar, source) for source in PRICE_FIELDS]
    return (all(value is not None and math.isfinite(value) and value > 0 for value in values)
            and bar.high >= max(bar.open, bar.close) and bar.low <= min(bar.open, bar.close))


async def _load_factors(key, data_dir, code, anchor):
    try:
        if settings.rest_bypass_enabled(data_dir):
            return kiwoom_adjust_factors.AdjustFactors(anchor, (), ())
        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            raise ValueError("수정계수 API 연결 설정 없음")
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

        async def paced(upd, fetch_fn):
            return await kiwoom_access.run_with_capacity(
                scheduler, key=("screener-adjust", code, anchor, upd), api_id="ka10081",
                priority="background", client=client, fetch_fn=fetch_fn)

        factors = await kiwoom_adjust_factors.fetch_adjust_factors(
            client, code, as_of_yyyymmdd=anchor, run_call=paced)
        if factors.dates:
            _FACTORS[key] = factors
            _FACTORS.move_to_end(key)
            while len(_FACTORS) > MAX_FACTOR_ENTRIES:
                _FACTORS.popitem(last=False)
        return factors
    except Exception:
        # A shielded factor pair may finish after the requesting scan timed out.
        # Consume failures here as well, so abandoned tasks cannot leak exceptions.
        log.exception("스크리너 수정계수 조회 실패: %s", code)
        return kiwoom_adjust_factors.AdjustFactors(anchor, (), ())
    finally:
        _FLIGHTS.pop(key, None)


async def adjusted_minutes(data_dir, code, bars, anchor):
    """All historical pages share today's factor anchor, never page base_dt."""
    if not any(dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).strftime("%Y%m%d") < anchor
               for bar in bars):
        return bars, None
    key = (data_dir, code, anchor)
    factors = _FACTORS.get(key)
    if factors is None:
        task = _FLIGHTS.get(key)
        if task is None:
            task = asyncio.create_task(_load_factors(key, data_dir, code, anchor))
            _FLIGHTS[key] = task
        try:
            factors = await asyncio.shield(task)
        except Exception:
            log.exception("스크리너 분봉 가격 보정 불가: %s", code)
            factors = kiwoom_adjust_factors.AdjustFactors(anchor, (), ())
    else:
        _FACTORS.move_to_end(key)
    out, reason = [], None
    for bar in bars:
        day = dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).strftime("%Y%m%d")
        factor = 1.0 if day == anchor else factors.factor_for(day)
        if factor is None or not math.isfinite(factor) or factor <= 0:
            out.append(replace(bar, valid=False))
            reason = "adjustment_unavailable"
        else:
            out.append(replace(bar, **{source: (getattr(bar, source) * factor
                if getattr(bar, source) is not None else None) for source in PRICE_FIELDS}))
    return out, reason


def records(leaf, bars, *, fetched_at_ms):
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    period, count = p.period, lookback(leaf)
    source = p.source if leaf.type == "ma" else "high"
    partial_allowed = leaf.type == "high_off_peak"
    complete = len(bars) >= count + period - 1
    start = max(0, len(bars) - count)
    key = screener_exclusions.condition_key(leaf)
    peaks, invalid = deque(), deque()
    total, events = 0.0, []
    valid = [bar.valid and valid_prices(bar) for bar in bars]
    values = [getattr(bar, source) if valid[i] else 0.0 for i, bar in enumerate(bars)]
    for i, bar in enumerate(bars):
        left = max(0, i - period + 1)
        total += values[i]
        if i >= period:
            total -= values[i - period]
        while peaks and peaks[0] < left:
            peaks.popleft()
        while invalid and invalid[0] < left:
            invalid.popleft()
        while peaks and values[peaks[-1]] <= values[i]:
            peaks.pop()
        peaks.append(i)
        if not valid[i]:
            invalid.append(i)
        if i < start:
            continue
        if invalid or (i + 1 < period and not partial_allowed):
            complete = False
            continue
        reference = total / (i - left + 1) if leaf.type == "ma" else values[peaks[0]]
        if leaf.type == "ma":
            matched = values[i] >= reference if p.relation == "above" else values[i] <= reference
        elif partial_allowed:
            boundary = reference * (1 - p.pct / 100)
            matched = values[i] >= boundary if p.side == "within" else values[i] < boundary
        else:
            matched = values[i] >= reference
        if matched:
            events.append(ScreenerOccurrence(condition_id=leaf.id, condition_key=key,
                date=dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat(),
                bar_start_ms=bar.start_ms,
                bar_price_match=BarPriceMatch(timeframe=p.timeframe, source=source, value=values[i],
                    reference=reference, window_start_ms=bars[left].start_ms,
                    is_open=bar.is_open, fetched_at_ms=fetched_at_ms)))
    return events, complete
