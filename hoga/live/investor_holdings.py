"""Actual ka10008 foreign holdings with continuation-only history."""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from hoga.live import kiwoom_access, kiwoom_rest_runtime, settings as live_settings
from hoga.live.candle_models import daily_anchor_ms
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_rest import PageRunner
from hoga.util.timeenc import KST

_DATE_LENGTH = 8
_MAX_RATIO = 100
_MAX_SAFE_INTEGER = 2**53 - 1
_MAX_CODES = 64
_MAX_PAGES = 128
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?")

HoldingsSource = Literal["kiwoom_ka10008"]
HoldingsWarningReason = Literal["unavailable", "api_error", "invalid_row", "page_budget", "cursor_stalled"]


class HoldingsObservation(BaseModel):
    date: str
    t_ms: int
    quantity_shares: int | None
    ratio_pct: float | None


class HoldingsWarning(BaseModel):
    reason: HoldingsWarningReason
    message: str


class InvestorHoldingsResponse(BaseModel):
    code: str
    from_: str = Field(alias="from")
    to: str
    source: HoldingsSource = "kiwoom_ka10008"
    provider_scope: str = "KRX"
    institution_supported: Literal[False] = False
    observations: list[HoldingsObservation] = Field(default_factory=list)
    oldest_observed_date: str | None = None
    latest_observed_date: str | None = None
    pages_observed: int = 0
    pagination_complete: bool = False
    exhausted: bool = False
    partial: bool = True
    data_warnings: list[HoldingsWarning] = Field(default_factory=list)


def _date(raw: object) -> str | None:
    text = str(raw or "").strip()
    if len(text) != _DATE_LENGTH or not text.isdigit():
        return None
    try:
        datetime.strptime(text, "%Y%m%d")
    except ValueError:
        return None
    return text


def _number(raw: object, *, quantity: bool) -> int | float | None:
    if raw is None or isinstance(raw, bool):
        return None
    text = str(raw).strip()
    if not _DECIMAL.fullmatch(text):
        return None
    try:
        value = Decimal(text.replace(",", ""))
    except (InvalidOperation, ValueError, TypeError):
        return None
    if (
        not value.is_finite()
        or value < 0
        or (quantity and (value != value.to_integral_value() or value > _MAX_SAFE_INTEGER))
        or (not quantity and value > _MAX_RATIO)
    ):
        return None
    return int(value) if quantity else float(value)


def parse_observation(row: object) -> HoldingsObservation | None:
    if not isinstance(row, dict):
        return None
    date = _date(row.get("dt"))
    if date is None or date > datetime.now(KST).strftime("%Y%m%d"):
        return None
    quantity = _number(row.get("poss_stkcnt"), quantity=True)
    return HoldingsObservation(
        date=date,
        t_ms=daily_anchor_ms(date),
        quantity_shares=int(quantity) if quantity is not None else None,
        ratio_pct=_number(row.get("wght"), quantity=False),
    )


@dataclass
class _History:
    created: float = field(default_factory=time.monotonic)
    points: dict[str, HoldingsObservation] = field(default_factory=dict)
    conflicts: set[str] = field(default_factory=set)
    next_key: str = ""
    pages: int = 0
    exhausted: bool = False
    warnings: list[HoldingsWarning] = field(default_factory=list)
    cursors: set[str] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0

    def ingest(self, rows: list[object]) -> None:
        for row in rows:
            point = parse_observation(row)
            invalid = point is None or point.quantity_shares is None or point.ratio_pct is None
            if invalid and not self.warnings:
                self.warnings.append(
                    HoldingsWarning(
                        reason="invalid_row", message="일부 날짜 또는 보유값이 유효하지 않아 빈 값으로 표시합니다."
                    )
                )
            if point is not None:
                previous = self.points.get(point.date)
                if point.date in self.conflicts:
                    continue
                if previous is not None and previous != point:
                    self.conflicts.add(point.date)
                    self.points[point.date] = point.model_copy(update={"quantity_shares": None, "ratio_pct": None})
                    if len(self.conflicts) == 1:
                        self.warnings.append(
                            HoldingsWarning(
                                reason="invalid_row",
                                message="같은 날짜의 보유 자료가 서로 달라 해당 날짜를 빈 값으로 표시합니다.",
                            )
                        )
                else:
                    self.points[point.date] = point


