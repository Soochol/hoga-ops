"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import (
    CandlesResponse,
    Meta,
    OrderbookResponse,
    StockDate,
    TradesResponse,
)
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms
from hoga.tables import brokers as brokers_tbl
from hoga.tables import candles as candles_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl
from hoga.tables.brokers import BrokersAt


def build_router(engine: QueryEngine) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDate])
    def stock_dates() -> list[StockDate]:
        return engine.list_stock_dates()

    @router.get("/meta", response_model=Meta)
    def meta(code: str, date: str) -> Meta:
        try:
            m = engine.get_meta(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return Meta(**{k: m[k] for k in Meta.model_fields})

    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(code: str, date: str, t: int = Query(...)) -> OrderbookResponse:
        try:
            path = engine.parquet_dir(date, code) / "snapshots.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        try:
            raw_t = unix_ms_to_hhmmssms(date, t)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
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
        code: str,
        date: str,
        t: int | None = Query(None),
        from_ms: int | None = Query(None, alias="from"),
        to_ms: int | None = Query(None, alias="to"),
        limit: int = 50,
    ) -> TradesResponse:
        try:
            path = engine.parquet_dir(date, code) / "trades.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        try:
            if from_ms is not None and to_ms is not None:
                raw_from = unix_ms_to_hhmmssms(date, from_ms)
                raw_to = unix_ms_to_hhmmssms(date, to_ms)
                rows = trades_tbl.query_range(
                    engine.conn, path=path, from_ms=raw_from, to_ms=raw_to, limit=limit
                )
            elif t is not None:
                raw_t = unix_ms_to_hhmmssms(date, t)
                rows = trades_tbl.query_up_to(
                    engine.conn, path=path, t_ms=raw_t, limit=limit
                )
            else:
                raise HTTPException(status_code=400, detail="provide either ?t= or ?from=&to=")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        rows = [r.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, r.ts_ms)}) for r in rows]
        return TradesResponse(trades=rows)

    @router.get("/candles", response_model=CandlesResponse)
    def candles(code: str, date: str) -> CandlesResponse:
        try:
            path = engine.parquet_dir(date, code) / "candles.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return CandlesResponse(candles=candles_tbl.query_all(engine.conn, path=path))

    @router.get("/brokers", response_model=BrokersAt)
    def brokers(code: str, date: str, t: int = Query(...)) -> BrokersAt:
        try:
            path = engine.parquet_dir(date, code) / "brokers.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        try:
            raw_t = unix_ms_to_hhmmssms(date, t)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        result = brokers_tbl.query_at(engine.conn, path=path, t_ms=raw_t)
        if result.ts_ms is not None:
            result = result.model_copy(
                update={"ts_ms": hhmmssms_to_unix_ms(date, result.ts_ms)}
            )
        return result

    return router
