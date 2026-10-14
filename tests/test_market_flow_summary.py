"""전역 하단 바: 최신 순매수·확정값·단위와 수신 상태의 HTTP 계약."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.market_routes import build_router
from hoga.collector.orchestrator import now_kst
from hoga.live.deriv_flow_store import DerivFlowStore, DerivSample
from hoga.live.investor_flow_store import (
    DailyConfirmedFile,
    IntradaySample,
    InvestorFlowStore,
)


async def _get_summary(data_dir):
    app = FastAPI()
    app.include_router(build_router(data_dir=data_dir))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ) as client:
        response = await client.get("/api/market/investor-flow-summary")
    assert response.status_code == 200
    return response.json()


async def test_summary_empty_day_keeps_missing_values_null(tmp_path):
    got = await _get_summary(tmp_path)
    assert got["stock"]["markets"] == {"KOSPI": None, "KOSDAQ": None}
    assert got["futures"]["markets"] == {"F001": None}
    assert got["futures"]["unit"] is None
    assert got["stock"]["confirmed"] is False
    assert "daily" not in got["stock"]


@pytest.mark.parametrize("resolved", [True, False])
async def test_summary_serves_latest_and_confirmed_values_with_safe_futures_units(tmp_path, resolved):
    date = now_kst().strftime("%Y%m%d")
    stock = InvestorFlowStore(tmp_path)
    for stamp, amount in ((1_000, 100), (2_000, 200)):
        stock.append_sample(date, IntradaySample(
            sampled_at_ms=stamp,
            request={"mrkt_tp": "0", "amt_qty_tp": "0", "base_dt": date},
            rows=[{"inds_cd": "001_AL", "ind_netprps": "-10",
                   "frgnr_netprps": str(amount), "orgn_netprps": "0"}],
        ))
    stock.append_sample(date, IntradaySample(
        sampled_at_ms=2_500,
        request={"mrkt_tp": "1", "amt_qty_tp": "0", "base_dt": date},
        rows=[{"inds_cd": "101_AL", "ind_netprps": "10",
               "frgnr_netprps": "-5", "orgn_netprps": "0"}],
    ))
    stock.write_confirmed(DailyConfirmedFile(
        date=date, confirmed_at_ms=3_000, request={},
        rows=[{"inds_cd": "001_AL", "ind_netprps": "-11",
               "frgnr_netprps": "250", "orgn_netprps": "0"}],
    ))
    deriv = DerivFlowStore(tmp_path)
    # 홀수 계약 수는 억원 환산 뒤 소수가 남는다. 정수형 응답 모델의 500 회귀를 잡는다.
    for stamp, net in ((1_000, 5_000), (2_000, 6_001)):
        row = {}
        for actor, legs in {"frgn": (60_000, 58_000), "prsn": (30_000, 31_000),
                            "orgn": (40_000, 41_000)}.items():
            for side, qty in zip(("seln", "shnu"), legs, strict=True):
                row[f"{actor}_{side}_vol"] = str(qty if resolved else qty * 0.001)
                row[f"{actor}_{side}_tr_pbmn"] = str(qty * 975 * 250_000 / 1e6)
            actor_net = -net if actor == "prsn" else net if actor == "frgn" else 0
            row[f"{actor}_ntby_qty"] = str(actor_net)
            row[f"{actor}_ntby_tr_pbmn"] = str(actor_net * 975 * 250_000 / 1e6)
        deriv.append_sample(date, DerivSample(
            sampled_at_ms=stamp, product="F001", request={}, row=row,
        ))

    got = await _get_summary(tmp_path)
    assert got["stock"]["confirmed"] is True
    assert got["stock"]["markets"]["KOSPI"]["foreign"] == 250
    assert got["stock"]["markets"]["KOSDAQ"]["foreign"] == -5
    point = got["futures"]["markets"]["F001"]
    assert point["t_ms"] == 2_000
    assert point["foreign"] == (14_627.4375 if resolved else None)
    assert point["individual"] == (-14_627.4375 if resolved else None)
    assert point["institution"] == (0 if resolved else None)
    assert got["futures"]["unit"] == ("amt_eok" if resolved else None)
    assert "foreign_qty" not in point
    assert "last_success_at_ms" in got["futures"]["collection"]["targets"]["F001"]
    assert set(got["futures"]["markets"]) == {"F001"}
