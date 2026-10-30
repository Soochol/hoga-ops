"""Shared selection policy for candle conditions and the SQL boundary."""
from hoga.api.models import BarTradeValueRangeParams, BarVolumeRangeParams

BOLLINGER_POSITION_TYPES = frozenset({"bollinger_position_today", "bollinger_position"})
RANK_TYPES = frozenset({"trade_value_rank", "change_pct_rank"})
BOLLINGER_TYPES = BOLLINGER_POSITION_TYPES | frozenset({"bollinger_breakout_today", "bollinger_breakout"})

CANDLE_TYPES = BOLLINGER_TYPES | frozenset({"new_high", "new_high_today", "new_high_vol", "new_high_vol_today",
                          "high_off_peak", "ma", "trade_value", "trade_value_period", "change_pct"})
RANGE_PARAMS = (BarVolumeRangeParams, BarTradeValueRangeParams)
TRADE_VALUE_TYPES = frozenset({"trade_value", "trade_value_period"})

VOLUME_TYPES = frozenset({"new_high_vol", "new_high_vol_today"})


def needs_bars(leaf) -> bool:
    return leaf.type in BOLLINGER_TYPES or leaf.type in CANDLE_TYPES and (
        isinstance(leaf.params, RANGE_PARAMS)
        or getattr(leaf.params, "timeframe", "D") != "D"
        or not getattr(leaf.params, "include_open_bar", True)
        or getattr(leaf.params, "change_reference", "previous_day") != "previous_day")


def lookback(leaf) -> int:
    return getattr(leaf.params, "lookback", 1)


def comparison_period(leaf) -> int:
    if leaf.type in BOLLINGER_POSITION_TYPES:
        return leaf.params.period
    if leaf.type in BOLLINGER_TYPES:
        return leaf.params.period + 1  # Both current and previous bands need a full window.
    if leaf.type == "change_pct":
        return 2 if leaf.params.change_reference == "previous_bar" else 1
    if hasattr(leaf.params, "record_period"):
        return leaf.params.record_period.value
    return getattr(leaf.params, "period", 1)
