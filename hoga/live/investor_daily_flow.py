from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from hoga.live.candle_models import daily_anchor_ms
from hoga.live.data_warnings import LiveDataWarning, make_data_warning, violation_to_warning
from hoga.live.error_policy import classify_live_error
from hoga.live.investor import InvestorNetInvariantViolation, InvestorNetPoint
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_investor import parse_investor_net_rows
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
    progressed: float = 0.0
    oldest_requested_from: str | None = None
    oldest_accepted_date: str | None = None
    points: dict[str, InvestorDailyFlowObservation] = field(default_factory=dict)
    daily_points: dict[str, InvestorNetPoint] = field(default_factory=dict)
    violations: list[InvestorNetInvariantViolation] = field(default_factory=list)
    conflicts: set[tuple[str, DailyFlowSubject]] = field(default_factory=set)
    issues: list[InvestorDailyFlowIssue] = field(default_factory=list)
    failure: InvestorDailyFlowIssue | None = None
    transport_reason: str | None = None
    unlocated: bool = False
    next_key: str = ""
    cursors: set[str] = field(default_factory=set)
    pages: int = 0
    exhausted: bool = False
    users: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def range_reached(self, from_: str) -> bool:
        return self.oldest_accepted_date is not None and self.oldest_accepted_date < from_

    def ingest(self, rows: list[object], to: str) -> str | None:
        today = datetime.now(KST).strftime("%Y%m%d")
        oldest = None
        for row in rows:
            date = _date(row.get("dt")) if isinstance(row, dict) else None
            if date is None or date > today or date > to:
                self.unlocated = True
                issue = _issue("invalid_row", "일부 자료의 날짜·위치를 확인할 수 없습니다.")
                if issue not in self.issues:
                    self.issues.append(issue)
                continue
            oldest = min(oldest, date) if oldest is not None else date
            if date not in self.daily_points:
                legacy = parse_investor_net_rows([row], date, date)
                self.daily_points[date] = legacy.points[0]
                self.violations.extend(legacy.violations)
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
        return oldest


@dataclass(frozen=True)
class NetQuantitySnapshot:
    daily_flow: InvestorDailyFlowResponse
    points: list[InvestorNetPoint]
    cached_batches: list[str]
    fresh_batches: list[str]
    data_warnings: list[LiveDataWarning]


