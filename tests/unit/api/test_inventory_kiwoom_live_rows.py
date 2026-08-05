"""보관함이 `kiwoom_live` 전용 Stock-Date 를 본다 (#1149).

`_find_winning_meta` 가 `hogaplay/` 와 평면 `meta.json` 둘만 걸어서, kiwoom_live 만
있는 Stock-Date 는 **행 자체가 안 생겼다**. 실측 2026-08-05: 17,877 중 **710건**.

docstring 이 설명하는 `kis_live` 제외 사유(`t_ms` Unix ms vs hogaplay 의 `ts_ms`
HHMMSSmmm)는 kiwoom_live 엔 해당하지 않는다 — 실측 결과 컬럼 66개가 완전히 동일하다.
막고 있던 건 **meta 키 불일치**였다: `name` · `pages_collected` · `today_*` 가 없어
`KeyError` 가 나고, pass-3 의 per-row `try` 가 그걸 삼켜 **조용히 계속 안 보였다**.
"""
import json

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from hoga.api.queries import QueryEngine

_SNAP_COLS = {
    "ts_ms": pa.array([90000000, 153000000], type=pa.int64()),
    "seq": pa.array([1, 2], type=pa.int64()),
}
_CANDLES = {
    "ts_ms": pa.array([90000000, 100000000], type=pa.int64()),
    "open": pa.array([50000, 50500], type=pa.int64()),
    "high": pa.array([51000, 51500], type=pa.int64()),
    "low": pa.array([49500, 50000], type=pa.int64()),
    "close": pa.array([50500, 51200], type=pa.int64()),
    "vol_a": pa.array([100, 200], type=pa.int64()),
    "vol_b": pa.array([0, 0], type=pa.int64()),
}


def _write(d, *, meta, candles=True):
    d.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table(_SNAP_COLS), d / "snapshots.parquet")
    if candles:
        pq.write_table(pa.table(_CANDLES), d / "candles.parquet")
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


_KIWOOM_META = {
    "code": "005930", "date": "20260520", "source": "kiwoom_live",
    "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    "collection_complete": True, "is_partial": False,
}


@pytest.fixture
def engine(tmp_path):
    eng = QueryEngine(tmp_path)
    yield eng
    eng.close()


def test_kiwoom_live_only_stock_date_produces_a_row(tmp_path, engine):
    """⚠ 회귀 가드 — 이게 #1149 다. 예전엔 행이 **0개**였다."""
    _write(tmp_path / "parquet" / "20260520" / "005930" / "kiwoom_live" / "KRX",
           meta=_KIWOOM_META)

    rows = engine.list_stock_dates()

    assert len(rows) == 1
    assert (rows[0].date, rows[0].code) == ("20260520", "005930")
    assert rows[0].disk_state == "complete"


def test_missing_meta_keys_are_derived_not_fatal(tmp_path, engine, monkeypatch):
    """`name`·`pages_collected`·`today_*` 부재가 **행을 죽이면 안 된다**.

    죽으면 pass-3 의 per-row `try` 가 삼켜서 조용히 사라진다 — 그게 710 건의 기전이다.
    OHLC 는 캔들에서 유도한다(0 으로 두면 화면에 "0원" 이 뜨는데 그건 없는 값이 아니라
    **틀린 값**이다).
    """
    # ⚠ 마스터를 **명시적으로** 비운다. 전역 캐시라 다른 테스트가 채워 두면
    # 이름 폴백이 안 타고 이 테스트가 순서에 따라 갈린다(실제로 그랬다).
    from hoga.api import symbols

    monkeypatch.setattr(symbols, "search", lambda *a, **k: [])
    _write(tmp_path / "parquet" / "20260520" / "005930" / "kiwoom_live" / "KRX",
           meta=_KIWOOM_META)

    row = engine.list_stock_dates()[0]

    assert row.pages_collected == 0        # hogaplay 전용 개념
    assert row.today_open == 50000         # 첫 캔들 open
    assert row.today_close == 51200        # 마지막 캔들 close
    assert row.today_high == 51500
    assert row.today_low == 49500
    assert row.name == "005930"            # 마스터에 없음 → 코드 폴백


def test_hogaplay_wins_when_both_sources_present(tmp_path, engine):
    """hogaplay 가 있으면 그쪽이 승자다 — meta 가 더 풍부하다(이름·OHLC·상하한가)."""
    sd = tmp_path / "parquet" / "20260520" / "005930"
    _write(sd / "hogaplay", meta={
        **_KIWOOM_META, "source": "hogaplay", "name": "삼성전자",
        "pages_collected": 47, "today_open": 1, "today_high": 2,
        "today_low": 3, "today_close": 4,
    })
    _write(sd / "kiwoom_live" / "KRX", meta=_KIWOOM_META)

    row = engine.list_stock_dates()[0]

    assert row.name == "삼성전자"
    assert (row.today_open, row.today_close) == (1, 4)  # hogaplay meta 값
    assert row.pages_collected == 47


def test_source_level_meta_is_not_mistaken_for_a_venue_meta(tmp_path, engine):
    """`kiwoom_live/meta.json`(PR-E source 레벨)을 완결성 meta 로 읽으면 안 된다.

    `collection_complete` 가 없어 **미완결로 오분류**된다. 해석은 `disk_state.
    source_meta_path` 가 SSOT 다 — 여기서 다시 조립하면 그 함정에 빠진다.
    """
    src = tmp_path / "parquet" / "20260520" / "005930" / "kiwoom_live"
    _write(src / "KRX", meta=_KIWOOM_META)
    (src / "meta.json").write_text(json.dumps(
        {"expected_venues": ["KRX", "NXT"], "nxt_enabled": True}), encoding="utf-8")

    row = engine.list_stock_dates()[0]

    assert row.disk_state == "complete"  # venue meta 를 읽었다


def test_candle_less_row_still_appears(tmp_path, engine):
    """캔들이 없어도 행은 나온다 — OHLC 만 0 이고 나머지는 정상."""
    _write(tmp_path / "parquet" / "20260520" / "005930" / "kiwoom_live" / "KRX",
           meta=_KIWOOM_META, candles=False)

    rows = engine.list_stock_dates()

    assert len(rows) == 1
    assert rows[0].today_close == 0


def test_name_falls_back_to_the_symbol_master(tmp_path, engine, monkeypatch):
    """meta 에 `name` 이 없으면 마스터에서 찾는다 — 코드로 두면 710 행이 이름 없이 뜬다."""
    from types import SimpleNamespace

    from hoga.api import symbols

    monkeypatch.setattr(
        symbols, "search",
        lambda *a, **k: [SimpleNamespace(code="005930", name="삼성전자")],
    )
    _write(tmp_path / "parquet" / "20260520" / "005930" / "kiwoom_live" / "KRX",
           meta=_KIWOOM_META)

    assert engine.list_stock_dates()[0].name == "삼성전자"
