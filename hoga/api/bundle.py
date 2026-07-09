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
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import HTTPException

from hoga import perf_debug
from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.indicator_reaggregate import reaggregate_fill, reaggregate_ratio
from hoga.api.invariants import normalize_session_bounds
from hoga.api.models import (
    AskPeak,
    BidPeak,
    BrokerLateEntryEvent,
    DateWarning,
    DayVolumeDistribution,
    DepthHeatmapPoint,
    ExcludedDate,
    FillStrength,
    FillStrengthPoint,
    ProgramTradePoint,
    ProgramTradeSeries,
    QuoteRatio,
    QuoteRatioPoint,
    RangeBundle,
    RangeSegment,
    TradeVolumePoc,
    VolumeDistributionBin,
    VolumeProfile,
    validate_bucket_ms,
)
from hoga.api.past_indicators_cache import CACHE_MISS
from hoga.api.peak_slice_guard import GUARD as PEAK_SLICE_GUARD
from hoga.api.today_ttl_cache import TODAY_TTL
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.sources import ordered_sources, resolve_source_result
from hoga.api.timeenc import (
    hhmmssms_to_intra_ms_sql,
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)
from hoga.live.program_trade_store import ProgramTradeStore
from hoga.tables import brokers as brokers_tbl
from hoga.tables import candles as candles_tbl
from hoga.tables import fills as fills_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl
from hoga.tables.candles import ApiCandle
from hoga.tables.trades import FillStrengthRow

if TYPE_CHECKING:
    from hoga.api.past_indicators_cache import PastIndicatorsCache

log = logging.getLogger(__name__)

_KST = timezone(timedelta(hours=9))
DEFAULT_TRADE_VOLUME_POC_BINS = 10

# /api/range minute timeframes are multiples of this; the indicator cache stores
# 1m and re-aggregates up. A request whose bucket_ms is NOT a 1m multiple (the
# 1000 ms /replay default, sub-minute callers) bypasses the cache and queries
# directly — re-aggregation cannot synthesize a finer grain than the cache.
_ONE_MINUTE_MS = 60_000

# WS3: 지표 빌더의 cache/today_kst 기본값 센티널. 미지정 호출은 빌더가
# engine.indicators_cache / 현재 KST 날짜로 자가-해석해 ADR-0043/0090 게이트를
# 내부에서 적용한다. None 명시는 "캐시 미적용"(테스트 주입 시맨틱)으로 유지.
_RESOLVE: object = object()


def _resolve_cache(engine: QueryEngine, cache: object) -> PastIndicatorsCache | None:
    if cache is _RESOLVE:
        return engine.indicators_cache
    return cache  # type: ignore[return-value]


