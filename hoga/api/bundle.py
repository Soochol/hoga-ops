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
import os
import time
from collections.abc import Collection, Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar, cast

from fastapi import HTTPException

from hoga import perf_debug
from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.eligibility import is_expired_upstream_stub
from hoga.api.indicator_reaggregate import reaggregate_fill, reaggregate_ratio
from hoga.api.invariants import indicator_session_bounds, normalize_session_bounds
from hoga.api.models import (
    CLIPPED_TIMEFRAME_MS,
    AskPeak,
    AskPeakCandidate,
    BidPeak,
    BrokerLateEntryEvent,
    DateWarning,
    DayVolumeDistribution,
    DepthHeatmapPoint,
    ExcludedDate,
    FillStrength,
    FillStrengthPoint,
    MissingDate,
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
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.slice_coalescer import SLICE_COALESCER
from hoga.api.sources import (
    ordered_sources,
    resolve_candle_source,
    resolve_source_result,
    source_covers_venue,
)
from hoga.api.today_ttl_cache import TODAY_TTL
from hoga.collector.orchestrator import now_kst
from hoga.live.program_trade_store import ProgramTradeStore, is_significant_gap_event
from hoga.live.venue import Venue
from hoga.tables import (
    brokers as brokers_tbl,
    candles as candles_tbl,
    fills as fills_tbl,
    snapshots as snapshots_tbl,
    trades as trades_tbl,
)
from hoga.tables.candles import ApiCandle
from hoga.tables.trades import FillStrengthRow
from hoga.util.timeenc import (
    KST,
    hhmmssms_to_intra_ms_sql,
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)

if TYPE_CHECKING:
    from hoga.api.past_indicators_cache import PastIndicatorsCache

log = logging.getLogger(__name__)

# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST
DEFAULT_TRADE_VOLUME_POC_BINS = 10

# /api/range minute timeframes are multiples of this; the indicator cache stores
# 1m and re-aggregates up. A request whose bucket_ms is NOT a 1m multiple (the
# 1000 ms /replay default, sub-minute callers) bypasses the cache and queries
# directly — re-aggregation cannot synthesize a finer grain than the cache.
_ONE_MINUTE_MS = 60_000

# 정규장 클립 경계(HHMMSSmmm). 프론트 `isRegularSessionMs` 의 고정 09:00~15:30 과
# 같은 값이어야 한다 — 근거는 `downsample_candles` docstring.
_REGULAR_OPEN_HHMMSSMS = 90_000_000
_REGULAR_CLOSE_HHMMSSMS = 153_000_000

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


def _resolve_source(engine: QueryEngine, date: str, code: str, pref: str,
                    venue: str = "KRX") -> str:
    """Backward-compatible source-name helper for older unit tests."""
    return resolve_source_result(engine, date, code, pref, venue).source


def _resolve_trade_indicator_source(
    engine: QueryEngine,
    *,
    date: str,
    code: str,
    source_pref: str,
    selected_source: str,
    venue: Venue = "KRX",
) -> str:
    """Pick the first policy source with price-level trades for trade indicators.


    ⚠ 후보를 **`source_covers_venue` 로 거른다**(#1133). 이 함수는 사다리
    (`resolve_source_result`)를 쓰지 않고 `ordered_sources` 를 직접 순회하므로,
    사다리가 하는 venue 필터를 **여기서 다시 해야 한다**. 안 걸었을 때 실측
    (2026-08-07): venue=NXT 요청이 hogaplay 를 체결 지표 소스로 골랐고, 매물대·
    거래량 POC 가 KRX 데이터로 계산됐다 — `source_venue_dir` 이 venue 축 없는
    source 엔 세그먼트를 안 붙여 경로가 그대로 존재했기 때문이다.

    "사다리를 안 쓰는 재선택 경로" 가 이 파일에 또 생기면 같은 필터가 또 필요하다.
    그래서 `source_venue_dir` 쪽에도 구조적 가드(`VenueNotCoveredError`)를 뒀다.
    """
    candidates = [selected_source]
    candidates.extend(source for source in ordered_sources(source_pref) if source not in candidates)
    candidates = [s for s in candidates if source_covers_venue(s, venue)]
    for source in candidates:
        try:
            source_dir = engine.parquet_dir(date, code, source, venue=venue)
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
    if hh < 9 or hh > 15 or mm < 0 or mm > 59:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise ValueError("broker_late_entry_start_hhmm must be between 900 and 1520")
    if hh == 15 and mm > 20:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
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


def downsample_candles(
    candles: list[ApiCandle], *, bucket_ms: int, date: str
) -> list[ApiCandle]:
    """Re-aggregate 1-minute OHLCV candles into the requested Timeframe bucket.

    Aggregation per bucket: open = first.open, close = last.close,
    high = max(high), low = min(low), vol_a/vol_b = sum.

    Input must be sorted by ts_ms ascending (this function does NOT sort).
    `bucket_ms == 60_000` returns the input verbatim (identity case).
    The last bucket may be partial (fewer than bucket_ms/60_000 source candles).

    Raises ValueError if bucket_ms is not in ALLOWED_TIMEFRAME_MS (ADR-0014).

    ``date`` 는 정규장 클립의 기준 날짜다(YYYYMMDD KST). **기본값을 두지 않는다** —
    호출부가 이미 날짜별 루프 안이라 넘길 값을 갖고 있고, 빠뜨리면 클립 대상 tf 에서
    조용히 안 잘린다.

    ## 120·240 만 정규장으로 클립한다

    이 두 tf 는 버킷이 정규장 마감(15:30)을 가로질러 NXT·UN 의 애프터마켓을 정규장
    봉에 끌어들인다(2026-08-07 실측 +1.08%/+1.30%). 클립 경계는 **고정 09:00~15:30**
    이고, meta 의 실제 세션이 아니다 — 프론트(`isRegularSessionMs`)가 고정값을 쓰기
    때문이다. 두 경로가 다른 경계를 쓰면 우회 ON/OFF 에서 **같은 종목·같은 날의 봉이
    달라진다**. 대가는 공유된 한계다: 반휴장일(12:30 마감) 이후 시간외가 창 안에
    들어오면 양쪽 다 통과시킨다.
    """
    validate_bucket_ms(bucket_ms)
    if bucket_ms in CLIPPED_TIMEFRAME_MS:
        open_ms = hhmmssms_to_unix_ms(date, _REGULAR_OPEN_HHMMSSMS)
        close_ms = hhmmssms_to_unix_ms(date, _REGULAR_CLOSE_HHMMSSMS)
        candles = [c for c in candles if open_ms <= c.ts_ms <= close_ms]
    if bucket_ms == 60_000 or not candles:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
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
    engine: QueryEngine, *, code: str, date: str, source: str = "hogaplay", venue: Venue = "KRX"
) -> list[ApiCandle]:
    # ADR-0040 / ADR-0043: a live promotion may have no candles.parquet — the
    # candle dimension can be served separately by Live Candle Backfill.
    # (ADR-0125 revised this for kiwoom_live, which synthesizes its own minute
    # candles; days where synthesis failed still land here.) Return empty list
    # rather than raising so /api/range can still serve hoga indicators +
    # segments for live-source Stock-Dates.
    path = engine.parquet_dir(date, code, source, venue=venue) / "candles.parquet"
    if not path.exists():
        return []
    # 자정→Unix 보정은 **SQL 이 한다**. 여기서 `model_copy` 로 다시 씌우면 같은 행을
    # 두 벌 만들게 되고, 5개월치면 그게 36,276개짜리 두 벌이다(`query_all` docstring).
    return candles_tbl.query_all(
        engine.conn, path=path, ts_offset_ms=ms_from_midnight_to_unix_ms(date, 0),
    )


def build_broker_late_entries_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    venue: Venue = "KRX",
    start_hhmm: int,
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> list[BrokerLateEntryEvent]:
    """거래원 지각 진입 — 완료된 과거일 이벤트를 PastIndicatorsCache로 재사용.

    brokers.parquet 풀스캔을 요청마다 재지불하던 것을 (code, date, source, start_hhmm)
    이벤트 리스트 캐시로 제거. start_hhmm 은 seen-set 선별 임계라 키 필수(SQL 자체는
    무관하지만 최종 events 는 종속). ``[]`` 도 유효 캐시값. 오늘은 재계산(ADR-0043)."""
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    path = engine.parquet_dir(date, code, source, venue=venue) / "brokers.parquet"
    if not path.exists():
        return []
    threshold_ms = _hhmm_to_hhmmssms(start_hhmm)  # invalid hhmm 은 캐시 이전에 raise
    cacheable = cache is not None and today_kst is not None and date < today_kst
    if cacheable:
        cached = cache.get_broker_late(code, date, source, start_hhmm, venue=venue)  # type: ignore[union-attr]
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    # 오늘자: short-TTL 프로세스 캐시(ADR-0090). ``[]`` 도 유효 캐시값.
    is_today = today_kst is not None and date == today_kst
    # threshold_ms is derived from start_hhmm, so start_hhmm alone keys the compute.
    broker_key = ("broker_late", code, date, source, venue, start_hhmm)
    if is_today:
        hit, cached = TODAY_TTL.lookup(broker_key)
        if hit:
            return cached
    rows = SLICE_COALESCER.run(
        broker_key,
        lambda: brokers_tbl.query_late_entry_events(
            engine.conn,
            path=path,
            threshold_ms=threshold_ms,
        ),
    )
    events = [
        BrokerLateEntryEvent(
            t_ms=hhmmssms_to_unix_ms(date, row.t_ms),
            broker=row.broker,
            side=row.side,
            net=row.net,
        )
        for row in rows
    ]
    if cacheable:
        cache.store_broker_late(code, date, source, start_hhmm, events, venue=venue)  # type: ignore[union-attr]
    elif is_today:
        TODAY_TTL.put(broker_key, events)
    return events


