from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live.api import batched_daily_walkback
from hoga.live.kis_client import InvestorNetFetchResult, KisClient
from hoga.live.kis_models import InvestorNetPoint
from hoga.live.live_investor_net_backfill import LiveInvestorNetBackfill
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


def _investor_points(from_yyyymmdd: str, to_yyyymmdd: str) -> list[InvestorNetPoint]:
    kst = dt.timezone(dt.timedelta(hours=9))
    start = dt.date(
        int(from_yyyymmdd[:4]),
        int(from_yyyymmdd[4:6]),
        int(from_yyyymmdd[6:8]),
    )
    end = dt.date(
        int(to_yyyymmdd[:4]),
        int(to_yyyymmdd[4:6]),
        int(to_yyyymmdd[6:8]),
    )
    out: list[InvestorNetPoint] = []
    cur = start
    while cur <= end:
        out.append(
            InvestorNetPoint(
                t_ms=int(dt.datetime(cur.year, cur.month, cur.day, 9, 0, tzinfo=kst).timestamp() * 1000),
                foreign_net=100,
                institution_net=-50,
            )
        )
        cur = cur + dt.timedelta(days=1)
    return out


class _FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    async def fetch_investor_net(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> InvestorNetFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
        return InvestorNetFetchResult(
            points=_investor_points(from_yyyymmdd, to_yyyymmdd),
            violations=[],
        )


class _RecordingScheduler:
    def __init__(self, kis: _FakeKis) -> None:
        self.kis = kis
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: str,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ):
        self.calls.append(
            {
                "key": key,
                "endpoint": endpoint,
                "priority": priority,
                "cooldown_scope": cooldown_scope,
            }
        )
        return await call(self.kis)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_live_investor_net_backfill_schedules_background_request(tmp_path) -> None:
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveInvestorNetBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
    )

    assert result["fresh_batches"] == ["20240101__20240105"]
    assert len(result["points"]) == 5
    assert result["points"][0]["foreign_net"] == 100
    assert result["points"][0]["institution_net"] == -50
    assert kis.calls == [("005930", "20240101", "20240105")]
    assert scheduler.calls == [
        {
            "key": ("live-investor-net", "005930", "20240101", "20240105"),
            "endpoint": "investor-net",
            "priority": "background",
            "cooldown_scope": "investor-net",
        }
    ]


class _GatedKis(_FakeKis):
    """Blocks inside the first fetch so a second concurrent request can race
    into (or be coalesced out of) the walk-back."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()

    async def fetch_investor_net(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> InvestorNetFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
        await self.gate.wait()
        return InvestorNetFetchResult(
            points=_investor_points(from_yyyymmdd, to_yyyymmdd),
            violations=[],
        )


@pytest.mark.asyncio
async def test_collect_coalesces_concurrent_same_code_requests(tmp_path) -> None:
    # Two overlapping [from, today] requests for the same code fire at once on a
    # cold cache. Single-flight must serialise them: the first walks KIS, the
    # second reads the warm cache and issues zero upstream calls (240→60 storm
    # collapse). Without coalescing both would fetch while the first is gated.
    kis = _GatedKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveInvestorNetBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    async def one(frm: dt.date):
        return await backfill.collect(
            code="005930",
            frm=frm,
            too=dt.date(2024, 1, 10),
            today_d=dt.date(2024, 2, 1),
        )

    t1 = asyncio.create_task(one(dt.date(2024, 1, 1)))
    t2 = asyncio.create_task(one(dt.date(2024, 1, 5)))

    # Spin the loop until the first request is parked inside the gated fetch,
    # proving the second had a chance to enter the walk-back concurrently.
    for _ in range(100):
        await asyncio.sleep(0)
        if kis.calls:
            break
    assert len(kis.calls) == 1

    kis.gate.set()
    r1, r2 = await asyncio.gather(t1, t2)

    # Exactly one KIS round-trip served both requests.
    assert len(kis.calls) == 1
    assert len(r1["points"]) == 10
    assert len(r2["points"]) == 6
    assert r2["fresh_batches"] == []  # served entirely from the warm cache
    assert r2["cached_batches"] == ["20240101__20240110"]
