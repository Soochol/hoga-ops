"""ADR-0109 — /study 저장뷰 캡처 공백의 KIS 분봉 영구 복구."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.queries import QueryEngine
from hoga.api.sources import resolve_source_result
from hoga.api.timeenc import ms_from_midnight_to_unix_ms
from hoga.live import candle_repair
from hoga.live.kis_models import KisCandle
from hoga.tables import candles as candles_tbl

_CODE = "005930"
_DATE = "20260518"  # 월요일


@pytest.fixture(autouse=True)
def _force_trading_day(monkeypatch: pytest.MonkeyPatch):
    """복구 모듈이 참조하는 is_trading_day를 결정론적으로 — 테스트 날짜는 거래일."""
    monkeypatch.setattr(candle_repair, "is_trading_day", lambda _d: True)
    # in-flight 집합은 모듈 전역이므로 테스트 간 격리.
    candle_repair._inflight.clear()


def _kis_candles() -> list[KisCandle]:
    open_unix = ms_from_midnight_to_unix_ms(_DATE, 90000000)  # 09:00
    return [
        KisCandle(t_ms=open_unix, open=100, high=110, low=95, close=105, volume=1000),
        KisCandle(t_ms=open_unix + 60_000, open=105, high=108, low=101, close=102, volume=800),
    ]


async def _fetch_ok(code: str, date_s: str) -> list[KisCandle]:
    return _kis_candles()


async def _fetch_empty(code: str, date_s: str) -> list[KisCandle]:
    return []


def _write_hogaplay_candles(tmp_path: Path, *, date: str = _DATE, code: str = _CODE) -> None:
    src = tmp_path / "parquet" / date / code / "hogaplay"
    src.mkdir(parents=True)
    src.joinpath("meta.json").write_text(json.dumps({
        "source": "hogaplay", "collection_complete": True, "is_partial": False,
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    }))
    candles_tbl.write_parquet(
        [candles_tbl.Candle(ts_ms=90000000, open_=1, close_=2, high=3, low=1, vol_a=5, vol_b=0)],
        src / "candles.parquet",
    )


async def _run(tmp_path: Path, fetch) -> candle_repair.RepairSummary | None:
    engine = QueryEngine(tmp_path)
    try:
        return await candle_repair.repair_saved_view_range(
            engine, tmp_path, code=_CODE, from_date=_DATE, to_date=_DATE,
            fetch=fetch, today_kst="20260601",
        )
    finally:
        engine.close()


@pytest.mark.asyncio
async def test_repairs_gap_writes_kis_api_candles(tmp_path: Path) -> None:
    summary = await _run(tmp_path, _fetch_ok)
    assert summary is not None
    assert summary.repaired == [_DATE]

    target = tmp_path / "parquet" / _DATE / _CODE / "kis_api"
    assert (target / "candles.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["created_from"] == candle_repair.REPAIR_MARKER
    assert meta["source"] == "kis_api"

    # ts_ms는 자정 기준 ms로 인코딩(09:00 → 90000000).
    rows = candles_tbl.query_all(QueryEngine(tmp_path).conn,
                                 path=target / "candles.parquet")
    assert rows[0].ts_ms == 90000000
    assert rows[0].vol_a == 1000 and rows[0].vol_b == 0


@pytest.mark.asyncio
async def test_repaired_meta_classifies_healthy_and_serves(tmp_path: Path) -> None:
    await _run(tmp_path, _fetch_ok)
    target = tmp_path / "parquet" / _DATE / _CODE / "kis_api"
    meta = json.loads((target / "meta.json").read_text())
    # invariant 통과 → SOURCE_PARTIAL(healthy), INVALID 아님.
    assert classify_from_meta(meta).state == DiskState.SOURCE_PARTIAL

    # hogaplay_first로 복구본이 승리 소스가 된다(hogaplay 부재).
    engine = QueryEngine(tmp_path)
    try:
        res = resolve_source_result(engine, _DATE, _CODE, "hogaplay_first")
        assert res.source == "kis_api"
        assert res.classification is not None
        assert res.classification.state != DiskState.INVALID
    finally:
        engine.close()


@pytest.mark.asyncio
async def test_idempotent_second_run_skips(tmp_path: Path) -> None:
    await _run(tmp_path, _fetch_ok)
    summary = await _run(tmp_path, _fetch_ok)
    assert summary is not None
    assert summary.repaired == []
    assert summary.skipped == [_DATE]


@pytest.mark.asyncio
async def test_existing_hogaplay_candles_not_repaired(tmp_path: Path) -> None:
    _write_hogaplay_candles(tmp_path)
    summary = await _run(tmp_path, _fetch_ok)
    assert summary is not None
    assert summary.repaired == []
    assert summary.skipped == [_DATE]
    # kis_api 네임스페이스는 만들어지지 않는다.
    assert not (tmp_path / "parquet" / _DATE / _CODE / "kis_api").exists()


@pytest.mark.asyncio
async def test_kis_empty_response_records_unavailable_no_write(tmp_path: Path) -> None:
    summary = await _run(tmp_path, _fetch_empty)
    assert summary is not None
    assert summary.unavailable == [_DATE]
    assert summary.repaired == []
    # 빈 parquet은 쓰지 않는다.
    assert not (tmp_path / "parquet" / _DATE / _CODE / "kis_api").exists()


@pytest.mark.asyncio
async def test_existing_kis_api_meta_preserved(tmp_path: Path) -> None:
    # rest30 승격이 만든 kis_api meta(30초 스냅샷)가 이미 있는 날.
    target = tmp_path / "parquet" / _DATE / _CODE / "kis_api"
    target.mkdir(parents=True)
    original = {
        "source": "kis_api", "created_from": "kis_rest", "sampling_ms": 30000,
        "collection_complete": True, "is_partial": True,
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    }
    target.joinpath("meta.json").write_text(json.dumps(original))

    summary = await _run(tmp_path, _fetch_ok)
    assert summary is not None
    assert summary.repaired == [_DATE]
    # 캔들은 추가되지만 meta는 덮어쓰지 않는다(rest30 provenance 보존).
    assert (target / "candles.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["created_from"] == "kis_rest"


@pytest.mark.asyncio
async def test_bypass_gate_returns_none_no_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(candle_repair.kis_access, "kis_rest_bypass_enabled", lambda _d: True)
    summary = await _run(tmp_path, _fetch_ok)
    assert summary is None
    assert not (tmp_path / "parquet" / _DATE / _CODE / "kis_api").exists()


@pytest.mark.asyncio
async def test_no_fetch_returns_none(tmp_path: Path) -> None:
    summary = await _run(tmp_path, None)
    assert summary is None


def test_scan_gaps_reports_without_fetch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(candle_repair, "is_trading_day", lambda _d: True)
    engine = QueryEngine(tmp_path)
    try:
        gaps = candle_repair.scan_saved_view_gaps(
            engine, code=_CODE, from_date=_DATE, to_date=_DATE, today_kst="20260601",
        )
        assert gaps == [_DATE]
    finally:
        engine.close()


def test_scan_gaps_excludes_days_with_candles(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(candle_repair, "is_trading_day", lambda _d: True)
    _write_hogaplay_candles(tmp_path)
    engine = QueryEngine(tmp_path)
    try:
        gaps = candle_repair.scan_saved_view_gaps(
            engine, code=_CODE, from_date=_DATE, to_date=_DATE, today_kst="20260601",
        )
        assert gaps == []
    finally:
        engine.close()


@pytest.mark.asyncio
async def test_end_to_end_repair_then_range_serves(tmp_path: Path) -> None:
    """복구가 쓴 parquet을 build_range_bundle이 그대로 읽어 서빙 — 모듈 간 스키마 잠금."""
    from hoga.api.bundle import build_range_bundle

    await _run(tmp_path, _fetch_ok)
    engine = QueryEngine(tmp_path)
    try:
        rb = build_range_bundle(
            engine, code=_CODE, from_date=_DATE, to_date=_DATE,
            bucket_ms=60_000, source_pref="hogaplay_first", mode="candles",
        )
    finally:
        engine.close()
    assert len(rb.candles) == 2
    assert rb.repaired_candle_dates == [_DATE]
    # 09:00 바가 Unix ms로 정확히 복원(자정 인코딩 왕복).
    assert rb.candles[0].ts_ms == ms_from_midnight_to_unix_ms(_DATE, 90000000)
    assert rb.candles[0].vol_a == 1000
