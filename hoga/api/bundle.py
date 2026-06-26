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

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.indicator_reaggregate import reaggregate_fill, reaggregate_ratio
from hoga.api.invariants import normalize_session_bounds
from hoga.api.models import (
    AskPeak,
    BidPeak,
    BrokerLateEntryEvent,
    DateWarning,
    DayVolumeDistribution,
    ExcludedDate,
    FillStrength,
    FillStrengthPoint,
    PriceLevelHit,
    ProgramTradePoint,
    ProgramTradeSeries,
    QuoteRatio,
    QuoteRatioPoint,
    RangeBundle,
    RangeSegment,
    TradeVolumePoc,
    VolumeDistributionBin,
    VolumeProfile,
    VolumeProfileBin,
    validate_bucket_ms,
)
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.sources import ordered_sources, resolve_source_result
from hoga.api.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
)
from hoga.tables import brokers as brokers_tbl
from hoga.tables import candles as candles_tbl
from hoga.tables import fills as fills_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl
from hoga.tables.candles import ApiCandle
from hoga.tables.trades import FillStrengthRow
from hoga.live.program_trade_store import ProgramTradeStore

if TYPE_CHECKING:
    from hoga.api.past_indicators_cache import PastIndicatorsCache

_KST = timezone(timedelta(hours=9))
_PriceLevelKind = Literal["vi", "limit"]
_PriceLevelDirection = Literal["upper", "lower"]
_PriceLevelPct = Literal[10, 20, 30]
_VI_COOLING_MS = 120_000
DEFAULT_TRADE_VOLUME_POC_BINS = 10

# /api/range minute timeframes are multiples of this; the indicator cache stores
# 1m and re-aggregates up. A request whose bucket_ms is NOT a 1m multiple (the
# 1000 ms /replay default, sub-minute callers) bypasses the cache and queries
# directly — re-aggregation cannot synthesize a finer grain than the cache.
_ONE_MINUTE_MS = 60_000


def _empty_volume_profile() -> VolumeProfile:
    return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])


def _resolve_source(engine: QueryEngine, date: str, code: str, pref: str) -> str:
    """Backward-compatible source-name helper for older unit tests."""
    return resolve_source_result(engine, date, code, pref).source


def _resolve_trade_indicator_source(
    engine: QueryEngine,
    *,
    date: str,
    code: str,
    source_pref: str,
    selected_source: str,
) -> str:
    """Pick the first policy source with price-level trades for trade indicators."""
    candidates = [selected_source]
    candidates.extend(source for source in ordered_sources(source_pref) if source not in candidates)
    for source in candidates:
        try:
            source_dir = engine.parquet_dir(date, code, source)
        except (FileNotFoundError, StockDateNotFound):
            continue
        if not isinstance(source_dir, Path):
            continue
        if not (source_dir / "trades.parquet").exists():
            continue
        meta_path = source_dir / "meta.json"
        if meta_path.exists():
            try:
                classification = classify_from_meta(json.loads(meta_path.read_text(encoding="utf-8")))
            except (ValueError, OSError):
                continue
            if classification.state == DiskState.INVALID:
                continue
        return source
    return selected_source


def _today_kst_yyyymmdd() -> str:
    return datetime.now(_KST).strftime("%Y%m%d")


def _hhmm_to_hhmmssms(value: int) -> int:
    hh = value // 100
    mm = value % 100
    if hh < 9 or hh > 15 or mm < 0 or mm > 59:
        raise ValueError("broker_late_entry_start_hhmm must be between 900 and 1520")
    if hh == 15 and mm > 20:
        raise ValueError("broker_late_entry_start_hhmm must be between 900 and 1520")
    return hh * 10_000_000 + mm * 100_000


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


