"""ADR-0109 — build_range_bundle의 repaired_candle_dates 방출 + mode 무해성."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.tables import candles as candles_tbl

_CODE = "005930"
_DATE = "20260518"


def _write_repaired_kis_api(tmp_path: Path) -> None:
    """복구본 kis_api Stock-Date(캔들 + repair meta, 스냅샷 없음)."""
    target = tmp_path / "parquet" / _DATE / _CODE / "kis_api"
    target.mkdir(parents=True)
    target.joinpath("meta.json").write_text(json.dumps({
        "source": "kis_api", "created_from": "kis_minute_repair",
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


def test_candles_mode_serves_repair_and_emits_dates(tmp_path: Path) -> None:
    _write_repaired_kis_api(tmp_path)
    engine = QueryEngine(tmp_path)
    try:
        rb = build_range_bundle(
            engine, code=_CODE, from_date=_DATE, to_date=_DATE,
            bucket_ms=60_000, source_pref="hogaplay_first", mode="candles",
        )
    finally:
        engine.close()
    # 복구본이 hogaplay_first로 서빙된다.
    assert len(rb.candles) == 2
    assert [s.source for s in rb.segments] == ["kis_api"]
    # 복구일이 방출된다.
    assert rb.repaired_candle_dates == [_DATE]


def test_hoga_mode_harmless_when_only_repair_candles(tmp_path: Path) -> None:
    """캔들만 있고 스냅샷 없는 kis_api 날에 mode=hoga → 크래시 없이 빈 캔들."""
    _write_repaired_kis_api(tmp_path)
    engine = QueryEngine(tmp_path)
    try:
        rb = build_range_bundle(
            engine, code=_CODE, from_date=_DATE, to_date=_DATE,
            bucket_ms=60_000, source_pref="hogaplay_first", mode="hoga",
        )
    finally:
        engine.close()
    assert rb.candles == []
    # hoga 모드도 복구일 자체는 인식(배지 데이터는 캔들 응답에서만 쓰지만 방출은 무해).
    assert rb.repaired_candle_dates == [_DATE]


def test_no_repair_marker_no_emission(tmp_path: Path) -> None:
    """일반 kis_api(rest30, created_from != marker)는 방출하지 않는다."""
    target = tmp_path / "parquet" / _DATE / _CODE / "kis_api"
    target.mkdir(parents=True)
    target.joinpath("meta.json").write_text(json.dumps({
        "source": "kis_api", "created_from": "kis_rest",
        "collection_complete": True, "is_partial": True,
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    }))
    candles_tbl.write_parquet(
        [candles_tbl.Candle(ts_ms=90000000, open_=1, close_=2, high=3, low=1,
                            vol_a=5, vol_b=0)],
        target / "candles.parquet",
    )
    engine = QueryEngine(tmp_path)
    try:
        rb = build_range_bundle(
            engine, code=_CODE, from_date=_DATE, to_date=_DATE,
            bucket_ms=60_000, source_pref="hogaplay_first", mode="candles",
        )
    finally:
        engine.close()
    assert len(rb.candles) == 1
    assert rb.repaired_candle_dates == []
