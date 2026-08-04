from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_investor, kiwoom_rest_runtime
from hoga.live.index_registry import get_representative_index
from hoga.live.investor import InvestorNetPoint
from hoga.live.kiwoom_errors import KiwoomRateLimitError
from hoga.live.live_index_investor_net import LiveIndexInvestorNetFetcher


class _FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    async def fetch_market_investor_net(
        self,
        _client,
        index,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> list[InvestorNetPoint]:
        # **평평한 리스트다** — 종목별(ka10059)의 FetchResult 와 모양이 다르다.
        # ka10051 은 날짜당 한 콜이라 불변식 위반 개념이 없다(#1041).
        self.calls.append((index.id, from_yyyymmdd, to_yyyymmdd))
        return [
            InvestorNetPoint(
                t_ms=1_718_574_400_000, foreign_net=-3519, institution_net=17184,
            )
        ]


class _RecordingScheduler:
    def __init__(self, *, raise_rate_limit: bool = False) -> None:
        self.raise_rate_limit = raise_rate_limit
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[object | None], Awaitable],
    ):
        self.calls.append(
            {
                "key": key,
                "api_id": api_id,
                "priority": priority,
            }
        )
        if self.raise_rate_limit:
            raise KiwoomRateLimitError("simulated 1700 유량 초과")
        return await call(None)


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 2점(클라이언트 조달·어댑터 함수)을 갈아끼운다."""
    def _install(fake: _FakeKis) -> _FakeKis:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda _d, **_k: object()
        )
        monkeypatch.setattr(
            kiwoom_investor, "fetch_market_investor_net", fake.fetch_market_investor_net
        )
        return fake

    return _install


@pytest.mark.asyncio
async def test_live_index_investor_net_schedules_background_request(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeKis())
    scheduler = _RecordingScheduler()
    fetcher = LiveIndexInvestorNetFetcher(
        data_dir=tmp_path,
        scheduler=scheduler,  # type: ignore[arg-type]
    )

    result = await fetcher.fetch(
        index=get_representative_index("KOSDAQ"),
        from_label="20260619",
        to_label="20260619",
    )

    assert result["index_id"] == "KOSDAQ"
    assert result["points"] == [
        {
            "t_ms": 1_718_574_400_000,
            "foreign_net": -3519,
            "institution_net": 17184,
        }
    ]
    assert result["data_warnings"] == []
    assert kis.calls == [("KOSDAQ", "20260619", "20260619")]
    assert scheduler.calls == [
        {
            "key": ("index-investor-net", "KOSDAQ", "20260619", "20260619"),
            "api_id": "ka10051",
            "priority": "background",
        }
    ]


@pytest.mark.asyncio
async def test_live_index_investor_net_surfaces_rate_limit_warning(tmp_path, kiwoom) -> None:
    kiwoom(_FakeKis())
    scheduler = _RecordingScheduler(raise_rate_limit=True)
    fetcher = LiveIndexInvestorNetFetcher(
        data_dir=tmp_path,
        scheduler=scheduler,  # type: ignore[arg-type]
    )

    result = await fetcher.fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260619",
        to_label="20260619",
    )

    assert result["points"] == []
    assert result["data_warnings"] == [
        {
            "batch": "20260619__20260619",
            "reason": "rate_limit_upstream",
            "msg": "simulated 1700 유량 초과",
        }
    ]
