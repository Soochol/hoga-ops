"""Route handlers."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import (
    BrokerEntry,
    BrokersResponse,
    Candle,
    CandlesResponse,
    Meta,
    OrderbookResponse,
    OrderbookSnapshot,
    StockDate,
    Trade,
    TradesResponse,
)
from hoga.api.queries import QueryEngine, StockDateNotFound

ORDERBOOK_LEVELS = 10


def build_router(engine: QueryEngine) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDate])
    def stock_dates() -> list[StockDate]:
        return [StockDate(**s) for s in engine.list_stock_dates()]

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
            row = engine.get_orderbook_at(date, code, t)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        if row is None:
            first_ts = engine.first_snapshot_ts(date, code)
            return OrderbookResponse(available_from=first_ts, snapshot=None)
        snap = OrderbookSnapshot(
            ts_ms=row["ts_ms"],
            seq=row["seq"],
            ask_p=[row[f"ask_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
            ask_q=[row[f"ask_q{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
            ask_d=[row[f"ask_d{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
            bid_p=[row[f"bid_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
            bid_q=[row[f"bid_q{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
            bid_d=[row[f"bid_d{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
            tot_ask=row["tot_ask"],
            tot_ask_d=row["tot_ask_d"],
            tot_bid=row["tot_bid"],
            tot_bid_d=row["tot_bid_d"],
        )
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
            if from_ms is not None and to_ms is not None:
                rows = engine.get_trades_in_range(date, code, from_ms, to_ms, limit)
            elif t is not None:
                rows = engine.get_trades_up_to(date, code, t, limit)
            else:
                raise HTTPException(
                    status_code=400,
                    detail="provide either ?t= or ?from=&to=",
                )
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return TradesResponse(trades=[Trade(**r) for r in rows])

    @router.get("/candles", response_model=CandlesResponse)
    def candles(code: str, date: str) -> CandlesResponse:
        try:
            rows = engine.get_candles(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return CandlesResponse(candles=[Candle(**r) for r in rows])

    @router.get("/brokers", response_model=BrokersResponse)
    def brokers(code: str, date: str, t: int = Query(...)) -> BrokersResponse:
        try:
            rows = engine.get_brokers_at(date, code, t)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        if not rows:
            return BrokersResponse(ts_ms=None, entries=[])
        ts = rows[0]["ts_ms"]
        entries = [
            BrokerEntry(
                side=r["side"],
                rank=r["rank"],
                broker=r["broker"],
                qty_today=r["qty_today"],
                qty_delta=r["qty_delta"],
            )
            for r in rows
        ]
        return BrokersResponse(ts_ms=ts, entries=entries)

    return router
