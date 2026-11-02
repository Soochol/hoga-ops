"""Incremental confirmed daily results with a full-universe fallback for live/rank inputs."""

from __future__ import annotations

import asyncio

from hoga.api import screener_series_runner as runner, screener_series_store as store
from hoga.api.models import BarVolumeCoverage, BarVolumeCoverageItem
from hoga.api.screener_expression import active_conditions
from hoga.api.screener_preparation_plan import daily_leaves


class RunResults:
    def __init__(self, data_dir, volume_runtime, live_clock=None):
        self.data_dir = data_dir
        self.volume_runtime = volume_runtime
        self.live_clock = live_clock
        self.inputs = None
        self.metadata = None
        self.observations = {}
        self.rows = {}
        self.failures = {}
        self.evaluated = set()
        self.truncated = False
        self.last = None
        self.contracts = {}
        self.contract_ids = {}

    def _clear(self):
        self.rows.clear()
        self.failures.clear()
        self.evaluated.clear()
        self.truncated = False
        self.last = None

    async def _context(self, req, pinned, clock, ready):
        manifest = pinned[1]
        metadata = store.digest({key: value for key, value in manifest.items()
                                 if key not in {"observations", "parent", "daily_query"}})
        changed = {code for code in ready if self.observations.get(code) != manifest["observations"].get(code)}
        changed.update(ready - self.evaluated)
        # Changes to already evaluated inputs can remove rows or lower a cutoff.
        # Recompute globally in that case, not just when new codes are appended.
        if metadata != self.metadata or changed & self.evaluated:
            self.inputs = None
            self._clear()
        if self.inputs is None:
            self.inputs = await runner._inputs(self.data_dir, req, manifest, clock, None)
        elif changed:
            confirmed = await asyncio.to_thread(
                runner._confirmed_at, self.data_dir, manifest, list(changed), clock.date())
            previous = self.inputs["confirmed_at"]
            if confirmed is not None and (previous is None or confirmed > previous):
                new_clock = runner._eod_clock(clock, confirmed).isoformat()
                if new_clock != self.inputs["clock"]:
                    self._clear()
                self.inputs.update(confirmed_at=confirmed, clock=new_clock)
        self.metadata = metadata
        self.observations = dict(manifest["observations"])

    async def evaluate(self, req, codes, pending, clock, pinned, blockers):
        leaves = {leaf.id for leaf in active_conditions(req.conditions, req.expression)}
        blocked = {(item.code, item.condition_id): item.reason for item in blockers}
        blocked_leaves = {}
        for code, condition in blocked:
            blocked_leaves.setdefault(code, set()).add(condition)
        blocked_only = {code for code, conditions in blocked_leaves.items() if leaves and leaves <= conditions}
        ready = set(codes) - pending - blocked_only
        daily_only = len(daily_leaves(req)) == len(active_conditions(req.conditions, req.expression))
        if not pinned or not daily_only or req.snapshot_id is not None:
            return await self._full(req, ready, clock, pinned, blocked)
        await self._context(req, pinned, clock, ready)
        if self.inputs["basis"] != "eod":
            return await self._full(req, ready, clock, pinned, blocked)
        changed = ready - self.evaluated
        if changed or self.last is None:
            inputs = {**self.inputs, "codes": sorted(changed)}
            partial = await runner.run_scan(data_dir=self.data_dir, req=req, now=clock,
                                            volume_runtime=self.volume_runtime, input_snapshot=pinned, replay=inputs,
                                            blocked_conditions=blocked)
            for code in changed:
                self.rows.pop(code, None)
                self.failures[code] = []
            self.rows.update({row.code: row for row in partial.rows})
            if partial.bar_coverage:
                for failure in partial.bar_coverage.incomplete:
                    self.failures.setdefault(failure.code, []).append(failure)
            self.truncated |= partial.has_more
            self.evaluated.update(changed)
            self.last = partial
        result = self.last.model_copy(deep=True)
        rows = sorted((row for code, row in self.rows.items() if code in ready),
                      key=lambda row: (-row.trade_value_won, row.code))
        result.rows, result.has_more = rows[:req.limit], self.truncated or len(rows) > req.limit
        failures = [failure for code, items in self.failures.items() if code in ready for failure in items]
        failures.extend(blockers)
        failures.extend(BarVolumeCoverageItem(code=code, condition_id="preparation", reason="daily_preparation_pending")
                        for code in sorted(pending))
        result.bar_coverage = BarVolumeCoverage(total=len(codes),
                                                complete=len(codes) - len({item.code for item in failures}),
                                                incomplete=failures)
        if result.calculation:
            result.calculation.snapshot_id = pinned[0]
            contracts = await asyncio.to_thread(self._contracts, pinned[1], codes)
            for field, value in contracts.items():
                setattr(result.calculation, field, value)
        result.warnings = [warning for warning in result.warnings if warning != "separate_bases_partial"]
        if failures:
            result.warnings.append("separate_bases_partial")
        return result

    def _contracts(self, manifest, codes):
        for code in codes:
            identity = manifest["observations"].get(code)
            if code not in self.contracts or identity != self.contract_ids.get(code):
                self.contracts[code] = runner._daily_contract(self.data_dir, manifest, [code])
                self.contract_ids[code] = identity
        result = {}
        for field in ("daily_session_scope", "daily_confirmation_policy"):
            values = {self.contracts[code][field] for code in codes}
            result[field] = next(iter(values)) if len(values) == 1 else "mixed" if values else None
        return result

    async def _full(self, req, ready, clock, pinned, blocked):
        now = self.live_clock() if self.live_clock and req.snapshot_id is None else clock
        if now.date() != clock.date():
            raise InterruptedError("검색 준비 중 날짜가 바뀌었습니다. 다시 조회해 주세요")
        return await runner.run_scan(data_dir=self.data_dir, req=req, now=now, volume_runtime=self.volume_runtime,
                                     ready_codes=ready, input_snapshot=pinned, blocked_conditions=blocked)
