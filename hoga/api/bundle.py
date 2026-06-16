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

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from fastapi import HTTPException

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.indicator_reaggregate import reaggregate_fill, reaggregate_ratio
from hoga.api.invariants import normalize_session_bounds
from hoga.api.models import (
    AskPeak,
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
from hoga.tables import fills as fills_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl
from hoga.tables.candles import ApiCandle
from hoga.tables.trades import FillStrengthRow

if TYPE_CHECKING:
    from hoga.api.past_indicators_cache import PastIndicatorsCache

_KST = timezone(timedelta(hours=9))

# /api/range minute timeframes are multiples of this; the indicator cache stores
# 1m and re-aggregates up. A request whose bucket_ms is NOT a 1m multiple (the
# 1000 ms /replay default, sub-minute callers) bypasses the cache and queries
# directly — re-aggregation cannot synthesize a finer grain than the cache.
_ONE_MINUTE_MS = 60_000


def _today_kst_yyyymmdd() -> str:
    return datetime.now(_KST).strftime("%Y%m%d")


def _indicator_cacheable(
    cache: PastIndicatorsCache | None, today_kst: str | None, date: str, bucket_ms: int
) -> bool:
    """Serve from the 1m indicator cache only for a COMPLETED past day at a
    minute-multiple bucket. Today is still being promoted (ADR-0043) → recompute
    live; sub-minute buckets have no 1m cache to re-aggregate from."""
    return (
        cache is not None
        and today_kst is not None
        and date < today_kst
        and bucket_ms % _ONE_MINUTE_MS == 0
    )


def _query_fill_rows(engine: QueryEngine, code_dir, bucket_ms: int) -> list[FillStrengthRow] | None:
    """fills.parquet (10s 구간합) preferred, else trades.parquet fallback (그릴링
    Q4). Returns None when NEITHER source exists (ADR-0043 empty cycle) so the
    caller can emit an empty slice without caching a non-result."""
    fills_path = code_dir / "fills.parquet"
    if fills_path.exists():
        return fills_tbl.query_fill_strength(engine.conn, path=fills_path, bucket_ms=bucket_ms)
    trades_path = code_dir / "trades.parquet"
    if not trades_path.exists():
        return None
    return trades_tbl.query_fill_strength(engine.conn, path=trades_path, bucket_ms=bucket_ms)


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
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = None,
    today_kst: str | None = None,
) -> QuoteRatio:
    # ADR-0001: the bucketing SQL + snapshots schema knowledge (the per-level
    # ask/bid quantity columns, the last-in-bucket selection, the closing-auction
    # pre-auction representative, the HHMMSSmmm-linearization rationale) now lives
    # in snapshots_tbl.query_bucketed_ratio. bundle stays the coordinator: it owns
    # the path layout + the no-data guard, passes the session bound through (so the
    # table can exclude the auction book from a straddling bucket — ADR-0029), and
    # re-bases the native ms-from-midnight bucket into Unix ms (the table query is
    # date-agnostic, so it cannot).
    path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    if not path_obj.exists():
        # ADR-0043: promote_today writes empty records as unlink → missing file
        # is the valid "no data" state, not an error.
        return QuoteRatio(bucket_ms=bucket_ms, points=[])
    if _indicator_cacheable(cache, today_kst, date, bucket_ms):
        # Past day + minute bucket: cache the 1-minute representatives once and
        # re-aggregate up (reaggregate_ratio == a direct bucket_ms query, proven
        # in test_indicator_reaggregate). The 1m rows carry the SAME
        # session_close_ms auction boundary, so the (0,0) auction sentinel is
        # preserved across re-aggregation.
        rows_1m = cache.get_ratio(code, date, source)  # type: ignore[union-attr]
        if rows_1m is None:
            rows_1m = snapshots_tbl.query_bucketed_ratio(
                engine.conn, path=path_obj, bucket_ms=_ONE_MINUTE_MS,
                session_close_ms=session_close_ms,
            )
            cache.store_ratio(code, date, source, rows_1m)  # type: ignore[union-attr]
        rows = reaggregate_ratio(rows_1m, bucket_ms)
    else:
        rows = snapshots_tbl.query_bucketed_ratio(
            engine.conn, path=path_obj, bucket_ms=bucket_ms, session_close_ms=session_close_ms
        )
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                # r.bucket_intra_ms is bucket-aligned ms-from-midnight, not
                # HHMMSSmmm — so convert via ms_from_midnight_to_unix_ms.
                t=ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms),
                bid_total=r.bid_total,
                ask_total=r.ask_total,
                bid_max=r.bid_max,
                ask_max=r.ask_max,
                imb_max_bid=r.imb_max_bid,
                imb_max_ask=r.imb_max_ask,
            )
            for r in rows
        ],
    )


