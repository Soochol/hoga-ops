"""DuckDB-driven range bundle slices, one builder per slice.

Each ``build_*_slice`` takes a :class:`QueryEngine` (per ADR-0001 the
cross-table coordinator) and resolves its own Parquet path via
``engine.parquet_dir``. The engine also owns the DuckDB connection.

Why the engine instead of ``(conn, data_dir)``:
  * single source of truth for path layout (``parquet_dir`` raises
    ``StockDateNotFound`` consistently);
  * builders compose into ``build_range_bundle`` without threading three
    arguments through every call site;
  * ``meta.json`` access goes through ``engine.get_meta`` instead of
    re-reading the file by hand.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.models import (
    DateWarning,
    ExcludedDate,
    FillStrength,
    FillStrengthPoint,
    QuoteRatio,
    QuoteRatioPoint,
    RangeBundle,
    RangeSegment,
    VolumeProfile,
    VolumeProfileBin,
    validate_bucket_ms,
)
from hoga.api.queries import QueryEngine, StockDateNotFound
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
    engine: QueryEngine, *, code: str, date: str, source: str = "hogaplay"
) -> list[ApiCandle]:
    # ADR-0040 / ADR-0043: kis_live promotion never writes candles.parquet —
    # the candle dimension is served separately by Live Candle Backfill.
    # Return empty list rather than raising so /api/range can still serve
    # hoga indicators + segments for kis_live-source Stock-Dates.
    path = engine.parquet_dir(date, code, source) / "candles.parquet"
    if not path.exists():
        return []
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
    source: str = "hogaplay",
) -> QuoteRatio:
    # Bucket on LINEAR ms-from-midnight, not raw HHMMSSmmm. The raw encoding
    # has gaps at minute / hour boundaries, so arithmetic bucketing of HHMMSSmmm
    # produces invalid HHMMSSmmm values that decode (via hhmmssms_to_unix_ms)
    # to duplicate or out-of-order Unix-ms outputs — which lightweight-charts
    # then rejects with "asc ordered by time". See hhmmssms_to_intra_ms_sql.
    path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    if not path_obj.exists():
        # ADR-0043: promote_today writes empty records as unlink → missing file
        # is the valid "no data" state, not an error.
        return QuoteRatio(bucket_ms=bucket_ms, points=[])
    path = str(path_obj)
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


def build_volume_profile_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str = "hogaplay",
    price_min: int | None = None,
    price_max: int | None = None,
    vp_bins: int = 24,
) -> VolumeProfile:
    code_dir = engine.parquet_dir(date, code, source)
    candles_path = str(code_dir / "candles.parquet")
    trades_path = str(code_dir / "trades.parquet")
    if price_min is None or price_max is None:
        row = engine.conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        if row is None or row[0] is None or row[1] is None:
            # Empty candles table — return a degenerate single-bin profile.
            return VolumeProfile(bin_count=1, price_min=0, price_max=0, bin_width=0, bins=[])
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
    dates_with_sources: list[tuple[str, str]],
    vp_bins: int = 24,
) -> VolumeProfile:
    """Union trades.parquet across all in-range Stock-Dates into one price-binned
    profile (range-wide POC view, ADR-0013).

    Bin-count policy mirrors build_volume_profile_slice (vp_bins=24 by default)
    applied to the unioned price range. Uses DuckDB's multi-file read_parquet
    via a list parameter — no f-string SQL for the path (matches bundle.py:145
    convention; see plan-eng-review D3).
    """
    if not dates_with_sources:
        return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])

    paths = [
        str(engine.parquet_dir(d, code, src) / "trades.parquet")
        for d, src in dates_with_sources
    ]

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
    source: str = "hogaplay",
) -> FillStrength:
    # Bucket on LINEAR ms-from-midnight, not HHMMSSmmm. With the previous
    # `(ts_ms / 60000)::BIGINT * 60000` pattern, a raw 11:00:59.000
    # (HHMMSSmmm=110_059_000) bucketed to integer 1834, multiplied back to
    # 110_040_000 = HHMMSSmmm "11:00:40.000" — an out-of-order ghost time
    # that fold-decoded via hhmmssms_to_unix_ms to 11:40:20 KST (39-min
    # backward jump). See hhmmssms_to_intra_ms_sql for the encoding details.
    path_obj = engine.parquet_dir(date, code, source) / "trades.parquet"
    if not path_obj.exists():
        # ADR-0043: missing trades parquet is the valid "no trades yet" state.
        return FillStrength(bucket_ms=bucket_ms, points=[])
    path = str(path_obj)
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


def _resolve_source(engine: QueryEngine, date: str, code: str, pref: str) -> str:
    """Return the source name actually present on disk for this (date, code).

    Prefers ``pref`` if its meta.json exists; otherwise picks the first other
    source that does. Returns ``pref`` even if nothing exists so the downstream
    StockDateNotFound surfaces naturally.
    """
    from hoga.api.disk_state import classify_stock_date
    from pathlib import Path
    sd_dir = engine.data_dir / "parquet" / date / code
    # Guard: only do real filesystem work when sd_dir is a real Path that exists.
    # MagicMock engines (used in unit tests) have a MagicMock data_dir, so
    # sd_dir won't be a real Path — fall back to pref immediately in that case.
    if not isinstance(sd_dir, Path):
        return pref
    per_source = classify_stock_date(sd_dir)
    if pref in per_source:
        return pref
    if per_source:
        return next(iter(per_source))
    return pref


def _empty_range_bundle(
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
    *,
    excluded: list[ExcludedDate],
) -> RangeBundle:
    """Empty RangeBundle for the no-captured-data and all-INVALID branches
    (spec 2026-05-27 §4.3). Mirrors the success-path shape with empty series
    arrays; excluded_dates carries any invariant-gated dates so frontend can
    surface DataWarning UX."""
    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=[],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=[]),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=[]),
        volume_profile_range=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]),
        volume_profile_by_day=[],
        excluded_dates=excluded,
        data_warnings=[],
    )


def build_range_bundle(
    engine: QueryEngine,
    *,
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
    source_pref: str = "hogaplay",  # ADR-0039
) -> RangeBundle:
    """Build the Wire Model for a Stock-Date Range (ADR-0013, ADR-0014).

    Validates ``bucket_ms`` and ``from_date <= to_date``.
    Returns an empty RangeBundle when no Stock-Date in range has captured data
    or all in-range dates are excluded by invariants (spec 2026-05-27 §4.3).

    Loops over captured Stock-Dates calling each per-slice builder directly.
    ``volume_profile`` is returned as a per-segment list (each Stock-Date
    has its own price grid — they cannot be meaningfully concatenated).
    ``quote_ratio.points`` and ``fill_strength.points`` ARE concatenated
    because they are flat ``(t, value)`` arrays. ``volume_profile_range``
    is computed once across all dates via :func:`build_volume_profile_range`.
    """
    validate_bucket_ms(bucket_ms)

    try:
        d_from = datetime.strptime(from_date, "%Y%m%d").date()
        d_to = datetime.strptime(to_date, "%Y%m%d").date()
    except ValueError as e:
        raise HTTPException(400, f"Invalid YYYYMMDD date: {e}") from e
    if d_to < d_from:
        raise HTTPException(400, "from > to")

    dates = engine.list_stock_dates_in_range(
        code=code, from_date=from_date, to_date=to_date,
        source_pref=source_pref,
    )
    if not dates:
        # Spec 2026-05-27 §4.3: empty range is a normal case for /live's
        # lazy-fetch. Surface as an empty bundle so the frontend can stitch
        # today's SSE buffer in without 404 round-trips.
        return _empty_range_bundle(code, from_date, to_date, bucket_ms, excluded=[])

    # ADR-0020: per-Stock-Date invariant check.
    # INVALID → skip + surface under excluded_dates.
    # warn-only → include + surface under data_warnings.
    excluded: list[ExcludedDate] = []
    warnings_list: list[DateWarning] = []
    segments: list[RangeSegment] = []
    candles: list[ApiCandle] = []
    ratio_pts: list[QuoteRatioPoint] = []
    fill_pts: list[FillStrengthPoint] = []
    profiles_by_day: list[VolumeProfile] = []

    for d in dates:
        source = _resolve_source(engine, d, code, source_pref)
        try:
            meta = engine.get_meta(d, code, source)
        except (FileNotFoundError, StockDateNotFound):
            continue
        c = classify_from_meta(meta)   # state + violations in one pass

        if c.state == DiskState.INVALID:
            excluded.append(ExcludedDate(
                date=d, violations=[v.to_model() for v in c.errors],
            ))
            continue

        if c.warnings:
            warnings_list.append(DateWarning(
                date=d, warnings=[v.to_model() for v in c.warnings],
            ))

        raw_candles = build_candles_slice(engine, code=code, date=d, source=source)
        candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms)
        qr_d = build_quote_ratio_slice(engine, code=code, date=d, bucket_ms=bucket_ms, source=source)
        fs_d = build_fill_strength_slice(engine, code=code, date=d, bucket_ms=bucket_ms, source=source)
        vp_d = build_volume_profile_slice(engine, code=code, date=d, source=source)

        segments.append(RangeSegment(
            date=d,
            session_open_ms=hhmmssms_to_unix_ms(d, meta["regular_session_open_ms"]),
            session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
            source=source,
        ))
        candles.extend(candles_d)
        ratio_pts.extend(qr_d.points)
        fill_pts.extend(fs_d.points)
        profiles_by_day.append(vp_d)

    if not segments:
        # Spec 2026-05-27 §4.3: every in-range date is INVALID → return an
        # empty bundle with excluded_dates populated, so frontend can render
        # DataWarning UX without 404 round-trips.
        return _empty_range_bundle(code, from_date, to_date, bucket_ms, excluded=excluded)

    # The range-wide volume profile must aggregate only the dates we actually
    # included — using the unfiltered `dates` would pull trades.parquet for
    # INVALID Stock-Dates whose data is corrupt or incomplete, contaminating
    # the range-wide histogram or raising a DuckDB read error.
    dates_with_sources = [(s.date, s.source) for s in segments]
    profile_range = build_volume_profile_range(engine, code=code, dates_with_sources=dates_with_sources)

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=segments,
        candles=candles,
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=fill_pts),
        volume_profile_range=profile_range,
        volume_profile_by_day=profiles_by_day,
        excluded_dates=excluded,
        data_warnings=warnings_list,
    )
