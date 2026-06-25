import pytest
from pydantic import ValidationError, TypeAdapter
from hoga.api.models import (
    ScreenerResponse, ScreenerStatusFile, ConditionLeaf,
    ScanRequest, ScreenerRow, SavedScreener, ScreenerSaveWriteRequest,
)


def test_screener_response_status_discriminates_empty():
    r = ScreenerResponse(status="not_seeded", rows=[])
    assert r.status == "not_seeded"

def test_status_file_schema_version():
    s = ScreenerStatusFile(schema_version=1, last_raw_date="20260514",
                           last_built_ms=1, universe_size=3561, derive_ms=2)
    assert s.schema_version == 1


# === A1: condition leaf discriminated union + param validators ===

_A = TypeAdapter(ConditionLeaf)

def test_leaf_discriminates_by_type():
    leaf = _A.validate_python({"id": "x1", "type": "new_high", "params": {"lookback": 200, "period": 500}})
    assert leaf.type == "new_high" and leaf.params.lookback == 200

def test_change_pct_gte_requires_pct():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "change_pct", "params": {"op": "gte"}})

def test_change_pct_between_requires_lo_le_hi():
    ok = _A.validate_python({"id": "x", "type": "change_pct", "params": {"op": "between", "lo": 2, "hi": 5}})
    assert ok.params.lo == 2
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "change_pct", "params": {"op": "between", "lo": 5, "hi": 2}})

def test_price_range_needs_at_least_one_bound():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "price_range", "params": {}})

def test_ma_relation_literal():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "ma", "params": {"period": 20, "relation": "sideways"}})

def test_ma_source_defaults_close_and_rejects_unknown():
    leaf = _A.validate_python({"id": "x", "type": "ma", "params": {"period": 20, "relation": "above"}})
    assert leaf.params.source == "close"
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "ma", "params": {"period": 20, "relation": "above", "source": "vwap"}})


# === A2: ScanRequest / flat ScreenerRow / saved-screener models ===

def test_scan_request_defaults():
    r = ScanRequest.model_validate({"conditions": [], "universe": {}})
    assert r.limit == 1000 and r.universe.markets == [] and r.basis == "eod"


def test_scan_request_accepts_intraday_basis():
    r = ScanRequest.model_validate({"conditions": [], "universe": {}, "basis": "intraday"})
    assert r.basis == "intraday"

def test_screener_row_is_flat_no_matches():
    row = ScreenerRow(code="005930", name="삼성전자", market="KOSPI",
                      price=74200, trade_value_won=842_000_000_000, change_pct=5.8)
    assert not hasattr(row, "new_high") and not hasattr(row, "matches")

def test_saved_screener_roundtrip():
    req = ScreenerSaveWriteRequest(name="급등주", conditions=[
        {"id": "a", "type": "new_high", "params": {"lookback": 200, "period": 500}}], universe={})
    s = SavedScreener(id="srv1", created_at_ms=1, updated_at_ms=1, **req.model_dump())
    assert s.conditions[0].type == "new_high" and s.created_at_ms == 1


def test_new_today_and_period_leaves_roundtrip():
    nt = _A.validate_python({"id": "x", "type": "new_high_today", "params": {"period": 200}})
    assert nt.type == "new_high_today" and nt.params.period == 200
    tv = _A.validate_python({"id": "y", "type": "trade_value_period", "params": {"lookback": 60, "min_eok": 1000}})
    assert tv.type == "trade_value_period" and tv.params.min_eok == 1000

def test_period_params_reject_below_one():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "new_high_today", "params": {"period": 0}})
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "y", "type": "trade_value_period", "params": {"lookback": 0, "min_eok": 1}})

def test_existing_new_high_still_parses_backcompat():
    # 디스크 saves.json의 기존 new_high 형태(타입 불변)가 여전히 유효 — 마이그레이션 0.
    leaf = _A.validate_python({"id": "old", "type": "new_high", "params": {"lookback": 500, "period": 250}})
    assert leaf.type == "new_high" and leaf.params.period == 250
