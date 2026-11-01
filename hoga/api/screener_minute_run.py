"""Finish an entire minute search, checkpointing judgments rather than bars."""
from __future__ import annotations

import asyncio
from dataclasses import replace

from hoga.api import (
    screener_rankings,
    screener_runner,
    screener_series_runner as runner,
    screener_series_store as store,
)
from hoga.api.models import BarVolumeCoverage, BarVolumeCoverageItem, ScreenerResponse
from hoga.api.screener_minute_scope import bind, resolve
from hoga.api.screener_preparation import DailyPreparation
from hoga.util.atomic_write import atomic_write_json

BATCH_SIZE = 64
_TRANSPORT_REASONS = {"fetch_timeout", "credentials_missing", "rest_bypassed", "invalid_rows",
                      "transport_error", "api_error", "rate_limit_upstream", "auth_error", "capacity_overloaded",
                      "batch_limit_exceeded", "internal_processing_error", "unexpected_error"}


def _rank_key(rank):
    return store.digest({"observed": rank.fetched_at_ms, "earliest": rank.earliest_at_ms,
        "evaluation_at": rank.evaluation_at_ms,
        "basis": rank.basis.model_dump(mode="json") if rank.basis else None,
        "events": {key: [(code, event.model_dump(mode="json")) for code, event in items]
                   for key, items in rank.events.items()}}) if rank else None


