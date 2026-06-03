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
from hoga.api.sources import resolve_source as _resolve_source
from hoga.api.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
)
from hoga.tables import candles as candles_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl
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
    # ADR-0001: the bucketing SQL + snapshots schema knowledge (the per-level
    # ask/bid quantity columns, the last-in-bucket selection, the HHMMSSmmm-
    # linearization rationale) now lives in snapshots_tbl.query_bucketed_ratio.
    # bundle stays the coordinator: it owns the path layout + the no-data guard,
    # and re-bases the native ms-from-midnight bucket into Unix ms (the table
    # query is date-agnostic, so it cannot).
    path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    if not path_obj.exists():
        # ADR-0043: promote_today writes empty records as unlink → missing file
        # is the valid "no data" state, not an error.
        return QuoteRatio(bucket_ms=bucket_ms, points=[])
    rows = snapshots_tbl.query_bucketed_ratio(engine.conn, path=path_obj, bucket_ms=bucket_ms)
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                # r.bucket_intra_ms is bucket-aligned ms-from-midnight, not
                # HHMMSSmmm — so convert via ms_from_midnight_to_unix_ms.
                t=ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms),
                bid_total=r.bid_total,
                ask_total=r.ask_total,
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
    # ADR-0001: this is the cross-table coordinator — it derives the price grid
    # from the candles dimension (candles_tbl.query_price_range owns the
    # low/high column knowledge) and bins the trades within it
    # (trades_tbl.query_volume_profile owns the price/qty binning SQL). bundle
    # keeps only the glue: path layout, the degenerate-profile guards, and the
    # dense VolumeProfileBin expansion (a models concern).
    code_dir = engine.parquet_dir(date, code, source)
    candles_path_obj = code_dir / "candles.parquet"
    trades_path_obj = code_dir / "trades.parquet"
    # ADR-0040/0043: kis_live source has no candles.parquet (Live Candle Backfill
    # owns that dimension via separate cache). Return degenerate profile rather
    # than raising. Likewise for missing trades.parquet (empty promote cycle).
    if not candles_path_obj.exists() or not trades_path_obj.exists():
        return VolumeProfile(bin_count=1, price_min=0, price_max=0, bin_width=0, bins=[])
    if price_min is None or price_max is None:
        price_range = candles_tbl.query_price_range(engine.conn, path=candles_path_obj)
        if price_range is None:
            # Empty candles table — return a degenerate single-bin profile.
            return VolumeProfile(bin_count=1, price_min=0, price_max=0, bin_width=0, bins=[])
        price_min, price_max = price_range
    binning = trades_tbl.query_volume_profile(
        engine.conn, path=trades_path_obj,
        price_lo=price_min, price_hi=price_max, bins=vp_bins,
    )
    bins_arr = [
        VolumeProfileBin(price_low=int(price_min + i * binning.bin_width), qty=0)
        for i in range(vp_bins)
    ]
    for idx, qty in binning.bins:
        if idx < 0:
            continue
        # Clamp the top-edge bin (FLOOR of price_max == vp_bins) into the last
        # valid bin (vp_bins-1). Without this fold, the highest-price volume is
        # silently dropped. GROUP BY guarantees at most one row per idx, so
        # accumulating with += is safe; for non-folded bins += equals =.
        b = min(idx, vp_bins - 1)
        bins_arr[b] = VolumeProfileBin(
            price_low=bins_arr[b].price_low, qty=bins_arr[b].qty + qty,
        )
    return VolumeProfile(
        bin_count=vp_bins, price_min=price_min, price_max=price_max,
        # int() the float bin_width only for the wire value — price_low above is
        # computed from the raw float so fractional widths don't shift the grid.
        bin_width=int(binning.bin_width), bins=bins_arr,
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

    # ADR-0043: kis_live trades.parquet may not exist for sparse Stock-Dates
    # (empty promote cycle → atomic_write_parquet unlinks the file). Filter
    # to existing paths only; if none remain, return empty profile.
    paths: list[str] = []
    for d, src in dates_with_sources:
        p = engine.parquet_dir(d, code, src) / "trades.parquet"
        if p.exists():
            paths.append(str(p))
    if not paths:
        return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])

    # ADR-0001: the MIN/MAX price query, the zero-width-guarded bin_width, and
    # the multi-file binning SQL (price/qty schema knowledge) now live in
    # trades_tbl.query_volume_profile_range. bundle stays the coordinator: it
    # owns the path layout + existence filtering above, maps the no-trades
    # signal (None) to the empty-profile wire shape, and expands the sparse
    # per-bin rows into the dense VolumeProfileBin array (a models concern).
    binning = trades_tbl.query_volume_profile_range(engine.conn, paths=paths, vp_bins=vp_bins)
    if binning is None:
        return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])

    bins_arr = [
        VolumeProfileBin(price_low=int(binning.price_min + i * binning.bin_width), qty=0)
        for i in range(vp_bins)
    ]
    for idx, qty in binning.bins:
        if idx < 0:
            continue
        # Clamp the top-edge bin (FLOOR of price_max == vp_bins) into the last
        # valid bin (vp_bins-1). Without this fold, the highest-price volume is
        # silently dropped. GROUP BY guarantees at most one row per idx, so
        # accumulating with += is safe; for non-folded bins += equals =.
        b = min(idx, vp_bins - 1)
        bins_arr[b] = VolumeProfileBin(
            price_low=bins_arr[b].price_low, qty=bins_arr[b].qty + qty,
        )

    return VolumeProfile(
        bin_count=vp_bins,
        price_min=binning.price_min,
        price_max=binning.price_max,
        # int() the float bin_width only for the wire value — price_low above is
        # computed from the raw float so fractional widths don't shift the grid.
        bin_width=int(binning.bin_width),
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
    # ADR-0001: the bucketing SQL + trades schema knowledge (side/qty columns,
    # the HHMMSSmmm-linearization rationale) now lives in
    # trades_tbl.query_fill_strength. bundle stays the coordinator: it owns the
    # path layout + the no-data guard, and re-bases the native ms-from-midnight
    # bucket into Unix ms (the table query is date-agnostic, so it cannot).
    path_obj = engine.parquet_dir(date, code, source) / "trades.parquet"
    if not path_obj.exists():
        # ADR-0043: missing trades parquet is the valid "no trades yet" state.
        return FillStrength(bucket_ms=bucket_ms, points=[])
    rows = trades_tbl.query_fill_strength(engine.conn, path=path_obj, bucket_ms=bucket_ms)
    return FillStrength(
        bucket_ms=bucket_ms,
        points=[
            FillStrengthPoint(
                # r.bucket_intra_ms is bucket-aligned ms-from-midnight (linear),
                # not HHMMSSmmm — so convert via ms_from_midnight_to_unix_ms.
                t=ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms),
                buy_qty=r.buy_qty,
                sell_qty=r.sell_qty,
            )
            for r in rows
        ],
    )


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
