"""Observed KRX aftermarket exclusions, not a complete trading-eligibility list.

Rules and provider field evidence: docs/research/2026-10-22-aftermarket-exclusions.md.
Never infer a restriction from missing quotes or from NXT eligibility.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from hoga.api.calendar import is_trading_day
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.stock_sessions import krx_aftermarket_window
from hoga.util.cache_primitives import TtlTriStateCache
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
AftermarketExclusionReason = Literal[
    "etf", "etn", "investment_warning", "investment_risk", "administrative",
    "liquidation", "short_term_overheat", "investment_caution_issue",
    "low_liquidity", "abnormal_surge", "investment_caution",
]
AftermarketExclusionStatus = Literal["checked", "unavailable", "error", "inactive"]
AftermarketExclusionSource = Literal["symbol_master", "kiwoom_ka10100"]


class AftermarketExclusionResponse(BaseModel):
    code: str
    date: str
    status: AftermarketExclusionStatus
    reasons: list[AftermarketExclusionReason] = Field(default_factory=list)
    checked_at_ms: int | None = None
    source: AftermarketExclusionSource | None = None


_WARNING_REASONS: dict[str, AftermarketExclusionReason] = {
    "2": "liquidation", "3": "short_term_overheat", "4": "investment_risk", "5": "investment_warning",
}
_STATE_REASONS: dict[str, AftermarketExclusionReason] = {
    "투자경고": "investment_warning", "투자위험": "investment_risk", "관리종목": "administrative",
    "정리매매": "liquidation", "단기과열": "short_term_overheat", "투자주의환기": "investment_caution_issue",
    "초저유동": "low_liquidity", "이상급등": "abnormal_surge", "투자유의": "investment_caution",
}
_CACHE_TTL_S = 60
_CACHE_CAPACITY = 256


def _broker_code(code: str) -> str:
    return code[1:] if re.fullmatch(r"Q\d{6}", code) else code


def parse_exclusion_reasons(row: dict[str, Any]) -> list[AftermarketExclusionReason]:
    """Only exact, positive designations; ordinary 투자주의/예고/해제 do not qualify."""
    market = str(row.get("marketCode", "")).strip()
    if market == "8":
        return ["etf"]
    if market in ("60", "70", "90"):
        return ["etn"]
    reasons: list[AftermarketExclusionReason] = []
    warning = _WARNING_REASONS.get(str(row.get("orderWarning", "")).strip())
    if warning:
        reasons.append(warning)
    for field in ("state", "auditInfo"):
        raw = row.get(field)
        if not isinstance(raw, str):
            continue
        for raw_token in re.split(r"[|,;]", raw):
            token = "".join(raw_token.split())
            reason = _STATE_REASONS.get(token) or _STATE_REASONS.get(token.removesuffix("종목"))
            # The exchange specifies 투자유의종목 for KOSPI; do not generalize it.
            if reason == "investment_caution" and str(row.get("marketCode")) != "0":
                continue
            if reason and reason not in reasons:
                reasons.append(reason)
    return reasons


class AftermarketExclusionService:
    def __init__(
        self, fetch: Callable[[str], Awaitable[dict[str, Any] | None]],
        security_type: Callable[[str], str | None],
    ) -> None:
        self.fetch = fetch
        self.security_type = security_type
        self.cache = TtlTriStateCache[tuple[str, str], AftermarketExclusionResponse](
            _CACHE_TTL_S, _CACHE_CAPACITY,
        )
        self.pending: dict[tuple[str, str], asyncio.Task[AftermarketExclusionResponse]] = {}

    async def get(self, code: str, now_ms: int) -> AftermarketExclusionResponse:
        date = datetime.fromtimestamp(now_ms / 1000, KST).strftime("%Y%m%d")
        response = AftermarketExclusionResponse(code=code, date=date, status="inactive")
        if not krx_aftermarket_window(now_ms):
            return response
        trading = is_trading_day(date)
        if trading is not True:
            return response.model_copy(update={"status": "inactive" if trading is False else "unavailable"})
        product = self.security_type(_broker_code(code))
        if product in ("etf", "etn"):
            return AftermarketExclusionResponse(
                code=code, date=date, status="checked", reasons=[product],
                checked_at_ms=now_ms, source="symbol_master",
            )
        key = (code, date)
        _, cached = self.cache.get(key)
        if cached is not None:
            return cached
        task = self.pending.get(key)
        if task is None:
            task = asyncio.create_task(self._load(key))
            self.pending[key] = task
        return await asyncio.shield(task)

    async def _load(self, key: tuple[str, str]) -> AftermarketExclusionResponse:
        code, date = key
        response = AftermarketExclusionResponse(code=code, date=date, status="unavailable")
        try:
            canonical = _broker_code(code)
            row = await self.fetch(canonical)
            if row is not None:
                if row.get("code") != canonical:
                    raise ValueError("stock information code mismatch")
                response = AftermarketExclusionResponse(
                    code=code, date=date, status="checked", reasons=parse_exclusion_reasons(row),
                    checked_at_ms=int(time.time() * 1000), source="kiwoom_ka10100",
                )
        except (KiwoomRestError, KiwoomCapacityOverloaded, httpx.HTTPError, ValueError):
            # An expired designation must not survive a failed recheck.
            log.warning("aftermarket designation lookup unavailable code=%s", code)
            response = response.model_copy(update={"status": "error"})
        finally:
            self.pending.pop(key, None)
        self.cache.store(key, response)
        return response
