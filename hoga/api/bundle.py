"""DuckDB-driven session bundle slices, one builder per slice.

Each ``build_*_slice`` takes a :class:`QueryEngine` (per ADR-0001 the
cross-table coordinator) and resolves its own Parquet path via
``engine.parquet_dir``. The engine also owns the DuckDB connection.

Why the engine instead of ``(conn, data_dir)``:
  * single source of truth for path layout (``parquet_dir`` raises
    ``StockDateNotFound`` consistently);
  * builders compose into ``build_bundle`` without threading three
    arguments through every call site;
  * ``meta.json`` access goes through ``engine.get_meta`` instead of
    re-reading the file by hand.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException

from hoga.api.models import (
    DepthIntensity,
    FillStrength,
    FillStrengthPoint,
    QuoteRatio,
    QuoteRatioPoint,
    RangeBundle,
    RangeSegment,
    SessionBundle,
    VolumeProfile,
    VolumeProfileBin,
    validate_bucket_ms,
)
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import (
    hhmmssms_to_intra_ms_sql,
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
)
from hoga.tables import candles as candles_tbl
from hoga.tables.candles import ApiCandle


def downsample_candles(candles: list[ApiCandle], *, bucket_ms: int) -> list[ApiCandle]:
    """Re-aggregate 1-minute OHLCV candles into the requested Timeframe bucket.

    Aggregation per bucket: open = first.open, close = last.close,
    high = max(high), low = min(low), vol_a/vol_b = sum.

    Input must be sorted by ts_ms ascending (this function does NOT sort).
    `bucket_ms == 60_000` returns the input verbatim (identity case).
    The last bucket may be partial (fewer than bucket_ms/60_000 source candles).

    Raises ValueError if bucket_ms is not in ALLOWED_TIMEFRAME_MS (ADR-0014).
    """
    validate_bucket_ms(bucket_ms)
    if bucket_ms == 60_000 or not candles:
        return list(candles)

    out: list[ApiCandle] = []
    bucket_start = (candles[0].ts_ms // bucket_ms) * bucket_ms
    bucket_open = candles[0].open
    bucket_high = candles[0].high
    bucket_low = candles[0].low
    bucket_close = candles[0].close
    bucket_va = candles[0].vol_a
    bucket_vb = candles[0].vol_b

    for c in candles[1:]:
        c_bucket = (c.ts_ms // bucket_ms) * bucket_ms
        if c_bucket != bucket_start:
            out.append(ApiCandle(
                ts_ms=bucket_start, open=bucket_open, close=bucket_close,
                high=bucket_high, low=bucket_low, vol_a=bucket_va, vol_b=bucket_vb,
            ))
            bucket_start = c_bucket
            bucket_open = c.open
            bucket_high = c.high
            bucket_low = c.low
            bucket_va = 0
            bucket_vb = 0
        bucket_high = max(bucket_high, c.high)
        bucket_low = min(bucket_low, c.low)
        bucket_close = c.close
        bucket_va += c.vol_a
        bucket_vb += c.vol_b

    out.append(ApiCandle(
        ts_ms=bucket_start, open=bucket_open, close=bucket_close,
        high=bucket_high, low=bucket_low, vol_a=bucket_va, vol_b=bucket_vb,
    ))
    return out


def build_candles_slice(
    engine: QueryEngine, *, code: str, date: str
) -> list[ApiCandle]:
    path = engine.parquet_dir(date, code) / "candles.parquet"
    rows = candles_tbl.query_all(engine.conn, path=path)
    return [
        r.model_copy(update={"ts_ms": ms_from_midnight_to_unix_ms(date, r.ts_ms)})
        for r in rows
    ]


def build_quote_ratio_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 1000,
) -> QuoteRatio:
    # Bucket on LINEAR ms-from-midnight, not raw HHMMSSmmm. The raw encoding
    # has gaps at minute / hour boundaries, so arithmetic bucketing of HHMMSSmmm
    # produces invalid HHMMSSmmm values that decode (via hhmmssms_to_unix_ms)
    # to duplicate or out-of-order Unix-ms outputs — which lightweight-charts
    # then rejects with "asc ordered by time". See hhmmssms_to_intra_ms_sql.
    path = str(engine.parquet_dir(date, code) / "snapshots.parquet")
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    rows = engine.conn.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 (ask_q1 + ask_q2 + ask_q3 + ask_q4 + ask_q5 +
                  ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) AS ask_total,
                 (bid_q1 + bid_q2 + bid_q3 + bid_q4 + bid_q5 +
                  bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) AS bid_total,
                 ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 ROW_NUMBER() OVER (PARTITION BY ({intra_ms_expr} // {bucket_ms})
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
                # r[0] is bucket-aligned ms-from-midnight, not HHMMSSmmm.
                t=ms_from_midnight_to_unix_ms(date, r[0]),
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
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    price_min: int | None = None,
    price_max: int | None = None,
    depth_bucket_ms: int = 5000,
    max_cells: int = 2_000_000,
) -> DepthIntensity:
    code_dir = engine.parquet_dir(date, code)
    candles_path = str(code_dir / "candles.parquet")
    snapshots_path = str(code_dir / "snapshots.parquet")

    # 1. Determine price range from candles MIN(low)/MAX(high)
    if price_min is None or price_max is None:
        row = engine.conn.execute(
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
    # Bucket on LINEAR ms-from-midnight via hhmmssms_to_intra_ms_sql — see
    # build_quote_ratio_slice for the rationale (HHMMSSmmm non-linearity).
    unpivot_sql = _build_unpivot_sql()
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    rows = engine.conn.execute(
        f"""
        WITH snap AS (
          SELECT * FROM read_parquet(?)
        ),
        unpivoted AS (
          {unpivot_sql}
        ),
        binned AS (
          SELECT ({intra_ms_expr} // {depth_bucket_ms}) AS bucket,
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
    # r[0] is bucket-aligned ms-from-midnight (linear), not HHMMSSmmm.
    times_set = sorted({r[0] for r in rows})
    times = [ms_from_midnight_to_unix_ms(date, t) for t in times_set]
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
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    price_min: int | None = None,
    price_max: int | None = None,
    vp_bins: int = 24,
) -> VolumeProfile:
    code_dir = engine.parquet_dir(date, code)
    candles_path = str(code_dir / "candles.parquet")
    trades_path = str(code_dir / "trades.parquet")
    if price_min is None or price_max is None:
        row = engine.conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        price_min = int(row[0])
        price_max = int(row[1])
    bin_width = (price_max - price_min) / vp_bins
    # No side filter — auction crosses count toward volume profile per spec §4.1
    rows = engine.conn.execute(
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


def build_volume_profile_range(
    engine: QueryEngine,
    *,
    code: str,
    dates: list[str],
    vp_bins: int = 24,
) -> VolumeProfile:
    """Union trades.parquet across all in-range Stock-Dates into one price-binned
    profile (range-wide POC view, ADR-0013).

    Bin-count policy mirrors build_volume_profile_slice (vp_bins=24 by default)
    applied to the unioned price range. Uses DuckDB's multi-file read_parquet
    via a list parameter — no f-string SQL for the path (matches bundle.py:145
    convention; see plan-eng-review D3).
    """
    if not dates:
        return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])

    paths = [str(engine.parquet_dir(d, code) / "trades.parquet") for d in dates]

    min_max = engine.conn.execute(
        "SELECT MIN(price), MAX(price) FROM read_parquet(?)", [paths],
    ).fetchone()
    if min_max is None or min_max[0] is None:
        return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])
    price_min, price_max = int(min_max[0]), int(min_max[1])

    # Bin-width derived from vp_bins, mirroring build_volume_profile_slice.
    # Guard against zero-width range (single-price day) by flooring at 1.
    bin_width_raw = (price_max - price_min) / vp_bins if vp_bins > 0 else 1
    if bin_width_raw <= 0:
        bin_width_raw = 1

    # No side filter — auction crosses count toward volume profile per spec §4.1.
    # Path is parameter-bound (list) for multi-file glob; bin arithmetic is
    # f-string'd since price_min/bin_width_raw are server-derived numerics.
    rows = engine.conn.execute(
        f"""
        SELECT FLOOR((price - {price_min}) / {bin_width_raw})::BIGINT AS bin_idx,
               SUM(qty) AS qty
        FROM read_parquet(?)
        WHERE price BETWEEN {price_min} AND {price_max}
        GROUP BY 1 ORDER BY 1
        """,
        [paths],
    ).fetchall()

    bins_arr = [
        VolumeProfileBin(price_low=int(price_min + i * bin_width_raw), qty=0)
        for i in range(vp_bins)
    ]
    for idx, qty in rows:
        i = int(idx)
        if 0 <= i < vp_bins:
            bins_arr[i] = VolumeProfileBin(
                price_low=int(price_min + i * bin_width_raw), qty=int(qty),
            )

    return VolumeProfile(
        bin_count=vp_bins,
        price_min=price_min,
        price_max=price_max,
        bin_width=int(bin_width_raw),
        bins=bins_arr,
    )