def build_quote_ratio_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 1000,
    source: str = "hogaplay",
    venue: Venue = "KRX",
    session_open_ms: int | None = None,
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
    path_obj = engine.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
    if not path_obj.exists():
        # ADR-0043: today promotion (promote_kiwoom_today) writes empty records
        # as unlink → missing file is the valid "no data" state, not an error.
        return QuoteRatio(bucket_ms=bucket_ms, points=[])
    if _indicator_cacheable(cache, today_kst, date, bucket_ms):
        # Past day + minute bucket: cache the 1-minute representatives once and
        # re-aggregate up (reaggregate_ratio == a direct bucket_ms query, proven
        # in test_indicator_reaggregate). The 1m rows carry the SAME
        # session_open_ms/session_close_ms auction boundary, so the (0,0) auction
        # sentinel (opening + closing) is preserved across re-aggregation.
        rows_1m = cache.get_ratio(code, date, source, venue=venue)  # type: ignore[union-attr]
        if rows_1m is None:
            rows_1m = SLICE_COALESCER.run(
                ("ratio", code, date, source, venue),
                lambda: snapshots_tbl.query_bucketed_ratio(
                    engine.conn, path=path_obj, bucket_ms=_ONE_MINUTE_MS,
                    session_open_ms=session_open_ms,
                    session_close_ms=session_close_ms,
                ),
            )
            cache.store_ratio(code, date, source, rows_1m, venue=venue)  # type: ignore[union-attr]
        rows = reaggregate_ratio(rows_1m, bucket_ms)
    elif (
        today_kst is not None and date == today_kst
        and bucket_ms % _ONE_MINUTE_MS == 0
    ):
        # 오늘도 **1분으로 한 번만** 스캔하고 굵은 봉은 재집계한다 — 위 과거일 분기가
        # 이미 하는 일이고, 차이는 저장소뿐이다(디스크 캐시 → 프로세스 TTL; ADR-0043 의
        # 금지는 영속 캐시 한정이다). `reaggregate_ratio == 직접 조회` 등가성은
        # `test_indicator_reaggregate` 가 이미 증명하므로 새 계약이 아니다.
        #
        # 키에 `bucket_ms` 가 **없다**: 스캔이 1분 고정이라 봉이 키일 이유가 없고,
        # 있으면 봉 전환마다 미스가 난다. 실측(2026-08-29, hogaplay 85k행): 종전엔
        # 1분 27.8ms → 5분 28.0ms → 15분 32.8ms 로 봉마다 풀 스캔이었고, 과거일은
        # 같은 데이터에서 0.4ms/0.2ms 였다. 픽스 전 peak 과 같은 결함이다.
        ttl_key = ("ratio_1m", code, date, source, venue, session_open_ms, session_close_ms)
        hit, rows_1m = TODAY_TTL.lookup(ttl_key)
        if not hit:
            rows_1m = snapshots_tbl.query_bucketed_ratio(
                engine.conn, path=path_obj, bucket_ms=_ONE_MINUTE_MS,
                session_open_ms=session_open_ms, session_close_ms=session_close_ms,
            )
            TODAY_TTL.put(ttl_key, rows_1m)
        rows = reaggregate_ratio(rows_1m, bucket_ms)
    else:
        # 여기 남는 것: 분 미만 봉(재집계할 1분 행이 없다) · 캐시 없는 과거일(테스트).
        rows = snapshots_tbl.query_bucketed_ratio(
            engine.conn, path=path_obj, bucket_ms=bucket_ms,
            session_open_ms=session_open_ms, session_close_ms=session_close_ms,
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
                band_pct=r.band_pct,
                tick=r.tick,
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
    venue: Venue = "KRX",
    session_open_ms: int,
    session_close_ms: int,
    range_count: int,
    price_min: int | None = None,
    price_max: int | None = None,
    cutoff_ms: int | None = None,
    continuous_before_ms: int | None = None,
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> DayVolumeDistribution | None:
    """체결 분포 — 완료된 과거일 결과를 PastIndicatorsCache로 재사용(POC/depth 패턴).

    trades.parquet 풀스캔 GROUP BY를 요청마다 재지불하던 것을 (code, date, source,
    range_count, price_min, price_max) 결과 캐시로 제거. **cutoff_ms is None 요청만
    캐시** — cutoff variant(hover/스터디 스크럽)는 버킷 정렬 카디널리티가 높아 디스크
    파편화를 유발하므로 v1 제외(선행 continuous_before 캐시가 스크럽 비용은 이미 상쇄).
    None(무데이터일)도 유효 캐시값. session_open/close_ms·last_trade_ms는 meta/데이터
    파생이라 (code,date) 불변 → 키 불포함(POC 선례와 동일).

    v2 아이디어: 1m 버킷별 bin 델타 아티팩트 + prefix-sum으로 임의 cutoff 응답을
    합성하면 cutoff variant도 캐시 가능(현재 미구현)."""
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    code_dir = engine.parquet_dir(date, code, source, venue=venue)
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
    # price 해석 후 캐시 조회 — 키가 확정되는 시점. cutoff 요청은 캐시 우회.
    cacheable = (
        cache is not None
        and today_kst is not None
        and date < today_kst
        and cutoff_ms is None
    )
    if cacheable:
        cached = cache.get_volume_distribution(  # type: ignore[union-attr]
            code, date, source, range_count, price_min, price_max, venue=venue,
        )
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    # 오늘자 & cutoff 없는 요청만 short-TTL(ADR-0090) — cutoff variant는 과거일과
    # 동일하게 캐시 제외(카디널리티). 키=coalescer 키로 정합 보장.
    is_today = today_kst is not None and date == today_kst and cutoff_ms is None
    vdist_key = ("vdist", code, date, source, venue, range_count, price_min, price_max, cutoff_ms)
    if is_today:
        hit, cached = TODAY_TTL.lookup(vdist_key)
        if hit:
            return cached  # type: ignore[return-value]
    upper_bound_ms = None
    if cutoff_ms is not None:
        cutoff_hhmmssms = unix_ms_to_hhmmssms(date, cutoff_ms)
        # 휴리스틱 래퍼(_session_bound_to_intra_ms)가 아니라 무조건 디코더를 쓴다.
        # 그 래퍼는 `value > 86_400_000` 일 때만 HHMMSSmmm 으로 보고 디코드하는데,
        # 위 unix_ms_to_hhmmssms 는 **항상** HHMMSSmmm 을 돌려주므로 그 분기는 여기서
        # 성립하지 않는다. 09:00 미만 커서는 HHMMSSmmm 이 86_400_000(=08:64:00.000,
        # 존재하지 않는 시각) 아래라 linear ms 로 오인되어 원값이 그대로 통과했다.
        #
        # 실측: 08:30 커서 → HHMMSSmmm 83_000_000, 올바른 intra_ms 30_600_000,
        # 실제 반환 83_000_000(=23.06h). 그러면 query_volume_distribution 의
        # `min(session_close_intra_ms, upper_bound_ms, ...)`(trades.py:570)에서
        # 장 마감(~55_800_000)이 이겨 **cutoff 가 조용히 무시되고 하루 전체 분포가
        # 반환된다** — 크래시가 없어 더 나쁘다. 09:00 이후 커서만 우연히 맞았다.
        #
        # 재현 경로는 공개 API 다: routes.py 의 volume_distribution_cutoff_ms 는
        # mode=sidecar 와 단일 Stock-Date 만 검증하고 장 시간대 가드가 없어,
        # 08:30~09:00 동시호가 구간으로 스크럽하면 그대로 발현한다.
        upper_bound_ms = trades_tbl._hhmmssms_to_intra_ms(cutoff_hhmmssms) + 1
    dist_kwargs = {}
    if upper_bound_ms is not None:
        dist_kwargs["upper_bound_ms"] = upper_bound_ms
    # cutoff_ms is in the key: cutoff sidecars bypass the cache and each cutoff
    # yields a different (upper-bounded) distribution, so they must NOT coalesce
    # with each other or with the normal (cutoff=None) result.
    binning = SLICE_COALESCER.run(
        vdist_key,
        lambda: trades_tbl.query_continuous_trade_volume_distribution(
            engine.conn,
            path=trades_path,
            price_lo=price_min,
            price_hi=price_max,
            bins=range_count,
            session_open_ms=session_open_ms,
            session_close_ms=session_close_ms,
            **dist_kwargs,
            continuous_before_ms=continuous_before_ms,
        ),
    )
    result = DayVolumeDistribution(
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
    if cacheable:
        cache.store_volume_distribution(  # type: ignore[union-attr]
            code, date, source, range_count, price_min, price_max, result, venue=venue,
        )
    elif is_today:
        TODAY_TTL.put(vdist_key, result)
    return result


def build_fill_strength_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 60_000,
    source: str = "hogaplay",
    venue: Venue = "KRX",
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
    # 그릴링 Q4: 신형 실시간 승격본은 fills.parquet(10초 구간합)이 체결강도 소스.
    # fills가 있으면 우선, 없으면(=hogaplay·레거시 승격본) trades 폴백
    # (_query_fill_rows). fill_strength is a pure SUM GROUP BY, so re-aggregating
    # the cached 1m sums up to bucket_ms is exact (reaggregate_fill).
    code_dir = engine.parquet_dir(date, code, source, venue=venue)
    if _indicator_cacheable(cache, today_kst, date, bucket_ms):
        rows_1m = cache.get_fill(code, date, source, venue=venue)  # type: ignore[union-attr]
        if rows_1m is None:
            rows_1m = SLICE_COALESCER.run(
                ("fill", code, date, source, venue),
                lambda: _query_fill_rows(engine, code_dir, _ONE_MINUTE_MS),
            )
            if rows_1m is None:
                return FillStrength(bucket_ms=bucket_ms, points=[])
            cache.store_fill(code, date, source, rows_1m, venue=venue)  # type: ignore[union-attr]
        rows = reaggregate_fill(rows_1m, bucket_ms)
    elif (
        today_kst is not None and date == today_kst
        and bucket_ms % _ONE_MINUTE_MS == 0
    ):
        # 오늘도 **1분으로 한 번만** 스캔하고 굵은 봉은 재집계한다 — 위 과거일 분기와
        # 같은 구조이고 저장소만 다르다(디스크 → 프로세스 TTL). fill 은 순수 SUM
        # GROUP BY 라 재집계가 정확하다(이 함수 상단 주석 + `reaggregate_fill`).
        #
        # 키에 `bucket_ms` 가 **없다**: 스캔이 1분 고정이라 봉이 키일 이유가 없고,
        # 있으면 봉 전환마다 미스가 난다. 실측(2026-08-29): 종전 1분 18.0ms → 5분
        # 16.0ms → 15분 15.7ms 로 봉마다 재스캔이었고, 과거일은 0.2ms/0.1ms 였다.
        ttl_key = ("fill_1m", code, date, source, venue)
        hit, rows_1m = TODAY_TTL.lookup(ttl_key)
        if not hit:
            rows_1m = _query_fill_rows(engine, code_dir, _ONE_MINUTE_MS)
            if rows_1m is None:
                # ADR-0043: fills·trades 둘 다 없음 = 유효한 "체결 없음".
                # **None 은 캐시하지 않는다** — 시가 직후 파일이 늦게 생길 수 있고
                # stale None 이 최대 TTL 만큼 그것을 가린다(기존 테스트가 잠근다).
                return FillStrength(bucket_ms=bucket_ms, points=[])
            # ADR-0090: `_query_fill_rows` 가 fills.parquet 우선·trades 폴백이라, trades
            # 유래 결과를 캐시한 뒤 fills.parquet 이 같은 15s 창 안에 늦게 도착하면 이후
            # 새로 선호되는 fills 유래 값 대신 캐시된 trades 유래 값을 서빙한다. trades
            # 유래 체결강도도 유효 데이터(틀린 게 아니라 선호 소스만 다름)이고, TTL 이
            # 이미 수용한 15s staleness 예산 안이라 허용한다.
            TODAY_TTL.put(ttl_key, rows_1m)
        rows = reaggregate_fill(rows_1m, bucket_ms)
    else:
        # 여기 남는 것: 분 미만 봉(재집계할 1분 행이 없다) · 캐시 없는 과거일(테스트).
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
    venue: Venue = "KRX",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = None,
    today_kst: str | None = None,
) -> AskPeak | None:
    """해당 거래일(date) 연속거래 매도 최대벽. best-effort: 파일 부재(=무데이터, ADR-0043)나
    미캐탈로그(StockDateNotFound — 경고/제외 세그먼트에서 발생 가능) → None(선 미표시).
    과거일(today_kst != date)은 불변이라 cache로 1회 계산 후 재사용(범위 내 N일 재스캔 회피).

    ``bucket_ms``로 총잔량 지표와 동일한 버킷 대표 위에서 집계(틱 max 아님). 세션 경계
    (``session_open_ms``/``session_close_ms``, native HHMMSSmmm)로 동시호가 배제.

    ⚠ **이 함수는 `trades.parquet` 이 없는 스톡데이트 전용 폴백이다**(호출부:
    `build_ask_bid_peak_slices`). 캐시 키에 ``bucket_ms``가 포함되므로 그 경로에서는
    분봉 전환이 재계산이다 — **주 경로는 더 이상 그렇지 않다**. 오늘·과거일 모두 1분
    으로 한 번 스캔하고 굵은 봉은 rep 재집계로 파생한다(`_today_peak_slices` ·
    `_peak_slices_from_1m_cache`). 이 문장을 "peak 은 봉마다 재계산된다" 로 읽지 말 것."""
    cacheable = cache is not None and today_kst is not None and date != today_kst
    if cacheable and cache.has_ask_peak(code, date, source, bucket_ms, venue=venue):  # type: ignore[union-attr]
        return cache.get_ask_peak(code, date, source, bucket_ms, venue=venue)  # type: ignore[union-attr]
    peak = _compute_ask_peak(
        engine, code=code, date=date, source=source, venue=venue, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if cacheable:
        cache.store_ask_peak(code, date, source, bucket_ms, peak, venue=venue)  # type: ignore[union-attr]
    return peak


def _unix_or_none(date: str, intra_ms: int | None) -> int | None:
    return ms_from_midnight_to_unix_ms(date, intra_ms) if intra_ms is not None else None


def _ask_candidate(date: str, c: snapshots_tbl.AskPeakCandidateRow) -> AskPeakCandidate:
    """행 → wire 모델. **dict 를 돌려주지 않는다.**

    소비처가 둘인데 검증 여부가 갈리기 때문이다: `AskPeak(...)` 생성자로 가는 쪽은
    pydantic 이 dict 를 검증해 모델로 만들어 주지만, `model_copy(update=...)` 로 가는
    쪽(`_reduced_ask_peak`)은 **검증을 하지 않아** dict 가 그대로 남는다. 그러면
    필드 선언(`list[AskPeakCandidate]`)과 실제 값이 어긋난 채 직렬화되어
    `PydanticSerializationUnexpectedValue` 경고가 나고, 값은 우연히 같게 나가지만
    **검증을 건너뛴 채**다(2026-08-24 사용자 로그에서 발견).

    여기서 모델로 만들면 두 경로가 같아진다 — 생성자 쪽은 모델 인스턴스를 그대로
    받으므로 동작이 바뀌지 않는다.
    """
    return AskPeakCandidate(
        price=c.price,
        qty=c.qty,
        t_ms=ms_from_midnight_to_unix_ms(date, c.intra_ms),
    )


def _ask_peak_from_dual_row(date: str, row: snapshots_tbl.AskPeakDualRow) -> AskPeak:
    return AskPeak(
        date=date, price=row.price, qty=row.qty,
        t_ms=_unix_or_none(date, row.intra_ms),
        max_price=row.max_price, max_qty=row.max_qty,
        max_t_ms=_unix_or_none(date, row.max_intra_ms),
        traded_peaks=[_ask_candidate(date, c) for c in row.traded_peaks],
        traded_max_peaks=[_ask_candidate(date, c) for c in row.traded_max_peaks],
        traded_record_peaks=[_ask_candidate(date, c) for c in row.traded_record_peaks],
        traded_record_max_peaks=[_ask_candidate(date, c) for c in row.traded_record_max_peaks],
        traded_bar_peaks=[_ask_candidate(date, c) for c in row.traded_bar_peaks],
        traded_bar_max_peaks=[_ask_candidate(date, c) for c in row.traded_bar_max_peaks],
        all_peaks=[_ask_candidate(date, c) for c in row.all_peaks],
        all_max_peaks=[_ask_candidate(date, c) for c in row.all_max_peaks],
        all_price=row.all_price, all_qty=row.all_qty,
        all_t_ms=_unix_or_none(date, row.all_intra_ms),
        all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
        all_max_t_ms=_unix_or_none(date, row.all_max_intra_ms),
        unreached_price=row.unreached_price, unreached_qty=row.unreached_qty,
        unreached_t_ms=_unix_or_none(date, row.unreached_intra_ms),
        unreached_peaks=[_ask_candidate(date, c) for c in row.unreached_peaks],
    )


def _bid_peak_from_dual_row(date: str, row: snapshots_tbl.BidPeakDualRow) -> BidPeak:
    return BidPeak(
        date=date, price=row.price, qty=row.qty,
        t_ms=_unix_or_none(date, row.intra_ms),
        max_price=row.max_price, max_qty=row.max_qty,
        max_t_ms=_unix_or_none(date, row.max_intra_ms),
        traded_peaks=[_ask_candidate(date, c) for c in row.traded_peaks],
        traded_max_peaks=[_ask_candidate(date, c) for c in row.traded_max_peaks],
        traded_record_peaks=[_ask_candidate(date, c) for c in row.traded_record_peaks],
        traded_record_max_peaks=[_ask_candidate(date, c) for c in row.traded_record_max_peaks],
        traded_bar_peaks=[_ask_candidate(date, c) for c in row.traded_bar_peaks],
        traded_bar_max_peaks=[_ask_candidate(date, c) for c in row.traded_bar_max_peaks],
        all_peaks=[_ask_candidate(date, c) for c in row.all_peaks],
        all_max_peaks=[_ask_candidate(date, c) for c in row.all_max_peaks],
        all_price=row.all_price, all_qty=row.all_qty,
        all_t_ms=_unix_or_none(date, row.all_intra_ms),
        all_max_price=row.all_max_price, all_max_qty=row.all_max_qty,
        all_max_t_ms=_unix_or_none(date, row.all_max_intra_ms),
        unreached_price=row.unreached_price, unreached_qty=row.unreached_qty,
        unreached_t_ms=_unix_or_none(date, row.unreached_intra_ms),
        unreached_peaks=[_ask_candidate(date, c) for c in row.unreached_peaks],
    )


def _compute_ask_peak(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    # ⚠ **기본값을 주지 말 것**(#1133 과 같은 함정, 이번엔 백엔드에서). 이 세 `_compute_*`
    # 헬퍼는 전부 `engine.parquet_dir(..., venue=venue)` 로 디스크 경로를 정하는데,
    # `= "KRX"` 가 있으면 호출부가 venue 를 빠뜨려도 **조용히 KRX 를 읽는다**.
    # b64036f5(ADR-0140) 가 슬라이스 빌더 15곳에 venue 를 꿰면서 이 안쪽 호출 5곳을
    # 빠뜨렸고, 기본값이 그걸 타입 에러가 아니라 런타임 오독으로 바꿔 놨다 —
    # NXT/UN 차트에 KRX 벽·KRX 연속거래 상한이 나갔고, 오늘자처럼 KRX 캡처 디렉터리가
    # 아직 없는 시각(프리마켓 08:00–09:00)엔 StockDateNotFound 로 /api/range 가 통째로
    # 500 이었다. 필수 키워드로 두면 다음 누락은 컴파일 시점에 걸린다.
    venue: Venue,
    bucket_ms: int,
    session_open_ms: int | None,
    session_close_ms: int | None,
) -> AskPeak | None:
    try:
        path_obj = engine.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
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
    venue: Venue = "KRX",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = None,
    today_kst: str | None = None,
) -> BidPeak | None:
    cacheable = cache is not None and today_kst is not None and date != today_kst
    if cacheable and cache.has_bid_peak(code, date, source, bucket_ms, venue=venue):  # type: ignore[union-attr]
        return cache.get_bid_peak(code, date, source, bucket_ms, venue=venue)  # type: ignore[union-attr]
    peak = _compute_bid_peak(
        engine, code=code, date=date, source=source, venue=venue, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if cacheable:
        cache.store_bid_peak(code, date, source, bucket_ms, peak, venue=venue)  # type: ignore[union-attr]
    return peak


def _compute_bid_peak(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    venue: Venue,  # 필수 — 근거는 `_compute_ask_peak` 의 주석
    bucket_ms: int,
    session_open_ms: int | None,
    session_close_ms: int | None,
) -> BidPeak | None:
    try:
        path_obj = engine.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
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


_PeakT = TypeVar("_PeakT", AskPeak, BidPeak)


def _without_all_peak_rankings(peak: _PeakT) -> _PeakT:
    """(2026-08-25 이후) **더 이상 벗기지 않는다** — 그대로 통과시킨다.

    이 함수가 있던 이유는 배열 크기였다: `all_peaks`/`all_max_peaks` 가 하루당 수천
    후보(실측 avg ~1.3k/1.6k)라 sidecar 페이로드의 99%였고, 당시 range 소비처는 그
    필드를 읽지 않았다. 이제 **소스에서 top-3 로 캡**하므로(snapshots `_side_row`)
    배열이 최대 3개이고, 프론트의 「전체 최대벽 표시 개수」가 그 3개를 읽는다.

    이름과 호출부를 남겨 두는 이유: 벗기던 자리가 어디였는지가 곧 "여기서 크기가
    문제였다" 는 기록이고, 다시 커지면 되돌릴 자리도 여기다. 지금은 항등이다."""
    return peak


def _peak_for_range_payload(peak: _PeakT, *, bar_peaks: bool) -> _PeakT:
    """`/api/range` sidecar 로 나갈 peak — 옵트인 배열을 벗긴다.

    `traded_bar_*`(봉별 최대)는 하루당 최대 정규장 분 수만큼이라, 두 축 × 두 방향이면
    `all_peaks` 를 벗겨야 했던 그 규모가 된다(`_without_all_peak_rankings` 의 기록).
    같은 실수를 반복하지 않으려고 **처음부터 옵트인**이다 — 최대벽 pane 의 봉별 모드를
    켠 창만 `bar_peaks_enabled=true` 로 요청한다.

    ⚠ 벗기는 것은 **응답뿐이고 캐시는 전량 저장한다**. 캐시가 요청 파라미터에 따라
    달라지면 같은 (종목, 날짜, 봉) 항목이 켠 창·끈 창에 따라 갈린다.
    """
    peak = _without_all_peak_rankings(peak)
    if bar_peaks:
        return peak
    return peak.model_copy(update={"traded_bar_peaks": [], "traded_bar_max_peaks": []})


def _peak_with_rep_outputs(
    base: _PeakT, *, date: str, reduced: dict[str, Any] | None,
) -> _PeakT | None:
    """1분 peak(`base`) 위에 `reduced`(굵은 봉 rep 재집계)를 덮어쓴다.

    덮는 필드는 `snapshots.reaggregate_peak_rep` 이 만들어 주는 것 전부다. 나머지는
    base(1분) 값을 그대로 나른다 — 그 이유가 필드마다 **두 가지로 갈리므로** 아래를
    구분해서 읽을 것. 하나로 뭉뚱그린 옛 설명("손대지 않는 것 = 봉 무관")은 틀렸다.

    **(1) 진짜 봉 무관 — 어느 봉으로 계산해도 같은 값**
    `max_*` · `all_max_*` 스칼라, `traded_max_peaks`, `traded_record_max_peaks` 는
    cont(틱-max) 프레임 산물이고 cont 는 유효 스냅샷 **전체**를 보므로 봉과 무관하다.
    `unreached_*` 도 판정이 (price, 당일 체결 극값) 비교라 봉과 무관하다.
    `test_peak_max_fields_are_bucket_independent` 가 이 성질을 건다.

    **(2) 봉 의존이지만 1분 값을 정본으로 고정 — 재파생이 불가능하거나 부적절해서**
    `all_max_peaks` 는 이름과 달리 **봉 의존이다**: 생산자 `_peak_bucket_dedup` 이
    `subset=["price", "bucket_id"]` 로 접으므로 봉이 굵어지면 같은 가격의 여러 후보가
    하나로 합쳐져 top-3 구성이 달라진다(실측 2026-08-28, 실데이터 3일 중 2일 · 픽스처
    전 봉에서 재현). 그런데 재파생하려면 cont 행이 필요한데 **캐시에는 rep 행만 있다**
    (`store_peak_rep`) — 원리적으로 못 덮는다. 그래서 1분 값이 정본이다.
    `traded_record_peaks`(기록 갱신 시퀀스)도 rep 프레임 산물이라 봉 의존이지만, 1분
    시퀀스가 더 촘촘해 "그 시점까지의 최대" 로서 더 옳으므로 역시 1분이 정본이다.
    `traded_bar_*`(봉별 최대)는 **의도적으로** 1분 정본이다 — 소비처가 캔들 봉에
    접어서 쓰고(max 는 결합적이라 1분 → N분 파생이 정확하다), 여기서 미리 접으면
    같은 배열을 봉마다 다시 만들면서 정보만 잃는다.

    (2)의 정본 선언이 이 함수의 계약이다. **정본이 하나여야 하는 이유**: 굵은 봉
    요청은 캐시 유무에 따라 이 파생 경로 또는 직접-굵은봉 조회로 갈리는데, 정본이
    없으면 같은 (종목, 날짜, 봉)이 캐시 상태에 따라 다른 값을 낸다. `ask_peak`/
    `bid_peak` 캐시 버전 12 범프가 그 규약 이전에 쌓인 항목을 걷어낸다.

    `all_peaks` 는 (2)와 달리 rep 에서 만들 수 있으므로 `reduced` 가 봉에 맞게 다시
    만들어 준다(2026-08-25). 여기서 비우면 파생된 날만 rank-1 이고 직접 계산된 날은
    top-3 가 되어 per-day 불일치가 생긴다.
    """
    if reduced is None:
        return None
    close = reduced["all_close"]
    traded = reduced["traded_close"]
    return base.model_copy(update={
        "all_price": close[0], "all_qty": close[1],
        "all_t_ms": ms_from_midnight_to_unix_ms(date, close[2]),
        "price": traded[0] if traded else None,
        "qty": traded[1] if traded else None,
        "t_ms": ms_from_midnight_to_unix_ms(date, traded[2]) if traded else None,
        "traded_peaks": [_ask_candidate(date, c) for c in reduced["traded_peaks"]],
        "all_peaks": [_ask_candidate(date, c) for c in reduced["all_peaks"]],
    })


def _derive_coarse_from_rep(
    base_ask: AskPeak | None,
    base_bid: BidPeak | None,
    rep_rows: list[snapshots_tbl.PeakRepRow],
    *,
    date: str,
    bucket_ms: int,
) -> tuple[AskPeak | None, BidPeak | None]:
    """1분 base + 1분 rep 행 → 굵은 봉 출력. 과거일·오늘이 **같은 코드**를 쓴다.

    저장소만 다르다(과거일=디스크 `PastIndicatorsCache`, 오늘=프로세스 `TODAY_TTL`).
    파생 규칙 자체는 하나여야 두 지평의 값이 갈리지 않는다.
    """
    return (
        None if base_ask is None else _peak_with_rep_outputs(
            base_ask, date=date,
            reduced=snapshots_tbl.reaggregate_peak_rep(
                [r for r in rep_rows if r.side == "ask"], side="ask", bucket_ms=bucket_ms,
            ),
        ),
        None if base_bid is None else _peak_with_rep_outputs(
            base_bid, date=date,
            reduced=snapshots_tbl.reaggregate_peak_rep(
                [r for r in rep_rows if r.side == "bid"], side="bid", bucket_ms=bucket_ms,
            ),
        ),
    )


def _peak_slices_from_1m_cache(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str,
    venue: Venue,
    session_open_ms: int | None,
    session_close_ms: int | None,
    cache: PastIndicatorsCache | None,
    today_kst: str | None,
    path_obj: Path,
    trades_path: Path,
) -> tuple[AskPeak | None, BidPeak | None] | None:
    """굵은 봉 peak 을 **1분 캐시에서 파생**한다. 해당 없으면 None(호출부가 원경로).

    peak 은 sidecar 콜드 비용의 74%인데(실측 2026-08-19), 그 대부분이 봉과 무관한
    일을 봉마다 다시 하는 것이었다. 봉을 30배 줄여도(390→13 버킷) 시간이 30%만
    줄었다 — 비용이 버킷 수가 아니라 **원본 스캔**에 있다는 뜻이다.

    그래서 굵은 봉은 파케이를 아예 읽지 않는다: 봉 의존 절반은 1분 rep 행을 묶어
    만들고, 봉 무관 절반(`*_max*`)은 1분 peak 캐시 값을 그대로 쓴다. 후자가
    정말 봉과 무관하다는 것은 같은 날짜의 1분/5분 캐시 파일 대조로 확인했다.

    1분 산출이 없으면 여기서 **한 번만** 만든다(스캔 1회 — ADR-0085 는 이 경로의
    쿼리를 늘리지 말 것을 요구한다). 그 뒤로는 어떤 봉이든 스캔이 없다.
    """
    one = snapshots_tbl.ONE_MINUTE_MS
    if cache is None or today_kst is None or date == today_kst:
        return None
    if bucket_ms == one or bucket_ms % one != 0:
        return None
    cached_rep = cache.get_peak_rep(code, date, source, venue=venue)
    rep_rows: list[snapshots_tbl.PeakRepRow] | None = (
        None if cached_rep is CACHE_MISS else cast("list[snapshots_tbl.PeakRepRow]", cached_rep)
    )
    have_ask = cache.has_ask_peak(code, date, source, one, venue=venue)
    have_bid = cache.has_bid_peak(code, date, source, one, venue=venue)
    base_ask = cache.get_ask_peak(code, date, source, one, venue=venue) if have_ask else None
    base_bid = cache.get_bid_peak(code, date, source, one, venue=venue) if have_bid else None
    if rep_rows is None or not (have_ask and have_bid):
        ask_row, bid_row, rep_rows = SLICE_COALESCER.run(
            ("peak_dual_1m", code, date, source, venue, session_open_ms, session_close_ms),
            lambda: snapshots_tbl.query_day_ask_bid_peak_dual_with_rep(
                engine.conn,
                path=path_obj,
                trades_path=trades_path,
                bucket_ms=one,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
            ),
        )
        base_ask = _ask_peak_from_dual_row(date, ask_row) if ask_row is not None else None
        base_bid = _bid_peak_from_dual_row(date, bid_row) if bid_row is not None else None
        cache.store_ask_peak(code, date, source, one, base_ask, venue=venue)
        cache.store_bid_peak(code, date, source, one, base_bid, venue=venue)
        cache.store_peak_rep(code, date, source, rep_rows, venue=venue)
    return _derive_coarse_from_rep(
        base_ask, base_bid, rep_rows, date=date, bucket_ms=bucket_ms,
    )


def _today_peak_slices(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str,
    venue: Venue,
    session_open_ms: int | None,
    session_close_ms: int | None,
    path_obj: Path,
    trades_path: Path,
) -> tuple[AskPeak | None, BidPeak | None] | None:
    """오늘자 peak — **항상 1분으로 스캔**하고 굵은 봉은 rep 에서 파생한다.

    과거일(`_peak_slices_from_1m_cache`)과 같은 구조이고 **저장소만 다르다**:
    오늘 parquet 은 5분마다 통째로 overwrite 되므로 디스크에 박제할 수 없고
    (ADR-0043), 프로세스 short-TTL 메모(ADR-0090)가 그 자리를 대신한다.

    ## 무엇이 달라지나

    종전에는 **요청받은 봉으로 스캔하고 rep 행을 버렸다**. TTL 키에 `bucket_ms` 가
    있었으므로 1분→5분→15분 전환이 봉마다 풀 스캔이었다(사용자 설정 기준 0.66s ×
    전환 횟수, 2026-08-28 실측). 비용이 버킷 수가 아니라 원본 스캔에 있으므로
    (봉을 60배 굵혀도 0.33s 로 그대로) 그 재스캔은 전액 낭비였다.

    이제 스캔이 봉에 의존하지 않으므로 **TTL 키에서 `bucket_ms` 를 뺀다**. 봉 전환은
    같은 엔트리를 재사용해 파생만 다시 한다(~5ms).

    ## ⚠ 셋을 한 엔트리에 원자적으로 담는다

    `(ask_row, bid_row, rep_rows)` 를 별도 TTL 엔트리로 두면 만료가 어긋나
    **cont 절반은 A 세대 스캔, rep 절반은 B 세대 스캔**이 섞인다 — 오늘 parquet 이
    5분마다 갈리기 때문이다. 한 키·한 값이 그 레이스를 원천 차단한다.

    ## 1분 배수가 아닌 봉

    `reaggregate_peak_rep` 이 배수를 요구하므로 그때는 `None` 을 돌려주고 호출부가
    원경로(직접 계산)로 떨어진다. 프론트의 `TIMEFRAME_TO_MS` 는 전부 60,000 배수라
    실제로는 도달하지 않지만, API 는 임의 값을 받을 수 있다.
    """
    one = snapshots_tbl.ONE_MINUTE_MS
    if bucket_ms != one and bucket_ms % one != 0:
        return None

    # 키에 `bucket_ms` 가 **없다** — 스캔이 1분 고정이므로 봉은 키가 될 이유가 없고,
    # 있으면 봉 전환마다 미스가 난다(이 변경의 직접 동기). 세션 경계는 계산에
    # 들어가므로 그대로 둔다.
    key = ("peak_dual_today_1m", code, date, source, venue, session_open_ms, session_close_ms)
    hit, cached = TODAY_TTL.lookup(key)
    if hit:
        ask_row, bid_row, rep_rows = cached
    else:
        ask_row, bid_row, rep_rows = SLICE_COALESCER.run(
            key,
            lambda: snapshots_tbl.query_day_ask_bid_peak_dual_with_rep(
                engine.conn,
                path=path_obj,
                trades_path=trades_path,
                bucket_ms=one,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
            ),
        )
        TODAY_TTL.put(key, (ask_row, bid_row, rep_rows))

    base_ask = _ask_peak_from_dual_row(date, ask_row) if ask_row is not None else None
    base_bid = _bid_peak_from_dual_row(date, bid_row) if bid_row is not None else None
    if bucket_ms == one:
        return base_ask, base_bid
    return _derive_coarse_from_rep(
        base_ask, base_bid, rep_rows, date=date, bucket_ms=bucket_ms,
    )


def build_ask_bid_peak_slices(  # noqa: PLR0912 — ADR 이 지정한 단일 조립점 — 분기 분할이 설계에 반한다
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    venue: Venue = "KRX",
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
        and cache.has_ask_peak(code, date, source, bucket_ms, venue=venue)
    )
    bid_cached = (
        cache is not None
        and today_kst is not None
        and date != today_kst
        and cache.has_bid_peak(code, date, source, bucket_ms, venue=venue)
    )
    ask = cache.get_ask_peak(code, date, source, bucket_ms, venue=venue) if ask_cached and cache is not None else None
    bid = cache.get_bid_peak(code, date, source, bucket_ms, venue=venue) if bid_cached and cache is not None else None
    if ask_cached and bid_cached:
        return ask, bid

    try:
        path_obj = engine.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
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
                venue=venue,
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
                venue=venue,
                session_open_ms=session_open_ms,
                session_close_ms=session_close_ms,
                cache=cache,
                today_kst=today_kst,
            )
        return ask, bid

    # 굵은 봉은 1분 캐시에서 파생해 스캔을 건너뛴다(근거는 그 함수 docstring).
    # 해당 없으면(오늘·1분·비배수) None 이 와서 아래 원경로로 떨어진다.
    derived = _peak_slices_from_1m_cache(
        engine,
        code=code, date=date, bucket_ms=bucket_ms, source=source, venue=venue,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        cache=cache, today_kst=today_kst,
        path_obj=path_obj, trades_path=trades_path,
    )
    if derived is not None:
        return derived

    # 오늘자도 같은 구조로 파생한다 — 저장소만 TODAY_TTL 이다(근거는 그 함수
    # docstring). 오늘은 `ask_cached`/`bid_cached` 가 정의상 False 이므로 그대로
    # 돌려주면 된다. 1분 배수가 아닌 봉만 None 이 와서 아래 원경로로 떨어진다.
    if today_kst is not None and date == today_kst:
        today_derived = _today_peak_slices(
            engine,
            code=code, date=date, bucket_ms=bucket_ms, source=source, venue=venue,
            session_open_ms=session_open_ms, session_close_ms=session_close_ms,
            path_obj=path_obj, trades_path=trades_path,
        )
        if today_derived is not None:
            return today_derived

    # Concurrent identical dual-peak computes are collapsed by single-flight
    # (SLICE_COALESCER), same as every other per-day slice. The 2-slot
    # semaphore that used to cap DISTINCT-key concurrency here (ADR-0085,
    # added when this query was a ~17GB/155s non-equi join) was retired in
    # ADR-0085 v2: the columnar sweep measures ~1.1s / ~450MB transient per
    # heavy day and scales under concurrency (12-way: 7.1s wall vs 13.2s
    # sequential), so a cap would only serialize wide-range first-touch work.
    #
    # ADR-0090: today's result is additionally reused across SEQUENTIAL calls
    # (not just concurrent ones) for a short TTL, to collapse symbol-switch
    # polling bursts that the single-flight above cannot dedupe.
    is_today = today_kst is not None and date == today_kst
    ttl_key = ("peak_dual", code, date, source, venue, bucket_ms, session_open_ms, session_close_ms)
    hit, cached_rows = TODAY_TTL.lookup(ttl_key) if is_today else (False, None)
    if hit:
        ask_row, bid_row = cached_rows
    else:
        # 키는 TTL 키를 미러(kind 프리픽스 + 세션 경계): 경계가 다른 동시 호출이
        # flight를 공유하면 다른 결과를 받게 되므로 경계도 키에 포함한다.
        ask_row, bid_row, rep_rows = SLICE_COALESCER.run(
            ("peak_dual", code, date, source, venue, bucket_ms, session_open_ms, session_close_ms),
            lambda: snapshots_tbl.query_day_ask_bid_peak_dual_with_rep(
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
        # 1분으로 계산한 김에 rep 행도 저장한다 — 이게 없으면 **이 종목의 첫 굵은
        # 봉 요청이 같은 스캔을 한 번 더** 한다(실측 8.9s 뒤 9.3s). 1분 요청일
        # 때만 의미가 있다: 굵은 봉의 rep 는 1분 rep 의 부분집합이라 그 반대는
        # 성립하지 않는다.
        elif (
            cache is not None
            and today_kst is not None
            and date != today_kst
            and bucket_ms == snapshots_tbl.ONE_MINUTE_MS
        ):
            cache.store_peak_rep(code, date, source, rep_rows, venue=venue)
    if ask_row is not None and not ask_cached:
        ask = _ask_peak_from_dual_row(date, ask_row)
    if bid_row is not None and not bid_cached:
        bid = _bid_peak_from_dual_row(date, bid_row)
    if cache is not None and today_kst is not None and date != today_kst:
        if not ask_cached:
            cache.store_ask_peak(code, date, source, bucket_ms, ask, venue=venue)
        if not bid_cached:
            cache.store_bid_peak(code, date, source, bucket_ms, bid, venue=venue)
    return ask, bid


def build_trade_volume_poc_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    venue: Venue = "KRX",
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
    code_dir = engine.parquet_dir(date, code, source, venue=venue)
    trades_path = code_dir / "trades.parquet"
    if price_range is None or not trades_path.exists():
        return None
    price_min, price_max = price_range
    cacheable = cache is not None and today_kst is not None and date < today_kst
    if cacheable:
        cached = cache.get_trade_volume_poc(
            code, date, source, range_count, price_min, price_max, venue=venue,
        )
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    # 오늘자: short-TTL 프로세스 캐시(ADR-0090). None 결과도 유효 캐시값.
    is_today = today_kst is not None and date == today_kst
    poc_key = ("poc", code, date, source, venue, range_count, price_min, price_max)
    if is_today:
        hit, cached = TODAY_TTL.lookup(poc_key)
        if hit:
            return cached
    row = SLICE_COALESCER.run(
        poc_key,
        lambda: trades_tbl.query_trade_volume_poc(
            engine.conn,
            path=trades_path,
            price_lo=price_min,
            price_hi=price_max,
            bins=range_count,
            session_open_ms=session_open_ms,
            session_close_ms=session_close_ms,
            continuous_before_ms=continuous_before_ms,
        ),
    )
    if row is None:
        if cacheable:
            cache.store_trade_volume_poc(
                code, date, source, range_count, price_min, price_max, None, venue=venue,
            )
        elif is_today:
            TODAY_TTL.put(poc_key, None)
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
            code, date, source, range_count, price_min, price_max, poc, venue=venue,
        )
    elif is_today:
        TODAY_TTL.put(poc_key, poc)
    return poc


def build_depth_heatmap_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    venue: Venue = "KRX",
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
    아니라 (code, date, source, bucket_ms) 결과를 그대로 캐시한다.

    ⚠ **그 이유로 적혀 있던 근거는 이미 무효다(2026-08-29 확인).** 종전 설명은
    "대표 선택이 조건부 argmax라 1m 행에서 coarse 대표를 복원할 수 없다" 였는데,
    ADR-0062 v3 가 유효 스냅샷을 WHERE 로 사전 필터하면서 **대표는 그냥 버킷의
    마지막 행**(``rep_key = intra_ms``)이 됐다 — `query_bucketed_depth_heatmap`
    docstring 이 "종전 is_pre CASE + last-in-bucket 폴백 방출을 대체" 라고 적는다.
    즉 `rep` 는 ratio 의 last-in-window 와 동형이라 재집계가 가능하다.

    그런데도 안 하는 **현재의** 이유는 둘이고, 근거의 성격이 다르다:
    ① `rep_max`(총잔량 최대 스냅샷)를 파생하려면 정렬 키인 ``total`` 이 필요한데
       그 값이 `DepthHeatmapPoint` 에 없다 — `peak_rep` 같은 보조 kind 가 필요하다.
    ② peak 이 겪은 "정본" 문제(`_peak_with_rep_outputs` 참조)가 `arg_max` 동률에서
       재발할 수 있어 등가성 테스트 + `KIND_VERSIONS["depth"]` 범프가 전제다.

    착수 판단용 실측(2026-08-29, 005930 hogaplay 20일): 봉별 콜드 계산이 1분
    **3.39s** · 5분 1.51s · 15분 1.14s 다 — peak 과 달리 **비용이 버킷 수에
    비례**하므로 "1분에서 파생" 이 자동으로 이득은 아니다. 다만 워크스페이스 기본
    봉이 `1m` 이라(`frontend/src/state/liveDefaultLayout.ts`) 1분 계산은 대개 어차피
    발생하고, **1분 캐시가 있을 때만 파생**하는 기회주의적 형태면 손해 시나리오가
    사라진다. 봉 3종을 도는 사용자 기준 6.04s → 3.4s.

    오늘은 프로모션 진행 중이라 항상 재계산.

    ``session_open_ms``는 개장 동시호가 배제의 하한(ADR-0062 v3) — 쿼리의 공용 술어
    ``_book_indicator_eligible_sql``로 전달된다. 호가비·매도벽과 동일 규칙.
    """
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    try:
        path_obj = engine.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
    except (FileNotFoundError, StockDateNotFound):
        return []
    if not path_obj.exists():
        return []
    cacheable = _indicator_cacheable(cache, today_kst, date, bucket_ms)
    if cacheable:
        cached = cache.get_depth(code, date, source, bucket_ms, venue=venue)  # type: ignore[union-attr]
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    # ADR-0090: 오늘자는 디스크 캐시 금지(프로모션 중)라 형제 지표(ratio/fill/peak)처럼
    # short-TTL 프로세스 캐시로 순차 반복(관심종목 전환 버스트)을 흡수한다. 항목이
    # ~1.5MB로 크지만 TODAY_TTL은 오늘 항목만 보유하고 put마다 만료분을 청소하므로
    # 정상 뷰의 정상상태는 (code, bucket_ms)당 1건이다. 키=coalescer 키로 정합 보장.
    is_today = today_kst is not None and date == today_kst
    depth_key = ("depth", code, date, source, venue, bucket_ms)
    if is_today:
        hit, cached = TODAY_TTL.lookup(depth_key)
        if hit:
            return cached
    rows = SLICE_COALESCER.run(
        depth_key,
        lambda: snapshots_tbl.query_bucketed_depth_heatmap(
            engine.conn,
            path=path_obj,
            bucket_ms=bucket_ms,
            session_open_ms=session_open_ms,
            session_close_ms=session_close_ms,
        ),
    )
    out: list[DepthHeatmapPoint] = []
    for r in rows:
        t_ms = ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms)
        out.append(
            DepthHeatmapPoint(
                t_ms=t_ms,
                asks=[[p, q] for p, q in zip(r.ask_prices, r.ask_qtys, strict=True)],
                bids=[[p, q] for p, q in zip(r.bid_prices, r.bid_qtys, strict=True)],
                asks_max=[[p, q] for p, q in zip(r.ask_prices_max, r.ask_qtys_max, strict=True)],
                bids_max=[[p, q] for p, q in zip(r.bid_prices_max, r.bid_qtys_max, strict=True)],
                asks_price_max=[
                    [p, q] for p, q in zip(r.ask_prices_pmax, r.ask_qtys_pmax, strict=True)
                ],
                bids_price_max=[
                    [p, q] for p, q in zip(r.bid_prices_pmax, r.bid_qtys_pmax, strict=True)
                ],
            )
        )
    if cacheable:
        cache.store_depth(code, date, source, bucket_ms, out, venue=venue)  # type: ignore[union-attr]
    elif is_today:
        TODAY_TTL.put(depth_key, out)
    return out


def _first_trailing_single_price_book_hhmmssms(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    venue: Venue = "KRX",
    session_close_ms: int,
    cache: PastIndicatorsCache | None = _RESOLVE,  # type: ignore[assignment]
    today_kst: str | None = _RESOLVE,  # type: ignore[assignment]
) -> int | None:
    """연속거래 상한(continuous_before_ms) — 체결분포·POC 슬라이스의 선행 의존값.

    snapshots + trades **2-스캔**을 완료된 과거일마다 재실행하던 것을
    PastIndicatorsCache로 1회 계산 후 재사용한다. None(경계 없음)도 유효 캐시값.
    게이트는 bucket 무관이라 ``_indicator_cacheable``이 아니라 ``date < today_kst``
    직접 판정(POC의 date-only 게이트 관용구). 오늘은 프로모션 진행 중이라 재계산."""
    cache = _resolve_cache(engine, cache)
    today_kst = _resolve_today_kst(today_kst)
    cacheable = cache is not None and today_kst is not None and date < today_kst
    if cacheable:
        cached = cache.get_continuous_before(code, date, source, int(session_close_ms), venue=venue)  # type: ignore[union-attr]
        if cached is not CACHE_MISS:
            return cached  # type: ignore[return-value]
    # 오늘자: short-TTL 프로세스 캐시(ADR-0090). "경계 없음"(None)은 장중 흔한
    # 정상값이라 캐시하지만, snapshots.parquet 부재(시가 직후 미생성)로 인한 None은
    # 캐시하지 않는다 — TTL 창 안에 파일이 생기면 stale None이 새 데이터를 가린다
    # (test_today_fill_strength_none_result_is_not_cached 선례).
    is_today = today_kst is not None and date == today_kst
    if is_today:
        snapshots_path = engine.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
        is_today = snapshots_path.exists()
    cont_key = ("continuous", code, date, source, venue, int(session_close_ms))
    if is_today:
        hit, cached = TODAY_TTL.lookup(cont_key)
        if hit:
            return cached
    result = SLICE_COALESCER.run(
        cont_key,
        lambda: _compute_first_trailing_single_price_book_hhmmssms(
            engine, code=code, date=date, source=source, venue=venue,
            session_close_ms=session_close_ms,
        ),
    )
    if cacheable:
        cache.store_continuous_before(code, date, source, int(session_close_ms), result, venue=venue)  # type: ignore[union-attr]
    elif is_today:
        TODAY_TTL.put(cont_key, result)
    return result


def _compute_first_trailing_single_price_book_hhmmssms(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    venue: Venue,  # 필수 — 근거는 `_compute_ask_peak` 의 주석
    session_close_ms: int,
) -> int | None:
    code_dir = engine.parquet_dir(date, code, source, venue=venue)
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


def uncaptured_trading_days(
    *,
    data_dir: Path,
    code: str,
    from_date: str,
    to_date: str,
    captured: Collection[str],
    today: str,
) -> list[MissingDate]:
    """캡처가 **아예 없는** 거래일 + 사유. 오름차순.

    `captured` 는 `list_stock_dates_in_range` 의 결과 — 그 목록은 parquet 인벤토리
    스캔이라 "캡처된 날" 만 담는다. 그 차집합이 곧 이 함수의 대상이다.
    """
    from hoga.api import queries  # noqa: PLC0415 — 지연 import(순환 회피)

    out: list[MissingDate] = []
    for d in _dates_between(from_date, to_date):
        if d in captured or d >= today:
            continue
        # ⚠ **확정 거래일만** 본다 — 모름(None)은 결손이 아니다. 근거는 술어 쪽 docstring.
        #
        # ⚠ `queries` 를 **모듈로** 참조하는 것이 load-bearing 이다. `from ... import` 로
        # 이름을 끌어오면 `tools/range_measurement_policy.py` 의 몽키패치가 우회되어,
        # 측정 진입점이 외부 달력에 닿는다(그 hermetic 가드가 이 실수를 잡아냈다).
        if not queries._is_confirmed_trading_day(d):
            continue
        sentinel = (data_dir / "raw" / d / code / ".no_upstream_data").exists()
        out.append(MissingDate(
            date=d, reason="no_upstream_data" if sentinel else "not_captured",
        ))
    return out


def _dates_between(from_date: str, to_date: str) -> list[str]:
    """[from, to] 의 모든 YYYYMMDD (거래일 여부 무관)."""
    start = datetime.strptime(from_date, "%Y%m%d").date()
    end = datetime.strptime(to_date, "%Y%m%d").date()
    out: list[str] = []
    cur = start
    while cur <= end:
        out.append(cur.strftime("%Y%m%d"))
        cur += timedelta(days=1)
    return out


def _empty_range_bundle(
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
    *,
    excluded: list[ExcludedDate],
    missing: list[MissingDate] | None = None,
    earliest_captured: str | None = None,
) -> RangeBundle:
    """Empty RangeBundle for the no-captured-data and all-INVALID branches
    (spec 2026-05-27 §4.3). Mirrors the success-path shape with empty series
    arrays; excluded_dates carries any invariant-gated dates so frontend can
    surface DataWarning UX.

    ``missing`` 은 **이 분기에서 특히 중요하다** — 전 구간이 비는 응답이야말로
    프론트가 "왜" 를 물어야 하는 자리다(#1133). NXT·통합을 저장 시작 이전 날짜로
    조회하면 여기로 떨어진다."""
    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        # ⚠ **이 분기에서 특히 중요하다.** 캡처 시작 이전으로 조회하면 여기로 떨어지는데
        # (위 도크스트링), 그 응답이 곧 "바닥을 지났다" 를 프론트에 알릴 유일한 자리다.
        earliest_captured_date=earliest_captured,
        segments=[],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=[]),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=[]),
        volume_profile_range=_empty_volume_profile(),
        volume_profile_by_day=[],
        excluded_dates=excluded,
        data_warnings=[],
        missing_dates=missing or [],
        ask_peaks=[],
        bid_peaks=[],
        broker_late_entries=[],
        price_level_hits=[],
        depth_heatmap=[],
        volume_distributions=[],
        program_trade=ProgramTradeSeries(points=[]),
    )


def _bucket_program_trade_points(
    points: list[ProgramTradePoint], *, open_ms: int, bucket_ms: int
) -> list[ProgramTradePoint]:
    """한 거래일의 점들을 `bucket_ms` 격자로 접는다.

    **격자 원점이 epoch 가 아니라 세션 오픈(`open_ms`)이다.** 프론트 프로젝터가
    `meta.openMs + floor((t - openMs) / bucketMs) * bucketMs` 로 재버킷하기 때문이다
    (`chart/projectors/programTrade.ts`). 같은 원점을 쓰면 서버 출력이 프론트가 계산할
    값과 **동일**해져 차트가 비트 단위로 안 바뀐다. epoch 원점으로 접으면 버킷 경계가
    어긋나 "프론트 버킷의 마지막 점" 이 아닌 값이 남을 수 있다.

    필드별 집계 규칙 — **누적이냐 증분이냐로 갈린다**:
    - `net_qty`·`net_amount`: **마지막 값**. 당일 누적이라 합치면 안 된다. 프론트
      프로젝터의 `byBucket.set`(뒤가 이김)과 같은 규칙이다.
    - `delta_qty`·`delta_amount`: **non-null 합**. 구간 증분이라 합이 그 버킷의 증분이다.
      전부 null 이면 null 이다 — 거래일 첫 행은 delta 가 null 이므로(수집기가 새 거래일에
      `_last_net` 을 리셋한다) 0 으로 만들면 "증분 없음" 과 "모름" 이 뭉개진다.
      ⚠ 현재 프론트는 이 두 필드를 **아무도 안 읽는다**(차트는 net_amount, 카드는
      net_amount·net_qty). 그래도 계약 필드이므로 뜻이 맞게 접는다.
    - `gap_risk`: **any**. 보수적으로 — 버킷 안에 위험 표본이 하나라도 있으면 그 버킷이
      위험이다. 30초 표본 하나의 플래그가 버킷 전체를 물들이는 것은 **의도된 선택**이다
      (놓치는 쪽보다 과하게 알리는 쪽).
    """
    if bucket_ms <= 0:
        return points
    by_bucket: dict[int, list[ProgramTradePoint]] = {}
    for point in points:
        start = open_ms + (point.t - open_ms) // bucket_ms * bucket_ms
        by_bucket.setdefault(start, []).append(point)

    out: list[ProgramTradePoint] = []
    for start in sorted(by_bucket):
        group = by_bucket[start]
        last = group[-1]
        out.append(
            ProgramTradePoint(
                t=start,
                net_qty=last.net_qty,
                net_amount=last.net_amount,
                delta_qty=_sum_or_none(p.delta_qty for p in group),
                delta_amount=_sum_or_none(p.delta_amount for p in group),
                gap_risk=any(p.gap_risk for p in group),
            )
        )
    return out


def _sum_or_none(values: Iterable[int | None]) -> int | None:
    """non-null 만 더한다. 전부 null 이면 **None**(0 이 아니다 — 위 docstring 참고)."""
    total: int | None = None
    for value in values:
        if value is None:
            continue
        total = value if total is None else total + value
    return total


def build_program_trade_series(
    engine: QueryEngine,
    *,
    code: str,
    dates: list[str],
    venue: str,
    bucket_ms: int = 0,
    session_open_by_date: Mapping[str, int] | None = None,
    today_kst: str | None = None,
) -> ProgramTradeSeries:
    """선택 venue 의 프로그램 순매수 시계열.

    ## `bucket_ms` — 이 번들의 다른 시리즈와 같은 해상도로 접는다

    수집 주기가 30초라 하루 ~845점이다. 접지 않으면 3개월 창에서 **47,313점 ·
    6.11MB** 가 나가는데(2026-08-21 실측), 이 번들의 **다른 모든 시리즈는 이미
    `bucket_ms` 로 접혀 나간다** — 여기만 예외였다. 게다가 프론트 차트는 어차피
    같은 격자로 재버킷해 버킷당 1점만 쓴다(`programByBucket`). 즉 나머지는 그리지도
    않을 점을 실어 보낸 것이다.

    `0`(기본)이면 접지 않는다 — 인자를 안 넘긴 기존 호출자의 동작이 그대로다.

    ## 오늘분은 **접지 않는다**

    오늘분은 프론트에서 WS 실시간 꼬리와 이어 붙는데, 그 이음매가
    `max(persisted.t)` 다(`programTradeLiveTail.ts`). 오늘분을 접으면 이음매가
    마지막 **버킷 시작**(예: 15:00)으로 당겨져, 그 뒤 원해상도 라이브 점들이 이미
    버킷이 덮은 구간에 겹쳐 들어온다. 캔들이 같은 이유로 "오늘분은 언제나 1분" 을
    못박은 것과 같은 함정이다(ADR-0125).

    비용은 무시할 만하다 — 3개월 56거래일 중 하루뿐이다.

    `venue` 는 **필수**다 — 기본값을 두면 호출부가 빠뜨렸을 때 조용히 KRX 답을 주고,
    NXT·통합 화면은 15:30 에 멎은 시계열을 자기 시장 것으로 믿는다. 그 침묵이 정확히
    이 축이 없던 시절의 증상이었다.

    `venue` 는 **필수**다 — 기본값을 두면 호출부가 빠뜨렸을 때 조용히 KRX 답을 주고,
    NXT·통합 화면은 15:30 에 멎은 시계열을 자기 시장 것으로 믿는다. 그 침묵이 정확히
    이 축이 없던 시절의 증상이었다.

    venue 축 이전 파일은 store 가 KRX 에 한해 폴백해 읽는다(`read_path`).
    """
    data_dir = getattr(engine, "data_dir", None)
    if not isinstance(data_dir, Path):
        return ProgramTradeSeries(points=[])
    store = ProgramTradeStore(data_dir)
    opens = session_open_by_date or {}
    points: list[ProgramTradePoint] = []
    for date in dates:
        day_points: list[ProgramTradePoint] = []
        # 읽기 전용 — mtime 캐시로 과거일 JSON 재파싱 제거(today 는 mtime 변경 시 재로드).
        day = store.load_cached(code, date, venue)
        # 임계 재검증 — 0w drain 초기(PR-F4 직후)에 매 드레인마다 쌓인 30초 간격
        # 오염 이벤트가 gap_risk 오탐을 만들지 않도록 저장분도 같은 술어로 거른다.
        gap_times = {
            str(ev.get("new_oldest"))
            for ev in day.gap_events
            if is_significant_gap_event(ev, poll_interval_ms=day.poll_interval_ms)
        }
        for row in day.rows:
            day_points.append(
                ProgramTradePoint(
                    t=row.t_ms,
                    net_qty=row.net_qty,
                    net_amount=row.net_amount,
                    delta_qty=row.delta_qty,
                    delta_amount=row.delta_amount,
                    gap_risk=row.bsop_hour in gap_times,
                )
            )
        open_ms = opens.get(date)
        # 접는 조건 세 가지가 **모두** 참일 때만 접는다. 세션 오픈을 모르면 격자 원점이
        # 없어 프론트와 어긋나므로 원해상도로 둔다 — 추측해서 접지 않는다.
        if bucket_ms > 0 and open_ms is not None and (today_kst is None or date < today_kst):
            day_points = _bucket_program_trade_points(
                day_points, open_ms=open_ms, bucket_ms=bucket_ms,
            )
        points.extend(day_points)
    points.sort(key=lambda p: p.t)
    return ProgramTradeSeries(points=points)


def _segment_gap_ms(date: str, meta: dict) -> int | None:
    """세그먼트의 정규장 결손 총량(ms). **판독 불가면 `None`(= 정보 없음)**.

    `0`(결손 없음)과 `None` 을 가르는 것이 계약이다 — 합치면 정보가 없는 상태가
    "완전함" 으로 둔갑해 배지가 조용해진다.

    ⚠ `gap_ranges` 의 값은 **HHMMSSmmm packed-decimal**(ADR-0010/0049)이라 그대로
    빼면 안 된다. `111030017 - 90000000` 은 시간 차이가 아니다(2.7배 부풀려진다).
    두 끝을 각각 Unix ms 로 디코딩한 뒤 뺀다.

    ⚠ 여기서 잡는 것은 **모양이 깨진 경우**(키 누락·숫자 아님)뿐이다. `hhmmssms_to_unix_ms`
    는 시각 범위를 검증하지 않아 `99:99:99.999` 도 통과한다 — 즉 `None` 은 "값이
    이상하다" 가 아니라 "판독 불가" 를 뜻한다. writer 가 인코딩을 보장하므로(ADR-0049)
    실무상 차이는 없다.
    """
    gaps = meta.get("gap_ranges")
    if gaps is None:
        return None
    total = 0
    for g in gaps:
        try:
            start = hhmmssms_to_unix_ms(date, int(g["start_ms"]))
            end = hhmmssms_to_unix_ms(date, int(g["end_ms"]))
        except (KeyError, TypeError, ValueError):
            # 한 구간이라도 못 읽으면 총량이 과소집계된다 — 조용히 작은 수를 주느니
            # "모른다" 가 정직하다.
            return None
        if end > start:
            total += end - start
    return total


# `build_range_bundle` 일자 루프의 GIL 양보 주기·길이.
#
# **왜 필요한가.** 이 함수는 라우트에서 `to_thread` **1개**로 통째로 돈다
# (routes.py — 취소 불가·permit 회수 문제로 구조가 그렇다). 본문은 96.7% 순수
# 파이썬이라(2026-08-16 프로파일) 워커 스레드가 GIL 을 사실상 독점하고, CPython
# 의 GIL convoy(강제 드롭 직후 CPU 스레드가 즉시 재획득) 때문에 이벤트 루프는
# switch interval(5ms)로도 못 비집고 들어온다. 실측(2026-08-21): 3개월 sidecar
# 요청 1발 = `/health` **9,757ms** 지연 — 앱 전체가 그만큼 멎는다(#998 단일 루프).
#
# **왜 시간 기반 sleep 인가.** `time.sleep(0.001)` 은 GIL 을 완전히 놓고 1ms 를
# 보장한다 — 루프가 epoll + 콜백 여러 개를 소화하기에 충분하다(sleep(0) 은 convoy
# 로 루프가 GIL 을 못 받을 수 있다). 50ms 마다 1ms 면 오버헤드 +2% 로, 무양보
# 구간이 「빌더 1개」 수준으로 상한된다 — 호출 지점이 일자 루프 상단 + 각 빌더
# 블록 앞(총 9곳/일자)이다. 과거 캐시일은 빌더당 수 ms 라 인터벌 게이트에 걸려
# 사실상 무비용이고, **오늘 재계산**(과거 36ms vs 오늘 1,379ms — 그중 peaks
# 577ms, 2026-08-21 실측)에서만 양보가 실제로 발화해 1.4s 무양보 블록이 최대
# 단일 빌더(~600ms)로 줄어든다. WS 틱 경로의 같은 처방이
# `kiwoom_ws_client._maybe_yield`(#1444)다 — 그쪽은 루프 위라 `asyncio.sleep(0)`,
# 여기는 워커 스레드라 `time.sleep(1ms)` 로 형태만 다르다.
_GIL_BREATHE_INTERVAL_S = 0.05
_GIL_BREATHE_SLEEP_S = 0.001


def _gil_breathe(last_yield_at: float) -> float:
    """`_GIL_BREATHE_INTERVAL_S` 가 지났으면 GIL 을 1ms 놓는다. 새 기준 시각을 돌려준다.

    반환값 재대입 형태인 이유: 이 함수는 워커 스레드의 동기 루프에서 불리므로
    인스턴스 상태를 둘 자리가 없고, 지역 변수 하나가 가장 싸다.
    """
    now = time.monotonic()
    if now - last_yield_at < _GIL_BREATHE_INTERVAL_S:
        return last_yield_at
    time.sleep(_GIL_BREATHE_SLEEP_S)
    return time.monotonic()


# 일자 루프 **앞**에서 과거일 peak 캐시를 채우는 유계 병렬 prefetch.
#
# ## 왜 peak 만 병렬인가 — 두 실측은 분모가 다르다
#
#   * **peak 계산 단독**: 12 동시가 13.2s → 7.1s(`slice_coalescer` 주석), 12일
#     4-way 가 4.58s → 2.14s(2026-08-28 실측). polars/DuckDB 라 GIL 을 놓는다.
#   * **일자 루프 전체**: 6스레드에서 wall **7.1배 팽창**(routes.py 상단 실측).
#     본문이 96.7% 순수 파이썬이고, 팽창의 절반은 GIL 이 아니라 **GC**
#     stop-the-world 다.
#
# 둘 다 옳다. 그래서 병렬은 peak 에만 걸고 **루프는 순차로 남긴다** — 그 결과
# `_gil_breathe` 처방(#998)·누적 리스트 13개의 순서·`excluded`/`warnings_list` 의
# 미정렬 계약·per-date perf 로그 델타가 **전부 무변경**이다. routes.py 가 미착수로
# 적어 둔 방향(ADR-0085 v3.2, 모드 기반 분리)과 같은 쪽이다.
#
# ## 왜 ThreadPoolExecutor 인가
#
# 리포의 기존 유계 패턴은 전부 `anyio.CapacityLimiter` / `asyncio.Semaphore` 인데,
# 여기는 `to_thread` **안쪽의 동기 컨텍스트**라 async 프리미티브를 쓸 수 없다.
# anyio 기본 풀(40토큰 공용)에 중첩하는 것은 routes.py 가 경고하는 **동기 라우트
# 기아**를 정면으로 밟는다(`/api/live/status` 폴링 등이 같은 풀을 쓴다). 전용
# 풀을 요청 수명만큼만 열고 닫는다.
#
# ⚠ **레인 상한과 곱해진다.** routes.py 의 sweep 표는 요청당 컴퓨트 스레드 1개를
# 전제로 측정됐으므로, 실효 스레드는 `상한 × 여기 워커 수`가 된다. 기본값을 3 으로
# 낮게 둔 이유이고, 이 값을 올리려면 그 sweep 을 다시 돌려야 한다.
#
# ## 그 재측정을 돌렸다 (2026-08-29) — 상한은 그대로, 그러나 **이득은 부하에 달렸다**
#
# 혼합 부하(콜드 sidecar 20일 4종목 + hoga 하루 12개 = 16 동시), 교대 대조 2라운드
# median. 매 실행 전 지표 캐시를 지워 콜드를 재현했다:
#
#     변형                  wall   heavy중앙  light중앙  전체평균
#     lane1 / prefetch3    15.88s    15.60s     2.40s     5.17s
#     lane2 / prefetch3    15.91s    15.62s     2.47s     5.24s   ← 현행
#     lane4 / prefetch3    16.13s    15.59s     2.50s     5.34s
#     lane2 / prefetch1    18.49s    17.65s     2.02s     5.33s   ← prefetch 대조군
#
# **레인 상한은 바꿀 근거가 없다**: 1/2/4 의 차이가 wall 1.6% · heavy 0.2% 로, 라운드
# 간 드리프트(0.6~1.4s)보다 작다. 현행 2를 유지한다.
#
# **prefetch 는 고부하에서 재분배에 가깝다**: heavy 를 11.5% 줄이는 대신 light 를 22%
# 늦추고 전체 평균은 5.33 → 5.24 로 거의 같다. 단독 요청에서 잰 1.39~1.40배와 다른
# 그림이고, 이유는 자명하다 — 동시 요청이 이미 CPU 를 채우면 요청 **내부** 병렬이
# 가져올 여유가 없다. routes.py v3 이 "상한은 이득이 아니라 재분배였다" 고 판정한 것과
# 같은 모양이다.
#
# 그래도 3 을 유지하는 근거: ① 순 합계는 여전히 heavy 쪽으로 기운다(heavy 4개 × -2.0s
# 대 light 12개 × +0.46s), ② 위 부하는 **콜드 4종목 동시**라 실사용보다 극단적이다
# (`/live` 는 한 종목을 연다), ③ 단독·저부하에서는 이득이 명확하다(1.4배).
# **이 값을 올리는 것은 위 표가 지지하지 않는다** — light 열이 더 나빠질 뿐이다.
_PEAK_PREFETCH_WORKERS_ENV = "HOGA_RANGE_PEAK_PREFETCH_WORKERS"
_DEFAULT_PEAK_PREFETCH_WORKERS = 3
#: 콜드 날짜가 이 수 미만이면 건너뛴다 — 풀을 띄우는 비용이 이득을 넘는다.
_MIN_PREFETCH_TARGETS = 2


def _peak_prefetch_workers() -> int:
    raw = os.environ.get(_PEAK_PREFETCH_WORKERS_ENV)
    if raw is None:
        return _DEFAULT_PEAK_PREFETCH_WORKERS
    try:
        return max(1, int(raw))
    except ValueError:
        return _DEFAULT_PEAK_PREFETCH_WORKERS


def _prefetch_peak_caches(
    engine: QueryEngine,
    *,
    code: str,
    dates: Iterable[str],
    source_pref: str,
    venue: Venue,
    bucket_ms: int,
    cache: PastIndicatorsCache | None,
    today_kst: str | None,
) -> int:
    """일자 루프 전에 과거일 peak 캐시를 채운다. 실제로 계산한 날짜 수를 돌려준다.

    루프 본문은 **한 줄도 바뀌지 않는다** — 도달했을 때 이미 캐시 히트이기 때문이다.
    호출도 `build_ask_bid_peak_slices` 를 요청 파라미터 그대로 쓰므로 기존
    `SLICE_COALESCER` 키를 그대로 타고(굵은 봉이면 `peak_dual_1m`, 1분이면
    `peak_dual`), 동시 요청과 자연히 합쳐진다. 키를 새로 만들면 같은 스캔이 두 번
    돈다.

    콜드 판정에 **1분 캐시**를 쓰는 것이 요점이다 — 그것이 있으면 어떤 봉이든
    파생으로 ~5ms 라 prefetch 할 이유가 없다(실측 2026-08-28: 콜드 304ms ↔ 파생
    3.3ms).

    오늘자는 대상이 아니다(ADR-0043 — 디스크 캐시가 없다). 소스·세션 경계는 루프와
    **같은 함수**로 정한다; 갈라지면 여기서 만든 캐시를 루프가 다른 키로 찾아
    **낭비가 되지만 값이 틀리지는 않는다**(실패 모드가 성능이지 정합성이 아니다).
    """
    if cache is None or today_kst is None:
        return 0
    one = snapshots_tbl.ONE_MINUTE_MS
    targets: list[tuple[str, str, int | None, int | None]] = []
    for d in dates:
        if d >= today_kst:
            continue
        try:
            resolution = resolve_source_result(engine, d, code, source_pref, venue)
        except (FileNotFoundError, StockDateNotFound):
            continue
        if resolution.path is None:
            continue
        source = resolution.source
        if (
            cache.has_ask_peak(code, d, source, one, venue=venue)
            and cache.has_bid_peak(code, d, source, one, venue=venue)
        ):
            continue
        try:
            meta = json.loads((resolution.path / "meta.json").read_text(encoding="utf-8"))
            norm_meta, _ = normalize_session_bounds(meta)
            open_ms, close_ms = indicator_session_bounds(norm_meta)
        except (FileNotFoundError, ValueError, OSError, KeyError):
            # 메타를 못 읽거나 경계 키가 없는 날 — 루프가 같은 판정을 다시 하고
            # excluded/missing 으로 표면화한다. prefetch 는 조용히 빠진다.
            continue
        targets.append((d, source, open_ms, close_ms))

    if len(targets) < _MIN_PREFETCH_TARGETS:
        return 0

    def _one(target: tuple[str, str, int | None, int | None]) -> None:
        d, source, open_ms, close_ms = target
        try:
            build_ask_bid_peak_slices(
                engine, code=code, date=d, bucket_ms=bucket_ms,
                source=source, venue=venue,
                session_open_ms=open_ms, session_close_ms=close_ms,
                cache=cache, today_kst=today_kst,
            )
        except Exception:
            # prefetch 실패는 **사용자에게 보이지 않는다** — 루프가 같은 날짜를 정상
            # 경로로 계산한다. 여기서 올리면 캐시 워밍이 요청을 죽인다. 그래도
            # warning 인 이유: 반복되면 병렬 이득이 통째로 사라지는데 증상이 "조금
            # 느리다" 뿐이라, 로그가 유일한 단서다.
            log.exception(
                "peak prefetch failed for %s/%s; the day loop will recompute", code, d,
            )

    workers = min(_peak_prefetch_workers(), len(targets))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="peak-prefetch") as ex:
        list(ex.map(_one, targets))
    return len(targets)


def build_range_bundle(  # noqa: PLR0912, PLR0915
    engine: QueryEngine,
    *,
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
    source_pref: str = "hogaplay",  # ADR-0039
    # 이 번들이 매물대·최대벽·프로그램·depth 히트맵·잔량 증감·거래원 늦은 진입의
    # 과거 시계열을 한꺼번에 실어 나른다. **필수는 HTTP 라우트 쪽**이다(`/api/range`
    # 의 `Query(...)`) — 프론트가 빠뜨리면 실시간 꼬리와 다른 시장이 한 차트에 섞인다.
    # 여기는 우리 코드만 부르므로 기본값을 둔다(경계 설명은 sources.resolve_source_result).
    venue: str = "KRX",
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
    bar_peaks_enabled: bool = False,
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
    # ⚠ `not cutoff_sidecar` 가 **load-bearing** 이다. cutoff sidecar 는 매물대 커서
    # 스크럽이 부르는 요청이고 소비처가 `volume_distributions` **하나뿐**인데
    # (`useVolumeDistributionCutoffProfile.ts`), 이 가드가 없으면 커서를 한 칸 옮길
    # 때마다 프로그램매매 계열을 통째로 다시 만들어 실어 보낸다. 오늘분은 봉으로 접지도
    # 않아서(아래 `build_program_trade_series`) 원해상도 ~845점이 매번 나간다.
    # 형제 슬라이스들은 `include_optional_sidecar_slices` 로, `broker_late_entries` 는
    # 자기 자리에서 같은 가드를 이미 걸고 있었다 — 여기만 빠져 있었다.
    include_program_trade = program_trade_enabled and sidecar_only and not cutoff_sidecar

    dates = engine.list_stock_dates_in_range(
        code=code, from_date=from_date, to_date=to_date,
        source_pref=source_pref,
    )
    # 캡처가 **아예 없는** 거래일 + 사유. `dates` 는 parquet 인벤토리 스캔이라 이들을
    # 담지 않으므로, 사유 기록을 아래 루프 안에서만 하면 이 부류는 영영 표면화되지
    # 않는다 — 화면에서 그날이 사유 없이 증발하던 원인이다(006800/20251218).
    # 한 번만 읽어 아래 루프의 만료 스텁 판정과 **같은 시각**을 쓰게 한다. 갈라지면
    # 자정 경계에서 "오늘이라 제외" 와 "보유 창 밖이라 스텁" 이 어긋난다.
    now_dt = now_kst()
    uncaptured = uncaptured_trading_days(
        data_dir=engine.data_dir,
        code=code,
        from_date=from_date,
        to_date=to_date,
        captured=set(dates),
        today=now_dt.strftime("%Y%m%d"),
    )
    if not dates:
        # Spec 2026-05-27 §4.3: empty range is a normal case for /live's
        # lazy-fetch. Surface as an empty bundle so the frontend can stitch
        # today's SSE buffer in without 404 round-trips.
        #
        # ⚠ `missing` 을 여기서 **반드시** 넘긴다. "그날 하나만 조회" 가 정확히 이
        # 분기로 떨어지는데, 그게 사용자가 원인을 가장 알고 싶어 하는 요청이다.
        return _empty_range_bundle(
            code, from_date, to_date, bucket_ms, excluded=[], missing=uncaptured,
        )

    # ADR-0020: per-Stock-Date invariant check.
    # INVALID → skip + surface under excluded_dates.
    # warn-only → include + surface under data_warnings.
    excluded: list[ExcludedDate] = []
    warnings_list: list[DateWarning] = []
    # 읽을 것이 없어 건너뛴 날 + 사유(#1133). `excluded` 와 나눠 두는 이유는 모델 주석 참조 —
    # "데이터가 틀렸다" 와 "데이터가 없다" 를 UI 가 다르게 말해야 한다.
    # 미캡처 거래일을 **시드로 깔고** 시작한다 — 루프가 채우는 것("목록엔 있는데 읽을 수
    # 없다")과 서로소라 그냥 합치면 된다. 이렇게 두면 아래 두 반환 지점이 자동으로 커버된다.
    missing: list[MissingDate] = list(uncaptured)
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

    # 콜드 범위의 peak 을 루프 **앞에서** 유계 병렬로 채운다. 루프는 순차 그대로이고
    # (근거는 `_prefetch_peak_caches` 위 주석) 도달했을 때 캐시 히트라 본문 무변경이다.
    # 전부 warm 이면 즉시 0 을 돌려주므로 웜 경로에 비용이 없다.
    if include_ask_peaks or include_bid_peaks:
        _prefetch_peak_caches(
            engine,
            code=code, dates=dates, source_pref=source_pref, venue=venue,
            bucket_ms=bucket_ms,
            # `_RESOLVE` 로 자가-해석시켜 빌더와 **같은** 캐시/오늘 판정을 쓴다.
            # 이 호출이 `engine.indicators_cache` 의 락 없는 lazy init 을 루프 전에
            # 한 번 touch 하는 역할도 겸한다(queries.py — 병렬 첫 접근이 인스턴스를
            # 두 개 만들 수 있다).
            cache=_resolve_cache(engine, _RESOLVE),
            today_kst=_resolve_today_kst(_RESOLVE),
        )

    gil_breathe_at = time.monotonic()
    for d in dates:
        # 일자 경계마다 검사 — 한 일자(~110ms, 2026-08-21 프로파일: heatmap 47ms
        # + peaks 29ms + delta 19ms + broker 13ms)가 무양보 상한이 된다.
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        date_t0 = perf_debug.now()
        date_candles_before = len(candles)
        date_ratio_before = len(ratio_pts)
        date_fill_before = len(fill_pts)
        date_excluded_before = len(excluded)
        date_warnings_before = len(warnings_list)
        # ⚠ `venue` 를 넘기는 것이 **load-bearing** 이다(#1133). 안 넘기면 사다리가
        # 기본 "KRX" 로 승자를 뽑아, `source_covers_venue` 가 걸러 냈어야 할
        # KRX 전용 소스(hogaplay)가 NXT·통합 요청을 이긴다 — 그러면 빈 응답도
        # `venue_unsupported` 도 아니고 **다른 시장 데이터가 그 시장 것처럼** 나간다.
        resolution = resolve_source_result(engine, d, code, source_pref, venue)
        source = resolution.source
        # `orderflow_ok` 게이트는 폐지됐다(2026-08-07) — 호가·체결을 서빙하지 않는
        # 유일한 소스가 `kis_api` 였고 그 소스가 사라졌다. 남은 둘은 둘 다 서빙한다.
        if resolution.path is not None:
            try:
                meta = json.loads((resolution.path / "meta.json").read_text(encoding="utf-8"))
            except (FileNotFoundError, ValueError, OSError):
                # ⚠ `path is not None` 이 "경로가 존재한다" 는 뜻이 **아니다**(#1133).
                # 사다리는 승자 source 를 정하고 `source_venue_dir` 로 경로를 **조립**할
                # 뿐이라, venue 디렉터리가 없어도 not-None 인 경로가 나온다 — NXT 를
                # 저장 시작 이전 날짜로 조회하는 통상 케이스가 정확히 이 모양이다.
                # 그래서 사유를 디렉터리 존재로 가른다: 없으면 결손, 있으면 손상.
                missing.append(MissingDate(
                    date=d,
                    reason="source_missing" if not resolution.path.exists() else "meta_unreadable",
                ))
                if perf_debug.enabled():
                    log.warning(
                        "hoga_perf range_date status=skip_meta code=%s date=%s source=%s mode=%s "
                        "duration_ms=%.1f",
                        code, d, source, mode, perf_debug.elapsed_ms(date_t0),
                    )
                continue
        else:
            try:
                meta = engine.get_meta(d, code, source, venue=venue)
            except (FileNotFoundError, StockDateNotFound):
                # NXT·통합을 저장 시작 이전 날짜로 조회하면 **여기로 온다** — 사다리가
                # 이미 사유를 판정해 뒀으므로 그대로 싣는다. 이 한 줄이 없으면 프론트는
                # 빈 배열만 받아 "장애" 와 "이 시장엔 원래 없음" 을 가를 수 없다.
                missing.append(MissingDate(
                    date=d, reason=resolution.missing_reason or "source_missing",
                ))
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
            # **만료 스텁은 `missing_dates` 에도 싣는다**(2026-08-24). 두 배열은 원래
            # 서로소지만("틀렸다" vs "없다") 이 클래스만은 **둘 다 사실**이다: 파일은
            # 있는데(→ excluded) 쓸 수 있는 데이터는 없다(→ missing). 한쪽만 쓰면
            # 그 거래일은 어느 복구 경로에도 닿지 못한다 —
            # `is_expired_upstream_stub` 의 docstring 이 그 경위를 적는다.
            #
            # 사유는 기존 값을 재사용한다. 사용자에게 뜻이 같고("업스트림이 못 준다,
            # 영구"), 새 값을 만들면 ADR-0004 2층이라 프론트 union·라벨 표까지 같은
            # PR 에서 미러해야 한다(#1183 이 그 미러가 갈렸을 때의 사고다).
            #
            # ⚠ 여기서는 `uncaptured_trading_days` 와 달리 **거래일 확정을 요구하지
            # 않는다.** 저쪽은 캡처 흔적이 **전혀 없는** 날을 다루므로 필터가 없으면
            # 주말·공휴일이 전부 구멍이 된다. 이쪽은 스텁 파일의 존재가 곧 "그날 캡처를
            # 시도했다" 는 증거라 그 오인이 생기지 않는다. 그리고 필터를 걸면 거래일
            # 시드 커버리지 밖(=`None`, 모름)이 통째로 빠지는데, 그 구간이야말로 최근
            # 날짜라 스텁이 새로 생기는 자리다. 비대칭 비용도 같은 방향이다 — 오탐은
            # 키움 콜 1건에 빈 응답이고, 미탐은 380일 뒤 영구 소실이다.
            if is_expired_upstream_stub(c, d, now_dt):
                missing.append(MissingDate(date=d, reason="no_upstream_data"))
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

        # 캔들 승자는 호가 승자와 독립이다(소스별 보유 차원이 다름 — ADR-0040).
        # 실시간 승격본이 호가로 이겨도 캔들은 hogaplay 에서 올 수 있다.
        # 이 분리가 없으면 캔들 미보유 승자가 같은
        # Stock-Date의 실제 캔들을 통째로 가린다.
        candle_source = resolve_candle_source(engine, d, code, source_pref, venue)
        needs_trade_price_range = volume_distribution_bins is not None or include_trade_volume_pocs
        needs_raw_candles = not hoga_only and (not sidecar_only or needs_trade_price_range)
        raw_candles = (
            build_candles_slice(engine, code=code, date=d, source=candle_source, venue=venue)
            if needs_raw_candles and candle_source is not None
            else []
        )
        if hoga_only:
            price_range = None
            trade_indicator_source = source
            candles_d = []
        elif candles_only:
            price_range = None
            trade_indicator_source = source
            candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms, date=d)
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
                    venue=venue,
                )
                if needs_trade_price_range
                else source
            )
            candles_d = [] if sidecar_only else downsample_candles(raw_candles, bucket_ms=bucket_ms, date=d)
        norm_meta, _ = normalize_session_bounds(meta)   # value-conversion only (notes handled by classify)
        # 지표 슬라이스가 쓰는 경계는 **정규장이 아니라 venue 별 지표 구간**이다
        # (ADR-0140). NXT·UN 은 08:00–20:00 이고, 이걸 정규장(09:00–15:30)으로
        # 읽던 것이 "포인트는 전 구간 오는데 값만 0" 결함이었다. 구형 meta·hogaplay
        # 는 새 키가 없어 정규장 값으로 떨어지므로 KRX 경로는 무변경이다.
        ind_open_ms, ind_close_ms = indicator_session_bounds(norm_meta)
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        qr_d = (
            QuoteRatio(bucket_ms=bucket_ms, points=[])
            if sidecar_only or candles_only
            else build_quote_ratio_slice(
                engine, code=code, date=d, bucket_ms=bucket_ms, source=source, venue=venue,
                session_open_ms=ind_open_ms,
                session_close_ms=ind_close_ms,
            )
        )
        fs_d = (
            FillStrength(bucket_ms=bucket_ms, points=[])
            if sidecar_only or candles_only
            else build_fill_strength_slice(
                engine, code=code, date=d, bucket_ms=bucket_ms, source=source, venue=venue,
            )
        )
        continuous_before_needed = (
            needs_trade_price_range and not hoga_only and not candles_only
        )
        continuous_before_ms = (
            _first_trailing_single_price_book_hhmmssms(
                engine,
                code=code,
                date=d,
                source=trade_indicator_source,
                venue=venue,
                # 지표 close 와 같은 값이어야 한다 — 이 컷오프는 "그날 연속거래가
                # 끝나는 시각" 이고, 위 체결 슬라이스가 이미 venue 별 구간으로 세고
                # 있다. KRX 15:30 을 그대로 두면 NXT 애프터마켓 체결이 통째로
                # "동시호가 이후" 로 잘린다. 캐시 키에 이 값이 들어가므로
                # (`get_continuous_before`) 바뀐 경계는 자연 무효화된다.
                session_close_ms=ind_close_ms,
            )
            if continuous_before_needed
            else None
        )
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        if include_ask_peaks or include_bid_peaks:
            ap_d, bp_d = build_ask_bid_peak_slices(
                engine, code=code, date=d, bucket_ms=bucket_ms, source=source, venue=venue,
                session_open_ms=ind_open_ms,
                session_close_ms=ind_close_ms,
            )
            if not include_ask_peaks:
                ap_d = None
            if not include_bid_peaks:
                bp_d = None
        else:
            ap_d = None
            bp_d = None
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        tvp_d = (
            build_trade_volume_poc_slice(
                engine, code=code, date=d, source=trade_indicator_source, venue=venue,
                session_open_ms=ind_open_ms,
                session_close_ms=ind_close_ms,
                range_count=trade_volume_poc_bins or DEFAULT_TRADE_VOLUME_POC_BINS,
                price_range=price_range,
                continuous_before_ms=continuous_before_ms,
            )
            if include_trade_volume_pocs
            else None
        )
        segments.append(RangeSegment(
            date=d,
            # 세그먼트 경계도 **venue 별 지표 구간**이다. #1243 에서는 정규장 그대로
            # 두고 후속 과제로 남겼었다 — `/live` 는 이 값을 안 쓰고
            # `sessionBoundsForDate`(effective_sessions + venue 확장창)로 세그먼트를
            # 다시 만들지만(buildLiveBundle.ts), **그 우회를 안 타는 `/study` 는 이
            # 값을 그대로 쓴다**: 체결강도 클립(`studyWindowContents`)과 참조 번들의
            # `LiveEffectiveSession` 변환(`useStudyReferenceBundle`) 둘 다. 정규장으로
            # 두면 복기에서 NXT 프리·애프터마켓이 x축과 클립 양쪽에서 잘린다.
            session_open_ms=hhmmssms_to_unix_ms(d, ind_open_ms),
            session_close_ms=hhmmssms_to_unix_ms(d, ind_close_ms),
            source=source,
            venue=venue,
            gap_ms=_segment_gap_ms(d, meta),
        ))
        included_dates.append(d)
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        if (
            not hoga_only and not cutoff_sidecar and not candles_only
            and broker_late_entries_enabled
        ):
            broker_late_entries.extend(
                build_broker_late_entries_slice(
                    engine,
                    code=code,
                    date=d,
                    source=source,
                    venue=venue,
                    start_hhmm=broker_late_entry_start_hhmm,
                )
            )
        candles.extend(candles_d)
        ratio_pts.extend(qr_d.points)
        fill_pts.extend(fs_d.points)
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        if (
            not hoga_only and not candles_only
            and volume_distribution_bins is not None
        ):
            profile = build_volume_distribution_slice(
                engine,
                code=code,
                date=d,
                source=trade_indicator_source,
                venue=venue,
                session_open_ms=ind_open_ms,
                session_close_ms=ind_close_ms,
                range_count=volume_distribution_bins,
                price_min=price_range[0] if price_range is not None else None,
                price_max=price_range[1] if price_range is not None else None,
                cutoff_ms=volume_distribution_slice_cutoff_ms,
                continuous_before_ms=continuous_before_ms,
            )
            if profile is not None:
                volume_distributions.append(profile)
        if ap_d is not None:
            ask_peaks.append(_peak_for_range_payload(ap_d, bar_peaks=bar_peaks_enabled))
        if bp_d is not None:
            bid_peaks.append(_peak_for_range_payload(bp_d, bar_peaks=bar_peaks_enabled))
        if tvp_d is not None:
            trade_volume_pocs.append(tvp_d)
        gil_breathe_at = _gil_breathe(gil_breathe_at)
        if include_depth_heatmap:
            depth_heatmap.extend(
                build_depth_heatmap_slice(
                    engine,
                    code=code,
                    date=d,
                    bucket_ms=bucket_ms,
                    source=source,
                    venue=venue,
                    session_open_ms=ind_open_ms,
                    session_close_ms=ind_close_ms,
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

    # 두 출처(미캡처 시드 + 루프)가 섞여 있으므로 날짜순으로 정렬해 내보낸다.
    missing.sort(key=lambda m: m.date)

    if not segments:
        # Spec 2026-05-27 §4.3: every in-range date is INVALID → return an
        # empty bundle with excluded_dates populated, so frontend can render
        # DataWarning UX without 404 round-trips.
        return _empty_range_bundle(
            code, from_date, to_date, bucket_ms, excluded=excluded, missing=missing,
            earliest_captured=engine.earliest_stock_date(
                code=code, source_pref=source_pref, venue=cast("Venue", venue),
            ),
        )

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        # 디스크 모드 좌측 팬의 바닥. 프론트가 `minuteScrollbackFloorDate` 에 물린다 —
        # 없으면 캡처 시작 이전으로 무한히 팬해 빈 화면이 된다(모델 필드 주석 참조).
        earliest_captured_date=engine.earliest_stock_date(
            code=code, source_pref=source_pref, venue=cast("Venue", venue),
        ),
        segments=segments,
        candles=candles,
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=fill_pts),
        # mode=full 퇴역(2026-07-08) 후 와이어 shape 유지용 상시-빈 필드.
        volume_profile_range=_empty_volume_profile(),
        volume_profile_by_day=[],
        excluded_dates=excluded,
        data_warnings=warnings_list,
        missing_dates=missing,
        ask_peaks=ask_peaks,
        bid_peaks=bid_peaks,
        broker_late_entries=broker_late_entries,
        price_level_hits=[],
        trade_volume_pocs=trade_volume_pocs,
        depth_heatmap=depth_heatmap,
        volume_distributions=volume_distributions,
        program_trade=(
            build_program_trade_series(
                engine,
                code=code,
                dates=included_dates,
                venue=venue,
                bucket_ms=bucket_ms,
                session_open_by_date={s.date: s.session_open_ms for s in segments},
                today_kst=_today_kst_yyyymmdd(),
            )
            if include_program_trade
            else ProgramTradeSeries(points=[])
        ),
    )
