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

부재는 **두 층**이다 — 디렉터리(위)와 그 안의 parquet 파일. 파일 층은 처음엔 범위 밖으로
남겼다가 다음 날 그대로 500 으로 터졌고, 이 파일 아래쪽이 그 층을 덮는다(실측 2026-08-07).
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

    파일을 만들어 대조한다. 파일 **부재** 축은 아래 파일-층 테스트가 따로 덮는다.
    """
    from hoga.tables.brokers import write_parquet as write_brokers_parquet

    krx = tmp_path / "parquet" / "20260806" / "028670" / "kiwoom_live" / "KRX"
    write_brokers_parquet([], krx / "brokers.parquet")

    r = client.get("/api/brokers/series", params={
        "code": "028670", "date": "20260806",
        "source_pref": "completeness_first", "venue": "KRX",
    })
    assert r.status_code == 200, r.text


# === 파일 층 — 같은 교훈의 한 칸 아래 (실측 2026-08-07) ===
#
# 위 디렉터리 층을 고칠 때 파일 부재는 **의도적으로 범위 밖**으로 남겼다. 그게 다음 날
# 그대로 터졌다: `009150` 을 08:00 대에 호버하니 `kiwoom_live/UN/` 은 있는데
# `brokers.parquet` 만 없어 `/api/brokers/series` 가 500(DuckDB IOException) 이었다.
#
# 결손을 만든 쪽은 정상이다 — `live/promote._atomic_write_table` 의 계약이 **"0행이면
# 파일을 안 남긴다"** 이고, 그 docstring 이 부재 처리를 리더의 몫으로 넘긴다. 실제로
# 그 순간 `meta.json` 은 `row_counts.brokers: 0` 이었다. 거래원이 붙은 08:04 에는 같은
# 요청이 200 이 됐다 — **매일 아침 전 종목이 지나는 창**이지 특정 종목의 결함이 아니다.


@pytest.fixture
def dir_present_file_absent(tmp_path, monkeypatch):
    """KRX 디렉터리와 meta.json 은 있고 parquet 파일은 **하나도 없다**.

    장 초반 promote 직후의 실제 디스크 모양이다(스냅샷·거래원 0행 → 파일 없음).
    """
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    krx = tmp_path / "parquet" / "20260806" / "028670" / "kiwoom_live" / "KRX"
    krx.mkdir(parents=True)
    (krx / "meta.json").write_text(json.dumps(_META), encoding="utf-8")
    with TestClient(create_app(data_dir=tmp_path)) as c:
        yield c


def test_brokers_series_empty_200_when_parquet_absent(dir_present_file_absent):
    r = dir_present_file_absent.get("/api/brokers/series", params={
        "code": "028670", "date": "20260806",
        "source_pref": "completeness_first", "venue": "KRX",
    })
    assert r.status_code == 200, r.text
    assert r.json()["brokers"] == []


def test_orderbook_empty_200_when_parquet_absent(dir_present_file_absent):
    r = dir_present_file_absent.get("/api/orderbook", params={
        "code": "028670", "date": "20260806", "t": 1785982320000,
        "bucket_ms": 60000, "source_pref": "completeness_first", "venue": "KRX",
    })
    assert r.status_code == 200, r.text
    assert r.json()["snapshot"] is None


def test_brokers_series_serves_once_file_appears(dir_present_file_absent, tmp_path):
    """부재 → 등장이 같은 프로세스에서 열려야 한다.

    `query_day_series_cached` 는 mtime LRU 를 탄다. 부재를 빈 결과로 **캐시했다면**
    아침의 빈 응답이 온종일 남았을 것이다 — `MtimeLruCache.get_or_load` 가 stat 실패
    시 캐시를 건너뛰도록 설계된 이유이고, 라우트 가드가 그 앞에 서도 그 성질은 유지된다.
    """
    from hoga.tables.brokers import BrokerRow, write_parquet as write_brokers_parquet

    params = {
        "code": "028670", "date": "20260806",
        "source_pref": "completeness_first", "venue": "KRX",
    }
    assert dir_present_file_absent.get("/api/brokers/series", params=params).json()["brokers"] == []

    krx = tmp_path / "parquet" / "20260806" / "028670" / "kiwoom_live" / "KRX"
    write_brokers_parquet(
        [BrokerRow(ts_ms=90000000, seq=1, side="buy", rank=1,
                   broker="키움증권", qty_today=100, qty_delta=100)],
        krx / "brokers.parquet",
    )

    r = dir_present_file_absent.get("/api/brokers/series", params=params)
    assert r.status_code == 200, r.text
    assert [e["broker"] for e in r.json()["brokers"]] == ["키움증권"]
