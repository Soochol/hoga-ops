"""Read-only, sourced observations for explaining missing screener daily history.

Facts come from manual master/history refresh or sourced maintenance, never inferred from the first stored
candle or absence from today's symbol master. Scanning performs no vendor calls.
"""
from __future__ import annotations

import datetime as dt
import logging
from collections import defaultdict
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger(__name__)


class HistoryEvidence(BaseModel):
    name: str = ""
    checked_at: dt.datetime
    sources: list[str] = Field(min_length=1)
    listing_date: dt.date | None = None
    delisting_date: dt.date | None = None
    suspended_from: dt.date | None = None
    suspended_to: dt.date | None = None
    prefix_checked_from: dt.date | None = None
    vendor_checked_from: dt.date | None = None
    vendor_checked_to: dt.date | None = None
    vendor_dates: set[dt.date] = Field(default_factory=set)
    vendor_absent_dates: set[dt.date] = Field(default_factory=set)


class EvidenceFile(BaseModel):
    schema_version: Literal[1] = 1
    records: dict[str, HistoryEvidence]


def load(data_dir: Path) -> dict[str, HistoryEvidence]:
    path = data_dir / "screener" / "history_evidence.json"
    if not path.exists():
        return {}
    try:
        return EvidenceFile.model_validate_json(path.read_text()).records
    except (OSError, ValidationError):
        log.exception("스크리너 이력 조사 자료를 읽지 못했습니다")
        return {}


def missing_reasons(days: list[dt.date], evidence: HistoryEvidence | None):
    """Classify each missing day; mixed listing/collection gaps stay separate."""
    grouped = defaultdict(list)
    for day in days:
        reason = "missing_daily_history"
        if evidence is not None:
            if evidence.listing_date and day < evidence.listing_date:
                reason = "pre_listing_history"
            elif evidence.delisting_date and day >= evidence.delisting_date:
                reason = "delisted"
            elif (evidence.suspended_from and evidence.suspended_to
                  and evidence.suspended_from <= day <= evidence.suspended_to):
                reason = "trading_suspended"
            elif day in evidence.vendor_dates:
                reason = "collection_missing"
            elif day in evidence.vendor_absent_dates:
                reason = "vendor_history_unavailable"
        grouped[reason].append(day)
    return dict(grouped)
