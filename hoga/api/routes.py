"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from hoga import perf_debug
from hoga.api.bundle import build_range_bundle
from hoga.api.models import (
    BrokerSeriesResponse,
    CandlesResponse,
    GapRange,
    GapRangesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    StockDate as StockDateModel,
    validate_bucket_ms,
)
from hoga.api.params import CODE_PATTERN, Code, StockDate
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.sources import SourceName, resolve_source_result
from hoga.tables import brokers as brokers_tbl, candles as candles_tbl, snapshots as snapshots_tbl
from hoga.util.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)

log = logging.getLogger(__name__)


def _parquet_path(
    engine: QueryEngine, date: str, code: str, filename: str
) -> Path:
    """Resolve a parquet file path inside a captured Stock-Date dir.

    Raises HTTP 404 if the Stock-Date isn't captured. Centralises the
    try/except pattern repeated across every per-Stock-Date handler.

    venue="KRX" 는 폴백이 아니라 **사실**이다 — 이 헬퍼를 쓰는 per-Stock-Date
    라우트들은 venue 축이 없다(#1133 에서 명시화).
    """
    try:
        return engine.parquet_dir(date, code, venue="KRX") / filename
    except StockDateNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


def _resolved_parquet_dir(
    engine: QueryEngine, date: str, code: str, source_pref: str, venue: str
) -> tuple[Path | None, SourceName]:
    """Resolve source preference per ADR-0044 and return (parquet_dir, resolved_source).

    Returns (None, source_pref) when the Stock-Date or source dir is missing
    on disk — the spot routes (/api/orderbook, /api/brokers/series) surface
    that as an empty 200 response rather than 404. This mirrors the empty-
    bundle semantics /api/range adopted, and matches ADR-0044's intent: a
    candle whose source dir was never captured should render as an empty
    sidebar, not a console error on every hover.

    /api/candles continues to use the simpler _parquet_path because it
    doesn't honor source_pref and keeps strict 404 semantics. /api/meta
    is the same.
    """
    resolution = resolve_source_result(engine, date, code, source_pref, venue)
    if resolution.source == "kis_api":
        # 2026-07-17 정책: kis_api는 캔들 전용(ADR-0109 복구) — 호가·체결 스팟
        # 라우트(/api/orderbook·/api/brokers/series)는 더는 서빙하지 않는다(빈 200).
        return None, resolution.source
    # ⚠ 경로 **존재**까지 본다. 위 docstring 이 약속하는 계약인데 구현이 안 따라가고
    # 있었다 — venue 축이 생기기 전엔 `resolve_source_result` 가 meta.json 을 가진
    # source 에만 경로를 줘서 디렉터리가 늘 존재했다. 지금은 분류가 **source 단위**
    # (venue 중 가장 심한 상태)라 `kiwoom_live` 가 healthy 로 뽑히고, 경로엔 없는
    # venue 세그먼트가 붙는다.
    #
    # 실측 2026-08-06: `venue=UN` 으로 NXT 미상장 종목(028670 팬오션)을 호버하면
    # `kiwoom_live/UN/` 이 없는데 그대로 DuckDB 로 넘어가 **`/api/orderbook` ·
    # `/api/brokers/series` 가 500** 이었다. 정상적으로 없는 것을 장애로 답한 셈이다.
    if resolution.path is not None and not resolution.path.is_dir():
        return None, resolution.source
    return resolution.path, resolution.source


