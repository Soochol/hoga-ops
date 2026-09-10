"""Server-owned historical OHLCV collection. Fetch outside the shared commit lock."""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
from pathlib import Path

import polars as pl
from fastapi import APIRouter, HTTPException

from hoga.api import screener_history_coverage as coverage, screener_universe, symbols
from hoga.api.models import HistoryCoverage, HistoryJob, ScanRequest
from hoga.api.screener_calendar import completed_day
from hoga.api.screener_history_state import ACTIVE_STATUSES, JobCheckpoint, create_job
from hoga.api.screener_history_storage import DailyPair, commit_verified, recover_publication, verified_factors
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
_COMMIT_BATCH = 20
_MAX_EXTENSION_RETRIES = 2
_tasks: dict[str, asyncio.Task] = {}
_gates: dict[str, asyncio.Lock] = {}
_stopping: set[str] = set()


async def _finish_disk_write(fn, *args):
    """Cancellation cannot stop a thread: drain publication before releasing ownership."""
    task = asyncio.create_task(asyncio.to_thread(fn, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        except Exception:
            log.exception("historical publication failed during shutdown")
        raise


async def shutdown_jobs(data_dir: Path) -> None:
    key = str(data_dir)
    _stopping.add(key)
    async with _gates.setdefault(key, asyncio.Lock()):
        task = _tasks.get(key)
        if task is not None:
            if not task.done():
                task.cancel()
            results = await asyncio.gather(task, return_exceptions=True)
            if isinstance(results[0], Exception):
                log.error("historical job failed during shutdown", exc_info=results[0])
            _tasks.pop(key, None)
        # A task cancelled before its first instruction never enters run_job's finally.
        try:
            job = JobCheckpoint(data_dir).load()
            if job is not None and job.status in ACTIVE_STATUSES:
                job.status = "interrupted"
                job.current_code = None
                _save(data_dir, job)
        except (OSError, ValueError):
            # A broken checkpoint/disk must not prevent vendor and DB teardown.
            log.exception("historical shutdown checkpoint failed")


def selected_codes(data_dir: Path, req: ScanRequest) -> list[str]:
    path = data_dir / "screener" / "stocks.parquet"
    if not path.exists():
        return []
    return screener_universe.codes_for_universe(
        path, req.universe,
        scope=screener_universe.scope_codes(data_dir, req.universe.scopes),
        etf_codes=symbols.all_etf_etn_codes() if req.universe.exclude_etf else None)


def preview(data_dir: Path, req: ScanRequest):
    if not coverage.history_leaves(req.conditions):
        raise ValueError("날짜 범위 조건이 필요합니다")
    return coverage.evaluate(data_dir, req.conditions, selected_codes(data_dir, req)).coverage


def load_job(data_dir: Path) -> HistoryJob | None:
    job = JobCheckpoint(data_dir).load()
    task = _tasks.get(str(data_dir))
    if job is not None and job.status in ACTIVE_STATUSES and (task is None or task.done()):
        job.status = "interrupted"
    return job


def _save(data_dir: Path, job: HistoryJob):
    JobCheckpoint(data_dir).save(job)


def _candles_frame(code, candles, start, end):
    rows = []
    for c in candles:
        day = dt.datetime.fromtimestamp(c.t_ms / 1000, KST).date()
        if start <= day <= end:
            rows.append(dict(code=code, date=day, open=float(c.open), high=float(c.high),
                             low=float(c.low), close=float(c.close), volume=int(c.volume)))
    return pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA).sort("date")


async def fetch_pair(data_dir: Path, code: str, start: dt.date, end: dt.date):
    from hoga.live import kiwoom_access, kiwoom_daily_candles, kiwoom_rest_runtime  # noqa: PLC0415 — runtime import

    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        raise ValueError("kiwoom_credentials_unavailable")
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
    as_of = dt.datetime.now(KST).strftime("%Y%m%d")
    frames = []
    for adjust in (False, True):
        def run_page(fetch_fn, page_idx, adjusted=adjust):
            return kiwoom_access.run_with_capacity(
                scheduler, key=("screener-history", code, adjusted, page_idx),
                api_id=kiwoom_daily_candles.API_ID, priority="background",
                client=client, fetch_fn=fetch_fn)
        result = await kiwoom_daily_candles.fetch_daily_candles(
            client, code, start.strftime("%Y%m%d"), end.strftime("%Y%m%d"),
            adjust=adjust, adjusted_as_of=as_of if adjust else None, run_page=run_page)
        if result.violations:
            raise ValueError("vendor_invalid_rows")
        frames.append(_candles_frame(code, result.candles, start, end))
    verified_factors(*frames)
    return tuple(frames)


async def flush_batch(data_dir: Path, job: HistoryJob, pending: list[DailyPair], fetch=fetch_pair):
    if not pending:
        return
    job.status = "deriving"
    _save(data_dir, job)
    # All extended codes are refetched together, at most twice per code. Already
    # published successes never re-enter a retry batch.
    for attempt in range(_MAX_EXTENSION_RETRIES + 1):
        try:
            result = await _finish_disk_write(commit_verified, data_dir, list(pending))
        except Exception as exc:
            log.exception("historical batch publication failed")
            job.errors.update({raw["code"][0]: str(exc)[:200] for raw, _ in pending})
            break
        job.written_rows += result.written_rows
        job.errors.update(result.errors)
        pending.clear()
        for code, extension in result.extensions.items():
            if attempt == _MAX_EXTENSION_RETRIES or job.cancel_requested:
                job.errors[code] = str(extension)
                continue
            try:
                pair = await fetch(data_dir, code, extension.start, max(extension.end, completed_day()))
                pending.append(pair)
            except Exception as exc:
                log.exception("historical extension fetch failed: %s", code)
                job.errors[code] = str(exc)[:200]
        if not pending:
            break
    pending.clear()
    _save(data_dir, job)


async def run_job(data_dir: Path, job: HistoryJob, fetch=fetch_pair):
    req = job.request
    try:
        # Complete already validated staged writes before planning any vendor work.
        await _finish_disk_write(recover_publication, data_dir)
        # A failed publication is retried from authoritative disk observations by the same
        # collection operation, not treated as proof that the missing interval is complete.
        report = await asyncio.to_thread(coverage.evaluate, data_dir, req.conditions, job.codes)
        ranges = report.collection_starts
        raw_path = data_dir / "screener" / "daily_unadjusted.parquet"
        bounds = {}
        if raw_path.exists():
            frame = await asyncio.to_thread(lambda: pl.scan_parquet(raw_path)
                                           .group_by("code").agg(pl.col("date").min().alias("first"),
                                                                  pl.col("date").max().alias("last")).collect())
            bounds = {code: (first, last) for code, first, last in frame.iter_rows()}
        job.total = len(ranges)
        pending = []
        for code, lower in ranges.items():
            current = load_job(data_dir)
            if current and current.cancel_requested:
                await flush_batch(data_dir, job, pending, fetch)
                job.status = "interrupted"
                _save(data_dir, job)
                return
            job.status = "collecting"
            job.current_code = code
            _save(data_dir, job)
            first, last = bounds.get(code, (dt.date.max, dt.date.min))
            start = min(lower, first)
            # Fetch through the last completed day so replacing a code's factors cannot
            # mix adjustment bases with the newer existing corpus.
            end = max(completed_day(), last)
            try:
                pair = await fetch(data_dir, code, start, end)
                pending.append(pair)
                if len(pending) >= _COMMIT_BATCH:
                    await flush_batch(data_dir, job, pending, fetch)
            except Exception as exc:
                log.exception("historical collection failed: %s", code)
                job.errors[code] = str(exc)[:200]
            job.done += 1
            _save(data_dir, job)
        await flush_batch(data_dir, job, pending, fetch)
        report = await asyncio.to_thread(coverage.evaluate, data_dir, req.conditions, job.codes)
        job.coverage = report.coverage
        job.status = "partial" if job.errors or report.coverage.incomplete else "complete"
    except asyncio.CancelledError:
        job.status = "interrupted"
        raise
    except Exception as exc:
        log.exception("historical collection job failed")
        job.status = "failed"
        job.errors["job"] = str(exc)[:200]
    finally:
        job.current_code = None
        _save(data_dir, job)


def build_router(data_dir: Path):
    _stopping.discard(str(data_dir))
    router = APIRouter(prefix="/history")

    @router.post("/preview")
    async def history_preview(req: ScanRequest) -> HistoryCoverage:
        try:
            return await asyncio.to_thread(preview, data_dir, req)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get("/jobs/current")
    async def current() -> HistoryJob | None:
        return load_job(data_dir)

    @router.post("/jobs")
    async def create(req: ScanRequest) -> HistoryJob:
        key = str(data_dir)
        async with _gates.setdefault(key, asyncio.Lock()):
            if key in _stopping:
                raise HTTPException(503, "서버 종료 중입니다")
            active = load_job(data_dir)
            if active and active.status in ACTIVE_STATUSES:
                if active.request != req:
                    raise HTTPException(409, "다른 과거 일봉 수집이 진행 중입니다")
                return active
            await history_preview(req)
            codes = (active.codes if active and active.status == "interrupted"
                     and active.request == req
                     else await asyncio.to_thread(selected_codes, data_dir, req))
            job = create_job(req, codes)
            _save(data_dir, job)
            _tasks[key] = asyncio.create_task(run_job(data_dir, job))
            return job

    @router.get("/jobs/{job_id}")
    async def get(job_id: str) -> HistoryJob:
        job = load_job(data_dir)
        if job is None or job.id != job_id:
            raise HTTPException(404, "수집 작업을 찾을 수 없습니다")
        return job

    @router.post("/jobs/{job_id}/cancel")
    async def cancel(job_id: str) -> HistoryJob:
        job = await get(job_id)
        job.cancel_requested = True
        _save(data_dir, job)
        return job

    return router
