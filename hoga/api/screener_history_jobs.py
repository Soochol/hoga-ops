"""Server-owned historical OHLCV collection. Fetch outside the shared commit lock."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import tempfile
import time
import uuid
from pathlib import Path

import polars as pl
from fastapi import APIRouter, HTTPException

from hoga.api import screener_factors, screener_history_coverage as coverage, screener_universe, symbols
from hoga.api.models import HistoryCoverage, HistoryJob, ScanRequest
from hoga.api.screener_store import _DAILY_PL_SCHEMA, derive_adjusted
from hoga.api.screener_write_lock import publish_history, screener_write_lock
from hoga.util.atomic_write import atomic_write_json, atomic_write_parquet_df
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
_COMMIT_BATCH = 20
_MAX_EXTENSION_RETRIES = 2
_ACTIVE = {"queued", "collecting", "deriving"}
_tasks: dict[str, asyncio.Task] = {}
_gates: dict[str, asyncio.Lock] = {}


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
        raise ValueError("날짜 범위 신고거래량 조건이 필요합니다")
    return coverage.evaluate(data_dir, req.conditions, selected_codes(data_dir, req)).coverage


def _job_path(data_dir: Path) -> Path:
    return data_dir / "screener" / "history_job.json"


def load_job(data_dir: Path):
    path = _job_path(data_dir)
    if not path.exists():
        return None
    job = json.loads(path.read_text())
    task = _tasks.get(str(data_dir))
    if job["status"] in _ACTIVE and (task is None or task.done()):
        job["status"] = "interrupted"
    return job


def _save(data_dir: Path, job):
    path = _job_path(data_dir)
    if path.exists():
        existing = json.loads(path.read_text())
        if existing.get("id") == job["id"] and existing.get("cancel_requested"):
            job["cancel_requested"] = True
    atomic_write_json(_job_path(data_dir), job)


def _candles_frame(code, candles, start, end):
    rows = []
    for c in candles:
        day = dt.datetime.fromtimestamp(c.t_ms / 1000, KST).date()
        if start <= day <= end:
            rows.append(dict(code=code, date=day, open=float(c.open), high=float(c.high),
                             low=float(c.low), close=float(c.close), volume=int(c.volume)))
    return pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA).sort("date")


def verified_factors(raw: pl.DataFrame, adjusted: pl.DataFrame) -> pl.DataFrame:
    """Validate the actual disk derivation, including volume (not just close ratios)."""
    if raw.is_empty() or set(raw["date"]) != set(adjusted["date"]):
        raise ValueError("vendor_history_incomplete")
    code = raw["code"][0]
    pairs = screener_factors.pair_raw_adj(
        list(zip(raw["date"], raw["close"], strict=True)),
        list(zip(adjusted["date"], adjusted["close"], strict=True)))
    segments = screener_factors.compute_factor_segments(pairs)
    if not segments:
        raise ValueError("factor_unavailable")
    factors = screener_factors.segments_to_frame({code: segments})
    derived = screener_factors.apply_factors(raw, factors).sort("date")
    expected = adjusted.sort("date")
    for actual, target in zip(derived.iter_rows(named=True), expected.iter_rows(named=True), strict=True):
        # Exact volume is necessary: even a small error can move a record date.
        if actual["volume"] != target["volume"]:
            raise ValueError("adjusted_volume_mismatch")
        if any(abs(actual[k] - target[k]) > max(1, abs(target[k]) * .001)
               for k in ("open", "high", "low", "close")):
            raise ValueError("adjusted_price_mismatch")
    return factors


class HistoryCorpusExtended(ValueError):
    """The disk corpus grew outside the fetched pair; retry without holding the lock."""

    def __init__(self, code: str, start: dt.date, end: dt.date):
        super().__init__("history_changed_during_collection")
        self.code, self.start, self.end = code, start, end


def completed_day() -> dt.date:
    from hoga.api.screener import _SCREENER_EOD_CUTOFF_HOUR  # noqa: PLC0415 — shared EOD policy

    now = dt.datetime.now(KST)
    return now.date() if now.hour >= _SCREENER_EOD_CUTOFF_HOUR else now.date() - dt.timedelta(days=1)


def commit_verified(data_dir: Path, batch: list[tuple[pl.DataFrame, pl.DataFrame]]) -> int:
    sdir = data_dir / "screener"
    with screener_write_lock(sdir):
        up = sdir / "daily_unadjusted.parquet"
        fp = sdir / "factors.parquet"
        base = pl.read_parquet(up) if up.exists() else pl.DataFrame(schema=_DAILY_PL_SCHEMA)
        factors = screener_factors.read_factors(fp)
        added = 0
        for raw, adjusted in batch:
            code = raw["code"][0]
            existing = base.filter(pl.col("code") == code)
            if not existing.is_empty() and (
                existing["date"].min() < raw["date"].min()
                or existing["date"].max() > raw["date"].max()
            ):
                raise HistoryCorpusExtended(
                    code, min(existing["date"].min(), raw["date"].min()),
                    max(existing["date"].max(), raw["date"].max()))
            # Preserve existing observations; a discrepancy must not silently rewrite history.
            merged = pl.concat([raw, existing]).unique(subset=["code", "date"], keep="last").sort("date")
            fresh = verified_factors(merged, adjusted)
            added += merged.height - existing.height
            base = pl.concat([base.filter(pl.col("code") != code), merged])
            kept = factors.filter(pl.col("code") != code) if factors is not None else fresh.head(0)
            factors = pl.concat([kept, fresh])
        # Recoverable publish: adjusted remains the last complete snapshot until derive succeeds.
        with tempfile.TemporaryDirectory(prefix="history-stage-", dir=sdir) as directory:
            staging = Path(directory)
            atomic_write_parquet_df(staging / up.name, base.sort(["code", "date"]))
            if factors is not None:
                screener_factors.write_factors(factors, staging / fp.name)
            derive_adjusted(staging / up.name, staging / "daily_adjusted.parquet",
                            factors_path=staging / fp.name, unadjusted_df=base)
            publish_history(sdir, staging)
        return added


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


async def flush_batch(data_dir, job, pending, fetch=fetch_pair):
    if not pending:
        return
    job["status"] = "deriving"
    _save(data_dir, job)
    try:
        retries: dict[str, int] = {}
        for _ in range(_MAX_EXTENSION_RETRIES * len(pending) + 1):
            try:
                job["written_rows"] += await asyncio.to_thread(commit_verified, data_dir, list(pending))
                break
            except HistoryCorpusExtended as exc:
                attempts = retries.get(exc.code, 0)
                if attempts == _MAX_EXTENSION_RETRIES:
                    raise
                retries[exc.code] = attempts + 1
                # commit_verified has released the writer lock before any REST await.
                pair = await fetch(data_dir, exc.code, exc.start, max(exc.end, completed_day()))
                pending[:] = [pair if raw["code"][0] == exc.code else (raw, adjusted)
                              for raw, adjusted in pending]
    except Exception as exc:
        log.exception("historical batch publication failed")
        for raw, _ in pending:
            job["errors"][raw["code"][0]] = str(exc)[:200]
    pending.clear()
    _save(data_dir, job)


def recover_publication(data_dir: Path):
    with screener_write_lock(data_dir / "screener"):
        pass


async def run_job(data_dir: Path, job, fetch=fetch_pair):
    req = ScanRequest.model_validate(job["request"])
    try:
        # Complete already validated staged writes before planning any vendor work.
        await asyncio.to_thread(recover_publication, data_dir)
        # A failed publication is retried from authoritative disk observations by the same
        # collection operation, not treated as proof that the missing interval is complete.
        report = await asyncio.to_thread(coverage.evaluate, data_dir, req.conditions, job["codes"])
        ranges = {}
        for item in report.coverage.incomplete:
            if item.reason not in {"missing_history", "factor_unavailable"}:
                job["errors"][item.code] = item.reason
                continue
            old = ranges.get(item.code)
            ranges[item.code] = min(item.required_from, old) if old else item.required_from
        raw_path = data_dir / "screener" / "daily_unadjusted.parquet"
        bounds = {}
        if raw_path.exists():
            frame = await asyncio.to_thread(lambda: pl.scan_parquet(raw_path)
                                           .group_by("code").agg(pl.col("date").min().alias("first"),
                                                                  pl.col("date").max().alias("last")).collect())
            bounds = {code: (first, last) for code, first, last in frame.iter_rows()}
        job["total"] = len(ranges)
        pending = []
        for code, lower in ranges.items():
            current = load_job(data_dir)
            if current and current.get("cancel_requested"):
                await flush_batch(data_dir, job, pending, fetch)
                job["status"] = "interrupted"
                _save(data_dir, job)
                return
            job["status"] = "collecting"
            job["current_code"] = code
            _save(data_dir, job)
            first, last = bounds.get(code, (dt.date.max, dt.date.min))
            start = min(dt.date.fromisoformat(lower), first)
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
                job["errors"][code] = str(exc)[:200]
            job["done"] += 1
            _save(data_dir, job)
        await flush_batch(data_dir, job, pending, fetch)
        report = await asyncio.to_thread(coverage.evaluate, data_dir, req.conditions, job["codes"])
        job["coverage"] = report.coverage.model_dump()
        job["status"] = "partial" if job["errors"] or report.coverage.incomplete else "complete"
    except Exception as exc:
        log.exception("historical collection job failed")
        job["status"] = "failed"
        job["errors"]["job"] = str(exc)[:200]
    finally:
        job["current_code"] = None
        _save(data_dir, job)


def build_router(data_dir: Path):
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
            active = load_job(data_dir)
            if active and active["status"] in _ACTIVE:
                if active["request"] != req.model_dump(mode="json"):
                    raise HTTPException(409, "다른 과거 일봉 수집이 진행 중입니다")
                return active
            await history_preview(req)
            codes = (active["codes"] if active and active["status"] == "interrupted"
                     and active["request"] == req.model_dump(mode="json")
                     else await asyncio.to_thread(selected_codes, data_dir, req))
            job = dict(id=uuid.uuid4().hex, status="queued", request=req.model_dump(mode="json"),
                       codes=codes,
                       total=0, done=0, written_rows=0, errors={}, current_code=None,
                       started_at_ms=int(time.time()*1000))
            _save(data_dir, job)
            _tasks[key] = asyncio.create_task(run_job(data_dir, job))
            return job

    @router.get("/jobs/{job_id}")
    async def get(job_id: str) -> HistoryJob:
        job = load_job(data_dir)
        if job is None or job["id"] != job_id:
            raise HTTPException(404, "수집 작업을 찾을 수 없습니다")
        return job

    @router.post("/jobs/{job_id}/cancel")
    async def cancel(job_id: str) -> HistoryJob:
        job = await get(job_id)
        job["cancel_requested"] = True
        _save(data_dir, job)
        return job

    return router
