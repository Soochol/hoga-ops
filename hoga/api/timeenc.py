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


def unix_ms_to_ms_from_midnight(date: str, unix_ms: int) -> int:
    """Inverse of :func:`ms_from_midnight_to_unix_ms` — encode a Unix ms (UTC)
    instant as candles.parquet's native ms-from-KST-midnight for ``date``.

    Write-path counterpart used when persisting externally-sourced bars (e.g.
    KIS minute candles, whose ``t_ms`` is Unix epoch ms) into a Stock-Date's
    ``candles.parquet``. Keeping the pair together makes the round-trip
    (encode → decode) the single test surface for the offset, mirroring the
    write↔read symmetry of ``candles.{write,read}_parquet``."""
    return unix_ms - _date_unix_ms_at_kst_midnight(date)


def hhmmssms_to_intra_ms_sql(col: str) -> str:
    """Build a DuckDB SQL expression that decodes a HHMMSSmmm column to
    linear ms-from-midnight.

    Why this exists:

      Parquet `ts_ms` columns (snapshots, trades, brokers) carry hogaplay's
      native HHMMSSmmm packed-decimal time. The encoding is NON-LINEAR — the
      integer values jump at minute (`...59999` → `...100000`) and hour
      (`...959999` → `...1000000`) boundaries. Any arithmetic bucketing of
      the raw HHMMSSmmm (e.g. `ts_ms // 60000` for 1-minute buckets) lands
      in invalid HHMMSSmmm regions (`seconds=60+`, `minutes=60+`) which
      `hhmmssms_to_unix_ms` then decodes back into valid-looking but WRONG
      Unix-ms values, producing duplicate or out-of-order series points
      (frontend lightweight-charts throws "asc ordered by time" on these).

      The fix is to decode HHMMSSmmm → linear ms-from-midnight BEFORE
      bucketing, then bucket on the linear space. Callers should pass the
      bucket-aligned intra_ms through ``ms_from_midnight_to_unix_ms`` (not
      ``hhmmssms_to_unix_ms``) on the way out.

    Use ``//`` (DuckDB integer division) inside the expression — the plain
    ``/`` operator returns DOUBLE, and ``::BIGINT`` rounds half-to-even,
    which IS the root cause of the dup bug this helper exists to prevent.

    Example::

        sql = f\"\"\"
          WITH linear AS (
            SELECT {hhmmssms_to_intra_ms_sql('ts_ms')} AS intra_ms, ...
            FROM read_parquet(?)
          )
          SELECT (intra_ms // {bucket_ms}) * {bucket_ms} AS bucket_intra_ms,
                 ...
          FROM linear GROUP BY 1 ORDER BY 1
        \"\"\"
    """
    return (
        f"((({col} // 10000000) * 3600000)"
        f" + ((({col} // 100000) % 100) * 60000)"
        f" + ((({col} // 1000) % 100) * 1000)"
        f" + ({col} % 1000))"
    )


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