def _resolve_today_kst(today_kst: object) -> str | None:
    if today_kst is _RESOLVE:
        return _today_kst_yyyymmdd()
    return today_kst  # type: ignore[return-value]


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
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> QuoteRatio:
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
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
        is_today = today_kst is not None and date == today_kst
        ttl_key = ("ratio", code, date, source, bucket_ms, session_close_ms)
        hit, cached = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
        if hit:
            rows = cached
        else:
            rows = snapshots_tbl.query_bucketed_ratio(
                engine.conn, path=path_obj, bucket_ms=bucket_ms, session_close_ms=session_close_ms
            )
            if is_today:
                TODAY_TTL.put(ttl_key, rows)
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
    cutoff_ms: int | None = None,
    continuous_before_ms: int | None = None,
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
    upper_bound_ms = None
    if cutoff_ms is not None:
        cutoff_hhmmssms = unix_ms_to_hhmmssms(date, cutoff_ms)
        upper_bound_ms = trades_tbl._session_bound_to_intra_ms(cutoff_hhmmssms) + 1
    dist_kwargs = {}
    if upper_bound_ms is not None:
        dist_kwargs["upper_bound_ms"] = upper_bound_ms
    binning = trades_tbl.query_continuous_trade_volume_distribution(
        engine.conn,
        path=trades_path,
        price_lo=price_min,
        price_hi=price_max,
        bins=range_count,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
        **dist_kwargs,
        continuous_before_ms=continuous_before_ms,
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


def build_fill_strength_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 60_000,
    source: str = "hogaplay",
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> FillStrength:
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
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
        is_today = today_kst is not None and date == today_kst
        ttl_key = ("fill", code, date, source, bucket_ms)
        hit, cached = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
        if hit:
            rows = cached
        else:
            direct = _query_fill_rows(engine, code_dir, bucket_ms)
            if direct is None:
                # ADR-0043: neither fills nor trades parquet — valid "no trades" state.
                return FillStrength(bucket_ms=bucket_ms, points=[])
            rows = direct
            if is_today:
                # ADR-0090: _query_fill_rows가 fills.parquet 우선·trades 폴백이라, trades
                # 유래 결과를 캐시한 뒤 fills.parquet이 같은 15s 창 안에 늦게 도착하면 이후
                # 새로 선호되는 fills 유래 값 대신 캐시된 trades 유래 값을 서빙한다. trades
                # 유래 체결강도도 유효 데이터(틀린 게 아니라 선호 소스만 다름)이고, TTL이
                # 이미 수용한 15s staleness 예산 안이라 허용한다.
                TODAY_TTL.put(ttl_key, rows)
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


def _unix_or_none(date: str, intra_ms: int | None) -> int | None:
    return ms_from_midnight_to_unix_ms(date, intra_ms) if intra_ms is not None else None


def _ask_candidate(date: str, c: snapshots_tbl.AskPeakCandidateRow) -> dict[str, int]:
    return {
        "price": c.price,
        "qty": c.qty,
        "t_ms": ms_from_midnight_to_unix_ms(date, c.intra_ms),
    }


def _ask_peak_from_dual_row(date: str, row: snapshots_tbl.AskPeakDualRow) -> AskPeak:
    untraded_peaks = [_ask_candidate(date, c) for c in row.untraded_peaks]
    untraded_max_peaks = [_ask_candidate(date, c) for c in row.untraded_max_peaks]
    return AskPeak(
        date=date, price=row.price, qty=row.qty,
        t_ms=_unix_or_none(date, row.intra_ms),
        max_price=row.max_price, max_qty=row.max_qty,
        max_t_ms=_unix_or_none(date, row.max_intra_ms),
        traded_peaks=[_ask_candidate(date, c) for c in row.traded_peaks],
        traded_max_peaks=[_ask_candidate(date, c) for c in row.traded_max_peaks],
        all_peaks=[_ask_candidate(date, c) for c in row.all_peaks],
        all_max_peaks=[_ask_candidate(date, c) for c in row.all_max_peaks],
        all_price=row.all_price, all_qty=row.all_qty,
        all_t_ms=_unix_or_none(date, row.all_intra_ms),
        all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
        all_max_t_ms=_unix_or_none(date, row.all_max_intra_ms),
        untraded_price=untraded_peaks[0]["price"] if untraded_peaks else row.untraded_price,
        untraded_qty=untraded_peaks[0]["qty"] if untraded_peaks else row.untraded_qty,
        untraded_t_ms=untraded_peaks[0]["t_ms"] if untraded_peaks else _unix_or_none(date, row.untraded_intra_ms),
        untraded_max_price=(
            untraded_max_peaks[0]["price"] if untraded_max_peaks else row.untraded_max_price
        ),
        untraded_max_qty=(
            untraded_max_peaks[0]["qty"] if untraded_max_peaks else row.untraded_max_qty
        ),
        untraded_max_t_ms=(
            untraded_max_peaks[0]["t_ms"]
            if untraded_max_peaks
            else _unix_or_none(date, row.untraded_max_intra_ms)
        ),
        untraded_peaks=untraded_peaks,
        untraded_max_peaks=untraded_max_peaks,
    )


def _bid_peak_from_dual_row(date: str, row: snapshots_tbl.BidPeakDualRow) -> BidPeak:
    untraded_peaks = [_ask_candidate(date, c) for c in row.untraded_peaks]
    untraded_max_peaks = [_ask_candidate(date, c) for c in row.untraded_max_peaks]
    return BidPeak(
        date=date, price=row.price, qty=row.qty,
        t_ms=_unix_or_none(date, row.intra_ms),
        max_price=row.max_price, max_qty=row.max_qty,
        max_t_ms=_unix_or_none(date, row.max_intra_ms),
        traded_peaks=[_ask_candidate(date, c) for c in row.traded_peaks],
        traded_max_peaks=[_ask_candidate(date, c) for c in row.traded_max_peaks],
        all_peaks=[_ask_candidate(date, c) for c in row.all_peaks],
        all_max_peaks=[_ask_candidate(date, c) for c in row.all_max_peaks],
        all_price=row.all_price, all_qty=row.all_qty,
        all_t_ms=_unix_or_none(date, row.all_intra_ms),
        all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
        all_max_t_ms=_unix_or_none(date, row.all_max_intra_ms),
        untraded_price=untraded_peaks[0]["price"] if untraded_peaks else row.untraded_price,
        untraded_qty=untraded_peaks[0]["qty"] if untraded_peaks else row.untraded_qty,
        untraded_t_ms=untraded_peaks[0]["t_ms"] if untraded_peaks else _unix_or_none(date, row.untraded_intra_ms),
        untraded_max_price=(
            untraded_max_peaks[0]["price"] if untraded_max_peaks else row.untraded_max_price
        ),
        untraded_max_qty=(
            untraded_max_peaks[0]["qty"] if untraded_max_peaks else row.untraded_max_qty
        ),
        untraded_max_t_ms=(
            untraded_max_peaks[0]["t_ms"]
            if untraded_max_peaks
            else _unix_or_none(date, row.untraded_max_intra_ms)
        ),
        untraded_peaks=untraded_peaks,
        untraded_max_peaks=untraded_max_peaks,
    )


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
        return _ask_peak_from_dual_row(date, row)
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
        return _bid_peak_from_dual_row(date, row)
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


def build_ask_bid_peak_slices(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> tuple[AskPeak | None, BidPeak | None]:
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    ask_cached = (
        cache is not None
        and today_kst is not None
        and date != today_kst
        and cache.has_ask_peak(code, date, source, bucket_ms)
    )
    bid_cached = (
        cache is not None
        and today_kst is not None
        and date != today_kst
        and cache.has_bid_peak(code, date, source, bucket_ms)
    )
    ask = cache.get_ask_peak(code, date, source, bucket_ms) if ask_cached and cache is not None else None
    bid = cache.get_bid_peak(code, date, source, bucket_ms) if bid_cached and cache is not None else None
    if ask_cached and bid_cached:
        return ask, bid

    try:
        path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    except (FileNotFoundError, StockDateNotFound):
        return ask, bid
    if not path_obj.exists():
        return ask, bid
    trades_path = path_obj.parent / "trades.parquet"
    if not trades_path.exists():
        if not ask_cached:
            ask = build_ask_peak_slice(
                engine,
                code=code,
                date=date,
                bucket_ms=bucket_ms,
                source=source,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
                cache=cache,
                today_kst=today_kst,
            )
        if not bid_cached:
            bid = build_bid_peak_slice(
                engine,
                code=code,
                date=date,
                bucket_ms=bucket_ms,
                source=source,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
                cache=cache,
                today_kst=today_kst,
            )
        return ask, bid

    # The dual-peak query is the process's heaviest read (inequality join +
    # unbounded windows, ~17GB/155s on a pathological day). `/api/range` is a
    # sync route on FastAPI's thread pool and today's peak is uncached
    # (ADR-0043), so concurrent sidecar polls would run this in parallel over a
    # shared soft `memory_limit` and OOM. The guard (ADR-0085) bounds concurrency
    # + collapses identical concurrent computes — it is load-bearing, NOT an
    # optimization: DuckDB's memory_limit is soft, so removing/bypassing this
    # re-opens the OOM. See hoga/api/peak_slice_guard.py.
    #
    # ADR-0090: today's result is additionally reused across SEQUENTIAL calls
    # (not just concurrent ones) for a short TTL, to collapse symbol-switch
    # polling bursts that the single-flight guard above cannot dedupe.
    is_today = today_kst is not None and date == today_kst
    ttl_key = ("peak_dual", code, date, source, bucket_ms, session_open_ms, session_close_ms)
    hit, cached_rows = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
    if hit:
        ask_row, bid_row = cached_rows
    else:
        ask_row, bid_row = PEAK_SLICE_GUARD.run(
            (code, date, source, bucket_ms),
            lambda: snapshots_tbl.query_day_ask_bid_peak_dual(
                engine.conn,
                path=path_obj,
                trades_path=trades_path,
                bucket_ms=bucket_ms,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
            ),
        )
        if is_today:
            TODAY_TTL.put(ttl_key, (ask_row, bid_row))
    if ask_row is not None and not ask_cached:
        ask = _ask_peak_from_dual_row(date, ask_row)
    if bid_row is not None and not bid_cached:
        bid = _bid_peak_from_dual_row(date, bid_row)
    if cache is not None and today_kst is not None and date != today_kst:
        if not ask_cached:
            cache.store_ask_peak(code, date, source, bucket_ms, ask)
        if not bid_cached:
            cache.store_bid_peak(code, date, source, bucket_ms, bid)
    return ask, bid


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
    continuous_before_ms: int | None = None,
    band_pct: float = 0.005,
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> TradeVolumePoc | None:
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    code_dir = engine.parquet_dir(date, code, source)
    trades_path = code_dir / "trades.parquet"
    if price_range is None or not trades_path.exists():
        return None
    price_min, price_max = price_range
    cacheable = cache is not None and today_kst is not None and date < today_kst
    if cacheable:
        cached = cache.get_trade_volume_poc(
            code, date, source, range_count, price_min, price_max,
        )
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    row = trades_tbl.query_trade_volume_poc(
        engine.conn,
        path=trades_path,
        price_lo=price_min,
        price_hi=price_max,
        bins=range_count,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
        continuous_before_ms=continuous_before_ms,
    )
    if row is None:
        if cacheable:
            cache.store_trade_volume_poc(
                code, date, source, range_count, price_min, price_max, None,
            )
        return None
    poc = TradeVolumePoc(
        date=date,
        center_price=row.center_price,
        low_price=row.low_price,
        high_price=row.high_price,
        qty=row.qty,
        t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
        band_pct=band_pct,
    )
    if cacheable:
        cache.store_trade_volume_poc(
            code, date, source, range_count, price_min, price_max, poc,
        )
    return poc


def build_depth_heatmap_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> list[DepthHeatmapPoint]:
    """버킷별 대표 스냅샷의 10호가 잔량 분포를 DepthHeatmapPoint 리스트로.

    query_bucketed_depth_heatmap은 LINEAR intra_ms를 주므로
    ms_from_midnight_to_unix_ms(date, intra)로 unix 변환 — 호가비/총잔량 빌더와
    동일 규약. 잔량 0 단계도 그대로 실어 보낸다(프론트가 스킵).

    형제 지표(호가비·체결강도·매도벽·POC)와 동일하게 완료된 과거일은
    PastIndicatorsCache로 1회 계산 후 재사용한다(ADR-0043/0090 게이트를
    ``_indicator_cacheable``로 자가-해석). ratio/fill 과 달리 1m 저장+재집계가
    아니라 (code, date, source, bucket_ms) 결과를 그대로 캐시한다 — 대표 선택이
    조건부 argmax라 1m 행에서 coarse 대표를 정확히 복원할 수 없기 때문
    (past_indicators_cache._mem_depth 주석 참조). 오늘은 프로모션 진행 중이라
    항상 재계산.

    ``session_open_ms``는 형제 빌더(및 Task-4 호출부) 시그니처 대칭용으로만
    유지 — 본문 미사용.
    """
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    try:
        path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    except (FileNotFoundError, StockDateNotFound):
        return []
    if not path_obj.exists():
        return []
    cacheable = _indicator_cacheable(cache, today_kst, date, bucket_ms)
    if cacheable:
        cached = cache.get_depth(code, date, source, bucket_ms)  # type: ignore[union-attr]
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    rows = snapshots_tbl.query_bucketed_depth_heatmap(
        engine.conn,
        path=path_obj,
        bucket_ms=bucket_ms,
        session_close_ms=session_close_ms,
    )
    out: list[DepthHeatmapPoint] = []
    for r in rows:
        t_ms = ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms)
        out.append(
            DepthHeatmapPoint(
                t_ms=t_ms,
                asks=[[p, q] for p, q in zip(r.ask_prices, r.ask_qtys)],
                bids=[[p, q] for p, q in zip(r.bid_prices, r.bid_qtys)],
                asks_max=[[p, q] for p, q in zip(r.ask_prices_max, r.ask_qtys_max)],
                bids_max=[[p, q] for p, q in zip(r.bid_prices_max, r.bid_qtys_max)],
            )
        )
    if cacheable:
        cache.store_depth(code, date, source, bucket_ms, out)  # type: ignore[union-attr]
    return out


def _first_trailing_single_price_book_hhmmssms(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    session_close_ms: int,
) -> int | None:
    code_dir = engine.parquet_dir(date, code, source)
    snapshots_path = code_dir / "snapshots.parquet"
    if not snapshots_path.exists():
        return None
    intra_ms = snapshots_tbl.query_first_trailing_single_price_book_intra_ms(
        engine.conn,
        path=snapshots_path,
        session_close_ms=session_close_ms,
    )
    if intra_ms is None:
        return None
    trades_path = code_dir / "trades.parquet"
    if trades_path.exists():
        intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
        close_intra_sql = hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))
        row = engine.conn.execute(
            f"SELECT count(*) FROM read_parquet(?) "
            f"WHERE side IN (1, -1) "
            f"AND {intra_ms_expr} > ? "
            f"AND {intra_ms_expr} < {close_intra_sql}",
            [str(trades_path), intra_ms],
        ).fetchone()
        if row is not None and int(row[0] or 0) > 0:
            return None
    h = intra_ms // 3_600_000
    m = (intra_ms // 60_000) % 60
    s = (intra_ms // 1000) % 60
    ms = intra_ms % 1000
    return h * 10_000_000 + m * 100_000 + s * 1000 + ms


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
        depth_heatmap=[],
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
    volume_distribution_cutoff_ms: int | None = None,
    mode: str,
    ask_peaks_enabled: bool = True,
    bid_peaks_enabled: bool = True,
    program_trade_enabled: bool = True,
    trade_volume_poc_enabled: bool = True,
    depth_heatmap_enabled: bool = True,
) -> RangeBundle:
    """Build the Wire Model for a Stock-Date Range (ADR-0013, ADR-0014).

    Validates ``bucket_ms`` and ``from_date <= to_date``.
    Returns an empty RangeBundle when no Stock-Date in range has captured data
    or all in-range dates are excluded by invariants (spec 2026-05-27 §4.3).

    Loops over captured Stock-Dates calling each per-slice builder directly.
    ``quote_ratio.points`` and ``fill_strength.points`` ARE concatenated
    because they are flat ``(t, value)`` arrays.

    ``volume_profile_range`` / ``volume_profile_by_day`` / ``price_level_hits``
    는 와이어 shape 유지를 위해 항상-빈 값으로 남는다 — 이 필드들을 채우던
    ``mode=full`` 은 프론트엔드 미사용 dead path 로 2026-07-08 제거됐다.
    """
    validate_bucket_ms(bucket_ms)
    if mode not in {"hoga", "sidecar", "candles"}:
        raise HTTPException(400, "mode must be one of hoga|sidecar|candles")

    try:
        d_from = datetime.strptime(from_date, "%Y%m%d").date()
        d_to = datetime.strptime(to_date, "%Y%m%d").date()
    except ValueError as e:
        raise HTTPException(400, f"Invalid YYYYMMDD date: {e}") from e
    if d_to < d_from:
        raise HTTPException(400, "from > to")

    hoga_only = mode == "hoga"
    sidecar_only = mode == "sidecar"
    candles_only = mode == "candles"
    cutoff_sidecar = sidecar_only and volume_distribution_cutoff_ms is not None
    volume_distribution_slice_cutoff_ms = (
        volume_distribution_cutoff_ms if sidecar_only else None
    )
    include_optional_sidecar_slices = not hoga_only and not cutoff_sidecar and not candles_only
    include_ask_peaks = include_optional_sidecar_slices and ask_peaks_enabled
    include_bid_peaks = include_optional_sidecar_slices and bid_peaks_enabled
    include_trade_volume_pocs = include_optional_sidecar_slices and trade_volume_poc_enabled
    include_depth_heatmap = include_optional_sidecar_slices and depth_heatmap_enabled
    include_program_trade = program_trade_enabled and sidecar_only

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
    volume_distributions: list[DayVolumeDistribution] = []
    # 거래일별 매도 최대벽 — 데이터 있는 각 거래일당 1개(프론트가 그날 구간 수평 세그먼트로 렌더).
    # 루프 안에서 계산해 native HHMMSSmmm 세션 경계(meta)에 접근 → 총잔량 지표와 동일하게
    # bucket_ms 버킷 대표 + 동시호가 배제. 과거일은 indicators_cache로 1회 계산(N일 재스캔 회피).
    ask_peaks: list[AskPeak] = []
    bid_peaks: list[BidPeak] = []
    broker_late_entries: list[BrokerLateEntryEvent] = []
    trade_volume_pocs: list[TradeVolumePoc] = []
    depth_heatmap: list[DepthHeatmapPoint] = []
    included_dates: list[str] = []

    # Indicator cache (호가비·체결강도)의 과거/오늘 게이트(ADR-0043/0090)는 각
    # 슬라이스 빌더가 자가-해석한다(WS3) — 루프는 캐시 정책을 알 필요 없음.

    for d in dates:
        date_t0 = perf_debug.now()
        date_candles_before = len(candles)
        date_ratio_before = len(ratio_pts)
        date_fill_before = len(fill_pts)
        date_excluded_before = len(excluded)
        date_warnings_before = len(warnings_list)
        resolution = resolve_source_result(engine, d, code, source_pref)
        source = resolution.source
        if resolution.path is not None:
            try:
                meta = json.loads((resolution.path / "meta.json").read_text(encoding="utf-8"))
            except (FileNotFoundError, ValueError, OSError):
                if perf_debug.enabled():
                    log.warning(
                        "hoga_perf range_date status=skip_meta code=%s date=%s source=%s mode=%s "
                        "duration_ms=%.1f",
                        code, d, source, mode, perf_debug.elapsed_ms(date_t0),
                    )
                continue
        else:
            try:
                meta = engine.get_meta(d, code, source)
            except (FileNotFoundError, StockDateNotFound):
                if perf_debug.enabled():
                    log.warning(
                        "hoga_perf range_date status=skip_meta code=%s date=%s source=%s mode=%s "
                        "duration_ms=%.1f",
                        code, d, source, mode, perf_debug.elapsed_ms(date_t0),
                    )
                continue
        c = resolution.classification or classify_from_meta(meta)

        if c.state == DiskState.INVALID:
            excluded.append(ExcludedDate(
                date=d, violations=[v.to_model() for v in c.errors],
            ))
            if perf_debug.enabled():
                log.warning(
                    "hoga_perf range_date status=invalid code=%s date=%s source=%s mode=%s "
                    "errors=%d duration_ms=%.1f",
                    code, d, source, mode, len(c.errors), perf_debug.elapsed_ms(date_t0),
                )
            continue

        if c.warnings:
            warnings_list.append(DateWarning(
                date=d, warnings=[v.to_model() for v in c.warnings],
            ))

        needs_trade_price_range = volume_distribution_bins is not None or include_trade_volume_pocs
        needs_raw_candles = not hoga_only and (not sidecar_only or needs_trade_price_range)
        raw_candles = (
            build_candles_slice(engine, code=code, date=d, source=source)
            if needs_raw_candles
            else []
        )
        if hoga_only:
            price_range = None
            trade_indicator_source = source
            candles_d = []
        elif candles_only:
            price_range = None
            trade_indicator_source = source
            candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms)
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
            trade_indicator_source = (
                _resolve_trade_indicator_source(
                    engine,
                    date=d,
                    code=code,
                    source_pref=source_pref,
                    selected_source=source,
                )
                if needs_trade_price_range
                else source
            )
            candles_d = [] if sidecar_only else downsample_candles(raw_candles, bucket_ms=bucket_ms)
        qr_d = (
            QuoteRatio(bucket_ms=bucket_ms, points=[])
            if sidecar_only or candles_only
            else build_quote_ratio_slice(
                engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
                session_close_ms=meta["regular_session_close_ms"],
            )
        )
        fs_d = (
            FillStrength(bucket_ms=bucket_ms, points=[])
            if sidecar_only or candles_only
            else build_fill_strength_slice(
                engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            )
        )
        norm_meta, _ = normalize_session_bounds(meta)   # value-conversion only (notes handled by classify)
        continuous_before_needed = needs_trade_price_range and not hoga_only and not candles_only
        continuous_before_ms = (
            _first_trailing_single_price_book_hhmmssms(
                engine,
                code=code,
                date=d,
                source=trade_indicator_source,
                session_close_ms=int(meta["regular_session_close_ms"]),
            )
            if continuous_before_needed
            else None
        )
        if include_ask_peaks or include_bid_peaks:
            ap_d, bp_d = build_ask_bid_peak_slices(
                engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
                session_open_ms=norm_meta["regular_session_open_ms"],
                session_close_ms=meta["regular_session_close_ms"],
            )
            if not include_ask_peaks:
                ap_d = None
            if not include_bid_peaks:
                bp_d = None
        else:
            ap_d = None
            bp_d = None
        tvp_d = (
            build_trade_volume_poc_slice(
                engine, code=code, date=d, source=trade_indicator_source,
                session_open_ms=norm_meta["regular_session_open_ms"],
                session_close_ms=meta["regular_session_close_ms"],
                range_count=trade_volume_poc_bins or DEFAULT_TRADE_VOLUME_POC_BINS,
                price_range=price_range,
                continuous_before_ms=continuous_before_ms,
            )
            if include_trade_volume_pocs
            else None
        )
        segments.append(RangeSegment(
            date=d,
            session_open_ms=hhmmssms_to_unix_ms(d, norm_meta["regular_session_open_ms"]),
            session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
            source=source,
        ))
        included_dates.append(d)
        if not hoga_only and not cutoff_sidecar and not candles_only and broker_late_entries_enabled:
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
        if not hoga_only and not candles_only and volume_distribution_bins is not None:
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
                cutoff_ms=volume_distribution_slice_cutoff_ms,
                continuous_before_ms=continuous_before_ms,
            )
            if profile is not None:
                volume_distributions.append(profile)
        if ap_d is not None:
            ask_peaks.append(ap_d)
        if bp_d is not None:
            bid_peaks.append(bp_d)
        if tvp_d is not None:
            trade_volume_pocs.append(tvp_d)
        if include_depth_heatmap:
            depth_heatmap.extend(
                build_depth_heatmap_slice(
                    engine,
                    code=code,
                    date=d,
                    bucket_ms=bucket_ms,
                    source=source,
                    session_open_ms=norm_meta["regular_session_open_ms"],
                    session_close_ms=meta["regular_session_close_ms"],
                )
            )
        if perf_debug.enabled():
            log.warning(
                "hoga_perf range_date status=ok code=%s date=%s source=%s mode=%s "
                "raw_candles=%d candles=%d quote_ratio=%d fill_strength=%d "
                "excluded_delta=%d warning_delta=%d duration_ms=%.1f",
                code,
                d,
                source,
                mode,
                len(raw_candles),
                len(candles) - date_candles_before,
                len(ratio_pts) - date_ratio_before,
                len(fill_pts) - date_fill_before,
                len(excluded) - date_excluded_before,
                len(warnings_list) - date_warnings_before,
                perf_debug.elapsed_ms(date_t0),
            )

    if not segments:
        # Spec 2026-05-27 §4.3: every in-range date is INVALID → return an
        # empty bundle with excluded_dates populated, so frontend can render
        # DataWarning UX without 404 round-trips.
        return _empty_range_bundle(code, from_date, to_date, bucket_ms, excluded=excluded)

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=segments,
        candles=candles,
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=fill_pts),
        # mode=full 퇴역(2026-07-08) 후 와이어 shape 유지용 상시-빈 필드.
        volume_profile_range=_empty_volume_profile(),
        volume_profile_by_day=[],
        excluded_dates=excluded,
        data_warnings=warnings_list,
        ask_peaks=ask_peaks,
        bid_peaks=bid_peaks,
        broker_late_entries=broker_late_entries,
        price_level_hits=[],
        trade_volume_pocs=trade_volume_pocs,
        depth_heatmap=depth_heatmap,
        volume_distributions=volume_distributions,
        program_trade=(
            build_program_trade_series(engine, code=code, dates=included_dates)
            if include_program_trade
            else ProgramTradeSeries(points=[])
        ),
    )
