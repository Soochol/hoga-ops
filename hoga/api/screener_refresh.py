"""Manual refresh: fresh master, per-symbol calendar gaps, verified append-only repair.

The EOD scheduler keeps its cheap global-date catch-up. This explicit operation
also finds new symbols, missing prefixes and holes in already current archives.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import polars as pl
from pydantic import BaseModel, Field, ValidationError

from hoga.api import screener_history_evidence as evidence, screener_store, symbols, trading_days
from hoga.api.calendar import TradingDayUnavailableError
from hoga.api.error_codes import UpstreamCode
from hoga.api.models import ScreenerRefreshSummary, SymbolHit
from hoga.api.screener_calendar import completed_day
from hoga.api.screener_history_jobs import _finish_disk_write, fetch_pair
from hoga.api.screener_history_storage import commit_verified_gaps
from hoga.api.screener_write_lock import screener_read_lock, screener_write_lock
from hoga.config import resolve_symbol_master_path
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
_BATCH_SIZE = 20
_WEEKEND_START = 5


class RefreshReport(BaseModel):
    summary: ScreenerRefreshSummary = Field(default_factory=ScreenerRefreshSummary)
    errors: dict[str, str] = Field(default_factory=dict)
    unresolved: dict[str, int] = Field(default_factory=dict)


@dataclass
class RepairTarget:
    code: str
    start: dt.date
    end: dt.date
    missing: set[dt.date]


def report_path(data_dir: Path) -> Path:
    return data_dir / "screener" / "refresh_report.json"


def last_summary(data_dir: Path) -> ScreenerRefreshSummary | None:
    try:
        summary = RefreshReport.model_validate_json(report_path(data_dir).read_text()).summary
        return summary if summary.completed_ms is not None else None
    except FileNotFoundError:
        return None
    except (OSError, ValidationError):
        log.exception("cannot read manual screener refresh report")
        return None


def _save(data_dir: Path, report: RefreshReport):
    report.summary.failed = len(report.errors)
    report.summary.unavailable = len(report.unresolved)
    atomic_write_json(report_path(data_dir), report.model_dump(mode="json"))


def _calendar(data_dir: Path, end: dt.date) -> list[dt.date]:
    known = trading_days.trading_days(data_dir)
    if not known:
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_UNAVAILABLE)
    # A Friday seed covers the following weekend, but never guess weekday holidays.
    through = dt.date.fromisoformat(max(known))
    cursor = end
    while cursor.weekday() >= _WEEKEND_START:
        cursor -= dt.timedelta(days=1)
    if cursor > through:
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_STALE)
    return sorted(dt.date.fromisoformat(day) for day in known if day <= end.strftime("%Y%m%d"))


def plan_repairs(data_dir: Path, master: list[SymbolHit], end: dt.date) -> list[RepairTarget]:
    days = _calendar(data_dir, end)
    if not days:
        return []
    with screener_read_lock(data_dir / "screener"):
        raw = pl.read_parquet(data_dir / "screener" / "daily_unadjusted.parquet",
                              columns=["code", "date"])
    parts = raw.partition_by("code", as_dict=True)
    facts = evidence.load(data_dir)
    targets = []
    for hit in master:
        fact = facts.get(hit.code)
        listing = dt.date.fromisoformat(hit.listing_date) if hit.listing_date else (
            fact.listing_date if fact else None)
        # Official listing dates, not first stored observations, bound missing prefixes.
        expected = {day for day in days if (listing is None or day >= listing)
                    and not (fact and fact.delisting_date and day >= fact.delisting_date)
                    and not (fact and fact.suspended_from and fact.suspended_to
                             and fact.suspended_from <= day <= fact.suspended_to)}
        stored = parts.get((hit.code,))
        observed = set(stored["date"]) if stored is not None else set()
        missing = expected - observed
        prefix_unchecked = (listing is not None and listing <= end and (not observed or min(observed) > listing)
                            and (fact is None or fact.prefix_checked_from is None
                                 or fact.prefix_checked_from > listing))
        if not missing and not prefix_unchecked:
            continue
        # Full existing range is necessary to replace factors on the same basis while
        # proving that every already stored adjusted observation stays unchanged.
        lower = min(missing | observed | ({listing} if listing else set()))
        targets.append(RepairTarget(hit.code, lower, max({end} | observed), missing))
    return sorted(targets, key=lambda target: (min(target.missing, default=target.start), target.code), reverse=True)


def _record_evidence(data_dir: Path, master: list[SymbolHit], pairs=(), accepted=()):
    with screener_write_lock(data_dir / "screener"):
        records = evidence.load(data_dir)
        now = dt.datetime.now(KST)
        for hit in master:
            old = records.get(hit.code)
            if not hit.listing_date:
                continue
            record = old or evidence.HistoryEvidence(checked_at=now, sources=["kiwoom:ka10099:regDay"])
            record.name, record.checked_at = hit.name, now
            record.listing_date = dt.date.fromisoformat(hit.listing_date)
            record.sources = list(dict.fromkeys([*record.sources, "kiwoom:ka10099:regDay"]))
            records[hit.code] = record
        for target, raw, _adjusted in pairs:
            record = records.get(target.code) or evidence.HistoryEvidence(
                checked_at=now, sources=["kiwoom:ka10081:raw+adjusted"])
            record.checked_at = now
            record.vendor_checked_from, record.vendor_checked_to = target.start, target.end
            observed = set(raw["date"])
            # The corpus already stores all successful observations. Keep evidence
            # only for unresolved dates, so scan metadata never duplicates decades
            # of OHLCV dates for thousands of symbols.
            record.vendor_absent_dates = target.missing - observed
            record.vendor_dates = target.missing & observed if target.code not in accepted else set()
            if target.code in accepted:
                record.prefix_checked_from = target.start
            record.sources = list(dict.fromkeys([*record.sources, "kiwoom:ka10081:raw+adjusted"]))
            records[target.code] = record
        atomic_write_json(data_dir / "screener" / "history_evidence.json",
                          evidence.EvidenceFile(records=records).model_dump(mode="json"))


def _update_status(data_dir: Path):
    sdir = data_dir / "screener"
    with screener_write_lock(sdir):
        previous = screener_store.read_status(sdir / "status.json")
        screener_store.write_status(
            sdir / "status.json", last_raw_date=screener_store.last_raw_date(sdir / "daily_unadjusted.parquet"),
            universe_size=pl.read_parquet(sdir / "stocks.parquet").height,
            derive_ms=previous.derive_ms if previous else 0, now_ms=int(time.time() * 1000))


async def _collect_targets(data_dir, targets, report, progress, fetch):
    pending = []

    async def flush():
        if not pending:
            return
        batch = list(pending)
        result = await _finish_disk_write(
            commit_verified_gaps, data_dir, [(raw, adjusted) for _, raw, adjusted in batch])
        report.summary.written_rows += result.written_rows
        report.errors.update(result.errors)
        report.errors.update({code: str(exc) for code, exc in result.extensions.items()})
        for target, raw, _adjusted in batch:
            if target.code not in report.errors:
                remaining = target.missing - set(raw["date"])
                if remaining:
                    report.unresolved[target.code] = len(remaining)
        # Positive observations explain rejected collection; an empty provider range is
        # never silently labelled as suspension or pre-listing.
        accepted = {target.code for target, _, _ in batch} - set(result.errors) - set(result.extensions)
        await _finish_disk_write(_record_evidence, data_dir, [], batch, accepted)
        await _finish_disk_write(_update_status, data_dir)
        pending.clear()
        await _finish_disk_write(_save, data_dir, report)

    for index, target in enumerate(targets):
        try:
            raw, adjusted = await fetch(data_dir, target.code, target.start, target.end)
            if raw.is_empty():
                report.unresolved[target.code] = len(target.missing)
                await _finish_disk_write(_record_evidence, data_dir, [], [(target, raw, adjusted)])
            else:
                pending.append((target, raw, adjusted))
        except Exception as exc:
            log.exception("manual daily repair failed: %s", target.code)
            report.errors[target.code] = str(exc)[:200]
        report.summary.checked = index + 1
        if len(pending) >= _BATCH_SIZE:
            progress(index, len(targets), "보충 일봉 저장 중")
            await flush()
        if (index + 1) % _BATCH_SIZE == 0:
            await _finish_disk_write(_save, data_dir, report)
        progress(index + 1, len(targets), "과거 일봉 보충 중")
    progress(len(targets), len(targets), "보충 일봉 저장 중")
    await flush()


async def run_refresh(data_dir: Path, *, progress, report: RefreshReport | None = None,
                      fetch=None) -> ScreenerRefreshSummary:
    """One server-owned job. Failed/unavailable codes remain visible and retry next click."""
    report = report or RefreshReport()
    if fetch is None:
        async def fetch(data_dir, code, start, end):
            return await fetch_pair(data_dir, code, start, end, allow_empty=True)

    try:
        progress(0, 0, "종목 목록 확인 중")
        master = await symbols.refresh(path=resolve_symbol_master_path(), data_dir=data_dir)
        if master.status != "fresh":
            report.summary.reason = "master_refresh_failed"
            raise RuntimeError(f"symbol master refresh failed: {master.reason}")
        report.summary.master_refreshed = True
        report.summary.symbols_added = await _finish_disk_write(
            screener_store.merge_roster_from_master,
            data_dir / "screener" / "stocks.parquet",
            [(hit.code, hit.name, hit.market, hit.security_type in {"etf", "etn"}) for hit in master.symbols])
        await _finish_disk_write(_record_evidence, data_dir, master.symbols)
        await _finish_disk_write(_update_status, data_dir)
        progress(0, 0, "종목별 누락 확인 중")
        targets = await asyncio.to_thread(plan_repairs, data_dir, master.symbols, completed_day())
        report.summary.total = len(targets)
        await _finish_disk_write(_save, data_dir, report)
        progress(0, len(targets), "과거 일봉 보충 중")
        await _collect_targets(data_dir, targets, report, progress, fetch)
        if report.errors or report.unresolved:
            report.summary.reason = "partial"
        return report.summary
    except asyncio.CancelledError:
        report.summary.reason = "cancelled"
        raise
    except TradingDayUnavailableError as exc:
        report.summary.reason = ("calendar_coverage_behind" if exc.code is UpstreamCode.TRADING_DAYS_STALE
                                 else "calendar_source_missing")
        raise
    except Exception:
        report.summary.reason = report.summary.reason or "error"
        raise
    finally:
        report.summary.completed_ms = int(time.time() * 1000)
        await _finish_disk_write(_save, data_dir, report)
