"""히트맵 그룹 흐름이 **venue 세그먼트**를 읽는다 (ADR-0140 §3).

⚠ 실측된 결함이다. `build_group_flow` 가 평면 경로 `live_kiwoom/{date}/{code}.jsonl` 을
읽었는데, PR-D 가 JSONL 을 `{date}/{venue}/{code}.jsonl` 로 옮긴 뒤 그 경로가 **존재하지
않게 됐다** — 실측 2026-08-06, 39개 그룹 전부 `pct: null` 이었다.

라우트는 `venue` 를 받아 놓고 *"프론트 계약 호환용 … 미사용"* 으로 버리고 있었다.
그 사이 스파크라인이 통째로 죽었고, **값이 없는 것과 그룹이 조용한 것이 화면에서 같아
보여** 아무도 못 봤다.
"""
import datetime as dt
import json

import pytest

from hoga.api.heatmap_group_flow import build_group_flow

BASIS = dt.date(2026, 8, 6)
_OPEN_MS = int(dt.datetime(2026, 8, 6, 9, 0, tzinfo=dt.timezone(dt.timedelta(hours=9))).timestamp() * 1000)


def _write_candles(root, code, closes):
    root.mkdir(parents=True, exist_ok=True)
    with (root / f"{code}.jsonl").open("w", encoding="utf-8") as f:
        for i, c in enumerate(closes):
            f.write(json.dumps({
                "t_ms": _OPEN_MS + i * 60_000, "kind": "candle",
                "payload": {"ts_ms": _OPEN_MS + i * 60_000, "close": c},
            }) + "\n")


@pytest.fixture
def data_dir(tmp_path):
    """전일 종가가 있는 히트맵 그룹 1개 + venue 별로 **다른** 종가."""
    import asyncio

    from hoga.api.heatmap import add_entry_to_folder, create_folder

    folder = asyncio.run(create_folder(tmp_path, name="그룹 1"))
    asyncio.run(add_entry_to_folder(tmp_path, code="005930", name="삼성전자", folder_id=folder.id))

    import polars as pl
    sc = tmp_path / "screener"; sc.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "code": ["005930", "005930"],
        "date": [dt.date(2026, 8, 5), BASIS],
        "close": [100.0, 100.0],
    }).write_parquet(sc / "daily_adjusted.parquet")

    live = tmp_path / "live_kiwoom" / "20260806"
    _write_candles(live / "KRX", "005930", [110.0])   # +10%
    _write_candles(live / "NXT", "005930", [90.0])    # -10%
    return tmp_path


def _first_value(resp):
    return next((p for g in resp.groups for p in g.pct if p is not None), None)


def test_group_flow_reads_the_requested_venue(data_dir):
    """⚠ 회귀 가드. venue 별로 **다른 값**이 나와야 한다."""
    krx = _first_value(build_group_flow(data_dir, BASIS, now_ms=_OPEN_MS + 120_000, venue="KRX"))
    nxt = _first_value(build_group_flow(data_dir, BASIS, now_ms=_OPEN_MS + 120_000, venue="NXT"))

    assert krx is not None, "KRX 값이 없다 — 평면 경로를 읽고 있다(그 경로는 이제 없다)"
    assert nxt is not None
    assert krx > 0 > nxt, f"venue 별로 갈리지 않았다: KRX={krx} NXT={nxt}"


def test_absent_venue_yields_empty_not_krx(data_dir):
    """없는 venue 는 **비어야** 한다 — KRX 로 대체하면 다른 시장 값을 그 시장 것처럼 준다."""
    un = _first_value(build_group_flow(data_dir, BASIS, now_ms=_OPEN_MS + 120_000, venue="UN"))
    assert un is None
