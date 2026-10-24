"""Explicit v2 preparation. It never invokes the legacy corpus publisher."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from pathlib import Path

from hoga.api import (
    screener_series_eval as evaluation,
    screener_series_store as store,
    screener_series_values as values,
    trading_days,
)
from hoga.api.models import HistoryCoverage, HistoryCoverageItem, HistoryJob
from hoga.api.screener_calendar import completed_day
from hoga.api.screener_depth import DEPTH_TYPES
from hoga.api.screener_expression import active_conditions
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)


def plans(data_dir, req):
    now = dt.datetime.now(KST)
    days = [dt.datetime.strptime(day, "%Y%m%d").date() for day in sorted(trading_days.trading_days(data_dir))]
    expected = [
        day
        for leaf in active_conditions(req.conditions, req.expression)
        if leaf.type not in DEPTH_TYPES and not getattr(leaf.params, "timeframe", "D").endswith("m")
        for window, _ in evaluation._windows(leaf, days, now)
        for bucket, _, _ in window
        for day in bucket
    ]
    if not expected:
        raise ValueError("준비할 일/주/월봉 비교 구간이 없습니다")
    first = min(expected)
    if any(leaf.type == "change_pct" for leaf in active_conditions(req.conditions, req.expression)):
        prior = [day for day in days if day < first]
        first = prior[-1] if prior else first
    return first, max(expected)


def preview(data_dir, req):
    from hoga.api.screener_history_jobs import selected_codes  # noqa: PLC0415

    first, last = plans(data_dir, req)
    codes = selected_codes(data_dir, req)
    pinned = store.load_snapshot(data_dir, req.snapshot_id)
    if pinned is None:
        failures = [
            HistoryCoverageItem(
                code=code,
                condition_id="series_v2",
                required_from=first.isoformat(),
                required_to=last.isoformat(),
                missing_days=0,
                reason="separate_bases_preparation_required",
            )
            for code in codes
        ]
    else:
        from hoga.api.screener_series_runner import calendar_evaluate  # noqa: PLC0415

        _, _, absent = calendar_evaluate(data_dir, req, pinned, codes, dt.datetime.now(KST))
        failures = [
            HistoryCoverageItem(
                code=x.code,
                condition_id=x.condition_id,
                required_from=first.isoformat(),
                required_to=last.isoformat(),
                missing_days=x.missing_days or 0,
                reason=x.reason,
            )
            for x in absent
        ]
    return HistoryCoverage(total=len(codes), complete=len(codes) - len({x.code for x in failures}), incomplete=failures)


def _prepared(data_dir, pinned, code, required):
    if pinned is None or code not in pinned[1]["observations"]:
        return False
    old = store.read_object(data_dir, pinned[1]["observations"][code])
    prices = {row["date"] for row in old["adjusted"] if values.valid_price(row) and row.get("complete", True)}
    return required <= prices and old["adjusted_as_of"] == dt.datetime.now(KST).date().isoformat()


async def run_job(data_dir: Path, job: HistoryJob):
    from hoga.api.screener_history_jobs import fetch_pair  # noqa: PLC0415
    from hoga.api.screener_history_state import JobCheckpoint  # noqa: PLC0415
    from hoga.api.screener_series_runner import run_scan  # noqa: PLC0415

    checkpoint = JobCheckpoint(data_dir)
    try:
        first, last = await asyncio.to_thread(plans, data_dir, job.request)
        baseline = await asyncio.to_thread(store.ensure_baseline, data_dir)
        job.total = len(job.codes)
        # Reuse completed observations on resume; a failed symbol remains retryable.
        pinned = await asyncio.to_thread(store.load_snapshot, data_dir)
        manifest = pinned[1] if pinned else {"baseline": baseline, "observations": {}, "quantity": {}}
        original = await asyncio.to_thread(values.load_series, data_dir, manifest, job.codes, first=first, last=last)
        required = {
            day
            for day in trading_days.trading_days(data_dir)
            if first.strftime("%Y%m%d") <= day <= last.strftime("%Y%m%d")
        }
        required = {dt.datetime.strptime(day, "%Y%m%d").date().isoformat() for day in required}
        for code in job.codes:
            current = checkpoint.load()
            if current and current.cancel_requested:
                job.status = "interrupted"
                return
            job.current_code, job.status = code, "collecting"
            checkpoint.save(job)
            old_rows = set(original[code].original) if code in original else set()
            if await asyncio.to_thread(_prepared, data_dir, pinned, code, required):
                job.done += 1
                checkpoint.save(job)
                continue
            try:
                unadjusted, _ = await fetch_pair(
                    data_dir, code, first, last, allow_empty=True, calculation_policy="separate_bases_v2"
                )
                job.written_rows += sum(day not in old_rows and day <= completed_day() for day in unadjusted["date"])
            except Exception as exc:
                log.exception("separate bases preparation failed: %s", code)
                job.errors[code] = str(exc)[:200]
            job.done += 1
            checkpoint.save(job)
        result = await run_scan(data_dir=data_dir, req=job.request, now=dt.datetime.now(KST))
        absent = result.bar_coverage.incomplete if result.bar_coverage else []
        job.coverage = HistoryCoverage(
            total=len(job.codes),
            complete=len(job.codes) - len({x.code for x in absent}),
            incomplete=[
                HistoryCoverageItem(
                    code=x.code,
                    condition_id=x.condition_id,
                    required_from=first.isoformat(),
                    required_to=last.isoformat(),
                    missing_days=x.missing_days or 0,
                    reason=x.reason,
                )
                for x in absent
            ],
        )
        job.status = "partial" if job.errors or absent else "complete"
    except asyncio.CancelledError:
        job.status = "interrupted"
        raise
    except Exception as exc:
        log.exception("separate bases preparation interrupted")
        job.errors["job"], job.status = str(exc)[:200], "failed"
    finally:
        job.current_code = None
        checkpoint.save(job)