def _expand_dense_bins(
    price_min: float, bin_width: float, sparse_bins: list[tuple[int, int]], vp_bins: int
) -> list[VolumeProfileBin]:
    """Expand sparse ``(bin_idx, qty)`` rows into a dense ``VolumeProfileBin``
    array of length ``vp_bins`` (shared by both volume-profile builders).

    ``price_low`` for bin ``i`` is ``floor(price_min + i*bin_width)`` — computed
    from the raw float ``bin_width`` so fractional widths don't shift the grid.
    The top-edge bin (``FLOOR(price_max) == vp_bins``) is folded into the last
    valid bin (``vp_bins-1``): without this clamp the highest-price volume is
    silently dropped. GROUP BY upstream guarantees at most one row per ``idx``,
    so accumulating with ``+=`` is safe (and equals ``=`` for non-folded bins).
    """
    bins_arr = [
        VolumeProfileBin(price_low=int(price_min + i * bin_width), qty=0)
        for i in range(vp_bins)
    ]
    for idx, qty in sparse_bins:
        if idx < 0:
            continue
        b = min(idx, vp_bins - 1)
        bins_arr[b] = VolumeProfileBin(price_low=bins_arr[b].price_low, qty=bins_arr[b].qty + qty)
    return bins_arr


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
    bins_arr = _expand_dense_bins(price_min, binning.bin_width, binning.bins, vp_bins)
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

    bins_arr = _expand_dense_bins(binning.price_min, binning.bin_width, binning.bins, vp_bins)
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
    cache: PastIndicatorsCache | None = None,
    today_kst: str | None = None,
) -> FillStrength:
    # ADR-0001: the bucketing SQL + schema knowledge now lives in the table
    # modules. bundle stays the coordinator: it owns the path layout + the
    # no-data guard, and re-bases the native ms-from-midnight bucket into
    # Unix ms (the table queries are date-agnostic, so they cannot).
    #
    # 그릴링 Q4: kis_live 신형은 fills.parquet(10초 구간합)이 체결강도 소스.
    # fills가 있으면 우선, 없으면(=hogaplay·레거시 kis_live) trades 폴백
    # (_query_fill_rows). fill_strength is a pure SUM GROUP BY, so re-aggregating
    # the cached 1m sums up to bucket_ms is exact (reaggregate_fill).
    code_dir = engine.parquet_dir(date, code, source)
    if _indicator_cacheable(cache, today_kst, date, bucket_ms):
        rows_1m = cache.get_fill(code, date, source)  # type: ignore[union-attr]
        if rows_1m is None:
            rows_1m = _query_fill_rows(engine, code_dir, _ONE_MINUTE_MS)
            if rows_1m is None:
                return FillStrength(bucket_ms=bucket_ms, points=[])
            cache.store_fill(code, date, source, rows_1m)  # type: ignore[union-attr]
        rows = reaggregate_fill(rows_1m, bucket_ms)
    else:
        direct = _query_fill_rows(engine, code_dir, bucket_ms)
        if direct is None:
            # ADR-0043: neither fills nor trades parquet — valid "no trades" state.
            return FillStrength(bucket_ms=bucket_ms, points=[])
        rows = direct
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


