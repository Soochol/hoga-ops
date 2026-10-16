"""Date-effective stock sessions, separate from the KRX official closing price.

2026-09-14: KRX continuous after-market replaces the single-price market.
Sources: docs/research/2026-09-11-krx-aftermarket-official-sources.md.
These are market windows, not a claim that every instrument is eligible.
"""
from __future__ import annotations

from datetime import datetime

from hoga.util.timeenc import KST, hhmmssms_to_unix_ms, unix_ms_to_hhmmssms

KRX_AFTERMARKET_START_DATE = "20260914"
KRX_AFTERMARKET_OPEN_MIN = 16 * 60
KRX_AFTERMARKET_CLOSE_MIN = 20 * 60


def krx_aftermarket_introduced(date: str) -> bool:
    return len(date) == 8 and date.isdigit() and date >= KRX_AFTERMARKET_START_DATE  # noqa: PLR2004 — YYYYMMDD


def krx_aftermarket_window(t_ms: int) -> bool:
    """Clock-only window; the capture gate also checks the holiday calendar."""
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    minute = kst.hour * 60 + kst.minute
    return (
        kst.weekday() < 5  # noqa: PLR2004 — weekdays
        and krx_aftermarket_introduced(kst.strftime("%Y%m%d"))
        and KRX_AFTERMARKET_OPEN_MIN <= minute < KRX_AFTERMARKET_CLOSE_MIN
    )


def stock_indicator_window(t_ms: int, venue: str) -> bool:
    """Use the venue's capture clock for live peaks and alerts as well."""
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    if kst.weekday() >= 5:  # noqa: PLR2004 — weekends
        return False
    minute = kst.hour * 60 + kst.minute
    if venue in ("NXT", "UN"):
        return 8 * 60 <= minute < 20 * 60
    return venue == "KRX" and (9 * 60 <= minute < 15 * 60 + 30 or krx_aftermarket_window(t_ms))


def stock_indicator_bounds(
    date: str, venue: str, *, regular_open_ms: int = 90000000,
    regular_close_ms: int = 153000000, aftermarket_eligible: bool | None = None,
) -> tuple[int, int]:
    """Indicator extent, independently of the official regular-session close."""
    if venue in ("NXT", "UN"):
        return 80000000, 200000000
    closing = 200000000 if krx_aftermarket_introduced(date) and aftermarket_eligible is not False else regular_close_ms
    return regular_open_ms or 90000000, closing


def stock_indicator_break(
    date: str, venue: str, *, regular_close_ms: int = 153000000,
) -> tuple[int, int] | None:
    """Exclude the KRX break and residual regular books from evening indicators.

    Endpoints remain eligible: the closing auction is excluded structurally and
    an actual 16:00 opening book must be admitted. Other venues have no KRX break.
    """
    if venue == "KRX" and krx_aftermarket_introduced(date):
        return regular_close_ms, 160000000
    return None


def krx_capture_partition(t_ms: int) -> tuple[str, bool]:
    """Carry cannot cross either midnight or the new 16:00 reopening."""
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    date = kst.strftime("%Y%m%d")
    return date, krx_aftermarket_introduced(date) and kst.hour >= 16  # noqa: PLR2004


def minute_bucket_start(t_ms: int, bucket_ms: int, venue: str) -> int:
    """Large KRX minute candles start a separate bucket at the reopening."""
    if bucket_ms >= 2 * 3_600_000 and venue == "KRX" and krx_aftermarket_window(t_ms):
        kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
        anchor = int(kst.replace(hour=16, minute=0, second=0, microsecond=0).timestamp() * 1000)
        return anchor + (t_ms - anchor) // bucket_ms * bucket_ms
    return t_ms // bucket_ms * bucket_ms


def has_aftermarket_buckets(date: str, venue: str, bucket_ms: int) -> bool:
    """Extended 120/240m indicators must share the candle's UTC grid."""
    return bucket_ms >= 2 * 3_600_000 and (
        venue in ("NXT", "UN") or (venue == "KRX" and krx_aftermarket_introduced(date))
    )


def indicator_bucket_intra(intra_ms: int, bucket_ms: int, *, date: str, venue: str) -> int:
    """Preserve old KST bucketing; new KRX coarse rows share the candle grid."""
    if not has_aftermarket_buckets(date, venue, bucket_ms):
        return intra_ms // bucket_ms * bucket_ms
    # Supported coarse buckets (120/240m) divide a UTC day. Convert the
    # KST-native row to the same UTC grid without datetime work per row.
    opening = KRX_AFTERMARKET_OPEN_MIN * 60_000
    if venue == "KRX" and opening <= intra_ms < KRX_AFTERMARKET_CLOSE_MIN * 60_000:
        return opening + (intra_ms - opening) // bucket_ms * bucket_ms
    utc_offset_ms = 9 * 3_600_000
    return (intra_ms - utc_offset_ms) // bucket_ms * bucket_ms + utc_offset_ms


def indicator_bucket_sql(intra: str, bucket_ms: int, *, date: str, venue: str) -> str:
    """SQL counterpart of indicator_bucket_intra for snapshot-only peak scans."""
    if not has_aftermarket_buckets(date, venue, bucket_ms):
        return f"({intra} // {int(bucket_ms)})"
    opening = KRX_AFTERMARKET_OPEN_MIN * 60_000
    closing = KRX_AFTERMARKET_CLOSE_MIN * 60_000
    offset = 9 * 3_600_000
    regular_grid = f"{offset} + CAST(floor(({intra} - {offset}) / {int(bucket_ms)}) AS BIGINT) * {int(bucket_ms)}"
    if venue != "KRX":
        return regular_grid
    return (
        f"CASE WHEN {intra} >= {opening} AND {intra} < {closing} "
        f"THEN {opening} + (({intra} - {opening}) // {int(bucket_ms)}) * {int(bucket_ms)} "
        f"ELSE {regular_grid} END"
    )


def krx_continuous_windows(
    date: str, venue: str, opening: int, closing: int, *, regular_close_ms: int | None = None,
) -> tuple[tuple[int, int], ...] | None:
    """Native HHMMSSmmm windows; None preserves historical/other-venue policy."""
    if venue != "KRX" or not krx_aftermarket_introduced(date):
        return None
    # The query boundary may be clipped; callers with metadata pass the actual
    # regular close so a partial query cannot invent a closing auction.
    regular_close = min(closing, 153_000_000) if regular_close_ms is None else regular_close_ms
    auction_start = int(unix_ms_to_hhmmssms(
        date, hhmmssms_to_unix_ms(date, regular_close) - 10 * 60_000,
    ))
    return tuple((lo, hi) for lo, hi in (
        (opening, min(closing, auction_start)),
        (max(opening, 160_000_000), closing),
    ) if lo < hi)
