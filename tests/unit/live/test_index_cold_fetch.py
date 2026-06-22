from __future__ import annotations

import asyncio

import pytest

from hoga.live.index_cold_fetch import (
    fetch_index_daily_candles_windowed,
    plan_index_cold_fetch_ranges,
)
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint


def point(t_ms: int, close: float) -> IndexCandlePoint:
    return IndexCandlePoint(
        t_ms=t_ms,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=1,
    )


def test_daily_planner_splits_long_cold_range_into_quarters() -> None:
    assert plan_index_cold_fetch_ranges("20240101", "20241231", "D") == [
        ("20240101", "20240331"),
        ("20240401", "20240630"),
        ("20240701", "20240930"),
        ("20241001", "20241231"),
    ]


def test_weekly_and_monthly_use_single_range() -> None:
    assert plan_index_cold_fetch_ranges("20240101", "20241231", "W") == [
        ("20240101", "20241231")
    ]
    assert plan_index_cold_fetch_ranges("20240101", "20241231", "M") == [
        ("20240101", "20241231")
    ]


@pytest.mark.asyncio
async def test_windowed_fetch_runs_daily_ranges_with_bounded_concurrency_and_sorts_unique_rows() -> None:
    active = 0
    max_active = 0
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        calls.append((from_s, to_s))
        call_no = len(calls)
        await asyncio.sleep(0)
        active -= 1
        close = float(call_no)
        return IndexCandleFetchResult(
            candles=[point(call_no, close), point(1, 99.0)]
        )

    result = await fetch_index_daily_candles_windowed(
        "20240101",
        "20241231",
        "D",
        fetch_batch,
        max_concurrency=2,
    )

    assert calls == [
        ("20240101", "20240331"),
        ("20240401", "20240630"),
        ("20240701", "20240930"),
        ("20241001", "20241231"),
    ]
    assert max_active == 2
    assert [c.t_ms for c in result.candles] == [1, 2, 3, 4]
