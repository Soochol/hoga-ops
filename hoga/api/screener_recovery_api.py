"""Server-owned recovery uses the same production client and governor as other reads."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hoga.api import screener_recovery as recovery
from hoga.api.screener_recovery_provider import collector

log = logging.getLogger(__name__)
_tasks: dict[str, tuple[str, asyncio.Task]] = {}
_gates: dict[str, asyncio.Lock] = {}


class RecoveryRunRequest(BaseModel):
    model_config = {"extra": "forbid"}
    resume: bool = False


class RecoveryAccepted(BaseModel):
    plan_id: str
    started: bool


class RecoveryCancellation(BaseModel):
    cancel_requested: bool


def active(data_dir):
    entry = _tasks.get(str(data_dir))
    return entry is not None and not entry[1].done()


def _other_running(data_dir):
    from hoga.api import screener, screener_history_jobs  # noqa: PLC0415 — avoid router assembly cycle

    historical = screener_history_jobs._tasks.get(str(data_dir))
    return ((historical is not None and not historical.done())
            or (screener._job_task is not None and not screener._job_task.done()))


async def _drive(data_dir, plan_id, resume, fetch):
    try:
        await recovery.run(data_dir, plan_id, fetch=fetch, resume=resume)
    except Exception as exc:
        log.exception("recovery owner failed for plan %s", plan_id)
        if isinstance(exc, recovery.RecoveryStop) and str(exc) == "recovery_already_running":
            return
        plan = recovery.load_plan(data_dir, plan_id)
        try:
            job = recovery.load_job(data_dir, plan_id)
        except FileNotFoundError:
            job = recovery.RecoveryJob(plan_id=plan_id, items={t.code: recovery.RecoveryItem() for t in plan.targets})
        job.status, job.error = "failed", str(exc) if isinstance(exc, recovery.RecoveryStop) else type(exc).__name__
        await asyncio.to_thread(recovery._save, data_dir, job)


async def shutdown(data_dir):
    entry = _tasks.pop(str(data_dir), None)
    if entry and not entry[1].done():
        recovery.cancel(data_dir, entry[0])
        entry[1].cancel()
        await asyncio.gather(entry[1], return_exceptions=True)


def _plan(data_dir, plan_id):
    try:
        return recovery.load_plan(data_dir, plan_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, "복구 계획을 찾을 수 없습니다") from exc


def build_router(data_dir: Path, *, fetch=None):
    @contextlib.asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await shutdown(data_dir)

    router = APIRouter(prefix="/recovery", lifespan=lifespan)

    @router.post("/{plan_id}/run", status_code=202)
    async def start(plan_id: str, req: RecoveryRunRequest) -> RecoveryAccepted:
        async with _gates.setdefault(str(data_dir), asyncio.Lock()):
            plan = _plan(data_dir, plan_id)
            if plan.review_binding is not None:
                raise HTTPException(409, "검토 전용 계획은 수집을 실행할 수 없습니다")
            if active(data_dir):
                if _tasks[str(data_dir)][0] == plan_id:
                    return RecoveryAccepted(plan_id=plan_id, started=False)
                raise HTTPException(409, "다른 복구 작업이 진행 중입니다")
            if _other_running(data_dir):
                raise HTTPException(409, "기존 일봉 갱신 작업이 진행 중입니다")
            if plan.revision != await asyncio.to_thread(recovery.code_revision):
                raise HTTPException(409, "코드·실행 환경 변경 후 복구 계획을 다시 만들어야 합니다")
            try:
                with recovery.owner(data_dir):
                    protected = await asyncio.to_thread(recovery.protected_hashes, data_dir)
            except recovery.RecoveryStop as exc:
                raise HTTPException(409, str(exc)) from exc
            if plan.protected != protected:
                raise HTTPException(409, "계획 이후 기존 데이터가 변경되었습니다")
            if recovery._path(data_dir, plan_id, "job").exists():
                job = recovery.load_job(data_dir, plan_id)
                if not req.resume and job.status != "complete":
                    raise HTTPException(409, "기존 실행 기록은 명시적으로 재개해야 합니다")
            _tasks[str(data_dir)] = (plan_id, asyncio.create_task(
                _drive(data_dir, plan_id, req.resume, fetch or collector(data_dir)), name="screener-recovery",
            ))
            return RecoveryAccepted(plan_id=plan_id, started=True)

    @router.get("/{plan_id}")
    async def status(plan_id: str) -> recovery.RecoveryJob:
        _plan(data_dir, plan_id)
        try:
            return await asyncio.to_thread(recovery.load_job, data_dir, plan_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, "아직 실행 기록이 없습니다") from exc

    @router.post("/{plan_id}/cancel")
    async def stop(plan_id: str) -> RecoveryCancellation:
        _plan(data_dir, plan_id)
        await asyncio.to_thread(recovery.cancel, data_dir, plan_id)
        return RecoveryCancellation(cancel_requested=True)

    return router