def build_broker_late_entries_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    start_hhmm: int,
) -> list[BrokerLateEntryEvent]:
    path = engine.parquet_dir(date, code, source) / "brokers.parquet"
    if not path.exists():
        return []
    threshold_ms = _hhmm_to_hhmmssms(start_hhmm)
    return [
        BrokerLateEntryEvent(
            t_ms=hhmmssms_to_unix_ms(date, row.t_ms),
            broker=row.broker,
            side=row.side,
            net=row.net,
        )
        for row in brokers_tbl.query_late_entry_events(
            engine.conn,
            path=path,
            threshold_ms=threshold_ms,
        )
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


def _expand_distribution_bins(
    price_min: int,
    price_max: int,
    bin_width: float,
    sparse_bins: list[tuple[int, int]],
    range_count: int,
) -> list[VolumeDistributionBin]:
    rows: list[VolumeDistributionBin] = []
    qty_by_idx = [0 for _ in range(range_count)]
    for idx, qty in sparse_bins:
        if idx < 0:
            continue
        qty_by_idx[min(idx, range_count - 1)] += qty
    if price_min == price_max:
        return [
            VolumeDistributionBin(
                price_low=price_min,
                price_high=price_max,
                qty=qty,
            )
            for qty in qty_by_idx
        ]
    for i, qty in enumerate(qty_by_idx):
        low = int(price_min + i * bin_width)
        high = price_max if i == range_count - 1 else int(price_min + (i + 1) * bin_width)
        rows.append(VolumeDistributionBin(price_low=low, price_high=high, qty=qty))
    return rows


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


def build_volume_distribution_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    session_open_ms: int,
    session_close_ms: int,
    range_count: int,
    price_min: int | None = None,
    price_max: int | None = None,
) -> DayVolumeDistribution | None:
    code_dir = engine.parquet_dir(date, code, source)
    candles_path = code_dir / "candles.parquet"
    trades_path = code_dir / "trades.parquet"
    if not trades_path.exists():
        return None
    if price_min is None or price_max is None:
        if not candles_path.exists():
            return None
        price_range = candles_tbl.query_price_range(engine.conn, path=candles_path)
        if price_range is None:
            return None
        price_min, price_max = price_range
    binning = trades_tbl.query_continuous_trade_volume_distribution(
        engine.conn,
        path=trades_path,
        price_lo=price_min,
        price_hi=price_max,
        bins=range_count,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
    )
    return DayVolumeDistribution(
        date=date,
        range_count=range_count,
        price_min=price_min,
        price_max=price_max,
        session_open_ms=hhmmssms_to_unix_ms(date, session_open_ms),
        session_close_ms=hhmmssms_to_unix_ms(date, session_close_ms),
        last_trade_ms=(
            ms_from_midnight_to_unix_ms(date, binning.max_intra_ms)
            if binning.max_intra_ms is not None
            else None
        ),
        bins=_expand_distribution_bins(
            price_min,
            price_max,
            binning.bin_width,
            binning.bins,
            range_count,
        ),
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
        def _unix_or_none(intra_ms: int | None) -> int | None:
            return ms_from_midnight_to_unix_ms(date, intra_ms) if intra_ms is not None else None

        def _candidate(c: snapshots_tbl.AskPeakCandidateRow) -> dict[str, int]:
            return {
                "price": c.price,
                "qty": c.qty,
                "t_ms": ms_from_midnight_to_unix_ms(date, c.intra_ms),
            }

        return AskPeak(
            date=date, price=row.price, qty=row.qty,
            t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
            max_price=row.max_price, max_qty=row.max_qty,
            max_t_ms=ms_from_midnight_to_unix_ms(date, row.max_intra_ms),
            traded_peaks=[_candidate(c) for c in row.traded_peaks],
            traded_max_peaks=[_candidate(c) for c in row.traded_max_peaks],
            all_price=row.all_price, all_qty=row.all_qty,
            all_t_ms=_unix_or_none(row.all_intra_ms),
            all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
            all_max_t_ms=_unix_or_none(row.all_max_intra_ms),
            untraded_price=row.untraded_price, untraded_qty=row.untraded_qty,
            untraded_t_ms=_unix_or_none(row.untraded_intra_ms),
            untraded_max_price=row.untraded_max_price, untraded_max_qty=row.untraded_max_qty,
            untraded_max_t_ms=_unix_or_none(row.untraded_max_intra_ms),
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


def build_bid_peak_slice(
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
) -> "BidPeak | None":
    cacheable = cache is not None and today_kst is not None and date != today_kst
    if cacheable and cache.has_bid_peak(code, date, source, bucket_ms):  # type: ignore[union-attr]
        return cache.get_bid_peak(code, date, source, bucket_ms)  # type: ignore[union-attr]
    peak = _compute_bid_peak(
        engine, code=code, date=date, source=source, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if cacheable:
        cache.store_bid_peak(code, date, source, bucket_ms, peak)  # type: ignore[union-attr]
    return peak


def _compute_bid_peak(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    bucket_ms: int,
    session_open_ms: int | None,
    session_close_ms: int | None,
) -> "BidPeak | None":
    try:
        path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    except (FileNotFoundError, StockDateNotFound):
        return None
    if not path_obj.exists():
        return None
    trades_path = path_obj.parent / "trades.parquet"
    if trades_path.exists():
        row = snapshots_tbl.query_day_bid_peak_dual(
            engine.conn, path=path_obj, trades_path=trades_path, bucket_ms=bucket_ms,
            session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        )
        if row is None:
            return None

        def _unix_or_none(intra_ms: int | None) -> int | None:
            return ms_from_midnight_to_unix_ms(date, intra_ms) if intra_ms is not None else None

        return BidPeak(
            date=date, price=row.price, qty=row.qty,
            t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
            max_price=row.max_price, max_qty=row.max_qty,
            max_t_ms=ms_from_midnight_to_unix_ms(date, row.max_intra_ms),
            all_price=row.all_price, all_qty=row.all_qty,
            all_t_ms=_unix_or_none(row.all_intra_ms),
            all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
            all_max_t_ms=_unix_or_none(row.all_max_intra_ms),
            untraded_price=row.untraded_price, untraded_qty=row.untraded_qty,
            untraded_t_ms=_unix_or_none(row.untraded_intra_ms),
            untraded_max_price=row.untraded_max_price, untraded_max_qty=row.untraded_max_qty,
            untraded_max_t_ms=_unix_or_none(row.untraded_max_intra_ms),
        )
    row = snapshots_tbl.query_day_bid_peak(
        engine.conn, path=path_obj, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if row is None:
        return None
    return BidPeak(
        date=date, price=row.price, qty=row.qty,
        t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
        max_price=row.max_price, max_qty=row.max_qty,
        max_t_ms=ms_from_midnight_to_unix_ms(date, row.max_intra_ms),
    )


def build_trade_volume_poc_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    session_open_ms: int,
    session_close_ms: int,
    range_count: int,
    price_range: tuple[int, int] | None = None,
    band_pct: float = 0.005,
) -> TradeVolumePoc | None:
    code_dir = engine.parquet_dir(date, code, source)
    trades_path = code_dir / "trades.parquet"
    if price_range is None or not trades_path.exists():
        return None
    price_min, price_max = price_range
    row = trades_tbl.query_trade_volume_poc(
        engine.conn,
        path=trades_path,
        price_lo=price_min,
        price_hi=price_max,
        bins=range_count,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
    )
    if row is None:
        return None
    return TradeVolumePoc(
        date=date,
        center_price=row.center_price,
        low_price=row.low_price,
        high_price=row.high_price,
        qty=row.qty,
        t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
        band_pct=band_pct,
    )


def _krx_stock_tick_size(price: int) -> int:
    if price < 2_000:
        return 1
    if price < 5_000:
        return 5
    if price < 20_000:
        return 10
    if price < 50_000:
        return 50
    if price < 200_000:
        return 100
    if price < 500_000:
        return 500
    return 1_000


def _ceil_krx_stock_tick(price: float) -> int:
    candidate = int(price)
    candidate = (
        (candidate + _krx_stock_tick_size(candidate) - 1)
        // _krx_stock_tick_size(candidate)
    ) * _krx_stock_tick_size(candidate)
    while candidate < price:
        candidate += _krx_stock_tick_size(candidate)
    return candidate


def _floor_krx_stock_tick(price: float) -> int:
    candidate = int(price)
    candidate = (candidate // _krx_stock_tick_size(candidate)) * _krx_stock_tick_size(candidate)
    while candidate > price:
        candidate -= _krx_stock_tick_size(candidate)
    return candidate


def _ceil_krx_stock_tick_ratio(price: int, numerator: int, denominator: int) -> int:
    won = (price * numerator + denominator - 1) // denominator
    return _ceil_krx_stock_tick(won)


def _floor_krx_stock_tick_ratio(price: int, numerator: int, denominator: int) -> int:
    won = (price * numerator) // denominator
    return _floor_krx_stock_tick(won)


def _limit_price_levels(
    *,
    limit_base_prev_close: int | None,
) -> list[tuple[int, _PriceLevelKind, _PriceLevelDirection, _PriceLevelPct]]:
    candidates: list[tuple[int, _PriceLevelKind, _PriceLevelDirection, _PriceLevelPct]] = []
    if limit_base_prev_close is not None and limit_base_prev_close > 0:
        candidates.append((_floor_krx_stock_tick_ratio(limit_base_prev_close, 13, 10), "limit", "upper", 30))
        candidates.append((_ceil_krx_stock_tick_ratio(limit_base_prev_close, 7, 10), "limit", "lower", 30))
    return candidates


def _first_price_level_touch(
    candles: list[ApiCandle],
    *,
    price: int,
    direction: _PriceLevelDirection,
    min_ts_ms: int | None = None,
) -> ApiCandle | None:
    for c in candles:
        if min_ts_ms is not None and c.ts_ms < min_ts_ms:
            continue
        if direction == "upper" and c.high >= price:
            return c
        if direction == "lower" and c.low <= price:
            return c
    return None


def _append_hit(
    hits: list[PriceLevelHit],
    *,
    date: str,
    candle: ApiCandle,
    price: int,
    kind: _PriceLevelKind,
    direction: _PriceLevelDirection,
    pct: _PriceLevelPct,
) -> None:
    hits.append(PriceLevelHit(
        date=date,
        t_ms=candle.ts_ms,
        price=price,
        kind=kind,
        direction=direction,
        pct=pct,
    ))


def _append_vi_hits(
    hits: list[PriceLevelHit],
    *,
    date: str,
    candles: list[ApiCandle],
    vi_base_open: int | None,
    direction: _PriceLevelDirection,
) -> None:
    if vi_base_open is None or vi_base_open <= 0:
        return

    if direction == "upper":
        first_price = _ceil_krx_stock_tick_ratio(vi_base_open, 11, 10)
    else:
        first_price = _floor_krx_stock_tick_ratio(vi_base_open, 9, 10)

    first = _first_price_level_touch(candles, price=first_price, direction=direction)
    if first is None:
        return
    _append_hit(
        hits,
        date=date,
        candle=first,
        price=first_price,
        kind="vi",
        direction=direction,
        pct=10,
    )

    reopen = next((c for c in candles if c.ts_ms >= first.ts_ms + _VI_COOLING_MS), None)
    if reopen is None:
        return
    second_price = (
        _ceil_krx_stock_tick_ratio(reopen.open, 11, 10)
        if direction == "upper"
        else _floor_krx_stock_tick_ratio(reopen.open, 9, 10)
    )
    second = _first_price_level_touch(
        candles,
        price=second_price,
        direction=direction,
        min_ts_ms=reopen.ts_ms,
    )
    if second is None:
        return
    _append_hit(
        hits,
        date=date,
        candle=second,
        price=second_price,
        kind="vi",
        direction=direction,
        pct=20,
    )


def build_price_level_hits_slice(
    *,
    date: str,
    candles: list[ApiCandle],
    vi_base_open: int | None,
    limit_base_prev_close: int | None,
) -> list[PriceLevelHit]:
    if not candles:
        return []

    candles = sorted(candles, key=lambda c: c.ts_ms)
    hits: list[PriceLevelHit] = []
    _append_vi_hits(hits, date=date, candles=candles, vi_base_open=vi_base_open, direction="upper")
    _append_vi_hits(hits, date=date, candles=candles, vi_base_open=vi_base_open, direction="lower")

    for price, kind, direction, pct in _limit_price_levels(limit_base_prev_close=limit_base_prev_close):
        if price <= 0:
            continue
        first = _first_price_level_touch(candles, price=price, direction=direction)
        if first is None:
            continue
        _append_hit(
            hits,
            date=date,
            candle=first,
            price=price,
            kind=kind,
            direction=direction,
            pct=pct,
        )
    return hits


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
        volume_profile_range=_empty_volume_profile(),
        volume_profile_by_day=[],
        excluded_dates=excluded,
        data_warnings=[],
        ask_peaks=[],
        bid_peaks=[],
        broker_late_entries=[],
        price_level_hits=[],
        volume_distributions=[],
        program_trade=ProgramTradeSeries(points=[]),
    )


def build_program_trade_series(engine: QueryEngine, *, code: str, dates: list[str]) -> ProgramTradeSeries:
    data_dir = getattr(engine, "data_dir", None)
    if not isinstance(data_dir, Path):
        return ProgramTradeSeries(points=[])
    store = ProgramTradeStore(data_dir)
    points: list[ProgramTradePoint] = []
    for date in dates:
        day = store.load(code, date)
        gap_times = {str(ev.get("new_oldest")) for ev in day.gap_events}
        for row in day.rows:
            points.append(
                ProgramTradePoint(
                    t=row.t_ms,
                    net_qty=row.net_qty,
                    net_amount=row.net_amount,
                    delta_qty=row.delta_qty,
                    delta_amount=row.delta_amount,
                    gap_risk=row.bsop_hour in gap_times,
                )
            )
    points.sort(key=lambda p: p.t)
    return ProgramTradeSeries(points=points)


def build_range_bundle(
    engine: QueryEngine,
    *,
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
    source_pref: str = "hogaplay",  # ADR-0039
    broker_late_entries_enabled: bool = True,
    broker_late_entry_start_hhmm: int = 930,
    volume_distribution_bins: int | None = None,
    trade_volume_poc_bins: int | None = None,
    volume_distribution_price_min: int | None = None,
    volume_distribution_price_max: int | None = None,
    mode: str = "full",
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
    volume_distributions: list[DayVolumeDistribution] = []
    # 거래일별 매도 최대벽 — 데이터 있는 각 거래일당 1개(프론트가 그날 구간 수평 세그먼트로 렌더).
    # 루프 안에서 계산해 native HHMMSSmmm 세션 경계(meta)에 접근 → 총잔량 지표와 동일하게
    # bucket_ms 버킷 대표 + 동시호가 배제. 과거일은 indicators_cache로 1회 계산(N일 재스캔 회피).
    ask_peaks: list[AskPeak] = []
    bid_peaks: list[BidPeak] = []
    broker_late_entries: list[BrokerLateEntryEvent] = []
    price_level_hits: list[PriceLevelHit] = []
    trade_volume_pocs: list[TradeVolumePoc] = []
    included_dates: list[str] = []

    # Indicator cache (호가비·체결강도): completed past days are computed once and
    # re-aggregated on later pans; today_kst gates today out (still promoting).
    indicators_cache = engine.indicators_cache
    today_kst = _today_kst_yyyymmdd()
    stock_dates_for_code = sorted(
        (row for row in engine.list_stock_dates() if row.code == code),
        key=lambda row: row.date,
    )
    prev_close_by_date: dict[str, int] = {}
    prev_close: int | None = None
    for row in stock_dates_for_code:
        prev_close_by_date[row.date] = (
            prev_close if prev_close is not None and prev_close > 0 else 0
        )
        prev_close = row.today_close

    hoga_only = mode == "hoga"

    for d in dates:
        resolution = resolve_source_result(engine, d, code, source_pref)
        source = resolution.source
        if resolution.path is not None:
            try:
                meta = json.loads((resolution.path / "meta.json").read_text(encoding="utf-8"))
            except (FileNotFoundError, ValueError, OSError):
                continue
        else:
            try:
                meta = engine.get_meta(d, code, source)
            except (FileNotFoundError, StockDateNotFound):
                continue
        c = resolution.classification or classify_from_meta(meta)

        if c.state == DiskState.INVALID:
            excluded.append(ExcludedDate(
                date=d, violations=[v.to_model() for v in c.errors],
            ))
            continue

        if c.warnings:
            warnings_list.append(DateWarning(
                date=d, warnings=[v.to_model() for v in c.warnings],
            ))

        raw_candles = [] if hoga_only else build_candles_slice(engine, code=code, date=d, source=source)
        if hoga_only:
            price_range = None
            trade_indicator_source = source
            candles_d = []
        else:
            raw_lows = [c.low for c in raw_candles]
            raw_highs = [c.high for c in raw_candles]
            candle_price_range = (
                (min(raw_lows), max(raw_highs))
                if raw_lows and raw_highs
                else None
            )
            supplied_trade_price_range = (
                (volume_distribution_price_min, volume_distribution_price_max)
                if volume_distribution_price_min is not None and volume_distribution_price_max is not None
                else None
            )
            price_range = candle_price_range or supplied_trade_price_range
            trade_indicator_source = _resolve_trade_indicator_source(
                engine,
                date=d,
                code=code,
                source_pref=source_pref,
                selected_source=source,
            )
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
        vp_d = None if hoga_only else build_volume_profile_slice(engine, code=code, date=d, source=source)

        norm_meta, _ = normalize_session_bounds(meta)   # value-conversion only (notes handled by classify)
        ap_d = None if hoga_only else build_ask_peak_slice(
            engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            session_open_ms=norm_meta["regular_session_open_ms"],
            session_close_ms=meta["regular_session_close_ms"],
            cache=indicators_cache, today_kst=today_kst,
        )
        bp_d = None if hoga_only else build_bid_peak_slice(
            engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            session_open_ms=norm_meta["regular_session_open_ms"],
            session_close_ms=meta["regular_session_close_ms"],
            cache=indicators_cache, today_kst=today_kst,
        )
        tvp_d = None if hoga_only else build_trade_volume_poc_slice(
            engine, code=code, date=d, source=trade_indicator_source,
            session_open_ms=norm_meta["regular_session_open_ms"],
            session_close_ms=meta["regular_session_close_ms"],
            range_count=trade_volume_poc_bins or DEFAULT_TRADE_VOLUME_POC_BINS,
            price_range=price_range,
        )
        segments.append(RangeSegment(
            date=d,
            session_open_ms=hhmmssms_to_unix_ms(d, norm_meta["regular_session_open_ms"]),
            session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
            source=source,
        ))
        included_dates.append(d)
        if not hoga_only and broker_late_entries_enabled:
            broker_late_entries.extend(
                build_broker_late_entries_slice(
                    engine,
                    code=code,
                    date=d,
                    source=source,
                    start_hhmm=broker_late_entry_start_hhmm,
                )
            )
        candles.extend(candles_d)
        ratio_pts.extend(qr_d.points)
        fill_pts.extend(fs_d.points)
        if vp_d is not None:
            profiles_by_day.append(vp_d)
        if not hoga_only and volume_distribution_bins is not None:
            profile = build_volume_distribution_slice(
                engine,
                code=code,
                date=d,
                source=trade_indicator_source,
                session_open_ms=int(norm_meta["regular_session_open_ms"]),
                session_close_ms=int(meta["regular_session_close_ms"]),
                range_count=volume_distribution_bins,
                price_min=price_range[0] if price_range is not None else None,
                price_max=price_range[1] if price_range is not None else None,
            )
            if profile is not None:
                volume_distributions.append(profile)
        if ap_d is not None:
            ask_peaks.append(ap_d)
        if bp_d is not None:
            bid_peaks.append(bp_d)
        if tvp_d is not None:
            trade_volume_pocs.append(tvp_d)
        if not hoga_only:
            vi_base_open = raw_candles[0].open if raw_candles else int(meta.get("today_open") or 0)
            price_level_hits.extend(
                build_price_level_hits_slice(
                    date=d,
                    candles=candles_d,
                    vi_base_open=vi_base_open,
                    limit_base_prev_close=prev_close_by_date.get(d) or None,
                ),
            )

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
    profile_range = (
        _empty_volume_profile()
        if hoga_only
        else build_volume_profile_range(engine, code=code, dates_with_sources=dates_with_sources)
    )

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
        bid_peaks=bid_peaks,
        broker_late_entries=broker_late_entries,
        price_level_hits=price_level_hits,
        trade_volume_pocs=trade_volume_pocs,
        volume_distributions=volume_distributions,
        program_trade=ProgramTradeSeries(points=[]) if hoga_only else build_program_trade_series(engine, code=code, dates=included_dates),
    )
