"""kis_api = 캔들 전용 소스 회귀 가드(2026-07-17 정책: 호가는 api로 받지 않는다).

kis_api Stock-Date(과거 rest30 캡처 유산 또는 ADR-0109 복구본)는 캔들·segment만
서빙하고 호가·체결 계열(호가비·체결강도 등)은 억제된다. 스팟 라우트
(/api/orderbook 등)의 _resolved_parquet_dir는 kis_api resolve 시 path None을
반환해 빈 200이 된다.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.queries import QueryEngine
from hoga.api.routes import _resolved_parquet_dir
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.tables import candles as candles_tbl
from hoga.tables.snapshots import Orderbook
from hoga.tables.snapshots import write_parquet as write_snapshots

_CODE = "005930"
_DATE = "20260518"


def _ob(ts_ms: int, seq: int) -> Orderbook:
    return Orderbook(
        ts_ms=ts_ms, seq=seq,
        ask_p=(25700,) + (0,) * 9,
        ask_q=(100,) + (0,) * 9,
        ask_d=(0,) * 10,
        bid_p=(25650,) + (0,) * 9,
        bid_q=(200,) + (0,) * 9,
        bid_d=(0,) * 10,
        tot_ask=1000, tot_ask_d=0,
        tot_bid=2000, tot_bid_d=0,
    )


def _seed_kis_api_only(data_dir: Path) -> None:
    """kis_api-only Stock-Date: 캔들 + 스냅샷 + meta. 스냅샷이 실재하므로
    호가비/체결강도가 비면 그건 데이터 부재가 아니라 게이트다."""
    target = data_dir / "parquet" / _DATE / _CODE / "kis_api"
    target.mkdir(parents=True)
    target.joinpath("meta.json").write_text(json.dumps({
        "source": "kis_api", "created_from": "kis_rest",
        "collection_complete": True, "is_partial": True,
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    }))
    candles_tbl.write_parquet(
        [
            candles_tbl.Candle(ts_ms=90000000, open_=100, close_=105, high=110, low=95,
                               vol_a=1000, vol_b=0),
            candles_tbl.Candle(ts_ms=90060000, open_=105, close_=102, high=108, low=101,
                               vol_a=800, vol_b=0),
        ],
        target / "candles.parquet",
    )
    write_snapshots(
        [_ob(91000000, 1), _ob(92000000, 2), _ob(93000000, 3)],
        target / "snapshots.parquet",
    )


def test_range_kis_api_serves_candles_but_suppresses_orderflow(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_kis_api_only(data_dir)
    client = TestClient(create_app(data_dir=data_dir))
    params = {
        "code": _CODE, "from": _DATE, "to": _DATE, "bucket_ms": 60_000,
    }

    # 캔들 요청: kis_api 캔들은 계속 서빙된다(ADR-0109 복구 경로 보존).
    r = client.get("/api/range", params={**params, "mode": "candles"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["candles"]) == 2
    assert [s["source"] for s in body["segments"]] == ["kis_api"]

    # 지표 요청(mode=hoga): 스냅샷이 디스크에 있어도 호가비·체결강도는 빈 배열 —
    # kis_api는 호가·체결 소스가 아니다(게이트).
    r = client.get("/api/range", params={**params, "mode": "hoga"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["quote_ratio"]["points"] == []
    assert body["fill_strength"]["points"] == []
    # segment 자체는 유지(달력/구간 렌더).
    assert [s["source"] for s in body["segments"]] == ["kis_api"]


def test_resolved_parquet_dir_returns_none_for_kis_api(tmp_path: Path) -> None:
    """스팟 라우트 공용 리졸버: kis_api로 resolve되면 path=None(빈 200 전제)."""
    data_dir = tmp_path / "data"
    _seed_kis_api_only(data_dir)
    engine = QueryEngine(data_dir)
    try:
        path, source = _resolved_parquet_dir(engine, _DATE, _CODE, "hogaplay")
    finally:
        engine.close()
    assert source == "kis_api"
    assert path is None


def test_orderbook_route_empty_200_for_kis_api_only_date(tmp_path: Path) -> None:
    """/api/orderbook: kis_api-only 날은 스냅샷이 디스크에 있어도 null 스냅샷 200."""
    data_dir = tmp_path / "data"
    _seed_kis_api_only(data_dir)
    client = TestClient(create_app(data_dir=data_dir))
    r = client.get("/api/orderbook", params={
        "code": _CODE, "date": _DATE,
        "t": hhmmssms_to_unix_ms(_DATE, 92000000),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["snapshot"] is None
    assert body["source"] == "kis_api"
