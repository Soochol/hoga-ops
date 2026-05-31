from __future__ import annotations
from pathlib import Path
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from hoga.api.models import BreakoutFilter, ScreenerResponse
from hoga.api import screener_scan, screener_store


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/screener", tags=["screener"])
    sdir = data_dir / "screener"

    def _pair(lb: int | None, pd: int | None, name: str) -> BreakoutFilter | None:
        if (lb is None) != (pd is None):
            raise HTTPException(422, f"{name}_lookback and {name}_period must be set together")
        return BreakoutFilter(lookback=lb, period=pd) if lb is not None else None

    @router.get("")
    def scan(
        min_trade_value_eok: float | None = Query(None, ge=0),
        nh_lookback: int | None = Query(None, ge=1),
        nh_period: int | None = Query(None, ge=1),
        nhv_lookback: int | None = Query(None, ge=1),
        nhv_period: int | None = Query(None, ge=1),
        markets: list[Literal["KOSPI", "KOSDAQ"]] | None = Query(None),
        exclude_etf: bool = False,
        exclude_halted: bool = False,
        q: str | None = None,
        limit: int = Query(1000, ge=1, le=2000),
    ) -> ScreenerResponse:
        if not (sdir / "status.json").exists():
            return ScreenerResponse(status="not_seeded", rows=[])
        rows = screener_scan.run_scan(
            sdir / "daily_adjusted.parquet", sdir / "stocks.parquet",
            new_high=_pair(nh_lookback, nh_period, "nh"),
            new_high_vol=_pair(nhv_lookback, nhv_period, "nhv"),
            min_trade_value_eok=min_trade_value_eok, markets=markets,
            exclude_etf=exclude_etf, exclude_halted=exclude_halted, q=q, limit=limit)
        return ScreenerResponse(status="ok", rows=rows)

    @router.get("/status")
    def status() -> dict:
        s = screener_store.read_status(sdir / "status.json")
        if s is None:
            return {"status": "not_seeded"}
        return {**s.model_dump(), "status": "ok"}

    return router
