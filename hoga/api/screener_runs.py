"""User-initiated searches own automatic preparation, independently of HTTP lifetimes."""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import json
import logging
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import (
    screener_history_jobs as history,
    screener_rankings,
    screener_runner,
    screener_series_store as store,
    trading_days,
)
from hoga.api.models import ScanRequest, ScreenerRun
from hoga.api.screener_preparation import DAILY_ATTEMPTS, RETRY_SECONDS, DailyPreparation, PreparationDeferred
from hoga.api.screener_preparation_plan import daily_leaves, plan
from hoga.api.screener_run_results import RunResults
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

ACTIVE = {"queued", "preparing"}
MAX_RUNS = 32
RESULT_INTERVAL = 1.
log = logging.getLogger(__name__)


def _stamp(path):
    if not path.exists():
        return None
    stat = path.stat()
    return stat.st_ino, stat.st_mtime_ns, stat.st_size


class ScreenerRuns:
    def __init__(self, data_dir: Path, *, volume_runtime=None, preparation=None, clock=None, pause=None):
        self.data_dir = data_dir
        self.clock = clock or (lambda: dt.datetime.now(KST))
        self.pause = pause or asyncio.sleep
        self.preparation = preparation or DailyPreparation(data_dir, clock=self.clock)
        self.volume_runtime = volume_runtime
        self.tasks: dict[str, asyncio.Task] = {}
        self.blockers = {}
        self.results = {}
        self.gate = asyncio.Lock()
        self.legacy_gate = asyncio.Lock()
        self.closing = False

    def _path(self, identity):
        if not re.fullmatch(r"[a-f0-9]{32}", identity):
            raise ValueError("검색 실행 ID가 올바르지 않습니다")
        return self.data_dir / "screener" / "runs" / f"{identity}.json"

    def _context(self, req):
        codes = history.selected_codes(self.data_dir, req)
        pinned = store.load_snapshot(self.data_dir)
        manifest = pinned[1] if pinned else {}
        context = store.digest([codes, _stamp(self.data_dir / "screener/stocks.parquet"),
                                sorted(trading_days.trading_days(self.data_dir)),
                                manifest.get("quantity", {}), manifest.get("corrections", {}),
                                _stamp(self.data_dir / "screener" / (
                                    "exclusions.v2.json" if req.calculation_policy == "separate_bases_v2"
                                    else "exclusions.json"))])
        return codes, context

    def _save(self, run, codes, context, clock):
        run.updated_at_ms = int(time.time() * 1000)
        atomic_write_json(self._path(run.id), dict(run=run.model_dump(mode="json"), codes=codes,
                                                  context=context, clock=clock.isoformat()))

    def read(self, identity):
        value = json.loads(self._path(identity).read_bytes())
        run = ScreenerRun.model_validate(value["run"])
        task = self.tasks.get(identity)
        if run.status in ACTIVE and (task is None or task.done()):
            run.status = "interrupted"
        return run

    async def start(self, req):
        async with self.gate:
            if self.closing:
                raise HTTPException(503, "서버 종료 중입니다")
            now = self.clock()
            codes, context = await asyncio.to_thread(self._context, req)
            key = store.digest([req.model_dump(mode="json"), context, now.date().isoformat()])
            index = self.data_dir / "screener/runs/requests" / f"{key}.json"
            previous_id = (await asyncio.to_thread(DailyPreparation._read, index)).get("id")
            previous = await asyncio.to_thread(self.read, previous_id) if previous_id else None
            if previous and previous.id in self.tasks and not self.tasks[previous.id].done():
                return previous
            if sum(not task.done() for task in self.tasks.values()) >= MAX_RUNS:
                raise HTTPException(429, "검색 준비 작업이 많습니다. 잠시 후 다시 조회하세요")
            resuming = previous is not None and previous.status == "interrupted"
            identity = previous.id if resuming else uuid.uuid4().hex
            if resuming:
                checkpoint = await asyncio.to_thread(DailyPreparation._read, self._path(identity))
                now = dt.datetime.fromisoformat(checkpoint["clock"])
            run = ScreenerRun(id=identity, status="queued", request=req, total=len(codes), preparing=len(codes),
                              revision=previous.revision + 1 if resuming else 0,
                              result_revision=previous.result_revision if resuming else 0,
                              started_at_ms=int(now.timestamp() * 1000), updated_at_ms=int(time.time() * 1000))
            await asyncio.to_thread(self._save, run, codes, context, now)
            await asyncio.to_thread(atomic_write_json, index, {"id": identity})
            task = asyncio.create_task(self._run(run, codes, context, now))
            self.tasks[identity] = task
            task.add_done_callback(lambda completed: self._finished(identity, completed))
            return run.model_copy(deep=True)

    def _finished(self, identity, task):
        if self.tasks.get(identity) is task:
            self.tasks.pop(identity, None)
            self.blockers.pop(identity, None)
            self.results.pop(identity, None)
        if not task.cancelled():
            task.exception()

    async def _check(self, req, context, clock):
        if self.closing or self.clock().date() != clock.date():
            raise InterruptedError("검색 준비 중 날짜가 바뀌었습니다. 다시 조회해 주세요")
        _, current = await asyncio.to_thread(self._context, req)
        if current != context:
            raise InterruptedError("종목 범위·달력·제외 목록이 변경되었습니다. 다시 조회해 주세요")

    async def _evaluate(self, run, codes, pending, clock):
        if run.request.calculation_policy == "separate_bases_v2":
            pinned = await asyncio.to_thread(store.load_snapshot, self.data_dir, run.request.snapshot_id)
            cache = self.results.setdefault(
                run.id, RunResults(self.data_dir, self.volume_runtime, live_clock=self.clock))
            result = await cache.evaluate(run.request, codes, pending, clock, pinned, self.blockers.get(run.id, []))
        else:
            result = await screener_runner.run_screener_scan(data_dir=self.data_dir, req=run.request, now=clock,
                                                            volume_runtime=self.volume_runtime)
        coverage = (result.bar_coverage if run.request.calculation_policy == "separate_bases_v2"
                    else result.history_coverage)
        if coverage:
            present = {(item.code, item.condition_id, item.reason) for item in coverage.incomplete}
            coverage.incomplete.extend(item for item in self.blockers.get(run.id, [])
                                       if (item.code, item.condition_id, item.reason) not in present)
            coverage.complete = coverage.total - len({item.code for item in coverage.incomplete})
        unavailable = {item.code for item in coverage.incomplete} if coverage else set()
        deferred = {code for code, reason in run.errors.items() if reason.startswith("재시도 대기 ·")}
        failed = set(run.errors) & set(codes) - deferred
        waiting = (unavailable | deferred) - pending - failed
        run.preparing, run.failed, run.waiting = len(pending), len(failed), len(waiting)
        run.evaluated = len(set(codes) - pending - failed - waiting)
        run.result = result
        run.revision += 1
        run.result_revision = run.revision

    async def _plan(self, run, codes, clock):
        rank_eval = None
        if screener_rankings.leaves(run.request):
            rank_eval = await screener_rankings.evaluate(self.data_dir, run.request, self.clock(), None)
            screener_rankings.validate_stored_conditions(run.request, rank_eval)
        if run.request.snapshot_id is None and daily_leaves(run.request) and codes:
            await history._finish_disk_write(
                lambda: store.publish_pairs(self.data_dir, [], adjusted_as_of=clock.date().isoformat()))
            # Historical rankings prepare candidates only up to their cutoff.
            # Live ranks may change while collection runs, so prepare the full
            # requested population for them and keep fetching current ranks.
            historical = rank_eval is not None and rank_eval.historical
            population = screener_rankings.candidate_codes(run.request, codes, rank_eval) if historical else codes
            prepared = await asyncio.to_thread(
                plan, self.data_dir, run.request, population, clock, rank_eval.cutoff if historical else None)
            self.blockers[run.id] = prepared.blocked
            return prepared.targets
        return {}

    async def _run(self, run, codes, context, clock):
        workers = []
        try:
            await self._check(run.request, context, clock)
            if run.request.calculation_policy != "separate_bases_v2":
                await self._legacy(run, codes, context, clock)
                return
            if not (self.data_dir / "screener/stocks.parquet").exists():
                raise ValueError("스크리너 기준선 데이터가 없습니다")
            gaps = await self._plan(run, codes, clock)
            pending = set(gaps)
            run.status = "preparing"
            await self._evaluate(run, codes, pending, clock)
            await asyncio.to_thread(self._save, run, codes, context, clock)
            if not pending:
                run.status = "partial" if run.waiting or run.failed else "complete"
                return
            events = asyncio.Queue()
            iterator = iter(gaps.items())

            workers = [asyncio.create_task(self._worker(iterator, clock, events)) for _ in range(4)]
            await self._consume(run, codes, context, clock, pending, events, gaps, workers)
            await asyncio.gather(*workers)
            await self._check(run.request, context, clock)
            await self._evaluate(run, codes, set(), clock)
            run.status = "partial" if run.waiting or run.failed else "complete"
        except asyncio.CancelledError:
            run.status = "interrupted"
            raise
        except InterruptedError as exc:
            run.status = "interrupted"
            run.errors["run"] = str(exc)
        except Exception as exc:
            log.exception("automatic screener run failed")
            run.status = "failed"
            run.errors["run"] = str(exc)[:200]
        finally:
            for worker in workers:
                if not worker.done():
                    worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            run.next_retry_at_ms = None
            run.revision += 1
            await history._finish_disk_write(self._save, run, codes, context, clock)

    async def _worker(self, iterator, clock, events):
        for code, (first, last) in iterator:
            try:
                await self.preparation.prepare(code, first, last, clock.date())
                await events.put((code, None))
            except PreparationDeferred as exc:
                await events.put((code, exc))
            except Exception as exc:
                log.exception("automatic preparation failed: %s", code)
                await events.put((code, exc))

    async def _consume(self, run, codes, context, clock, pending, events, gaps, workers):
        last_result = 0.
        dirty = False
        retries = {}
        while pending:
            await self._check(run.request, context, clock)
            for code, due in list(retries.items()):
                if due <= self.clock().timestamp():
                    retries.pop(code)
                    run.errors.pop(code, None)
                    workers.append(asyncio.create_task(self._worker(iter([(code, gaps[code])]), clock, events)))
                    dirty = True
            if retries and pending <= retries.keys() and events.empty() and not dirty:
                await self.pause(min(60, max(0, min(retries.values()) - self.clock().timestamp())))
                continue
            try:
                code, error = await asyncio.wait_for(events.get(), RESULT_INTERVAL if dirty else 60)
                self._event(run, pending, retries, code, error)
                dirty = True
            except TimeoutError:
                pass
            run.next_retry_at_ms = int(min(retries.values()) * 1000) if retries and pending <= retries.keys() else None
            if dirty and (not pending or time.monotonic() - last_result >= RESULT_INTERVAL):
                await self._check(run.request, context, clock)
                await self._evaluate(run, codes, pending, clock)
                await asyncio.to_thread(self._save, run, codes, context, clock)
                last_result, dirty = time.monotonic(), False

    @staticmethod
    def _event(run, pending, retries, code, error):
        if isinstance(error, PreparationDeferred) and error.retry_at is not None:
            retries[code] = error.retry_at
        else:
            pending.discard(code)
            retries.pop(code, None)
        if error is not None:
            prefix = "재시도 대기 · " if isinstance(error, PreparationDeferred) else ""
            run.errors[code] = prefix + str(error)[:180]
        else:
            run.errors.pop(code, None)

    async def _legacy(self, run, codes, context, clock):
        await self._evaluate(run, codes, set(), clock)
        if run.result.history_coverage and run.result.history_coverage.incomplete and run.request.snapshot_id is None:
            async with self.legacy_gate:
                await self._check(run.request, context, clock)
                active = history.load_job(self.data_dir)
                if active and active.status in history.ACTIVE_STATUSES:
                    task = history._tasks.get(str(self.data_dir))
                    if task:
                        await asyncio.shield(task)
                try:
                    await history._finish_disk_write(self._legacy_budget, run.request, clock)
                except PreparationDeferred as exc:
                    for item in run.result.history_coverage.incomplete:
                        run.errors[item.code] = "재시도 대기 · " + str(exc)
                    await self._evaluate(run, codes, set(), clock)
                    run.status = "partial"
                    return
                job = await history.ensure_job(self.data_dir, run.request)
                task = history._tasks.get(str(self.data_dir))
                if task:
                    await self._legacy_progress(task, run, codes, context, clock)
                job = history.load_job(self.data_dir) or job
                run.errors.update(job.errors)
            await self._evaluate(run, codes, set(), clock)
        run.status = "partial" if run.waiting or run.failed else "complete"

    def _legacy_budget(self, req, clock):
        identity = store.digest(req.model_dump(mode="json"))
        path = self.data_dir / "screener/preparation" / f"legacy-{identity}.json"
        record = DailyPreparation._read(path)
        if record.get("day") != clock.date().isoformat():
            record = {}
        attempts = record.get("attempts", 0)
        if (attempts >= DAILY_ATTEMPTS
                or clock.timestamp() - record.get("attempted_at", 0) < RETRY_SECONDS):
            raise PreparationDeferred("과거 일봉의 재확인 간격·횟수 대기 중입니다")
        atomic_write_json(path, dict(day=clock.date().isoformat(), attempts=attempts + 1,
                                    attempted_at=clock.timestamp()))

    async def _legacy_progress(self, task, run, codes, context, clock):
        run.status = "preparing"
        while not task.done():
            await self._check(run.request, context, clock)
            await self._evaluate(run, codes, set(), clock)
            coverage = run.result.history_coverage
            pending = {item.code for item in coverage.incomplete} if coverage else set()
            run.preparing, run.waiting = len(pending), 0
            run.evaluated = len(codes) - run.preparing
            await asyncio.to_thread(self._save, run, codes, context, clock)
            await asyncio.wait({task}, timeout=RESULT_INTERVAL)
        await asyncio.shield(task)

    async def close(self):
        self.closing = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.preparation.close()


def build_router(owner: ScreenerRuns):
    @contextlib.asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await owner.close()

    router = APIRouter(prefix="/runs", lifespan=lifespan)

    @router.post("")
    async def start(req: ScanRequest) -> ScreenerRun:
        return await owner.start(req)

    @router.get("/{identity}")
    async def read(identity: str, after_revision: int | None = None) -> ScreenerRun:
        try:
            result = await asyncio.to_thread(owner.read, identity)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(404, "검색 실행을 찾을 수 없습니다") from exc
        if after_revision == result.result_revision:
            result.result = None
        return result

    return router
