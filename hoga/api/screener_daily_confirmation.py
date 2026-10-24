"""The provider's KRX daily aggregate is distinct from the 15:30 regular close.

Confirmation means an as-of, repeatable historical observation under this policy,
not a promise that the provider will never revise it. Legacy observations keep
their original semantics; new recovery plans require this evidence.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, model_validator

from hoga.api.screener_series_store import digest
from hoga.util.timeenc import KST

ConfirmationState = Literal["unverified", "confirmed", "too_early", "unstable"]
ConfirmationPolicy = Literal["legacy_unverified", "historical_recheck_v1"]
RECHECK_SECONDS = 2
FINALIZATION_HOUR = 22
FIELDS = ("unadjusted", "adjusted", "price_events", "violations")


class DailySample(BaseModel):
    model_config = {"extra": "forbid"}
    started_at: dt.datetime
    finished_at: dt.datetime
    unadjusted: list[dict]
    adjusted: list[dict]
    price_events: list[dict]
    violations: list[dict]
    provider_rows: dict[str, list[dict]]

    @model_validator(mode="after")
    def chronological(self):
        if (self.started_at.tzinfo is None or self.finished_at.tzinfo is None
                or self.started_at > self.finished_at):
            raise ValueError("확인 표본의 시간대와 수신 시작·종료 시각이 필요합니다")
        return self


class DailyConfirmation(BaseModel):
    model_config = {"extra": "forbid"}
    policy: Literal["historical_recheck_v1"] = "historical_recheck_v1"
    source: Literal["kiwoom:ka10081"] = "kiwoom:ka10081"
    venue: Literal["KRX"] = "KRX"
    session_scope: Literal["provider_daily_all_sessions"] = "provider_daily_all_sessions"
    close_semantics: Literal["provider_last_price"] = "provider_last_price"
    first: DailySample
    second: DailySample

    @model_validator(mode="after")
    def independent_rounds(self):
        if self.second.started_at - self.first.finished_at < dt.timedelta(seconds=RECHECK_SECONDS):
            raise ValueError("첫 수신 종료 후 간격을 둔 독립 재조회가 필요합니다")
        return self


def sample_values(sample):
    return {field: getattr(sample, field) for field in FIELDS}


def state(payload: dict) -> ConfirmationState:
    """Validate identities and timestamps before any row is treated as confirmed."""
    if not payload.get("confirmation"):
        return "unverified"
    confirmation = DailyConfirmation.model_validate(payload["confirmation"])
    second = confirmation.second
    if any(getattr(second, field) != payload[field] for field in FIELDS):
        raise ValueError("확인 표본과 공개 후보의 값이 다릅니다")
    if second.provider_rows != payload.get("provider_rows", {}):
        raise ValueError("확인 표본과 공급자 원문이 다릅니다")
    observed = dt.datetime.fromisoformat(payload["observed_at"])
    anchor = dt.date.fromisoformat(payload["adjusted_as_of"])
    if observed != second.finished_at or observed.astimezone(KST).date() != anchor:
        raise ValueError("확인 시각과 수정 기준일이 다릅니다")
    for sample in (confirmation.first, second):
        for field in ("unadjusted", "adjusted"):
            dates = [row["date"] for row in getattr(sample, field)]
            if len(dates) != len(set(dates)):
                raise ValueError("확인 표본에 날짜가 중복됩니다")
            for row in getattr(sample, field):
                day = dt.date.fromisoformat(row["date"])
                if row.get("code") != payload["code"] or day >= anchor:
                    raise ValueError("확인 표본의 종목·거래일이 후보와 다릅니다")
                cutoff = dt.datetime.combine(day, dt.time(FINALIZATION_HOUR), KST)
                if sample.started_at < cutoff:
                    return "too_early"
    if digest(sample_values(confirmation.first)) != digest(sample_values(second)):
        return "unstable"
    return "confirmed"


def confirmed_dates(payload):
    """Only dates actually present in both rounds inherit this confirmation."""
    if state(payload) != "confirmed":
        return set()
    return {row["date"] for row in payload["confirmation"]["second"]["unadjusted"]}
