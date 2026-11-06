"""Strict foreign and institution net shares. ADR-0055 exception preserves raw quality."""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from hoga.live import kiwoom_access, kiwoom_rest_runtime, settings as live_settings
from hoga.live.candle_models import daily_anchor_ms
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_rest import Page, PageRunner
from hoga.util.timeenc import KST

DailyFlowSubject = Literal["foreign", "institution"]
DailyFlowSource = Literal["kiwoom_ka10059"]
DailyFlowScope = Literal["KRX"]
DailyFlowUnit = Literal["qty_shares"]
DailyFlowSide = Literal["net"]
DailyFlowPagination = Literal["covered", "incomplete"]
DailyFlowIssueReason = Literal[
    "invalid_row", "duplicate_conflict", "invalid_page", "cursor_stalled", "page_budget", "api_error", "unavailable"
]
_SIGNED = re.compile(r"[+-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)")
_MAX_SAFE = 2**53 - 1
_MAX_SAFE_DIGITS = len(str(_MAX_SAFE))


class InvestorDailyFlowObservation(BaseModel):
    date: str
    t_ms: int
    institution_net_shares: int | None
    foreign_net_shares: int | None


class InvestorDailyFlowIssue(BaseModel):
    reason: DailyFlowIssueReason
    date: str | None
    subject: DailyFlowSubject | None
    message: str


class InvestorDailyFlowResponse(BaseModel):
    code: str
    from_: str = Field(alias="from")
    to: str
    source: DailyFlowSource = "kiwoom_ka10059"
    provider_scope: DailyFlowScope = "KRX"
    unit: DailyFlowUnit = "qty_shares"
    trade_side: DailyFlowSide = "net"
    observations: list[InvestorDailyFlowObservation] = Field(default_factory=list)
    pagination: DailyFlowPagination = "incomplete"
    unlocated_defect: bool = False
    pages_observed: int = 0
    can_continue: bool = True
    data_warnings: list[InvestorDailyFlowIssue] = Field(default_factory=list)


def _date(raw: object) -> str | None:
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9]{8}", raw):
        return None
    try:
        datetime.strptime(raw, "%Y%m%d")
    except ValueError:
        return None
    return raw


def _signed_shares(raw: object) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if abs(raw) <= _MAX_SAFE else None
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not _SIGNED.fullmatch(text):
        return None
    digits = text.replace(",", "").lstrip("+-").lstrip("0")
    if len(digits) > _MAX_SAFE_DIGITS:
        return None
    value = int(digits or "0") * (-1 if text.startswith("-") else 1)
    return value if abs(value) <= _MAX_SAFE else None


def _issue(
    reason: DailyFlowIssueReason, message: str, date: str | None = None, subject: DailyFlowSubject | None = None
) -> InvestorDailyFlowIssue:
    return InvestorDailyFlowIssue(reason=reason, date=date, subject=subject, message=message)


@dataclass
class _History:
    touched: float
    fresh: float
    points: dict[str, InvestorDailyFlowObservation] = field(default_factory=dict)
    conflicts: set[tuple[str, DailyFlowSubject]] = field(default_factory=set)
    issues: list[InvestorDailyFlowIssue] = field(default_factory=list)
    failure: InvestorDailyFlowIssue | None = None
    unlocated: bool = False
    next_key: str = ""
    cursors: set[str] = field(default_factory=set)
    pages: int = 0
    exhausted: bool = False
    users: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def ingest(self, rows: list[object], to: str) -> None:
        today = datetime.now(KST).strftime("%Y%m%d")
        for row in rows:
            date = _date(row.get("dt")) if isinstance(row, dict) else None
            if date is None or date > today or date > to:
                self.unlocated = True
                issue = _issue("invalid_row", "일부 자료의 날짜·위치를 확인할 수 없습니다.")
                if issue not in self.issues:
                    self.issues.append(issue)
                continue
            institution = _signed_shares(row.get("orgn"))
            foreign_investor = _signed_shares(row.get("frgnr_invsr"))
            other_foreign = _signed_shares(row.get("natfor"))
            foreign = (
                None
                if foreign_investor is None or other_foreign is None
                else _signed_shares(foreign_investor + other_foreign)
            )
            point = InvestorDailyFlowObservation(
                date=date, t_ms=daily_anchor_ms(date), institution_net_shares=institution, foreign_net_shares=foreign
            )
            previous = self.points.get(date)
            for subject, field_name in (("institution", "institution_net_shares"), ("foreign", "foreign_net_shares")):
                value = getattr(point, field_name)
                if (date, subject) in self.conflicts:
                    point = point.model_copy(update={field_name: None})
                elif previous is not None and getattr(previous, field_name) != value:
                    self.conflicts.add((date, subject))
                    point = point.model_copy(update={field_name: None})
                    self.issues.append(
                        _issue("duplicate_conflict", "동일 날짜 투자자 자료가 상충합니다.", date, subject)
                    )
                elif value is None and previous is None:
                    self.issues.append(_issue("invalid_row", "투자자 순매수 수량을 확인할 수 없습니다.", date, subject))
            self.points[date] = point