class InvestorDailyFlowCache:
    def __init__(
        self,
        *,
        ttl: float = 60,
        historical_ttl: float = 3600,
        page_budget: int = 6,
        max_histories: int = 64,
        max_pages: int = 128,
        max_rows: int = 128_000,
    ):
        self.ttl = ttl
        self.historical_ttl = historical_ttl
        self.page_budget = page_budget
        self.max_histories = max_histories
        self.max_pages = max_pages
        self.max_rows = max_rows
        self.histories: dict[tuple[str, str], _History] = {}

    def stats_snapshot(self) -> dict[str, int]:
        return {
            "histories": len(self.histories),
            "pages": sum(history.pages for history in self.histories.values()),
            "rows": sum(len(history.points) for history in self.histories.values()),
        }

    async def collect(
        self, *, code: str, from_: str, to: str, run_page: PageRunner | None = None,
    ) -> NetQuantitySnapshot:
        key = (code, to)
        now = time.monotonic()
        history = self.histories.get(key)
        ttl = self.ttl if to >= datetime.now(KST).strftime("%Y%m%d") else self.historical_ttl
        if run_page is None and history is None:
            return self._snapshot(_History(touched=now, fresh=now), code, from_, to, fresh=False, bypass=True)
        requested_from = min(from_, history.oldest_requested_from or from_) if history is not None else from_
        continuing = (
            history is not None
            and 0 < history.pages < self.max_pages
            and not history.exhausted
            and history.failure is None
            and not history.range_reached(requested_from)
            and now - history.progressed < ttl
        )
        if history is None or (
            run_page is not None and history.users == 0 and now - history.fresh >= ttl and not continuing
        ):
            if history is None and len(self.histories) >= self.max_histories:
                idle = [key for key, entry in self.histories.items() if entry.users == 0]
                if not idle:
                    return self._snapshot(
                        _History(touched=now, fresh=now, failure=_issue(
                            "unavailable", "투자자 자료 조회가 혼잡합니다. 다시 조회해 주세요.",
                        )), code, from_, to, fresh=False,
                    )
                del self.histories[min(idle, key=lambda key: self.histories[key].touched)]
            history = self.histories[key] = _History(touched=now, fresh=now)
        if run_page is not None:
            history.oldest_requested_from = min(from_, history.oldest_requested_from or from_)
        history.users += 1
        try:
            async with history.lock:
                before = history.pages
                if run_page is not None:
                    await self._collect(history, code, from_, to, run_page)
                return self._snapshot(
                    history, code, from_, to, fresh=history.pages > before, bypass=run_page is None,
                )
        finally:
            history.touched = time.monotonic()
            history.users -= 1

    async def _collect(
        self, history: _History, code: str, from_: str, to: str, run_page: PageRunner,
    ) -> None:
        for _ in range(1 if history.pages == 0 else self.page_budget):
            if history.exhausted or history.pages >= self.max_pages or history.range_reached(from_):
                break
            cursor = history.next_key
            body = {"stk_cd": code, "dt": to, "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}

            def fetch(client, *, _cursor=cursor, _body=body):
                return client.call("ka10059", _body, cont=bool(_cursor), next_key=_cursor)

            fetch.request_identity = ("ka10059", tuple(sorted(body.items())), bool(cursor), cursor)
            try:
                page = await run_page(fetch, history.pages)
            except (KiwoomRestError, KiwoomCapacityOverloaded, OSError, TimeoutError) as exc:
                history.failure = _issue("api_error", "투자자 자료 조회 실패 · 같은 페이지부터 다시 조회합니다.")
                history.transport_reason = classify_live_error(exc).reason
                break
            if not isinstance(page.raw, dict) or not isinstance(page.raw.get("stk_invsr_orgn"), list):
                history.failure = _issue("invalid_page", "투자자 자료 응답 형식 미확인 · 다시 조회가 필요합니다.")
                history.transport_reason = None
                break
            if len(history.points) + len(page.raw["stk_invsr_orgn"]) > self.max_rows:
                history.failure = _issue("invalid_page", "투자자 자료 보관 한도를 초과했습니다.")
                history.transport_reason = None
                break
            oldest = history.ingest(page.raw["stk_invsr_orgn"], to)
            failure = self._continuation_failure(page, cursor, history)
            if failure is not None:
                history.failure = failure
                history.transport_reason = None
                break
            history.failure = None
            history.transport_reason = None
            if oldest is not None:
                history.oldest_accepted_date = (
                    min(history.oldest_accepted_date, oldest) if history.oldest_accepted_date is not None else oldest
                )
            history.progressed = time.monotonic()
            if history.pages == 0:
                history.fresh = history.progressed
            history.pages += 1
            if page.raw_cont_yn == "N":
                history.exhausted = True
            else:
                history.cursors.add(page.next_key)
                history.next_key = page.next_key
            if history.range_reached(from_):
                break

    def _snapshot(
        self, history: _History, code: str, from_: str, to: str, *, fresh: bool, bypass: bool = False,
    ) -> NetQuantitySnapshot:
        warnings = [issue.model_copy() for issue in history.issues]
        if bypass and not history.exhausted:
            warnings.append(_issue("unavailable", "REST 우회 중입니다. 캐시된 자료만 표시합니다."))
        elif history.failure is not None:
            warnings.append(history.failure.model_copy())
        elif not history.exhausted and (history.pages >= self.max_pages or not history.range_reached(from_)):
            warnings.append(
                _issue(
                    "page_budget",
                    "전체 조회 한도입니다. 잠시 후 새로 조회합니다."
                    if history.pages >= self.max_pages
                    else "일부 페이지만 확인했습니다. 계속 조회해 주세요.",
                )
            )
        strict = InvestorDailyFlowResponse(
            code=code,
            **{"from": from_},
            to=to,
            observations=[point.model_copy() for date, point in sorted(history.points.items()) if from_ <= date <= to],
            pagination="covered" if history.exhausted else "incomplete",
            unlocated_defect=history.unlocated,
            pages_observed=history.pages,
            can_continue=(
                not bypass and not history.exhausted and history.pages < self.max_pages
                and not history.range_reached(from_)
            ),
            data_warnings=warnings,
        )
        label = f"{from_}__{to}"
        legacy_warnings = [
            violation_to_warning(violation, label) for violation in history.violations
            if from_ <= violation.date_yyyymmdd <= to
        ]
        for issue in warnings:
            if bypass and issue.reason == "unavailable":
                continue
            reason = {
                "api_error": history.transport_reason or "api_error",
                "page_budget": "fetch_budget_exhausted",
                "unavailable": "capacity_overloaded",
            }.get(issue.reason, "invariant_violation")
            legacy_warnings.append(make_data_warning(reason, issue.message, date=issue.date, batch=label))
        if bypass:
            legacy_warnings.insert(0, make_data_warning("rest_bypassed", "REST 우회 중입니다. 캐시만 표시합니다."))
        return NetQuantitySnapshot(
            daily_flow=strict,
            points=[point.model_copy(deep=True) for date, point in sorted(history.daily_points.items())
                    if from_ <= date <= to],
            cached_batches=[label] if history.pages and not fresh else [],
            fresh_batches=[label] if fresh else [],
            data_warnings=[LiveDataWarning.model_validate(warning) for warning in legacy_warnings],
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
