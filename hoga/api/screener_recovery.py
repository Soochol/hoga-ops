"""Explicit, resumable recovery into v2; legacy inputs are protected, never published.

The collector is injected by the production owner. Planning/status/cancellation
are offline. Each response is staged before publication so restart never needs
to repeat a completed network collection.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import fcntl
import hashlib
import json
import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import polars as pl
from pydantic import BaseModel, Field, model_validator

from hoga.api import screener_series_store as store, screener_series_values as values, trading_days
from hoga.api.models import ScanRequest
from hoga.api.screener_daily_confirmation import ConfirmationPolicy, ConfirmationState
from hoga.api.screener_history_jobs import _finish_disk_write
from hoga.api.screener_series_execution import code_revision, validate_archivable
from hoga.live.kiwoom_errors import KiwoomAuthError, KiwoomRateLimitError, KiwoomTerminalAuthError
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

_PROTECTED = (*store._BASE_FILES, "saves.v2.json", "exclusions.v2.json", "refresh_report.json")
log = logging.getLogger(__name__)
RecoveryItemStatus = Literal["pending", "staged", "observed", "quarantined", "failed"]
RecoveryJobStatus = Literal["collecting", "complete", "partial", "interrupted", "failed"]


class RecoveryTarget(BaseModel):
    model_config = {"extra": "forbid"}
    code: str = Field(pattern=r"^[A-Z0-9]{6}$")
    first: dt.date
    last: dt.date
    reason: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def ordered(self):
        if self.first > self.last:
            raise ValueError("복구 시작일이 종료일보다 늦습니다")
        return self


class RecoverySpec(BaseModel):
    model_config = {"extra": "forbid"}
    adjusted_as_of: dt.date
    clock: dt.datetime
    targets: list[RecoveryTarget] = Field(min_length=1, max_length=1000)
    comparisons: list[ScanRequest] = Field(default_factory=list, max_length=20)
    confirmation_policy: ConfirmationPolicy = "historical_recheck_v1"

    @model_validator(mode="after")
    def bounded(self):
        if self.clock.tzinfo is None or self.clock.astimezone(KST).date() != self.adjusted_as_of:
            raise ValueError("복구 기준일과 고정 조회 시각(KST)이 일치해야 합니다")
        if len({target.code for target in self.targets}) != len(self.targets):
            raise ValueError("복구 종목이 중복되었습니다")
        if any(target.last >= self.adjusted_as_of for target in self.targets):
            raise ValueError("복구는 수정 기준일 이전에 완료된 날짜만 지원합니다")
        for request in self.comparisons:
            if request.calculation_policy != "legacy_v1" or request.basis != "eod":
                raise ValueError("비교 원본은 기존 정책의 확정 일봉 요청이어야 합니다")
            validate_archivable(request.model_copy(update={"calculation_policy": "separate_bases_v2"}))
        return self


class ReviewBinding(BaseModel):
    """Internal plan metadata, not part of the recovery job wire response."""
    model_config = {"extra": "forbid"}
    parent_plan_id: str
    parent_job_id: str
    input_id: str
    snapshot_id: str


class RecoveryPlan(RecoverySpec):
    schema_version: Literal[1] = 1
    baseline: str
    initial_snapshot: str | None
    protected: dict[str, str | None]
    calendar: list[dt.date]
    revision: str
    confirmation_policy: ConfirmationPolicy = "legacy_unverified"
    review_binding: ReviewBinding | None = None


class RecoveryItem(BaseModel):
    status: RecoveryItemStatus = "pending"
    candidate_id: str | None = None
    observation_id: str | None = None
    snapshot_id: str | None = None
    added_original_days: int = 0
    original_missing: list[dt.date] = Field(default_factory=list)
    price_missing: list[dt.date] = Field(default_factory=list)
    conflict_dates: list[dt.date] = Field(default_factory=list)
    share_evidence_ready: bool = False
    violations: int = 0
    error: str | None = None
    confirmation_state: ConfirmationState = "unverified"
    resolved_conflict_dates: list[dt.date] = Field(default_factory=list)
    correction_id: str | None = None


class RecoveryJob(BaseModel):
    plan_id: str
    status: RecoveryJobStatus = "collecting"
    items: dict[str, RecoveryItem]
    current_code: str | None = None
    preserved: bool = True
    error: str | None = None


class RecoveryStop(RuntimeError):
    """A run-wide stop: do not continue with other symbols."""


def directory(data_dir: Path) -> Path:
    return store.root(data_dir) / "recovery"


def _path(data_dir, plan_id, suffix):
    return directory(data_dir) / f"{store._checked(plan_id)}.{suffix}.json"


def protected_hashes(data_dir):
    """No journal recovery, even when examining a pending production publication."""
    sdir = data_dir / "screener"
    with (sdir / ".writer.lock").open("rb") as handle:
        fcntl.flock(handle, fcntl.LOCK_SH)
        if (sdir / "history_publish.json").exists():
            raise RecoveryStop("pending_legacy_publication")
        return {
            name: hashlib.sha256(path.read_bytes()).hexdigest() if (path := sdir / name).exists() else None
            for name in _PROTECTED
        }


def _stamps(data_dir):
    result = {}
    for name in _PROTECTED:
        path = data_dir / "screener" / name
        if path.exists():
            stat = path.stat()
            result[name] = (stat.st_size, stat.st_mtime_ns, stat.st_ino)
        else:
            result[name] = None
    return result


@contextmanager
def owner(data_dir):
    """Only recovery is leased here; the writer lock is never held over network IO."""
    base = directory(data_dir)
    base.mkdir(parents=True, exist_ok=True)
    with (base / ".owner.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RecoveryStop("recovery_already_running") from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def create_plan(data_dir: Path, spec: RecoverySpec) -> str:
    before = protected_hashes(data_dir)
    roster = set(pl.read_parquet(data_dir / "screener/stocks.parquet", columns=["code"])["code"])
    if any(target.code not in roster for target in spec.targets):
        raise ValueError("보유 로스터에 없는 복구 종목입니다")
    days = sorted(dt.datetime.strptime(day, "%Y%m%d").date() for day in trading_days.trading_days(data_dir))
    if not days or any(target.first < days[0] or target.last > days[-1] for target in spec.targets):
        raise ValueError("복구 범위는 확인된 거래일 달력 안이어야 합니다")
    baseline = store.ensure_baseline(data_dir)
    pinned = store.load_snapshot(data_dir)
    plan = RecoveryPlan(
        **spec.model_dump(), baseline=baseline, initial_snapshot=pinned[0] if pinned else None,
        protected=before, calendar=days, revision=code_revision(),
    )
    if protected_hashes(data_dir) != before:
        raise RecoveryStop("legacy_changed_during_planning")
    payload = plan.model_dump(mode="json")
    identity = store.digest(payload)
    directory(data_dir).mkdir(parents=True, exist_ok=True)
    atomic_write_json(_path(data_dir, identity, "plan"), payload)
    return identity


def load_plan(data_dir, plan_id):
    payload = json.loads(_path(data_dir, plan_id, "plan").read_text())
    if store.digest(payload) != plan_id:
        raise ValueError("복구 계획 지문이 다릅니다")
    return RecoveryPlan.model_validate(payload)


def load_job(data_dir, plan_id) -> RecoveryJob:
    return RecoveryJob.model_validate_json(_path(data_dir, plan_id, "job").read_text())


def cancel(data_dir, plan_id):
    load_plan(data_dir, plan_id)
    atomic_write_json(_path(data_dir, plan_id, "cancel"), {"cancel_requested": True})


def _save(data_dir, job):
    atomic_write_json(_path(data_dir, job.plan_id, "job"), job.model_dump(mode="json"))


def _initial_manifest(data_dir, plan):
    return store.load_snapshot(data_dir, plan.initial_snapshot)[1] if plan.initial_snapshot else {
        "baseline": plan.baseline, "observations": {}, "quantity": {}, "adjusted_as_of": None,
    }


def _guard(data_dir, plan_id, plan, stamps, now):
    if _path(data_dir, plan_id, "cancel").exists():
        raise RecoveryStop("cancel_requested")
    if now().astimezone(KST).date() != plan.adjusted_as_of:
        raise RecoveryStop("adjusted_as_of_changed")
    if _stamps(data_dir) != stamps or (data_dir / "screener/history_publish.json").exists():
        raise RecoveryStop("legacy_inputs_changed")
    pinned = store.load_snapshot(data_dir)
    if pinned and pinned[1]["adjusted_as_of"] and pinned[1]["adjusted_as_of"] > plan.adjusted_as_of.isoformat():
        raise RecoveryStop("newer_price_anchor_published")


def _summarize(data_dir, plan, target, snapshot_id, item):
    from hoga.api import screener_daily_confirmation as confirmation  # noqa: PLC0415 — store boundary

    manifest = store.load_snapshot(data_dir, snapshot_id)[1]
    series = values.load_series(data_dir, manifest, [target.code], first=target.first, last=target.last)[target.code]
    original = values.load_series(
        data_dir, _initial_manifest(data_dir, plan), [target.code], first=target.first, last=target.last,
    )[target.code]
    required = {day for day in plan.calendar if target.first <= day <= target.last}
    item.original_missing = sorted(day for day in required if day not in series.original
                                   or not values.valid_row(series.original[day]))
    item.price_missing = sorted(required - series.prices.keys())
    item.conflict_dates = sorted(required & series.conflicts)
    item.resolved_conflict_dates = sorted(required & series.corrected)
    item.correction_id = manifest.get("corrections", {}).get(target.code)
    item.added_original_days = sum(day not in original.original and day in series.original
                                   and values.valid_row(series.original[day]) for day in required)
    item.share_evidence_ready = bool(required) and all(
        series.quantity(day, target.last, "share_adjusted") is not None for day in required
    )
    item.snapshot_id, item.observation_id = snapshot_id, manifest["observations"][target.code]
    observation = store.current_observation(data_dir, store.read_object(data_dir, item.observation_id))
    item.violations = len(observation.get("violations", []))
    item.confirmation_state = confirmation.state(observation)
    unconfirmed = plan.confirmation_policy != "legacy_unverified" and item.confirmation_state != "confirmed"
    item.status = "quarantined" if (
        item.original_missing or item.price_missing or item.conflict_dates or unconfirmed
    ) else "observed"
    item.error = None


async def _collect_one(data_dir, plan, target, item, job, fetch, check):
    if item.candidate_id is None:
        candidate = await fetch(target, plan.adjusted_as_of, check)
        check()
        if candidate["code"] != target.code or candidate["adjusted_as_of"] != plan.adjusted_as_of.isoformat():
            raise RecoveryStop("collector_identity_or_anchor_mismatch")
        if any(row.get("code") != target.code or not target.first <= dt.date.fromisoformat(row["date"]) <= target.last
               for field in ("unadjusted", "adjusted") for row in candidate[field]):
            raise RecoveryStop("collector_rows_outside_plan")
        if plan.confirmation_policy == "historical_recheck_v1" and not candidate.get("confirmation"):
            raise ValueError("독립 재조회·세션·확정 시점 근거가 없는 복구 후보입니다")
        item.candidate_id = await asyncio.to_thread(store._write_object, store.root(data_dir), candidate)
        item.status = "staged"
        await _finish_disk_write(_save, data_dir, job)
    check()
    if await asyncio.to_thread(protected_hashes, data_dir) != plan.protected:
        raise RecoveryStop("legacy_inputs_changed")
    candidate = store.read_object(data_dir, item.candidate_id)
    snapshot_id = await _finish_disk_write(lambda: store.publish_pair(data_dir, **candidate))
    await _finish_disk_write(_summarize, data_dir, plan, target, snapshot_id, item)


async def run(data_dir: Path, plan_id: str, *, fetch, resume=False, now=None) -> RecoveryJob:
    now = now or (lambda: dt.datetime.now(KST))
    with owner(data_dir):
        plan = load_plan(data_dir, plan_id)
        if plan.review_binding is not None:
            raise RecoveryStop("review_plan_cannot_collect")
        if code_revision() != plan.revision:
            raise RecoveryStop("code_or_runtime_changed")
        if await asyncio.to_thread(protected_hashes, data_dir) != plan.protected:
            raise RecoveryStop("legacy_inputs_changed")
        path = _path(data_dir, plan_id, "job")
        job = load_job(data_dir, plan_id) if path.exists() else RecoveryJob(
            plan_id=plan_id, items={target.code: RecoveryItem() for target in plan.targets},
        )
        if path.exists() and not resume:
            if job.status == "complete":
                return job
            raise RecoveryStop("explicit_resume_required")
        if resume:
            _path(data_dir, plan_id, "cancel").unlink(missing_ok=True)
        stamps = _stamps(data_dir)
        def check():
            _guard(data_dir, plan_id, plan, stamps, now)
        job.status, job.error = "collecting", None
        await _finish_disk_write(_save, data_dir, job)
        try:
            await _run_targets(data_dir, plan, job, fetch, check)
            job.status = "partial" if any(item.status != "observed" for item in job.items.values()) else "complete"
        except RecoveryStop as exc:
            job.error, job.status = str(exc), "interrupted"
        except asyncio.CancelledError:
            job.status, job.error = "interrupted", "owner_cancelled"
            raise
        finally:
            job.current_code = None
            try:
                job.preserved = await asyncio.to_thread(protected_hashes, data_dir) == plan.protected
            except RecoveryStop:
                job.preserved = False
            if not job.preserved:
                job.status, job.error = "failed", "legacy_inputs_changed"
            await _finish_disk_write(_save, data_dir, job)
        return job


async def _run_targets(data_dir, plan, job, fetch, check):
    for target in plan.targets:
        check()
        item = job.items[target.code]
        if item.status in {"observed", "quarantined"}:
            continue
        job.current_code = target.code
        await _finish_disk_write(_save, data_dir, job)

        try:
            await _collect_one(data_dir, plan, target, item, job, fetch, check)
        except (RecoveryStop, KiwoomAuthError, KiwoomTerminalAuthError, KiwoomRateLimitError) as exc:
            raise RecoveryStop(str(exc) if isinstance(exc, RecoveryStop) else type(exc).__name__) from exc
        except Exception as exc:
            log.exception("recovery collection failed for %s", target.code)
            item.status, item.error = "failed", type(exc).__name__
        await _finish_disk_write(_save, data_dir, job)


def review_corrections(data_dir: Path, plan_id: str, payload: dict):
    """Explicit offline evidence import under the same lease as collection; no credentials."""
    from hoga.api import screener_corrections as corrections  # noqa: PLC0415 — operational review only

    if load_plan(data_dir, plan_id).review_binding is not None:
        from hoga.api.screener_review_plan import apply_plan  # noqa: PLC0415 — avoid plan model cycle
        return apply_plan(data_dir, plan_id, payload=payload)
    with owner(data_dir):
        plan, job = load_plan(data_dir, plan_id), load_job(data_dir, plan_id)
        if job.status == "collecting" or code_revision() != plan.revision:
            raise RecoveryStop("review_requires_stopped_job_and_unchanged_code")
        if protected_hashes(data_dir) != plan.protected:
            raise RecoveryStop("legacy_inputs_changed")
        targets = {target.code: target for target in plan.targets}
        requests = [corrections.CorrectionRequest.model_validate(value) for value in payload["requests"]]
        if (any(request.code not in targets for request in requests)
                or len({request.code for request in requests}) != len(requests)):
            raise ValueError("정정 검토의 종목은 중복 없이 복구 대상 안에 있어야 합니다")
        for evidence in payload.get("evidence", []):
            store._write_object(store.root(data_dir), evidence)
        reviews = {}
        for request in requests:
            target = targets[request.code]
            if any(not target.first <= proof.date <= target.last for proof in request.proofs):
                raise ValueError("정정 날짜가 복구 범위 밖입니다")
            if protected_hashes(data_dir) != plan.protected:
                raise RecoveryStop("legacy_inputs_changed")
            snapshot_id, review = corrections.publish_review(data_dir, request)
            _summarize(data_dir, plan, target, snapshot_id, job.items[request.code])
            reviews[request.code] = review
            _save(data_dir, job)
        job.status = "partial" if any(item.status != "observed" for item in job.items.values()) else "complete"
        job.preserved = protected_hashes(data_dir) == plan.protected
        if not job.preserved:
            job.status, job.error = "failed", "legacy_inputs_changed"
        _save(data_dir, job)
        return {"job": job.model_dump(mode="json"), "reviews": reviews}
