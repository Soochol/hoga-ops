"""Serve deterministic vendor rows through the production index history collector."""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import date, datetime, time, timedelta

from hoga.live.candle_fetch_result import IndexCandleFetchResult
from hoga.live.candle_models import IndexCandlePoint
from hoga.live.index_candles_cache import IndexCandlesCache, collect_index_candles_with_cache
from hoga.util.timeenc import KST


def rows(frm: date, to: date) -> list[IndexCandlePoint]:
    candles = []
    day = frm
    while day <= to:
        if day.weekday() < 5:
            close = 3000 + (day - date(2026, 10, 4)).days * .02
            candles.append(IndexCandlePoint(
                t_ms=int(datetime.combine(day, time(9), KST).timestamp() * 1000),
                open=close - 1, high=close + 2, low=close - 2, close=close, volume=100,
            ))
        day += timedelta(days=1)
    return candles


async def response(initial_from: str, requested_from: str, to_s: str) -> dict:
    initial = datetime.strptime(initial_from, "%Y%m%d").date()
    to = datetime.strptime(to_s, "%Y%m%d").date()
    past_to = min(to, date(2026, 10, 3))
    middle = initial + (past_to - initial) // 2
    cache = IndexCandlesCache(max_batches_per_key=2)
    key = ("KOSPI", "D")
    for frm, end in [(initial, middle), (middle + timedelta(days=1), past_to)]:
        cache.append_batch(key, frm, end, rows(frm, end))

    async def fetch(frm: str, end: str) -> IndexCandleFetchResult:
        return IndexCandleFetchResult(candles=rows(
            datetime.strptime(frm, "%Y%m%d").date(), datetime.strptime(end, "%Y%m%d").date(),
        ))

    result = await collect_index_candles_with_cache(
        cache, key, requested_from, to_s, fetch, today=date(2026, 10, 4),
    )
    return {"index_id": "KOSPI", "timeframe": "D", "from": requested_from, "to": to_s,
            "candles": [c.model_dump() for c in result.candles], "data_warnings": []}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(response(*sys.argv[1:]))))
