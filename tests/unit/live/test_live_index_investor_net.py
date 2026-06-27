from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live.index_registry import get_representative_index
from hoga.live.kis_client import InvestorNetFetchResult, KisClient, KisRateLimitError
from hoga.live.kis_models import InvestorNetPoint
from hoga.live.live_index_investor_net import LiveIndexInvestorNetFetcher


class _FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    async def fetch_market_investor_net(
        self,
        index,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> InvestorNetFetchResult:
        self.calls.append((index.id, from_yyyymmdd, to_yyyymmdd))
        return InvestorNetFetchResult(
            points=[
                InvestorNetPoint(
                    t_ms=1_718_574_400_000,
                    foreign_net=-3519,
                    institution_net=17184,
                )
            ],
            violations=[],
        )


class _RecordingScheduler:
    def __init__(self, kis: _FakeKis, *, raise_rate_limit: bool = False) -> None:
        self.kis = kis
        self.raise_rate_limit = raise_rate_limit
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
        if self.raise_rate_limit:
            raise KisRateLimitError("simulated EGW00201")
        return await call(self.kis)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_live_index_investor_net_schedules_background_request(tmp_path) -> None:
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
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
            "endpoint": "index-investor-net",
            "priority": "background",
            "cooldown_scope": "index-investor-net",
        }
    ]


@pytest.mark.asyncio
async def test_live_index_investor_net_surfaces_rate_limit_warning(tmp_path) -> None:
    scheduler = _RecordingScheduler(_FakeKis(), raise_rate_limit=True)
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
            "reason": "kis_rate_limit",
            "msg": "simulated EGW00201",
        }
    ]