def build_fill_strength_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 60_000,
) -> FillStrength:
    # Bucket on LINEAR ms-from-midnight, not HHMMSSmmm. With the previous
    # `(ts_ms / 60000)::BIGINT * 60000` pattern, a raw 11:00:59.000
    # (HHMMSSmmm=110_059_000) bucketed to integer 1834, multiplied back to
    # 110_040_000 = HHMMSSmmm "11:00:40.000" — an out-of-order ghost time
    # that fold-decoded via hhmmssms_to_unix_ms to 11:40:20 KST (39-min
    # backward jump). See hhmmssms_to_intra_ms_sql for the encoding details.
    path = str(engine.parquet_dir(date, code) / "trades.parquet")
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    rows = engine.conn.execute(
        f"""
        SELECT (({intra_ms_expr} // {bucket_ms}) * {bucket_ms}) AS bucket,
               SUM(CASE WHEN side = 1 THEN qty ELSE 0 END) AS buy_qty,
               SUM(CASE WHEN side = -1 THEN qty ELSE 0 END) AS sell_qty
        FROM read_parquet(?)
        WHERE side != 0
        GROUP BY 1 ORDER BY 1
        """,
        [path],
    ).fetchall()
    return FillStrength(
        bucket_ms=bucket_ms,
        points=[
            FillStrengthPoint(
                # r[0] is bucket-aligned ms-from-midnight (linear), not HHMMSSmmm.
                t=ms_from_midnight_to_unix_ms(date, r[0]),
                buy_qty=int(r[1]),
                sell_qty=int(r[2]),
            )
            for r in rows
        ],
    )