class MinuteSearch:
    def __init__(self, owner, run, codes, context, clock):
        self.owner, self.run, self.codes, self.context, self.clock = owner, run, codes, context, clock
        self.path = owner.data_dir / "screener" / "runs" / f"{run.id}.minutes.json"
        self.result = None
        self.rows, self.failures, self.done = {}, [], set()
        self.inputs, self.pinned, self.rank, self.scope, self.fingerprint = None, None, None, None, None
        self.observed_from, self.observed_to = None, None
        self.sidecars, self.auxiliary = {}, {}
        self.contracts = {}

    async def prepare(self):
        self.scope = await asyncio.to_thread(resolve, self.owner.data_dir, self.clock)
        self.scope = replace(self.scope, clock=self.owner.clock)
        self.run.minute_date, self.run.status = self.scope.day.isoformat(), "preparing"
        checkpoint = await asyncio.to_thread(DailyPreparation._read, self.path)
        self.fingerprint = store.digest([self.run.request.model_dump(mode="json"), self.context,
                                         self.scope.day.isoformat(), self.clock.isoformat()])
        if checkpoint and checkpoint.get("fingerprint") != self.fingerprint:
            raise InterruptedError("분봉 검색의 입력이 바뀌었습니다. 다시 조회해 주세요")
        self.pinned = await asyncio.to_thread(store.load_snapshot, self.owner.data_dir,
            checkpoint.get("snapshot") or self.run.request.snapshot_id)
        if self.run.request.calculation_policy == "separate_bases_v2" and self.pinned is None:
            raise ValueError("분봉 검색에 필요한 종목·가격 기준선이 없습니다")
        self.rank = await screener_rankings.evaluate(self.owner.data_dir, self.run.request, self.clock, None)
        if checkpoint.get("rank") and _rank_key(self.rank) != checkpoint["rank"]:
            raise ValueError("재개할 분봉 검색의 순위 관측이 바뀌었습니다. 다시 조회해 주세요")
        screener_rankings.validate_stored_conditions(self.run.request, self.rank)
        if self.rank and self.rank.historical:
            if self.rank.cutoff.date() != self.scope.day:
                raise ValueError("저장된 순위 기준일과 분봉 검색 거래일이 다릅니다")
            self.scope = replace(self.scope, cutoff=min(self.scope.cutoff, self.rank.cutoff), live=False)
        candidates = set(screener_rankings.candidate_codes(self.run.request, self.codes, self.rank))
        self.done = set(checkpoint.get("done", [])) | (set(self.codes) - candidates)
        if checkpoint.get("result"):
            self.result = ScreenerResponse.model_validate(checkpoint["result"])
            self.rows = {row.code: row for row in self.result.rows}
            self.failures = [item for item in self.result.bar_coverage.incomplete if item.code in self.done]
            self.observed_from, self.observed_to = checkpoint.get("observed_from"), checkpoint.get("observed_to")
            self.sidecars = self.result.depth_values or {}
            self.auxiliary = {field: getattr(self.result, field) for field in
                              ("daily_coverage", "history_coverage", "depth_coverage")}
        if self.pinned:
            self.inputs = await runner._inputs(self.owner.data_dir, self.run.request,
                                               self.pinned[1], self.clock, None, self.rank)
            self.contracts = await asyncio.to_thread(runner._daily_contract,
                self.owner.data_dir, self.pinned[1], self.codes)

    def merge_auxiliary(self, partial):
        self.sidecars.update(partial.depth_values or {})
        for field in ("daily_coverage", "history_coverage", "depth_coverage"):
            current, incoming = self.auxiliary.get(field), getattr(partial, field)
            if incoming is None:
                continue
            if current is None:
                self.auxiliary[field] = incoming.model_copy(deep=True)
            elif field == "depth_coverage":
                current.evaluated += incoming.evaluated
                current.excluded.extend(incoming.excluded)
                current.partial.extend(incoming.partial)
            else:
                current.total += incoming.total
                current.complete += incoming.complete
                current.incomplete.extend(incoming.incomplete)

    def update_result(self):
        if self.result is None:
            self.result = ScreenerResponse(status="ok", rows=[], warnings=[])
        pending = [BarVolumeCoverageItem(code=code, condition_id="preparation", reason="minute_preparation_pending")
                   for code in self.codes if code not in self.done]
        self.rows = {row.code: row for row in sorted(self.rows.values(),
            key=lambda row: (-row.trade_value_won, row.code))[:self.run.request.limit + 1]}
        self.result.rows = list(self.rows.values())[:self.run.request.limit]
        self.sidecars = {code: value for code, value in self.sidecars.items() if code in self.rows}
        self.result.depth_values = self.sidecars or None
        for field, value in self.auxiliary.items():
            setattr(self.result, field, value)
        if self.result.calculation:
            for field, value in self.contracts.items():
                setattr(self.result.calculation, field, value)
        self.result.has_more = len(self.rows) > self.run.request.limit
        unavailable = {item.code for item in self.failures}
        failed = {item.code for item in self.failures if item.reason in _TRANSPORT_REASONS}
        self.result.bar_coverage = BarVolumeCoverage(total=len(self.codes), complete=len(self.done - unavailable),
            incomplete=[*self.failures, *pending], trading_date=self.run.minute_date)
        self.result.warnings = [warning for warning in self.result.warnings
                               if warning not in {"separate_bases_partial", "bar_volume_partial"}]
        if self.failures or pending:
            self.result.warnings.append("bar_volume_partial")
        self.result.basis_at_ms = int(self.scope.cutoff.timestamp() * 1000)
        if self.observed_to is not None:
            self.result.basis_at_ms = self.observed_to
            self.result.fallback_basis_at_ms = min(int(self.scope.cutoff.timestamp() * 1000), self.observed_from)
        self.run.result = self.result
        self.run.evaluated = self.result.bar_coverage.complete
        self.run.preparing = len(self.codes) - len(self.done)
        self.run.failed, self.run.waiting = len(failed), len(unavailable - failed)
        self.run.revision += 1
        self.run.result_revision = self.run.revision

    async def publish(self):
        self.update_result()
        # Store judgments and the top N+1 evidence rows, never provider candles.
        saved = self.result.model_copy(update={"rows": list(self.rows.values())})
        await asyncio.to_thread(atomic_write_json, self.path, {
            "fingerprint": self.fingerprint, "snapshot": self.pinned[0] if self.pinned else None,
            "rank": _rank_key(self.rank), "done": sorted(self.done), "result": saved.model_dump(mode="json"),
            "observed_from": self.observed_from, "observed_to": self.observed_to,
        })
        await asyncio.to_thread(self.owner._save, self.run, self.codes, self.context, self.clock)

    async def batch(self, codes):
        request = self.run.request.model_copy(update={"limit": 2000})
        scope = replace(self.scope, snapshots={}, cutoffs={}, observations=[])
        with bind(scope):
            if self.pinned is not None and request.calculation_policy == "separate_bases_v2":
                partial = await runner.run_scan(data_dir=self.owner.data_dir, req=request, now=self.clock,
                    input_snapshot=self.pinned, replay={**self.inputs, "codes": codes}, rank_eval=self.rank,
                    blocked_conditions={(item.code, item.condition_id): item.reason
                                        for item in self.owner.blockers.get(self.run.id, []) if item.code in codes})
            else:
                partial = await screener_runner._run_legacy_scan(data_dir=self.owner.data_dir, req=request,
                    now=self.clock, rank_eval=self.rank, codes_override=codes)
        self.result = partial
        self.merge_auxiliary(partial)
        if scope.observations:
            self.observed_from = min([*scope.observations, *([self.observed_from] if self.observed_from else [])])
            self.observed_to = max([*scope.observations, *([self.observed_to] if self.observed_to else [])])
        self.rows.update({row.code: row for row in partial.rows})
        if partial.bar_coverage:
            self.failures.extend(partial.bar_coverage.incomplete)
        self.done.update(codes)


async def execute(owner, run, codes, context, clock):
    search = MinuteSearch(owner, run, codes, context, clock)
    await search.prepare()
    await search.publish()
    queue = [code for code in codes if code not in search.done]
    for offset in range(0, len(queue), BATCH_SIZE):
        await owner._check(run.request, context, clock)
        await search.batch(queue[offset:offset + BATCH_SIZE])
        await owner._check(run.request, context, clock)
        await search.publish()
    run.status = "partial" if run.waiting or run.failed else "complete"
