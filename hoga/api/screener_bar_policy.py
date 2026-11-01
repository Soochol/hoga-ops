"""Shared selection policy for candle conditions and the SQL boundary."""
from hoga.api.models import (
    SCREENER_RANK_TYPES,
    BarTradeValueRangeParams,
    BarVolumeRangeParams,
    ChangePctRangeParams,
    MaCompareRangeParams,
    MaCrossRangeParams,
    MaGapRangeParams,
    MaSlopeRangeParams,
    PriceCompareRangeParams,
    VolumeCompareDateParams,
    VolumeRangeDateParams,
    VolumeRatioDateParams,
)

BOLLINGER_POSITION_TYPES = frozenset({"bollinger_position_today", "bollinger_position"})
RANK_TYPES = SCREENER_RANK_TYPES
BOLLINGER_TYPES = BOLLINGER_POSITION_TYPES | frozenset({"bollinger_breakout_today", "bollinger_breakout"})

MA_TYPES = frozenset({"ma_compare", "ma_compare_period", "ma_cross", "ma_cross_period",
                      "ma_gap", "ma_gap_period", "ma_slope", "ma_slope_period"})

PRICE_COMPARE_TYPES = frozenset({"price_compare", "price_compare_period"})
VOLUME_CONDITION_TYPES = frozenset({"volume_range", "volume_range_period", "volume_compare", "volume_compare_period",
                                   "volume_ratio", "volume_ratio_period"})
BAR_ONLY_TYPES = (BOLLINGER_TYPES | PRICE_COMPARE_TYPES | MA_TYPES | VOLUME_CONDITION_TYPES
                  | frozenset({"change_pct_period"}))

CANDLE_TYPES = BAR_ONLY_TYPES | frozenset({"new_high", "new_high_today", "new_high_vol", "new_high_vol_today",
                          "high_off_peak", "ma", "trade_value", "trade_value_period",
                          "change_pct", "change_pct_period"})
RANGE_PARAMS = (BarVolumeRangeParams, BarTradeValueRangeParams, ChangePctRangeParams, PriceCompareRangeParams,
                MaCompareRangeParams, MaCrossRangeParams, MaGapRangeParams, MaSlopeRangeParams,
                VolumeRangeDateParams, VolumeCompareDateParams, VolumeRatioDateParams)
CHANGE_TYPES = frozenset({"change_pct", "change_pct_period"})
TRADE_VALUE_TYPES = frozenset({"trade_value", "trade_value_period"})

VOLUME_TYPES = VOLUME_CONDITION_TYPES | frozenset({"new_high_vol", "new_high_vol_today"})


def needs_bars(leaf) -> bool:
    return leaf.type in BAR_ONLY_TYPES or leaf.type in CANDLE_TYPES and (
        isinstance(leaf.params, RANGE_PARAMS)
        or getattr(leaf.params, "timeframe", "D") != "D"
        or not getattr(leaf.params, "include_open_bar", True)
        or getattr(leaf.params, "change_reference", "previous_day") != "previous_day")


def lookback(leaf) -> int:
    return getattr(leaf.params, "lookback", 1)


def _volume_period(leaf) -> int:
    p = leaf.params
    if leaf.type.startswith("volume_compare"):
        return max(p.left_offset, p.right_offset) + 1
    return p.offset + 1 + (p.period if leaf.type.startswith("volume_ratio") else 0)


def comparison_period(leaf) -> int:
    if leaf.type in VOLUME_CONDITION_TYPES:
        return _volume_period(leaf)
    if leaf.type in BOLLINGER_POSITION_TYPES:
        return leaf.params.period
    if leaf.type in BOLLINGER_TYPES:
        return leaf.params.period + 1  # Both current and previous bands need a full window.
    if leaf.type in MA_TYPES:
        p = leaf.params
        if leaf.type in {"ma_slope", "ma_slope_period"}:
            return p.average.offset + p.average.period + p.lag
        needed = max(operand.offset + getattr(operand, "period", 1) for operand in (p.left, p.right))
        return needed + (leaf.type in {"ma_cross", "ma_cross_period"})
    if leaf.type in PRICE_COMPARE_TYPES:
        return max(leaf.params.left.offset, leaf.params.right.offset) + 1
    if leaf.type in CHANGE_TYPES:
        return 2 if leaf.params.change_reference == "previous_bar" else 1
    return (leaf.params.record_period.value if hasattr(leaf.params, "record_period")
            else getattr(leaf.params, "period", 1))
