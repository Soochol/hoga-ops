"""Stage 6B — build_range_bundle source_pref + fallback (ADR-0039)."""
import json
from pathlib import Path

import pytest

# We don't import build_range_bundle yet — we test the signature exists.


def test_resolve_source_prefers_explicit(tmp_path: Path) -> None:
    """Verify the _resolve_source helper returns the preferred source when present."""
    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    (sd_dir / "hogaplay").mkdir(parents=True)
    (sd_dir / "hogaplay" / "meta.json").write_text(json.dumps({
        "collection_complete": True, "is_partial": False,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }))
    (sd_dir / "kis_live").mkdir()
    (sd_dir / "kis_live" / "meta.json").write_text(json.dumps({
        "source": "kis_live",
    }))

    engine = QueryEngine(tmp_path)
    try:
        assert _resolve_source(engine, "20260527", "005930", "hogaplay") == "hogaplay"
        assert _resolve_source(engine, "20260527", "005930", "kis_live") == "kis_live"
    finally:
        engine.close()


def test_resolve_source_fallback(tmp_path: Path) -> None:
    """When preferred source is absent, fall back to any other available."""
    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    (sd_dir / "kis_live").mkdir(parents=True)
    (sd_dir / "kis_live" / "meta.json").write_text(json.dumps({"source": "kis_live"}))

    engine = QueryEngine(tmp_path)
    try:
        # Prefer hogaplay but it's not present → fallback to kis_live
        assert _resolve_source(engine, "20260527", "005930", "hogaplay") == "kis_live"
    finally:
        engine.close()


def test_resolve_source_prefers_kis_api_when_policy_requests_it(tmp_path: Path) -> None:
    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260622" / "005930"
    for source in ("hogaplay", "kis_live", "kis_api"):
        (sd_dir / source).mkdir(parents=True, exist_ok=True)
        (sd_dir / source / "meta.json").write_text(json.dumps({
            "collection_complete": True,
            "is_partial": False,
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
        }))

    engine = QueryEngine(tmp_path)
    try:
        assert _resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"
    finally:
        engine.close()


def test_list_stock_dates_in_range_finds_any_source(tmp_path: Path) -> None:
    """list_stock_dates_in_range matches any source for backward compat."""
    from hoga.api.queries import QueryEngine

    # hogaplay layout
    (tmp_path / "parquet" / "20260520" / "005930" / "hogaplay").mkdir(parents=True)
    (tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False,
                    "regular_session_open_ms": 90000000,
                    "regular_session_close_ms": 153000000})
    )
    # kis_live layout
    (tmp_path / "parquet" / "20260521" / "005930" / "kis_live").mkdir(parents=True)
    (tmp_path / "parquet" / "20260521" / "005930" / "kis_live" / "meta.json").write_text(
        json.dumps({"source": "kis_live"})
    )

    engine = QueryEngine(tmp_path)
    try:
        dates = engine.list_stock_dates_in_range(
            code="005930", from_date="20260101", to_date="20261231",
        )
        assert dates == ["20260520", "20260521"]
    finally:
        engine.close()


def test_list_stock_dates_in_range_excludes_non_trading_day(tmp_path: Path) -> None:
    """비거래일(주말) 파티션은 서빙 인벤토리에서 제외한다(defense-in-depth).

    회귀: 유령 REST 호가 캡처가 비거래일 파티션(예: 토요일)을 만들면 사이드카 지표로
    서빙됐다. 주말 게이트는 순수 날짜연산이라 캘린더 크레덴셜 없이 결정론적.
    """
    from hoga.api.queries import QueryEngine

    # 20260710 = 금요일(거래일), 20260711 = 토요일(비거래일 유령 파티션)
    for date in ("20260710", "20260711"):
        d = tmp_path / "parquet" / date / "005930" / "kis_api"
        d.mkdir(parents=True)
        (d / "meta.json").write_text(json.dumps({"source": "kis_api"}))

    engine = QueryEngine(tmp_path)
    try:
        dates = engine.list_stock_dates_in_range(
            code="005930", from_date="20260701", to_date="20260731",
            source_pref="kis_api",
        )
        assert dates == ["20260710"]  # 토요일 20260711 배제
    finally:
        engine.close()


def test_is_non_trading_day_predicate() -> None:
    """_is_non_trading_day: 주말=확실 배제, 휴장=캘린더 확정 False만, None/불가=관대."""
    from unittest.mock import patch

    from hoga.api.queries import _is_non_trading_day

    # 주말은 캘린더 무관하게 True (순수 날짜연산 우선)
    assert _is_non_trading_day("20260711") is True   # 토
    assert _is_non_trading_day("20260712") is True   # 일

    # 평일: 캘린더 판정에 위임
    with patch("hoga.api.calendar.is_trading_day", return_value=False):
        assert _is_non_trading_day("20260713") is True   # 월이지만 휴장 확정 → 배제
    with patch("hoga.api.calendar.is_trading_day", return_value=True):
        assert _is_non_trading_day("20260713") is False  # 정상 거래일 → 서빙
    with patch("hoga.api.calendar.is_trading_day", return_value=None):
        assert _is_non_trading_day("20260713") is False  # 판정 불가 → 관대(서빙)

    # 파싱 불가 형식은 보류(기존 인벤토리 동작 보존)
    assert _is_non_trading_day("not-a-date") is False