def build_bundle(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    price_min: int | None = None,
    price_max: int | None = None,
    vp_bins: int = 24,
    bucket_ms: int = 60_000,
) -> SessionBundle:
    """Assemble a SessionBundle for one Stock-Date at the requested Timeframe.

    ``bucket_ms`` (ADR-0014) drives the time bucket for every time-aware
    series: candles (via :func:`downsample_candles`), quote_ratio,
    depth_intensity, and fill_strength. ``volume_profile`` is time-agnostic
    and is not affected. ``bucket_ms`` must be in ``ALLOWED_TIMEFRAME_MS``.
    """
    validate_bucket_ms(bucket_ms)
    meta = engine.get_meta(date, code)
    session_open_ms = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])
    session_close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])

    raw_candles = build_candles_slice(engine, code=code, date=date)
    candles = downsample_candles(raw_candles, bucket_ms=bucket_ms)
    qr = build_quote_ratio_slice(engine, code=code, date=date, bucket_ms=bucket_ms)
    di = build_depth_intensity_slice(
        engine,
        code=code,
        date=date,
        price_min=price_min,
        price_max=price_max,
        depth_bucket_ms=bucket_ms,
    )
    vp = build_volume_profile_slice(
        engine,
        code=code,
        date=date,
        price_min=price_min,
        price_max=price_max,
        vp_bins=vp_bins,
    )
    fs = build_fill_strength_slice(engine, code=code, date=date, bucket_ms=bucket_ms)

    return SessionBundle(
        code=code,
        date=date,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
        candles=candles,
        quote_ratio=qr,
        depth_intensity=di,
        volume_profile=vp,
        fill_strength=fs,
    )


MAX_RANGE_DAYS = 30


def build_range_bundle(
    engine: QueryEngine,
    *,
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
) -> RangeBundle:
    """Build the Wire Model for a Stock-Date Range (ADR-0013, ADR-0014).

    Validates ``bucket_ms``, ``from_date <= to_date``, and span <= 30 days.
    Returns HTTP 404 if no Stock-Date in range has captured data.

    Loops over captured Stock-Dates: per-day :func:`build_bundle` for series.
    ``depth_intensity`` and ``volume_profile`` are returned as per-segment
    lists (each Stock-Date has its own price grid — they cannot be
    meaningfully concatenated). ``quote_ratio.points`` and
    ``fill_strength.points`` ARE concatenated because they are flat
    ``(t, value)`` arrays. ``volume_profile_range`` is computed once across
    all dates via :func:`build_volume_profile_range`.
    """
    validate_bucket_ms(bucket_ms)

    try:
        d_from = datetime.strptime(from_date, "%Y%m%d").date()
        d_to = datetime.strptime(to_date, "%Y%m%d").date()
    except ValueError as e:
        raise HTTPException(400, f"Invalid YYYYMMDD date: {e}") from e
    if d_to < d_from:
        raise HTTPException(400, "from > to")
    if (d_to - d_from).days > MAX_RANGE_DAYS:
        raise HTTPException(400, f"range exceeds {MAX_RANGE_DAYS} days")

    dates = engine.list_stock_dates_in_range(
        code=code, from_date=from_date, to_date=to_date,
    )
    if not dates:
        raise HTTPException(
            404,
            f"no captured Stock-Date for code={code} in [{from_date}, {to_date}]",
        )

    segments: list[RangeSegment] = []
    candles: list[ApiCandle] = []
    ratio_pts: list[QuoteRatioPoint] = []
    fill_pts: list[FillStrengthPoint] = []
    intensity_by_day: list[DepthIntensity] = []
    profiles_by_day: list[VolumeProfile] = []

    for d in dates:
        sub = build_bundle(engine, code=code, date=d, bucket_ms=bucket_ms)
        segments.append(RangeSegment(
            date=d,
            session_open_ms=sub.session_open_ms,
            session_close_ms=sub.session_close_ms,
        ))
        candles.extend(sub.candles)
        ratio_pts.extend(sub.quote_ratio.points)
        fill_pts.extend(sub.fill_strength.points)
        intensity_by_day.append(sub.depth_intensity)
        profiles_by_day.append(sub.volume_profile)

    profile_range = build_volume_profile_range(engine, code=code, dates=dates)

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=segments,
        candles=candles,
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        depth_intensity_by_day=intensity_by_day,
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=fill_pts),
        volume_profile_range=profile_range,
        volume_profile_by_day=profiles_by_day,
    )