def build_ask_peak_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = None,
    today_kst: str | None = None,
) -> "AskPeak | None":
    """해당 거래일(date) 연속거래 매도 최대벽. best-effort: 파일 부재(=무데이터, ADR-0043)나
    미캐탈로그(StockDateNotFound — 경고/제외 세그먼트에서 발생 가능) → None(선 미표시).
    과거일(today_kst != date)은 불변이라 cache로 1회 계산 후 재사용(범위 내 N일 재스캔 회피).

    ``bucket_ms``로 총잔량 지표와 동일한 버킷 대표 위에서 집계(틱 max 아님). 세션 경계
    (``session_open_ms``/``session_close_ms``, native HHMMSSmmm)로 동시호가 배제 —
    캐시 키에 ``bucket_ms``가 포함되므로 분봉 전환 시 재계산된다."""
    cacheable = cache is not None and today_kst is not None and date != today_kst
    if cacheable and cache.has_ask_peak(code, date, source, bucket_ms):  # type: ignore[union-attr]
        return cache.get_ask_peak(code, date, source, bucket_ms)  # type: ignore[union-attr]
    peak = _compute_ask_peak(
        engine, code=code, date=date, source=source, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if cacheable:
        cache.store_ask_peak(code, date, source, bucket_ms, peak)  # type: ignore[union-attr]
    return peak


def _compute_ask_peak(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    bucket_ms: int,
    session_open_ms: int | None,
    session_close_ms: int | None,
) -> "AskPeak | None":
    try:
        path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    except (FileNotFoundError, StockDateNotFound):
        return None
    if not path_obj.exists():
        return None
    trades_path = path_obj.parent / "trades.parquet"
    if trades_path.exists():
        row = snapshots_tbl.query_day_ask_peak_dual(
            engine.conn, path=path_obj, trades_path=trades_path, bucket_ms=bucket_ms,
            session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        )
        if row is None:
            return None
        return AskPeak(
            date=date, price=row.price, qty=row.qty,
            t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
            max_price=row.max_price, max_qty=row.max_qty,
            max_t_ms=ms_from_midnight_to_unix_ms(date, row.max_intra_ms),
            all_price=row.all_price, all_qty=row.all_qty,
            all_t_ms=ms_from_midnight_to_unix_ms(date, row.all_intra_ms),
            all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
            all_max_t_ms=ms_from_midnight_to_unix_ms(date, row.all_max_intra_ms),
        )
    row = snapshots_tbl.query_day_ask_peak(
        engine.conn, path=path_obj, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if row is None:
        return None
    return AskPeak(
        date=date, price=row.price, qty=row.qty,
        t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
        max_price=row.max_price, max_qty=row.max_qty,
        max_t_ms=ms_from_midnight_to_unix_ms(date, row.max_intra_ms),
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
        ask_peaks=[],
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
    # 거래일별 매도 최대벽 — 데이터 있는 각 거래일당 1개(프론트가 그날 구간 수평 세그먼트로 렌더).
    # 루프 안에서 계산해 native HHMMSSmmm 세션 경계(meta)에 접근 → 총잔량 지표와 동일하게
    # bucket_ms 버킷 대표 + 동시호가 배제. 과거일은 indicators_cache로 1회 계산(N일 재스캔 회피).
    ask_peaks: list[AskPeak] = []

    # Indicator cache (호가비·체결강도): completed past days are computed once and
    # re-aggregated on later pans; today_kst gates today out (still promoting).
    indicators_cache = engine.indicators_cache
    today_kst = _today_kst_yyyymmdd()

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
        qr_d = build_quote_ratio_slice(
            engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            session_close_ms=meta["regular_session_close_ms"],
            cache=indicators_cache, today_kst=today_kst,
        )
        fs_d = build_fill_strength_slice(
            engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            cache=indicators_cache, today_kst=today_kst,
        )
        vp_d = build_volume_profile_slice(engine, code=code, date=d, source=source)

        norm_meta, _ = normalize_session_bounds(meta)   # value-conversion only (notes handled by classify)
        ap_d = build_ask_peak_slice(
            engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            session_open_ms=norm_meta["regular_session_open_ms"],
            session_close_ms=meta["regular_session_close_ms"],
            cache=indicators_cache, today_kst=today_kst,
        )
        segments.append(RangeSegment(
            date=d,
            session_open_ms=hhmmssms_to_unix_ms(d, norm_meta["regular_session_open_ms"]),
            session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
            source=source,
        ))
        candles.extend(candles_d)
        ratio_pts.extend(qr_d.points)
        fill_pts.extend(fs_d.points)
        profiles_by_day.append(vp_d)
        if ap_d is not None:
            ask_peaks.append(ap_d)

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
        ask_peaks=ask_peaks,
    )