class HoldingsCache:
    def __init__(self, *, ttl: float = 300, page_budget: int = 8):
        self.ttl = ttl
        self.page_budget = page_budget
        self.histories: dict[str, _History] = {}

    async def collect(self, code: str, from_: str, to: str, run_page: PageRunner) -> InvestorHoldingsResponse:
        history = self.histories.get(code)
        if history is None or (history.users == 0 and time.monotonic() - history.created >= self.ttl):
            if code not in self.histories and len(self.histories) >= _MAX_CODES:
                idle = [key for key, entry in self.histories.items() if entry.users == 0]
                if not idle:
                    return InvestorHoldingsResponse(
                        code=code,
                        **{"from": from_},
                        to=to,
                        data_warnings=[
                            HoldingsWarning(
                                reason="unavailable", message="보유 자료 조회가 혼잡합니다. 잠시 후 다시 조회합니다."
                            )
                        ],
                    )
                del self.histories[min(idle, key=lambda key: self.histories[key].created)]
            history = self.histories[code] = _History()
        history.users += 1
        try:
            async with history.lock:
                return await self._collect_locked(history, code, from_, to, run_page)
        finally:
            history.users -= 1

    async def _collect_locked(
        self, history: _History, code: str, from_: str, to: str, run_page: PageRunner
    ) -> InvestorHoldingsResponse:
        warnings = []

        for _ in range(self.page_budget):
            if history.exhausted:
                break
            if history.pages >= _MAX_PAGES:
                break
            cursor = history.next_key

            def fetch(client, *, _cursor=cursor):
                return client.call("ka10008", {"stk_cd": code}, cont=bool(_cursor), next_key=_cursor)

            try:
                page = await run_page(fetch, history.pages)
            except (KiwoomRestError, KiwoomCapacityOverloaded, OSError, TimeoutError):
                warnings.append(
                    HoldingsWarning(reason="api_error", message="보유 자료 조회 실패 · 확인된 페이지만 표시합니다.")
                )
                break
            rows = page.raw.get("stk_frgnr")
            if not isinstance(rows, list):
                warnings.append(
                    HoldingsWarning(
                        reason="api_error",
                        message="보유 자료 응답 형식이 유효하지 않습니다. 확인된 페이지만 표시합니다.",
                    )
                )
                break
            history.pages += 1
            history.ingest(rows)
            if not page.cont:
                history.exhausted = True
                break
            if not page.next_key or page.next_key == cursor or page.next_key in history.cursors:
                warnings.append(
                    HoldingsWarning(
                        reason="cursor_stalled",
                        message="연속조회 진행을 확인하지 못했습니다. 확인된 페이지만 표시합니다.",
                    )
                )
                break
            history.cursors.add(page.next_key)
            history.next_key = page.next_key
        complete = history.exhausted
        if not complete and not warnings:
            warnings.append(
                HoldingsWarning(
                    reason="page_budget",
                    message=(
                        "전체 조회 한도에 도달했습니다. 캐시 만료(최대 5분) 후 최신 자료부터 다시 조회합니다."
                        if history.pages >= _MAX_PAGES
                        else "조회 한도 내 일부 자료입니다. 다음 조회에서 나머지 자료를 이어 받습니다."
                    ),
                )
            )
        dates = sorted(history.points)
        return InvestorHoldingsResponse(
            code=code,
            **{"from": from_},
            to=to,
            observations=[history.points[date] for date in dates if from_ <= date <= to],
            oldest_observed_date=dates[0] if dates else None,
            latest_observed_date=dates[-1] if dates else None,
            pages_observed=history.pages,
            pagination_complete=complete,
            exhausted=history.exhausted,
            partial=not complete,
            data_warnings=history.warnings + warnings,
        )


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/live")
    cache = HoldingsCache()

    @router.get("/investor-holdings")
    async def get_holdings(
        code: str = Query(..., pattern=r"^[0-9A-Z]{6}$"),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> InvestorHoldingsResponse:
        if _date(from_) is None or _date(to) is None or from_ > to:
            raise HTTPException(422, "from/to must be valid ordered YYYYMMDD dates")
        client = (
            kiwoom_rest_runtime.ensure_rest_client(data_dir)
            if not live_settings.rest_bypass_enabled(data_dir)
            else None
        )
        if client is None:
            return InvestorHoldingsResponse(
                code=code,
                **{"from": from_},
                to=to,
                data_warnings=[HoldingsWarning(reason="unavailable", message="보유 자료 공급자를 사용할 수 없습니다.")],
            )
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

        def run_page(fetch, index):
            return kiwoom_access.run_with_capacity(
                scheduler,
                key=("investor-holdings", code, index),
                api_id="ka10008",
                priority="user_visible",
                fetch_fn=fetch,
                client=client,
            )

        return await cache.collect(code, from_, to, run_page)

    return router