class InvestorDailyFlowCache:
    def __init__(
        self,
        *,
        ttl: float = 300,
        historical_ttl: float = 3600,
        page_budget: int = 6,
        max_histories: int = 64,
        max_pages: int = 128,
    ):
        self.ttl = ttl
        self.historical_ttl = historical_ttl
        self.page_budget = page_budget
        self.max_histories = max_histories
        self.max_pages = max_pages
        self.histories: dict[tuple[str, str], _History] = {}

    async def collect(self, *, code: str, from_: str, to: str, run_page: PageRunner) -> InvestorDailyFlowResponse:
        key = (code, to)
        now = time.monotonic()
        history = self.histories.get(key)
        ttl = self.ttl if to >= datetime.now(KST).strftime("%Y%m%d") else self.historical_ttl
        if history is None or (history.users == 0 and now - history.fresh >= ttl):
            if history is None and len(self.histories) >= self.max_histories:
                idle = [key for key, entry in self.histories.items() if entry.users == 0]
                if not idle:
                    return InvestorDailyFlowResponse(
                        code=code,
                        **{"from": from_},
                        to=to,
                        data_warnings=[_issue("unavailable", "투자자 자료 조회가 혼잡합니다. 다시 조회해 주세요.")],
                    )
                del self.histories[min(idle, key=lambda key: self.histories[key].touched)]
            history = self.histories[key] = _History(touched=now, fresh=now)
        history.users += 1
        try:
            async with history.lock:
                return await self._collect(history, code, from_, to, run_page)
        finally:
            history.touched = time.monotonic()
            history.users -= 1

    async def _collect(
        self, history: _History, code: str, from_: str, to: str, run_page: PageRunner
    ) -> InvestorDailyFlowResponse:
        for _ in range(self.page_budget):
            if history.exhausted or history.pages >= self.max_pages:
                break
            cursor = history.next_key
            body = {"stk_cd": code, "dt": to, "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}

            def fetch(client, *, _cursor=cursor, _body=body):
                return client.call("ka10059", _body, cont=bool(_cursor), next_key=_cursor)

            fetch.request_identity = ("ka10059", tuple(sorted(body.items())), bool(cursor), cursor)
            try:
                page = await run_page(fetch, history.pages)
            except (KiwoomRestError, KiwoomCapacityOverloaded, OSError, TimeoutError):
                history.failure = _issue("api_error", "투자자 자료 조회 실패 · 같은 페이지부터 다시 조회합니다.")
                break
            if not isinstance(page.raw, dict) or not isinstance(page.raw.get("stk_invsr_orgn"), list):
                history.failure = _issue("invalid_page", "투자자 자료 응답 형식 미확인 · 다시 조회가 필요합니다.")
                break
            history.ingest(page.raw["stk_invsr_orgn"], to)
            failure = self._continuation_failure(page, cursor, history)
            if failure is not None:
                history.failure = failure
                break
            history.failure = None
            history.pages += 1
            history.fresh = time.monotonic()
            if page.raw_cont_yn == "N":
                history.exhausted = True
            else:
                history.cursors.add(page.next_key)
                history.next_key = page.next_key
        warnings = list(history.issues)
        if history.failure is not None:
            warnings.append(history.failure)
        elif not history.exhausted:
            warnings.append(
                _issue(
                    "page_budget",
                    "전체 조회 한도입니다. 잠시 후 새로 조회합니다."
                    if history.pages >= self.max_pages
                    else "일부 페이지만 확인했습니다. 계속 조회해 주세요.",
                )
            )
        return InvestorDailyFlowResponse(
            code=code,
            **{"from": from_},
            to=to,
            observations=[point.model_copy() for date, point in sorted(history.points.items()) if from_ <= date <= to],
            pagination="covered" if history.exhausted else "incomplete",
            unlocated_defect=history.unlocated,
            pages_observed=history.pages,
            can_continue=not history.exhausted and history.pages < self.max_pages,
            data_warnings=warnings,
        )

    @staticmethod
    def _continuation_failure(page: Page, cursor: str, history: _History) -> InvestorDailyFlowIssue | None:
        if page.raw_cont_yn not in ("N", "Y"):
            return _issue("invalid_page", "연속조회 완료 여부 미확인 · 다시 조회가 필요합니다.")
        if page.raw_cont_yn == "Y" and (
            not page.next_key.strip() or page.next_key == cursor or page.next_key in history.cursors
        ):
            return _issue("cursor_stalled", "연속조회 커서가 진행하지 않습니다. 다시 조회해 주세요.")
        return None


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/live")
    cache = InvestorDailyFlowCache()

    @router.get("/investor-daily-flow")
    async def get_investor_daily_flow(
        code: str = Query(..., pattern=r"^[0-9A-Z]{6}$"), from_: str = Query(..., alias="from"), to: str = Query(...)
    ) -> InvestorDailyFlowResponse:
        if _date(from_) is None or _date(to) is None or from_ > to:
            raise HTTPException(422, "from/to must be valid ordered YYYYMMDD dates")
        client = (
            None if live_settings.rest_bypass_enabled(data_dir) else kiwoom_rest_runtime.ensure_rest_client(data_dir)
        )
        if client is None:
            return InvestorDailyFlowResponse(
                code=code,
                **{"from": from_},
                to=to,
                data_warnings=[_issue("unavailable", "투자자 자료 공급자를 사용할 수 없습니다.")],
            )
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

        def run_page(fetch, _index):
            return kiwoom_access.run_with_capacity(
                scheduler,
                key=("investor-daily-flow", fetch.request_identity),
                api_id="ka10059",
                priority="user_visible",
                fetch_fn=fetch,
                client=client,
            )

        return await cache.collect(code=code, from_=from_, to=to, run_page=run_page)

    return router
