"""`/api/orderbook` 의 버킷 대표 선택은 **venue 별 지표 구간**을 봐야 한다.

## 이 가드가 막는 방향

**막는 것**: 시간외에도 연속거래가 도는 venue(NXT·UN, 08:00–20:00)의 호가 스냅샷이
KRX 정규장 마감(15:30)으로 잘려 나가는 것. 그 결과가 "캔들은 있는데 10호가 창은
`호가 데이터 없음`" 이었다(실측 2026-08-14, 000720 16:00 캔들).

**막지 않는 것**: 종가 동시호가 배제(ADR-0062). 그건 시각이 아니라 **호가창 깊이**로
판정하므로 이 변경과 독립이다 — 아래 `..._auction_book_still_excluded` 가 그 독립성을
고정한다. corpus 실측(23,913 조합)에서도 게이트와 무관하게 누출은 0 이었다.

**의존하는 등록**: `promote` 가 meta 에 싣는 `indicator_session_*` 키. 그 키가 없는
meta(hogaplay·구형 kiwoom_live)는 `indicator_session_bounds` 가 `regular_session_*` 로
떨어뜨리므로 **동작이 글자 그대로 종전과 같다** — `..._legacy_meta_unchanged` 가 그
하위호환을 고정한다. 이 무변경이 계약인 이유는 과거 복기 데이터(hogaplay)가 corpus 의
대부분이고, 거기서 값이 바뀌면 어제까지 보던 지표가 조용히 달라지기 때문이다.

기전은 `hoga/tables/snapshots.py` 의 `_last_continuous_intra_ms_from_index` —
"마감 이전 마지막 연속거래 book" 을 구한 뒤 **그 시각 이후 행을 후보에서 전부 뺀다**.
따라서 넘기는 마감 시각이 곧 "이 venue 에서 언제까지가 거래인가" 의 선언이다.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.util.timeenc import hhmmssms_to_unix_ms

DATE = "20260806"
CODE = "005930"

#: 09:00–15:30. 모든 venue meta 가 같은 값을 싣는다 — "정규장" 은 venue 와 무관하다
#: (promote 주석). venue 차이는 아래 지표 구간에서만 난다.
_REGULAR = {"regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000}
#: NXT·UN 이 promote 에서 받는 값 — 08:00–20:00.
_NXT_INDICATOR = {"indicator_session_open_ms": 80000000, "indicator_session_close_ms": 200000000}

#: 16:00:00.000 — KRX 정규장 밖, NXT 애프터마켓 안.
AFTER_HOURS_MS = 160000000
#: 15:25:00.000 — 종가 동시호가 한복판.
AUCTION_MS = 152500000
#: 10:00:00.000 — 연속거래.
INTRADAY_MS = 100000000


def _deep_snap(ts_ms: int, *, seq: int = 0) -> dict:
    """10 호가가 전부 채워진 **연속거래** book (`_AUCTION_BOOK_DEPTH=3` 초과 잔량 있음)."""
    row: dict = {"ts_ms": ts_ms, "seq": seq}
    for i in range(1, 11):
        row[f"ask_p{i}"] = 70000 + i * 100
        row[f"ask_q{i}"] = 10 * i
        row[f"ask_d{i}"] = 0
        row[f"bid_p{i}"] = 69900 - i * 100
        row[f"bid_q{i}"] = 10 * i
        row[f"bid_d{i}"] = 0
    row.update({"tot_ask": 550, "tot_ask_d": 0, "tot_bid": 550, "tot_bid_d": 0})
    return row


def _auction_snap(ts_ms: int, *, seq: int = 0) -> dict:
    """3 단만 있는 **동시호가** book — 4~10 번 잔량 0 이라 깊이 조건에서 걸린다."""
    row = _deep_snap(ts_ms, seq=seq)
    for i in range(4, 11):
        row[f"ask_p{i}"] = 0
        row[f"ask_q{i}"] = 0
        row[f"bid_p{i}"] = 0
        row[f"bid_q{i}"] = 0
    row.update({"tot_ask": 60, "tot_bid": 60})
    return row


def _seed(root: Path, *, rel: str, meta: dict, rows: list[dict]) -> None:
    d = root / "parquet" / DATE / CODE / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(
        json.dumps({"source": "kiwoom_live", "code": CODE, "date": DATE,
                    "collection_complete": True, "is_partial": False, **meta}),
        encoding="utf-8",
    )
    pl.DataFrame(rows).write_parquet(d / "snapshots.parquet")


def _get(client: TestClient, *, venue: str, hhmmssms: int) -> dict:
    """그 시각이 속한 **1분 버킷**의 대표를 조회한다."""
    r = client.get("/api/orderbook", params={
        "code": CODE, "date": DATE, "venue": venue,
        "t": hhmmssms_to_unix_ms(DATE, hhmmssms), "bucket_ms": 60000,
    })
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> Iterator[TestClient]:
    """세 venue 를 같은 행으로 심는다 — **차이는 오직 meta 의 지표 구간**이다.

    같은 데이터를 주고 meta 만 다르게 두는 것이 이 테스트의 요점이다. 결과가 갈리면
    그건 데이터가 아니라 **경계 선언**이 만든 차이다.
    """
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    rows = [_deep_snap(INTRADAY_MS), _auction_snap(AUCTION_MS), _deep_snap(AFTER_HOURS_MS)]
    _seed(tmp_path, rel="kiwoom_live/KRX", meta=_REGULAR, rows=rows)
    _seed(tmp_path, rel="kiwoom_live/NXT", meta={**_REGULAR, **_NXT_INDICATOR}, rows=rows)
    _seed(tmp_path, rel="hogaplay", meta=_REGULAR, rows=rows)
    with TestClient(create_app(data_dir=tmp_path)) as c:
        yield c


def test_after_hours_book_survives_on_nxt(client: TestClient) -> None:
    """**red-check**: NXT 는 16:00 에도 연속거래 중이므로 그 buckets 대표가 나와야 한다.

    수정 전에는 `regular_session_close_ms`(15:30)로 잘려 `snapshot: null` 이었다.
    """
    body = _get(client, venue="NXT", hhmmssms=AFTER_HOURS_MS)
    assert body["snapshot"] is not None, "NXT 애프터마켓 book 이 배제됐다"
    assert body["snapshot"]["ask"][9]["qty"] == 100, "10호가까지 온전해야 한다"


def test_after_hours_book_still_excluded_on_krx(client: TestClient) -> None:
    """KRX 는 15:30 마감이라 16:00 book 은 **계속 배제**된다 — 같은 행, 다른 meta."""
    assert _get(client, venue="KRX", hhmmssms=AFTER_HOURS_MS)["snapshot"] is None


def test_legacy_meta_unchanged(client: TestClient) -> None:
    """`indicator_session_*` 이 없는 meta(hogaplay·구형)는 종전 동작 그대로.

    이 무변경이 계약이다 — 과거 복기 데이터가 corpus 의 대부분이라 여기서 값이 바뀌면
    어제까지 보던 지표가 조용히 달라진다. `source_pref` 로 hogaplay 를 지목한다.
    """
    r = client.get("/api/orderbook", params={
        "code": CODE, "date": DATE, "venue": "KRX", "source_pref": "hogaplay",
        "t": hhmmssms_to_unix_ms(DATE, AFTER_HOURS_MS), "bucket_ms": 60000,
    })
    assert r.status_code == 200, r.text
    assert r.json()["snapshot"] is None


@pytest.mark.parametrize("venue", ["KRX", "NXT"])
def test_auction_book_still_excluded(client: TestClient, venue: str) -> None:
    """동시호가 배제는 **깊이**가 하는 일이라 지표 구간을 넓혀도 살아난다.

    NXT 는 마감이 20:00 이라 15:25 가 구간 **안**인데도 3 단 book 이라 배제된다 —
    이 한 줄이 "시간을 넓혔더니 동시호가가 새어들지 않는가" 에 답한다(ADR-0062).
    """
    assert _get(client, venue=venue, hhmmssms=AUCTION_MS)["snapshot"] is None


@pytest.mark.parametrize("venue", ["KRX", "NXT"])
def test_intraday_book_unaffected(client: TestClient, venue: str) -> None:
    """정규장 buckets 는 어느 쪽에서도 그대로 나온다 — 변경이 장중을 안 건드린다."""
    assert _get(client, venue=venue, hhmmssms=INTRADAY_MS)["snapshot"] is not None
