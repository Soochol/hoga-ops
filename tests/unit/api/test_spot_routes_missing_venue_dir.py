"""venue 디렉터리가 없을 때 스팟 라우트는 **빈 200** 이어야 한다 (실측 2026-08-06).

⚠ 실장에서 500 이 났다. `venue=UN` 으로 **NXT 미상장** 종목(028670 팬오션)을 호버하면
`parquet/{date}/{code}/kiwoom_live/UN/` 이 없는데 경로가 그대로 DuckDB 로 넘어가
`IOException: No files found that match the pattern ...` 로 터졌다.

정상적으로 없는 것을 **장애로 답한** 것이다. 미상장 종목에 그 시장 데이터가 없는 건
결함이 아니라 사실이고, `_resolved_parquet_dir` 의 docstring 도 이미 *"source dir is
missing on disk → (None, source)"* 를 약속하고 있었다 — 구현이 안 따라갔다.

기전: venue 축 이전엔 `resolve_source_result` 가 meta.json 을 가진 source 에만 경로를
줘서 디렉터리가 늘 존재했다. 지금은 분류가 **source 단위**(venue 중 가장 심한 상태)라
`kiwoom_live` 가 KRX venue meta 로 healthy 가 되고, 경로엔 없는 venue 세그먼트가 붙는다.
"""
import json

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app

_META = {
    "collection_complete": True, "is_partial": False,
    "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    "name": "팬오션", "pages_collected": 1,
    "today_open": 1, "today_high": 2, "today_low": 1, "today_close": 2,
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """KRX 만 캡처된 Stock-Date — NXT·UN 디렉터리는 **없다**(미상장)."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    krx = tmp_path / "parquet" / "20260806" / "028670" / "kiwoom_live" / "KRX"
    krx.mkdir(parents=True)
    (krx / "meta.json").write_text(json.dumps(_META), encoding="utf-8")
    with TestClient(create_app(data_dir=tmp_path)) as c:
        yield c


@pytest.mark.parametrize("venue", ["NXT", "UN"])
def test_orderbook_returns_empty_200_for_absent_venue(client, venue):
    r = client.get("/api/orderbook", params={
        "code": "028670", "date": "20260806", "t": 1785982320000,
        "bucket_ms": 60000, "source_pref": "completeness_first", "venue": venue,
    })
    assert r.status_code == 200, r.text
    assert r.json()["snapshot"] is None


@pytest.mark.parametrize("venue", ["NXT", "UN"])
def test_brokers_series_returns_empty_200_for_absent_venue(client, venue):
    r = client.get("/api/brokers/series", params={
        "code": "028670", "date": "20260806",
        "source_pref": "completeness_first", "venue": venue,
    })
    assert r.status_code == 200, r.text
    assert r.json()["brokers"] == []


def test_krx_still_serves(client, tmp_path):
    """대조군 — 있는 venue 는 그대로 동작한다(회귀 없음).

    ⚠ **파일 부재는 여기서 다루지 않는다.** 디렉터리는 있는데 `brokers.parquet` 만
    없는 경우는 이 수정의 범위 밖이고 별도 사실이다 — 그래서 파일을 만들어 대조한다.
    """
    from hoga.tables.brokers import write_parquet as write_brokers_parquet

    krx = tmp_path / "parquet" / "20260806" / "028670" / "kiwoom_live" / "KRX"
    write_brokers_parquet([], krx / "brokers.parquet")

    r = client.get("/api/brokers/series", params={
        "code": "028670", "date": "20260806",
        "source_pref": "completeness_first", "venue": "KRX",
    })
    assert r.status_code == 200, r.text