def _cursor_to_native(date: str, unix_ms: int) -> int:
    """Translate a request **Cursor** (Unix-ms, ADR-0003) into the native
    HHMMSSmmm encoding the snapshot/trade/broker tables store.

    Out-of-day cursors (a cursor falling on a different Stock-Date than
    ``date``) become HTTP 400 instead of leaking ``timeenc``'s ValueError
    as a 500. ``timeenc`` stays pure (no FastAPI dependency); the HTTP
    mapping lives at this route-handler seam.
    """
    try:
        return unix_ms_to_hhmmssms(date, unix_ms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _blocked_manifest_stock_date(
    *, code: str, date: str, fail_streak: int
) -> StockDateModel | None:
    if re.fullmatch(CODE_PATTERN, code) is None or re.fullmatch(r"\d{8}", date) is None:
        return None
    try:
        open_ms = hhmmssms_to_unix_ms(date, 90_000_000)
        close_ms = hhmmssms_to_unix_ms(date, 153_000_000)
    except ValueError:
        return None
    return StockDateModel(
        date=date,
        code=code,
        name=code,
        regular_session_open_ms=open_ms,
        regular_session_close_ms=close_ms,
        data_window_first_ms=open_ms,
        data_window_last_ms=close_ms,
        price_min=0,
        price_max=0,
        captured_at=0,
        total_volume=0,
        pages_collected=0,
        file_size_bytes=0,
        today_open=0,
        today_high=0,
        today_low=0,
        today_close=0,
        collection_complete=False,
        is_partial=True,
        disk_state="client_incomplete",
        full_capture_count=None,
        fail_streak=fail_streak,
        blocked=True,
    )


def build_router(engine: QueryEngine) -> APIRouter:  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDateModel])
    def stock_dates() -> list[StockDateModel]:
        # ADR-0042: annotate each row with its fail_streak / blocked status.
        # Read the in-memory _fail_streaks dict once (no I/O); model_copy
        # produces a non-cached instance so QueryEngine's mtime-cached
        # StockDate objects keep fail_streak=0 internally.
        from hoga.api import captures  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        from hoga.api.fail_streak import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
            ATTEMPT_CAP,
            streak_key,
        )
        rows = engine.list_stock_dates()
        if not captures._fail_streaks:
            return rows
        seen = {(row.code, row.date) for row in rows}
        annotated: list[StockDateModel] = []
        for row in rows:
            streak = captures._fail_streaks.get(streak_key(row.code, row.date), 0)
            if streak == 0:
                annotated.append(row)
            else:
                annotated.append(row.model_copy(update={
                    "fail_streak": streak,
                    "blocked": streak >= ATTEMPT_CAP,
                }))
        for key, streak in captures._fail_streaks.items():
            if streak < ATTEMPT_CAP:
                continue
            try:
                code, date = key.split("|", 1)
            except ValueError:
                continue
            if (code, date) in seen:
                continue
            blocked_row = _blocked_manifest_stock_date(
                code=code, date=date, fail_streak=streak
            )
            if blocked_row is not None:
                annotated.append(blocked_row)
        return annotated

    @router.get("/meta", response_model=Meta)
    def meta(code: Code, date: StockDate) -> Meta:
        try:
            m = engine.get_meta(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return Meta(**{k: m[k] for k in Meta.model_fields})

    @router.get("/gaps", response_model=GapRangesResponse)
    def gaps(
        code: Code,
        date: StockDate,
        source: str = Query("hogaplay"),
    ) -> GapRangesResponse:
        """WS1: continuous-trading data-gap boundaries for a Stock-Date source.

        A ``source_partial`` Stock-Date whose collection completed still has
        these gaps → the upstream archive is missing them (re-capture won't
        recover). Only ``hogaplay`` snapshots use HHMMSSmmm ts encoding; other
        sources (live promotions store Unix ms) are rejected 400.
        """
        if source != "hogaplay":
            raise HTTPException(
                status_code=400,
                detail=f"gap analysis only supported for hogaplay, got {source!r}",
            )
        try:
            ranges_hoga, sparse, origin = engine.compute_gap_ranges(date, code, source)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return GapRangesResponse(
            code=code,
            date=date,
            source=source,
            gap_ranges=[
                GapRange(
                    start_ms=hhmmssms_to_unix_ms(date, start),
                    end_ms=hhmmssms_to_unix_ms(date, end),
                )
                for start, end in ranges_hoga
            ],
            sparse=sparse,
            origin=origin,
        )

    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(
        code: Code,
        date: StockDate,
        t: int = Query(...),
        bucket_ms: int | None = Query(None),
        source_pref: str = Query("hogaplay"),
        # venue 는 **필수**다(ADR-0140) — 기본값은 곧 "빠뜨리면 조용히 KRX" 다.
        venue: str = Query(...),
    ) -> OrderbookResponse:
        # ADR-0044: hover spot path honors source_pref via resolve_source +
        # ADR-0039 preference+fallback semantics. The resolved source is
        # echoed back so LiveStatusBar's chip can reflect fallback honestly.
        # bucket_ms aligns the sidebar's 10호가 view with the candle-close
        # convention used by QuoteTotalsPane (and downsample_candles): for a
        # cursor sitting on candle T's start (= bucket_start), return the last
        # snapshot inside [t, t + bucket_ms) — the same snapshot the indicator
        # labels at t. Without bucket_ms the legacy "latest ≤ t" semantics
        # apply, so the parameter is backward-compatible.
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref, venue)
        if sd_dir is None:
            return OrderbookResponse(available_from=None, snapshot=None, source=source)
        path = sd_dir / "snapshots.parquet"
        if bucket_ms is not None:
            try:
                validate_bucket_ms(bucket_ms)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            # The bucket representative is the last *continuous-trading* book in
            # [t, t+bucket_ms), EXCLUDING the closing-auction 3-level book — the
            # same snapshot the 호가비·총잔량 indicator labels at t
            # (query_bucketed_ratio, ADR-0062). Without the structural exclusion a
            # straddle bucket (e.g. 3m [15:18,15:21)) would show the 15:20+ auction
            # book here while the indicator shows the last pre-auction book.
            try:
                session_close_ms = engine.get_meta(date, code, source).get(
                    "regular_session_close_ms"
                )
            except (FileNotFoundError, StockDateNotFound):
                session_close_ms = None
            snap = snapshots_tbl.query_bucket_representative(
                engine.conn,
                path=path,
                lo_native=_cursor_to_native(date, t),
                hi_native=_cursor_to_native(date, t + bucket_ms - 1),
                session_close_ms=session_close_ms,
            )
        else:
            snap = snapshots_tbl.query_at(
                engine.conn, path=path, t_ms=_cursor_to_native(date, t)
            )
        if snap is None:
            first_ts = snapshots_tbl.query_first_ts(engine.conn, path=path)
            available_from = (
                hhmmssms_to_unix_ms(date, first_ts) if first_ts is not None else None
            )
            return OrderbookResponse(available_from=available_from, snapshot=None, source=source)
        snap = snap.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, snap.ts_ms)})
        return OrderbookResponse(available_from=None, snapshot=snap, source=source)

    @router.get("/candles", response_model=CandlesResponse)
    def candles(code: Code, date: StockDate) -> CandlesResponse:
        path = _parquet_path(engine, date, code, "candles.parquet")
        rows = candles_tbl.query_all(engine.conn, path=path)
        rows = [
            r.model_copy(update={"ts_ms": ms_from_midnight_to_unix_ms(date, r.ts_ms)})
            for r in rows
        ]
        return CandlesResponse(candles=rows)

    @router.get("/brokers/series", response_model=BrokerSeriesResponse)
    def brokers_series(
        code: Code,
        date: StockDate,
        source_pref: str = Query("hogaplay"),
        # venue 는 **필수**다(ADR-0140) — 기본값은 곧 "빠뜨리면 조용히 KRX" 다.
        venue: str = Query(...),
    ) -> BrokerSeriesResponse:
        # ADR-0044: hover spot path honors source_pref via resolve_source +
        # ADR-0039 preference+fallback semantics. The resolved source is
        # echoed back so LiveStatusBar's chip can reflect fallback honestly.
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref, venue)
        if sd_dir is None:
            return BrokerSeriesResponse(date=date, brokers=[], source=source)
        path = sd_dir / "brokers.parquet"
        raw_entries = brokers_tbl.query_day_series_cached(engine.conn, path=path)
        # Convert each point's ts_ms from HH:MM:SS.ms-encoded to Unix ms,
        # mirroring the /api/brokers and /api/candles handlers.
        entries = [
            e.model_copy(
                update={
                    "points": [
                        p.model_copy(
                            update={"ts_ms": hhmmssms_to_unix_ms(date, p.ts_ms)}
                        )
                        for p in e.points
                    ],
                }
            )
            for e in raw_entries
        ]
        return BrokerSeriesResponse(date=date, brokers=entries, source=source)

    @router.get("/range", response_model=RangeBundle)
    def api_range(
        code: Code,
        from_date: str = Query(..., alias="from"),
        to_date: str = Query(..., alias="to"),
        bucket_ms: int = Query(...),
        source_pref: str = Query("hogaplay"),
        # venue 는 **필수**다(ADR-0140). 기본값을 주면 호출자가 빠뜨렸을 때 조용히
        # KRX 를 읽고, 그게 곧 "실시간 꼬리는 NXT 인데 과거 본체는 KRX" 인 섞인
        # 차트다 — 이 한 라우트가 매물대·최대벽·프로그램·depth 히트맵·잔량 증감·
        # 거래원 늦은 진입 **지표 6~7개**의 과거 시계열을 실어 나른다.
        venue: str = Query(...),
        broker_late_entries_enabled: bool = Query(True),
        broker_late_entry_start_hhmm: int = Query(930),
        volume_distribution_bins: int | None = Query(None, ge=5, le=30),
        volume_distribution_price_min: int | None = Query(None, ge=0),
        volume_distribution_price_max: int | None = Query(None, ge=0),
        volume_distribution_cutoff_ms: int | None = Query(None, ge=0),
        trade_volume_poc_bins: int | None = Query(None, ge=5, le=30),
        ask_peaks_enabled: bool = Query(True),
        bid_peaks_enabled: bool = Query(True),
        program_trade_enabled: bool = Query(True),
        trade_volume_poc_enabled: bool = Query(True),
        depth_heatmap_enabled: bool = Query(True),
        depth_delta_enabled: bool = Query(True),
        mode: str = Query(..., pattern="^(hoga|sidecar|candles)$"),
    ) -> RangeBundle:
        try:
            validate_bucket_ms(bucket_ms)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        if (volume_distribution_price_min is None) != (volume_distribution_price_max is None):
            raise HTTPException(400, "volume_distribution_price_min/max must be supplied together")
        if (
            volume_distribution_price_min is not None
            and volume_distribution_price_max is not None
            and volume_distribution_price_max < volume_distribution_price_min
        ):
            raise HTTPException(400, "volume_distribution_price_max < volume_distribution_price_min")
        if volume_distribution_cutoff_ms is not None:
            if mode != "sidecar":
                raise HTTPException(
                    400,
                    "volume_distribution_cutoff_ms requires mode=sidecar",
                )
            if from_date != to_date:
                raise HTTPException(
                    400,
                    "volume_distribution_cutoff_ms requires a single Stock-Date range",
                )
            _cursor_to_native(from_date, volume_distribution_cutoff_ms)
        hh = broker_late_entry_start_hhmm // 100
        mm = broker_late_entry_start_hhmm % 100
        if hh < 9 or hh > 15 or mm < 0 or mm > 59 or (hh == 15 and mm > 20):  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            raise HTTPException(
                400,
                "broker_late_entry_start_hhmm must be between 900 and 1520",
            )
        t0 = perf_debug.now()
        try:
            bundle = build_range_bundle(
                engine,
                code=code,
                from_date=from_date,
                to_date=to_date,
                bucket_ms=bucket_ms,
                source_pref=source_pref,
                venue=venue,
                broker_late_entries_enabled=broker_late_entries_enabled,
                broker_late_entry_start_hhmm=broker_late_entry_start_hhmm,
                volume_distribution_bins=volume_distribution_bins,
                volume_distribution_price_min=volume_distribution_price_min,
                volume_distribution_price_max=volume_distribution_price_max,
                volume_distribution_cutoff_ms=volume_distribution_cutoff_ms,
                trade_volume_poc_bins=trade_volume_poc_bins,
                ask_peaks_enabled=ask_peaks_enabled,
                bid_peaks_enabled=bid_peaks_enabled,
                program_trade_enabled=program_trade_enabled,
                trade_volume_poc_enabled=trade_volume_poc_enabled,
                depth_heatmap_enabled=depth_heatmap_enabled,
                depth_delta_enabled=depth_delta_enabled,
                mode=mode,
            )
        except Exception:
            # NOT gated on perf_debug. The success log below is performance
            # instrumentation and belongs behind the flag; a failure is a
            # defect report and must survive the default configuration.
            # Gating both meant the traceback for a 500 existed only when a
            # developer had already suspected this endpoint and restarted with
            # HOGA_PERF_DEBUG set — i.e. the log was absent exactly when it
            # was needed. ADR-0120 records four days lost to this failure class.
            log.exception(
                "hoga_perf api_range status=error code=%s from=%s to=%s bucket_ms=%s "
                "mode=%s source_pref=%s duration_ms=%.1f",
                code, from_date, to_date, bucket_ms, mode, source_pref,
                perf_debug.elapsed_ms(t0),
            )
            raise
        if perf_debug.enabled():
            log.warning(
                "hoga_perf api_range status=ok code=%s from=%s to=%s bucket_ms=%s "
                "mode=%s source_pref=%s segments=%d candles=%d quote_ratio=%d "
                "fill_strength=%d excluded=%d warnings=%d duration_ms=%.1f",
                code,
                from_date,
                to_date,
                bucket_ms,
                mode,
                source_pref,
                len(bundle.segments),
                len(bundle.candles),
                len(bundle.quote_ratio.points),
                len(bundle.fill_strength.points),
                len(bundle.excluded_dates),
                len(bundle.data_warnings),
                perf_debug.elapsed_ms(t0),
            )
        return bundle

    return router
