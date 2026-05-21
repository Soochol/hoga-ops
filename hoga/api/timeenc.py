"""Time encoding helpers for the API boundary, per ADR 0003.

Parquet tables retain hogaplay's native encodings (HHMMSSmmm for trades /
snapshots / brokers / info, ms-from-midnight for candles). The Api* models
expose Unix epoch ms (UTC) everywhere. Hogaplay is KRX-only, so the offset
is a fixed +09:00 with no DST.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import NewType

KST = timezone(timedelta(hours=9))

# Encoding-as-type for hogaplay's native packed-decimal time. HogaMs values
# are HHMMSSmmm (e.g., 90000000 = 09:00:00.000) — they MUST be converted via
# hhmmssms_to_unix_ms before reaching any wire surface (ADR-0003). Pyright
# uses this to catch accidental encoding mixups in collector / capture state.
# Runtime is identity (zero-cost); the type only carries meaning at check time.
HogaMs = NewType("HogaMs", int)


def _date_unix_ms_at_kst_midnight(date: str) -> int:
    dt = datetime.strptime(date, "%Y%m%d").replace(tzinfo=KST)
    return int(dt.timestamp() * 1000)


def hhmmssms_to_unix_ms(date: str, hhmmssms: int) -> int:
    """Convert hogaplay's HHMMSSmmm packed-decimal time to Unix ms (UTC).

    Example: ``hhmmssms_to_unix_ms("20260518", 90000000) == 1779062400000``
    (09:00:00.000 KST on 2026-05-18).
    """
    h = hhmmssms // 10_000_000
    m = (hhmmssms // 100_000) % 100
    s = (hhmmssms // 1000) % 100
    ms = hhmmssms % 1000
    return _date_unix_ms_at_kst_midnight(date) + (h * 3600 + m * 60 + s) * 1000 + ms


def ms_from_midnight_to_unix_ms(date: str, intra_ms: int) -> int:
    """Convert candles.parquet's ms-from-midnight to Unix ms (UTC)."""
    return _date_unix_ms_at_kst_midnight(date) + intra_ms


def unix_ms_to_hhmmssms(date: str, unix_ms: int) -> int:
    """Inverse of :func:`hhmmssms_to_unix_ms` — used by route handlers that
    take a Unix-ms cursor and need to query a Parquet table that stores
    HHMMSSmmm. ``date`` is the Stock-Date the cursor falls into.
    """
    base = _date_unix_ms_at_kst_midnight(date)
    delta_ms = unix_ms - base
    if not 0 <= delta_ms < 86_400_000:
        raise ValueError(f"Unix ms {unix_ms} is not within Stock-Date {date}")
    h, rem = divmod(delta_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return h * 10_000_000 + m * 100_000 + s * 1000 + ms
