import pytest
from pydantic import ValidationError
from hoga.api.models import (
    BreakoutHit, BreakoutMiss, ScreenerRow, ScreenerResponse,
    ScreenerStatusFile, BreakoutFilter,
)

def test_breakout_hit_requires_fields():
    h = BreakoutHit(hit=True, event_date="20260514", days_ago=3, period_extreme=323000)
    assert h.hit is True and h.days_ago == 3

def test_breakout_miss_is_bare():
    m = BreakoutMiss(hit=False)
    assert m.hit is False

def test_screener_row_code_is_str_leading_zero():
    row = ScreenerRow(
        code="005930", name="삼성전자", market="KOSPI", price=317000,
        trade_value_won=11699639541368, change_pct=5.84,
        new_high=BreakoutHit(hit=True, event_date="20260514", days_ago=0, period_extreme=323000),
        new_high_vol=BreakoutMiss(hit=False),
    )
    assert row.code == "005930"

def test_screener_row_code_rejects_non_6digit():
    with pytest.raises(ValidationError):
        ScreenerRow(code="5930", name="x", market="KOSPI", price=1,
                    trade_value_won=1, change_pct=None, new_high=None, new_high_vol=None)

def test_breakout_filter_bounds():
    BreakoutFilter(lookback=200, period=500)
    with pytest.raises(ValidationError):
        BreakoutFilter(lookback=0, period=500)

def test_screener_response_status_discriminates_empty():
    r = ScreenerResponse(status="not_seeded", rows=[])
    assert r.status == "not_seeded"

def test_status_file_schema_version():
    s = ScreenerStatusFile(schema_version=1, last_raw_date="20260514",
                           last_built_ms=1, universe_size=3561, derive_ms=2)
    assert s.schema_version == 1


# === A1: condition leaf discriminated union + param validators ===

from pydantic import TypeAdapter
from hoga.api.models import ConditionLeaf

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
