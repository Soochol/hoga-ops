"""`/api/candles` 는 **파일 부재**를 빈 200 으로, **미캡처**만 404 로 답한다.

부재는 두 층이다 — Stock-Date 디렉터리, 그리고 그 안의 파케이 파일. 앞 층은
ADR-0051 이 못박은 404 이고(`/api/meta` 와 함께 스팟 라우트의 200-empty 와 의도된
비대칭), 뒤 층은 ADR-0051 Amendment(2026-08-07)가 빈 200 으로 정했다.

⚠ 뒤 층에 가드가 없던 시절 **같은 논리 상태(캔들 0개)가 디스크 모양에 따라 갈렸다**
(실측 2026-08-07): 0행 `candles.parquet` 이 남아 있으면 `200 {"candles": []}`, 같은
0개인데 파일이 없으면 DuckDB `IOException: No files found that match the pattern ...`
으로 **500**. 응답이 어느 writer 세대가 그 디렉터리를 만들었는지에 달려 있던 셈이다 —
hogaplay 파서(`parser/__init__.py`)는 0행이어도 쓰고, `live/promote._atomic_write_table`
의 계약은 **"0행이면 파일을 안 남긴다"** 이며 그 docstring 이 부재 처리를 리더의 몫으로
넘긴다.

같은 결손·같은 원인으로 스팟 라우트 두 개가 500 이었고 #1176 이 고쳤다
(`test_spot_routes_missing_venue_dir.py` 의 파일-층 절). `/api/candles` 는 헬퍼와
규약이 달라 그때 범위 밖으로 남았다 — 이 파일이 그 축을 마저 덮는다.

⚠ 픽스처의 `hogaplay/` 에 **venue 세그먼트를 붙이지 말 것**. hogaplay 는 KRX 하나만
덮어서 `source_venue_dir` 가 세그먼트를 안 붙인다(`SOURCE_VENUES`) — `hogaplay/KRX/`
에 meta.json 을 두면 `parquet_dir` 이 못 찾아 **의도치 않은 404** 가 나고, 그러면
이 테스트는 500 회귀를 보지 못한 채 초록이 된다.
"""
import json

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.tables.candles import Candle, write_parquet as write_candles_parquet

_META = {
    "collection_complete": True, "is_partial": False,
    "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    "name": "팬오션", "pages_collected": 1,
    "today_open": 1, "today_high": 2, "today_low": 1, "today_close": 2,
}


@pytest.fixture
def sd_dir(tmp_path, monkeypatch):
    """캡처된 Stock-Date — 디렉터리와 meta.json 은 있고 파케이 파일은 **없다**."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    d = tmp_path / "parquet" / "20260806" / "028670" / "hogaplay"
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps(_META), encoding="utf-8")
    return d


@pytest.fixture
def client(tmp_path, sd_dir):
    with TestClient(create_app(data_dir=tmp_path)) as c:
        yield c


def _get(client, code="028670"):
    return client.get("/api/candles", params={"code": code, "date": "20260806"})


def test_empty_200_when_parquet_file_absent(client):
    """디렉터리는 있고 `candles.parquet` 만 없음 → 빈 200 (그전엔 500)."""
    r = _get(client)
    assert r.status_code == 200, r.text
    assert r.json()["candles"] == []


def test_empty_200_when_parquet_file_has_zero_rows(sd_dir, client):
    """0행 **파일**도 같은 답이어야 한다 — 이 줄이 위 테스트의 근거다.

    두 픽스처가 같은 사실("캔들 0개")을 말하는데 응답이 갈리면 그 자체가 버그다.
    hogaplay 파서는 0행이어도 파일을 쓰므로 이 모양이 실제로 디스크에 존재한다.
    """
    write_candles_parquet([], sd_dir / "candles.parquet")
    r = _get(client)
    assert r.status_code == 200, r.text
    assert r.json()["candles"] == []


def test_404_still_for_uncaptured_stock_date(client):
    """**ADR-0051 의 404 는 그대로다.** 이 줄이 개정의 범위를 고정한다.

    파일 층을 빈 200 으로 내린 것이지 미캡처를 200 으로 바꾼 것이 아니다.
    """
    r = _get(client, code="999999")
    assert r.status_code == 404, r.text


def test_serves_rows_once_file_appears(sd_dir, client):
    """부재 → 등장이 **같은 프로세스에서** 열려야 한다(부재를 캐시하지 않는다).

    가드가 라우트 층에 있으므로 다음 요청이 다시 `is_file()` 을 본다 — 아침의 빈
    응답이 온종일 남지 않는다.
    """
    assert _get(client).json()["candles"] == []

    write_candles_parquet(
        [Candle(ts_ms=32_400_000, open_=100, close_=110, high=120, low=90, vol_a=5, vol_b=7)],
        sd_dir / "candles.parquet",
    )

    r = _get(client)
    assert r.status_code == 200, r.text
    candles = r.json()["candles"]
    assert len(candles) == 1
    assert candles[0]["close"] == 110
