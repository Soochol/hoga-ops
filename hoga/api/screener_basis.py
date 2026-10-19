"""Server-owned automatic selection and the actual snapshot cutoff."""
import datetime as dt
from pathlib import Path
from typing import Literal

import polars as pl

from hoga.api import screener_intraday
from hoga.api.models import ScanBasis
from hoga.api.screener_calendar import EOD_CUTOFF_HOUR
from hoga.api.screener_write_lock import screener_read_lock
from hoga.live.stock_sessions import stock_indicator_window
from hoga.util.timeenc import KST


def confirmed_timestamp(sdir: Path, codes: list[str]) -> int | None:
    if not codes:
        return None
    # This comes from the input universe, even if every condition rejects it.
    # Matched occurrence dates and request completion time are not data cutoffs.
    with screener_read_lock(sdir):
        day = (pl.scan_parquet(sdir / "daily_adjusted.parquet")
               .filter(pl.col("code").is_in(codes)).select(pl.col("date").max()).collect().item())
    if day is None:
        return None
    return int(dt.datetime.combine(day, dt.time(15, 30), KST).timestamp() * 1000)


def choose_basis(requested: ScanBasis, now: dt.datetime, confirmed_at: int | None,
                 data_dir: Path) -> Literal["eod", "intraday"]:
    if requested != "auto":
        return requested
    if screener_intraday.session_warning(data_dir, now):
        return "eod"
    if (now.hour >= EOD_CUTOFF_HOUR and not stock_indicator_window(int(now.timestamp() * 1000), "KRX")
            and confirmed_at is not None
            and dt.datetime.fromtimestamp(confirmed_at / 1000, KST).date() >= now.date()):
        return "eod"
    # Keep today's final quote until the confirmed corpus has caught up.
    return "intraday"


def evaluation_times(confirmed_at: int | None, now: dt.datetime, *, live_conditions: bool,
                     overlay_at: int | None, partial: bool) -> dict[str, int | None]:
    live_at = int(now.timestamp() * 1000) if live_conditions else overlay_at
    return {"basis_at_ms": live_at if live_at is not None else confirmed_at,
            "fallback_basis_at_ms": confirmed_at if live_at is not None and partial else None}
