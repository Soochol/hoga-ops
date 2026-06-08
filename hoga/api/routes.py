"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from hoga.api.bundle import build_range_bundle
from hoga.api.models import (
    BrokerSeriesResponse,
    CandlesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    validate_bucket_ms,
)
from hoga.api.models import (
    StockDate as StockDateModel,
)
from hoga.api.params import Code, StockDate
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.sources import SourceName, resolve_source
from hoga.api.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)
from hoga.collector.orchestrator import now_kst
from hoga.tables import brokers as brokers_tbl
from hoga.tables import candles as candles_tbl
from hoga.tables import snapshots as snapshots_tbl

_log = logging.getLogger(__name__)

# 라이브 버퍼가 대표하는 캡처 소스. /api/brokers/series의 today 봉합은 이 소스일
# 때만 버퍼 꼬리를 합친다(hogaplay 소스엔 라이브 버퍼 없음). #9.
_LIVE_CAPTURE_SOURCE: SourceName = "kis_live"


def _parquet_path(
    engine: QueryEngine, date: str, code: str, filename: str
) -> Path:
    """Resolve a parquet file path inside a captured Stock-Date dir.

    Raises HTTP 404 if the Stock-Date isn't captured. Centralises the
    try/except pattern repeated across every per-Stock-Date handler.
    """
    try:
        return engine.parquet_dir(date, code) / filename
    except StockDateNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


def _resolved_parquet_dir(
    engine: QueryEngine, date: str, code: str, source_pref: SourceName
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
    source = resolve_source(engine, date, code, source_pref)
    try:
        sd_dir = engine.parquet_dir(date, code, source=source)
    except StockDateNotFound:
        return None, source
    return sd_dir, source


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


def build_router(
    engine: QueryEngine,
    *,
    get_buffer: Callable[[], Any] | None = None,
) -> APIRouter:
    """`get_buffer`: 라이브 버퍼 접근자(() -> LiveBuffer | None). 주어지면
    /api/brokers/series가 today & kis_live에서 버퍼 꼬리를 봉합한다(#9). None이면
    parquet-only(기존 동작·라우트 테스트 호환)."""
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDateModel])
    def stock_dates() -> list[StockDateModel]:
        # ADR-0042: annotate each row with its fail_streak / blocked status.
        # Read the in-memory _fail_streaks dict once (no I/O); model_copy
        # produces a non-cached instance so QueryEngine's mtime-cached
        # StockDate objects keep fail_streak=0 internally.
        from hoga.api import captures
        from hoga.api.fail_streak import ATTEMPT_CAP, streak_key
        rows = engine.list_stock_dates()
        if not captures._fail_streaks:
            return rows
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
        return annotated

    @router.get("/meta", response_model=Meta)
    def meta(code: Code, date: StockDate) -> Meta:
        try:
            m = engine.get_meta(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return Meta(**{k: m[k] for k in Meta.model_fields})

    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(
        code: Code,
        date: StockDate,
        t: int = Query(...),
        bucket_ms: int | None = Query(None),
        source_pref: SourceName = Query("hogaplay"),
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
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref)
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
    async def brokers_series(
        code: Code,
        date: StockDate,
        source_pref: SourceName = Query("hogaplay"),
    ) -> BrokerSeriesResponse:
        # ADR-0044: hover spot path honors source_pref via resolve_source +
        # ADR-0039 preference+fallback semantics. The resolved source is
        # echoed back so LiveStatusBar's chip can reflect fallback honestly.
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref)
        if sd_dir is None:
            return BrokerSeriesResponse(date=date, brokers=[], source=source)
        path = sd_dir / "brokers.parquet"

        # #9 today 봉합: date==오늘(KST) & 라이브 캡처 소스 & 버퍼 배선됨이면
        # 라이브 버퍼의 미승격 꼬리를 합쳐 당일 전체 궤적을 반환. 그 외(과거·
        # hogaplay·버퍼 미배선)는 기존 parquet-only.
        use_tail = (
            date == now_kst().strftime("%Y%m%d")
            and source == _LIVE_CAPTURE_SOURCE
            and get_buffer is not None
            and get_buffer() is not None
        )
        buffer_snapshots: list[dict] = []
        if use_tail:
            try:
                series = await get_buffer().get_series(code)  # type: ignore[misc]
                buffer_snapshots = series.get("brokers") or []
            except Exception:  # noqa: BLE001 — 버퍼 일시 오류는 parquet-only 폴백(500 금지)
                _log.exception("brokers.series.buffer_read_failed code=%s", code)
                use_tail = False

        def _compute() -> list[Any]:
            if use_tail:
                # query_day_series_today는 unix-ms로 반환 — 재변환 금지(이중변환 방지).
                return brokers_tbl.query_day_series_today(
                    engine.conn, path, date=date, buffer_snapshots=buffer_snapshots
                )
            # parquet-only: HHMMSSmmm → Unix ms 변환(/api/brokers·candles와 동일).
            raw_entries = brokers_tbl.query_day_series(engine.conn, path=path)
            return [
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

        # DuckDB는 동기(블로킹) — async 핸들러에서 to_thread로 루프 비차단(기존
        # 동기 핸들러가 threadpool에서 돌던 것과 동일 속성 유지). 버퍼 읽기는
        # 위에서 await 완료(plain dict)라 스레드엔 conn 동시성 없음.
        entries = await asyncio.to_thread(_compute)
        return BrokerSeriesResponse(date=date, brokers=entries, source=source)

    @router.get("/range", response_model=RangeBundle)
    def api_range(
        code: Code,
        from_date: str = Query(..., alias="from"),
        to_date: str = Query(..., alias="to"),
        bucket_ms: int = Query(...),
        source_pref: str = Query("hogaplay"),
    ) -> RangeBundle:
        try:
            validate_bucket_ms(bucket_ms)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return build_range_bundle(
            engine,
            code=code,
            from_date=from_date,
            to_date=to_date,
            bucket_ms=bucket_ms,
            source_pref=source_pref,
        )

    return router
