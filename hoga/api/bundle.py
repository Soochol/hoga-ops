"""DuckDB-driven session bundle slices, one builder per slice."""
from __future__ import annotations

from pathlib import Path

import duckdb

from hoga.api.models import (
    DepthIntensity,
    QuoteRatio,
    QuoteRatioPoint,
    VolumeProfile,
    VolumeProfileBin,
)
from hoga.api.timeenc import hhmmssms_to_unix_ms, ms_from_midnight_to_unix_ms
from hoga.tables import candles as candles_tbl
from hoga.tables.candles import ApiCandle


def build_candles_slice(
    conn: duckdb.DuckDBPyConnection, *, code: str, date: str, data_dir: Path
) -> list[ApiCandle]:
    path = data_dir / "parquet" / date / code / "candles.parquet"
    rows = candles_tbl.query_all(conn, path=path)
    return [
        r.model_copy(update={"ts_ms": ms_from_midnight_to_unix_ms(date, r.ts_ms)})
        for r in rows
    ]


def build_quote_ratio_slice(
    conn: duckdb.DuckDBPyConnection,
    *,
    code: str,
    date: str,
    data_dir: Path,
    bucket_ms: int = 1000,
) -> QuoteRatio:
    path = str(data_dir / "parquet" / date / code / "snapshots.parquet")
    rows = conn.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 (ask_q1 + ask_q2 + ask_q3 + ask_q4 + ask_q5 +
                  ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) AS ask_total,
                 (bid_q1 + bid_q2 + bid_q3 + bid_q4 + bid_q5 +
                  bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) AS bid_total,
                 (ts_ms / {bucket_ms})::BIGINT AS bucket,
                 ROW_NUMBER() OVER (PARTITION BY (ts_ms / {bucket_ms})::BIGINT
                                   ORDER BY ts_ms DESC) AS rn
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms}, bid_total, ask_total
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [path],
    ).fetchall()
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                t=hhmmssms_to_unix_ms(date, r[0]),
                bid_total=int(r[1]),
                ask_total=int(r[2]),
            )
            for r in rows
        ],
    )


KRX_TICK_TIERS = [
    (2_000, 1), (5_000, 5), (20_000, 10),
    (50_000, 50), (200_000, 100),
    (500_000, 500), (float("inf"), 1_000),
]


def tick_size(price_max: int) -> int:
    for threshold, t in KRX_TICK_TIERS:
        if price_max < threshold:
            return t
    return 1_000


def _build_unpivot_sql() -> str:
    """Generate the 20-row UNPIVOT (10 ask + 10 bid) against a single `snap` CTE.

    Caller must define a `snap` CTE binding `read_parquet(?)` so the parquet
    file is scanned once and the path is parameter-bound (not f-string
    interpolated — which would be an injection surface if `code`/`date`
    ever flowed in unsanitized).
    """
    parts = []
    for i in range(1, 11):
        parts.append(
            f"SELECT ts_ms, 'ask' AS side, ask_p{i} AS price, ask_q{i} AS qty FROM snap"
        )
    for i in range(1, 11):
        parts.append(
            f"SELECT ts_ms, 'bid', bid_p{i}, bid_q{i} FROM snap"
        )
    return "\n  UNION ALL\n  ".join(parts)


def build_depth_intensity_slice(
    conn: duckdb.DuckDBPyConnection,
    *,
    code: str,
    date: str,
    data_dir: Path,
    price_min: int | None = None,
    price_max: int | None = None,
    depth_bucket_ms: int = 5000,
    max_cells: int = 2_000_000,
) -> DepthIntensity:
    code_dir = data_dir / "parquet" / date / code
    candles_path = str(code_dir / "candles.parquet")
    snapshots_path = str(code_dir / "snapshots.parquet")

    # 1. Determine price range from candles MIN(low)/MAX(high)
    if price_min is None or price_max is None:
        row = conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        price_min = int(row[0])
        price_max = int(row[1])
    tick = tick_size(price_max)
    bin_count = (price_max - price_min) // tick + 1

    # 2. Cell-cap: widen bucket until n_times * bin_count <= max_cells.
    # Trading window = 7 hours = 25,200,000 ms.
    while True:
        n_times = 25_200_000 // depth_bucket_ms
        if n_times * bin_count <= max_cells:
            break
        depth_bucket_ms *= 2

    # 3. UNPIVOT + bin (single parquet scan via `snap` CTE; path is parameter-bound)
    unpivot_sql = _build_unpivot_sql()
    rows = conn.execute(
        f"""
        WITH snap AS (
          SELECT * FROM read_parquet(?)
        ),
        unpivoted AS (
          {unpivot_sql}
        ),
        binned AS (
          SELECT (ts_ms / {depth_bucket_ms})::BIGINT AS bucket,
                 side,
                 ((price - {price_min}) / {tick})::BIGINT AS bin_idx,
                 MAX(qty) AS max_qty
          FROM unpivoted
          WHERE price BETWEEN {price_min} AND {price_max}
          GROUP BY 1, 2, 3
        )
        SELECT bucket * {depth_bucket_ms}, side, bin_idx, max_qty
        FROM binned ORDER BY bucket, side, bin_idx
        """,
        [snapshots_path],
    ).fetchall()

    # 4. Reshape into grids
    times_set = sorted({r[0] for r in rows})
    times = [hhmmssms_to_unix_ms(date, t) for t in times_set]
    bid_grid = [[0.0] * bin_count for _ in times_set]
    ask_grid = [[0.0] * bin_count for _ in times_set]
    t_idx = {t: i for i, t in enumerate(times_set)}
    for t, side, b, q in rows:
        target = ask_grid if side == "ask" else bid_grid
        target[t_idx[t]][int(b)] = float(q)

    return DepthIntensity(
        bucket_ms=depth_bucket_ms,
        price_min=price_min, price_max=price_max, price_step=tick,
        times=times, bid_grid=bid_grid, ask_grid=ask_grid,
    )


def build_volume_profile_slice(
    conn: duckdb.DuckDBPyConnection,
    *,
    code: str,
    date: str,
    data_dir: Path,
    price_min: int | None = None,
    price_max: int | None = None,
    vp_bins: int = 24,
) -> VolumeProfile:
    code_dir = data_dir / "parquet" / date / code
    candles_path = str(code_dir / "candles.parquet")
    trades_path = str(code_dir / "trades.parquet")
    if price_min is None or price_max is None:
        row = conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        price_min = int(row[0])
        price_max = int(row[1])
    bin_width = (price_max - price_min) / vp_bins
    # No side filter — auction crosses count toward volume profile per spec §4.1
    rows = conn.execute(
        f"""
        SELECT FLOOR((price - {price_min}) / {bin_width})::BIGINT AS bin_idx, SUM(qty) AS qty
        FROM read_parquet(?)
        WHERE price BETWEEN {price_min} AND {price_max}
        GROUP BY 1 ORDER BY 1
        """,
        [trades_path],
    ).fetchall()
    bins_arr = [
        VolumeProfileBin(price_low=int(price_min + i * bin_width), qty=0)
        for i in range(vp_bins)
    ]
    for idx, qty in rows:
        i = int(idx)
        if 0 <= i < vp_bins:
            bins_arr[i] = VolumeProfileBin(
                price_low=int(price_min + i * bin_width), qty=int(qty),
            )
    return VolumeProfile(
        bin_count=vp_bins, price_min=price_min, price_max=price_max,
        bin_width=int(bin_width), bins=bins_arr,
    )
