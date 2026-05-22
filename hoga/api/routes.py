"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from hoga.api.bundle import build_bundle, build_range_bundle
from hoga.api.cursor import cursor_to_native
from hoga.api.models import (
    CandlesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    SessionBundle,
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
from hoga.tables.brokers import BrokersAt


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
    def orderbook(code: Code, date: StockDate, t: int = Query(...)) -> OrderbookResponse:
        try:
            path = engine.parquet_dir(date, code) / "snapshots.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        raw_t = cursor_to_native(date, t)
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
        try:
            path = engine.parquet_dir(date, code) / "trades.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
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
        try:
            path = engine.parquet_dir(date, code) / "candles.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        rows = candles_tbl.query_all(engine.conn, path=path)
        rows = [
            r.model_copy(update={"ts_ms": ms_from_midnight_to_unix_ms(date, r.ts_ms)})
            for r in rows
        ]
        return CandlesResponse(candles=rows)

    @router.get("/brokers", response_model=BrokersAt)
    def brokers(code: Code, date: StockDate, t: int = Query(...)) -> BrokersAt:
        try:
            path = engine.parquet_dir(date, code) / "brokers.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        raw_t = cursor_to_native(date, t)
        result = brokers_tbl.query_at(engine.conn, path=path, t_ms=raw_t)
        if result.ts_ms is not None:
            result = result.model_copy(
                update={"ts_ms": hhmmssms_to_unix_ms(date, result.ts_ms)}
            )
        return result

    @router.get("/session", response_model=SessionBundle)
    def session(
        code: Code,
        date: StockDate,
        price_min: int | None = Query(None),
        price_max: int | None = Query(None),
        vp_bins: int = Query(24),
        bucket_ms: int = Query(60_000),
    ) -> SessionBundle:
        try:
            engine.parquet_dir(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return build_bundle(
            engine,
            code=code,
            date=date,
            price_min=price_min,
            price_max=price_max,
            vp_bins=vp_bins,
            bucket_ms=bucket_ms,
        )

    @router.get("/range", response_model=RangeBundle)
    def api_range(
        code: Code,
        from_date: str = Query(..., alias="from"),
        to_date: str = Query(..., alias="to"),
        bucket_ms: int = Query(...),
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
        )

    return router
