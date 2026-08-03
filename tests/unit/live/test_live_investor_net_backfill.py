from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_investor, kiwoom_rest_runtime
from hoga.live.api import batched_daily_walkback
from hoga.live.investor import InvestorNetPoint
from hoga.live.kis_endpoints import InvestorNetFetchResult
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
        _client,
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
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[], Awaitable],
    ):
        # 계정 차원(endpoint·cooldown_scope)은 PR-E(#1041)에서 사라졌다 —
        # 키움 유량은 TR별이라 고를 계정이 없다(#1015). api_id 가 버킷 키다.
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await call()


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 2점을 갈아끼운다 — 클라이언트 조달과 어댑터 함수.

    PR-E(#1041) 이후 소비자는 KIS 클라이언트 객체를 들고 다니지 않는다:
    런타임에서 클라이언트를 받고 **모듈 레벨 어댑터 함수**를 부른다. 그래서
    페이크도 객체가 아니라 그 함수 자리에 꽂는다.
    """
    def _install(fake: _FakeKis) -> _FakeKis:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda _d, **_k: object()
        )
        monkeypatch.setattr(
            kiwoom_investor, "fetch_investor_net", fake.fetch_investor_net
        )
        return fake

    return _install


@pytest.mark.asyncio
async def test_live_investor_net_backfill_schedules_background_request(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeKis())
    scheduler = _RecordingScheduler()
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
            "api_id": "ka10059",
            "priority": "background",
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
        _client,
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
async def test_collect_coalesces_concurrent_same_code_requests(tmp_path, kiwoom) -> None:
    # Two overlapping [from, today] requests for the same code fire at once on a
    # cold cache. Single-flight must serialise them: the first walks upstream, the
    # second reads the warm cache and issues zero upstream calls (240→60 storm
    # collapse). Without coalescing both would fetch while the first is gated.
    kis = kiwoom(_GatedKis())
    scheduler = _RecordingScheduler()
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

    # Exactly one upstream round-trip served both requests.
    assert len(kis.calls) == 1
    assert len(r1["points"]) == 10
    assert len(r2["points"]) == 6
    assert r2["fresh_batches"] == []  # served entirely from the warm cache
    assert r2["cached_batches"] == ["20240101__20240110"]
