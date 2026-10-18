"""US daily API composition; shares existing broker runtimes and no WS resources."""

from __future__ import annotations

import asyncio
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from hoga.api.error_codes import LiveErrorCode
from hoga.live import kis_runtime, kiwoom_access, kiwoom_rest_runtime, settings as live_settings
from hoga.live.kis_global_index_candles import fetch_index_daily
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_us_daily_candles import EXCHANGE_CODES, fetch_stock_daily
from hoga.live.us_daily_candles import (
    UsDailyService,
    UsExchange,
    UsStockDailyResponse,
    parse_date,
)
from hoga.util.timeenc import KST

_SYMBOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]{0,19}\Z")


class UsStockEntry(BaseModel):
    exchange: UsExchange
    symbol: str
    label: str
    english_name: str = ""
    is_etf: bool = False


class UsStockCatalogResponse(BaseModel):
    stocks: list[UsStockEntry] = Field(default_factory=list)
    status: str
    fetched_at_ms: int | None = None


class UsMarketApi:
    def __init__(self, data_dir: Path | None) -> None:
        self.data_dir = data_dir
        self.daily = UsDailyService()
        self.stocks: list[UsStockEntry] = []
        self.master_at_ms: int | None = None
        self.master_expiry = 0.0
        self.master_pending: asyncio.Task | None = None
        self.master_status = "unconfigured"

        @asynccontextmanager
        async def lifespan(_app):
            try:
                yield
            finally:
                if self.master_pending:
                    self.master_pending.cancel()
                    await asyncio.gather(self.master_pending, return_exceptions=True)
                await self.daily.aclose()

        self.router = APIRouter(lifespan=lifespan)
        self.router.add_api_route("/us-stocks", self.catalog, methods=["GET"], response_model=UsStockCatalogResponse)
        self.router.add_api_route(
            "/us-stock-daily-candles", self.stock_daily, methods=["GET"], response_model=UsStockDailyResponse
        )

    def bypass(self) -> bool:
        return self.data_dir is not None and live_settings.rest_bypass_enabled(self.data_dir)

    async def index_daily(self, index, start: str, end: str):
        client = (
            kis_runtime.ensure_kis_client_for_account(0, self.data_dir) if self.data_dir and not self.bypass() else None
        )

        async def fetch(frm, too):
            return await fetch_index_daily(client, index.daily_code, frm, too)

        return await self.daily.get(
            f"index:{index.id}:points",
            start,
            end,
            source="kis",
            price_basis="index_points",
            stock=False,
            fetch=fetch if client else None,
            bypass=self.bypass(),
        )

    async def stock_daily(
        self,
        exchange: UsExchange = Query(...),
        symbol: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> UsStockDailyResponse:
        if not _SYMBOL.fullmatch(symbol):
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_CODE, "message": "invalid US ticker"})
        try:
            if parse_date(from_) > parse_date(to):
                raise ValueError("from after to")
        except ValueError as exc:
            raise HTTPException(
                422, {"code": LiveErrorCode.INVALID_DATE, "message": "invalid daily date range"}
            ) from exc
        if to > datetime.now(KST).strftime("%Y%m%d"):
            raise HTTPException(422, {"code": LiveErrorCode.DATE_IN_FUTURE, "message": "to must be <= today"})
        client = kiwoom_rest_runtime.ensure_rest_client(self.data_dir) if self.data_dir and not self.bypass() else None
        scheduler = kiwoom_rest_runtime.ensure_scheduler(self.data_dir) if client else None
        key = f"us-stock:{exchange}:{symbol}"

        async def fetch(frm, too):
            return await fetch_stock_daily(client, scheduler, exchange, symbol, frm, too)

        bars, meta = await self.daily.get(
            f"{key}:raw:USD",
            from_,
            to,
            source="kiwoom",
            price_basis="raw",
            stock=True,
            fetch=fetch if client else None,
            bypass=self.bypass(),
        )
        return UsStockDailyResponse(
            instrument_key=key,
            exchange=exchange,
            symbol=symbol,
            **{"from": from_, "to": to},
            candles=bars,
            daily_metadata=meta,
        )

    async def catalog(self) -> UsStockCatalogResponse:
        if self.bypass():
            return UsStockCatalogResponse(stocks=self.stocks, status="bypass", fetched_at_ms=self.master_at_ms)
        if self.master_pending:
            await asyncio.shield(self.master_pending)
        elif time.monotonic() >= self.master_expiry:
            self.master_pending = asyncio.create_task(self._load_master())
            self.master_pending.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            await asyncio.shield(self.master_pending)
        return UsStockCatalogResponse(stocks=self.stocks, status=self.master_status, fetched_at_ms=self.master_at_ms)

    async def _load_master(self) -> None:
        try:
            client = kiwoom_rest_runtime.ensure_rest_client(self.data_dir) if self.data_dir else None
            if client is None:
                self.master_status = "unconfigured"
                self.master_expiry = time.monotonic() + 30
                return
            scheduler = kiwoom_rest_runtime.ensure_scheduler(self.data_dir)
            rows = []
            token = ""
            tokens = set()
            for _ in range(8):

                async def call(c, cursor=token):
                    return await c.call("usa10099", {"stex_tp": "%"}, cont=bool(cursor), next_key=cursor)

                page = await kiwoom_access.run_with_capacity(
                    scheduler,
                    key=("us-stock-master", token),
                    api_id="usa10099",
                    priority="user_visible",
                    client=client,
                    fetch_fn=call,
                )
                if page.raw.get("return_code") != 0 or not isinstance(page.raw.get("list"), list):
                    raise ValueError("invalid US master envelope")
                rows.extend(page.rows)
                if not page.cont:
                    break
                if not page.next_key or page.next_key in tokens:
                    raise ValueError("US master cursor stalled")
                token = page.next_key
                tokens.add(token)
            else:
                raise ValueError("US master truncated")
            reverse = {code: exchange for exchange, code in EXCHANGE_CODES.items()}
            stocks = {}
            for row in rows:
                exchange = reverse.get(row.get("stex_tp"))
                symbol = str(row.get("stk_cd", "")).strip()
                if exchange and _SYMBOL.fullmatch(symbol):
                    stocks[(exchange, symbol)] = UsStockEntry(
                        exchange=exchange,
                        symbol=symbol,
                        label=str(row.get("stk_nm") or symbol),
                        english_name=str(row.get("stk_enm") or ""),
                        is_etf=row.get("isEtf") == "Y",
                    )
            if rows and not stocks:
                raise ValueError("US master has no valid symbols")
            self.stocks = sorted(stocks.values(), key=lambda s: (s.symbol, s.exchange))
            self.master_at_ms = int(time.time() * 1000)
            self.master_status = "normal"
            self.master_expiry = time.monotonic() + 86400
        except (KiwoomRestError, KiwoomCapacityOverloaded, ValueError, KeyError, TypeError):
            self.master_status = "stale" if self.stocks else "error"
            self.master_expiry = time.monotonic() + 300
        finally:
            self.master_pending = None
