"""Current-day executions from Kiwoom's continuation API."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import TradeHistoryResponse
from hoga.api.params import CODE_PATTERN
from hoga.api.trading_days import is_trading_day
from hoga.util.timeenc import KST

from .kiwoom_errors import KiwoomRestError
from .trade_history import fetch_history

_EARLIEST_TRADING_HOUR = 8


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/live", tags=["live"])

    @router.get("/trades/history", response_model=TradeHistoryResponse)
    async def get_trade_history(
        code: str = Query(pattern=CODE_PATTERN),
        date: str = Query(pattern=r"^\d{8}$"),
        venue: Literal["KRX", "NXT", "UN"] = "KRX",
        next_key: str | None = Query(None, min_length=1, max_length=1024),
    ) -> TradeHistoryResponse:
        now = datetime.now(KST)
        if date != now.strftime("%Y%m%d"):
            # ka10003 has no date input. Never relabel today's rows as another day.
            raise HTTPException(422, "체결 과거 조회는 당일 내역만 지원합니다")
        if is_trading_day(date, data_dir) is False or now.hour < _EARLIEST_TRADING_HOUR:
            return TradeHistoryResponse(code=code, date=date, venue=venue, rows=[], next_key=None,
                                        latest_at_ms=None, latest_volume=None, prev_close=None)
        try:
            return await fetch_history(data_dir, code=code, date=date, venue=venue, next_key=next_key)
        except KiwoomRestError as exc:
            raise HTTPException(503, "키움 체결 과거 내역 조회 실패") from exc

    return router
