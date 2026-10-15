"""Captured event pages and on-demand Kiwoom history; never synthesize from totals."""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import ProgramTradeHistoryResponse, ProgramTradeTicksResponse
from hoga.api.params import CODE_PATTERN

from .kiwoom_errors import KiwoomRestError
from .program_trade_history import fetch_history
from .program_trade_tape import ProgramTradeTapeStore


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/live", tags=["live"])
    store = ProgramTradeTapeStore(data_dir)

    @router.get("/program-trades/history", response_model=ProgramTradeHistoryResponse)
    async def get_program_trade_history(
        code: str = Query(pattern=CODE_PATTERN),
        date: str = Query(pattern=r"^\d{8}$"),
        venue: Literal["KRX", "NXT", "UN"] = "KRX",
        next_key: str | None = Query(None, min_length=1, max_length=1024),
    ) -> ProgramTradeHistoryResponse:
        try:
            datetime.strptime(date, "%Y%m%d")
        except ValueError as exc:
            raise HTTPException(422, "Invalid trading date") from exc
        try:
            return await fetch_history(data_dir, code=code, date=date, venue=venue, next_key=next_key)
        except KiwoomRestError as exc:
            raise HTTPException(503, "키움 프로그램 과거 내역 조회 실패") from exc

    @router.get("/program-trades", response_model=ProgramTradeTicksResponse)
    async def get_program_trades(
        code: str = Query(pattern=CODE_PATTERN),
        date: str = Query(pattern=r"^\d{8}$"),
        venue: Literal["KRX", "NXT", "UN"] = "KRX",
        before: int | None = Query(None, ge=0),
        limit: int = Query(200, ge=1, le=500),
    ) -> ProgramTradeTicksResponse:
        try:
            datetime.strptime(date, "%Y%m%d")
        except ValueError as exc:
            raise HTTPException(422, "Invalid trading date") from exc
        try:
            rows, next_before = await asyncio.to_thread(store.page, code, venue, date, before=before, limit=limit)
        except OSError as exc:
            raise HTTPException(503, "Program trade history unavailable") from exc
        return ProgramTradeTicksResponse(code=code, date=date, venue=venue, rows=rows, next_before=next_before)

    return router
