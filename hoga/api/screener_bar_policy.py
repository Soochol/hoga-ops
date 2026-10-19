"""Shared selection policy for candle conditions and the SQL boundary."""
from hoga.api.models import BarVolumeRangeParams

CANDLE_TYPES = frozenset({"new_high", "new_high_today", "new_high_vol", "new_high_vol_today",
                          "high_off_peak", "ma"})
VOLUME_TYPES = frozenset({"new_high_vol", "new_high_vol_today"})


def needs_bars(leaf) -> bool:
    return leaf.type in CANDLE_TYPES and (
        isinstance(leaf.params, BarVolumeRangeParams)
        or getattr(leaf.params, "timeframe", "D") != "D"
        or not getattr(leaf.params, "include_open_bar", True))


def lookback(leaf) -> int:
    return getattr(leaf.params, "lookback", 1)
