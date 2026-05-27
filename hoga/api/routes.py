"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from hoga.api.bundle import build_range_bundle
from hoga.api.cursor import cursor_to_native
from hoga.api.models import (
    BrokerSeriesResponse,
    CandlesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    StockDate as StockDateModel,
    TradesResponse,
    validate_bucket_ms,
)
from hoga.api.params import Code, StockDate
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
)
from hoga.tables import brokers as brokers_tbl
from hoga.tables import candles as candles_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl


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


def build_router(engine: QueryEngine) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDateModel])
    def stock_dates() -> list[StockDateModel]:
        return engine.list_stock_dates()

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
    ) -> OrderbookResponse:
        # bucket_ms aligns the sidebar's 10호가 view with the candle-close
        # convention used by QuoteTotalsPane (and downsample_candles): for a
        # cursor sitting on candle T's start (= bucket_start), return the last
        # snapshot inside [t, t + bucket_ms) — the same snapshot the indicator
        # labels at t. Without bucket_ms the legacy "latest ≤ t" semantics
        # apply, so the parameter is backward-compatible.
        path = _parquet_path(engine, date, code, "snapshots.parquet")
        if bucket_ms is not None:
            try:
                validate_bucket_ms(bucket_ms)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            cutoff_unix = t + bucket_ms - 1
        else:
            cutoff_unix = t
        raw_t = cursor_to_native(date, cutoff_unix)
        snap = snapshots_tbl.query_at(engine.conn, path=path, t_ms=raw_t)
        if snap is None:
            first_ts = snapshots_tbl.query_first_ts(engine.conn, path=path)
            available_from = (
                hhmmssms_to_unix_ms(date, first_ts) if first_ts is not None else None
            )
            return OrderbookResponse(available_from=available_from, snapshot=None)
        snap = snap.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, snap.ts_ms)})
        return OrderbookResponse(available_from=None, snapshot=snap)

    @router.get("/trades", response_model=TradesResponse)
    def trades(
        code: Code,
        date: StockDate,
        t: int | None = Query(None),
        from_ms: int | None = Query(None, alias="from"),
        to_ms: int | None = Query(None, alias="to"),
        limit: int = 50,
    ) -> TradesResponse:
        path = _parquet_path(engine, date, code, "trades.parquet")
        if from_ms is not None and to_ms is not None:
            rows = trades_tbl.query_range(
                engine.conn,
                path=path,
                from_ms=cursor_to_native(date, from_ms),
                to_ms=cursor_to_native(date, to_ms),
                limit=limit,
            )
        elif t is not None:
            rows = trades_tbl.query_up_to(
                engine.conn, path=path, t_ms=cursor_to_native(date, t), limit=limit
            )
        else:
            raise HTTPException(status_code=400, detail="provide either ?t= or ?from=&to=")
        rows = [r.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, r.ts_ms)}) for r in rows]
        return TradesResponse(trades=rows)

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
    def brokers_series(code: Code, date: StockDate) -> BrokerSeriesResponse:
        path = _parquet_path(engine, date, code, "brokers.parquet")
        raw_entries = brokers_tbl.query_day_series(engine.conn, path=path)
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
        return BrokerSeriesResponse(date=date, brokers=entries)

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
