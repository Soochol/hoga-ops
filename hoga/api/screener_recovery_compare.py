"""Compare fixed requests on a new, isolated copy; never narrow the production roster."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import polars as pl

from hoga.api import screener_recovery as recovery, screener_series_store as store
from hoga.api.screener_history_jobs import selected_codes
from hoga.api.screener_runner import run_screener_scan
from hoga.api.screener_series_cli import _request, clone
from hoga.api.screener_series_execution import replay_execution
from hoga.api.screener_series_runner import run_scan
from hoga.util.atomic_write import atomic_write_json


def _copy_observation(source, destination, identity):
    value = store.read_object(source, identity)
    for field in ("previous_observation", "candidate_observation", "previous_review"):
        if value.get(field):
            _copy_observation(source, destination, value[field])
    if value.get("kind") == "screener_correction_review":
        for entry in value["accepted"]:
            _copy_observation(source, destination, entry["evidence_id"])
        for entry in value["rejected"]:
            if (store.root(source) / "objects" / f"{entry['evidence_id']}.json").exists():
                _copy_observation(source, destination, entry["evidence_id"])
    copied = store._write_object(store.root(destination), value)
    if copied != identity:
        raise ValueError("Copied observation identity mismatch")
    return value


def _import(source, destination, job):
    # Corrections are bound to the original immutable baseline, including its id.
    # The comparison roster remains scoped by the destination manifest's roster.
    first = next((item for item in job.items.values() if item.snapshot_id), None)
    if first is not None:
        baseline = store.load_snapshot(source, first.snapshot_id)[1]["baseline"]
        base = store.root(destination)
        target = base / "legacy" / baseline
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(store.root(source) / "legacy" / baseline, target)
        atomic_write_json(base / "baseline.json", {"id": baseline})
    for code, item in job.items.items():
        if item.observation_id is None:
            continue
        value = _copy_observation(source, destination, item.observation_id)
        store._publish(destination, "observations", code, value, anchor=value["adjusted_as_of"])
        manifest = store.load_snapshot(source, item.snapshot_id)[1]
        if identity := manifest["quantity"].get(code):
            evidence = store.ShareEvidence.model_validate(store.read_object(source, identity))
            store.publish_share_evidence(destination, evidence)
    unreviewed = store.load_snapshot(destination)
    for code, item in job.items.items():
        if item.snapshot_id is None:
            continue
        manifest = store.load_snapshot(source, item.snapshot_id)[1]
        if correction_id := manifest.get("corrections", {}).get(code):
            review = _copy_observation(source, destination, correction_id)
            store._publish(destination, "corrections", code, review)
    return unreviewed[0] if unreviewed else None


def _stable(response):
    payload = response.model_dump(mode="json")
    # Legacy EOD match constructors stamp wall-clock receipt/evaluation time.
    # Preserve those in the report, but compare all prices, amounts, dates and
    # coverage independently of when the two verification calls ran.
    for row in payload["rows"]:
        for occurrence in row.get("occurrences", []):
            for field in ("bar_match", "bar_price_match", "bar_trade_value_match", "bar_change_match"):
                if occurrence.get(field) is not None:
                    occurrence[field].pop("fetched_at_ms", None)
    return {field: payload[field] for field in (
        "status", "rows", "has_more", "warnings", "basis_at_ms", "bar_coverage", "history_coverage",
    )}


def _coverage(response, codes, selected):
    incomplete = {}
    for coverage in (response.bar_coverage, response.history_coverage):
        if coverage:
            for item in coverage.incomplete:
                incomplete.setdefault(item.code, set()).add(item.reason)
    matched = {row.code for row in response.rows}
    return {code: {"selected": code in selected, "matched": code in matched,
                   "unavailable_reasons": sorted(incomplete.get(code, set()))}
            for code in codes}


async def compare(source: Path, plan_id: str, destination: Path):
    plan, job = recovery.load_plan(source, plan_id), recovery.load_job(source, plan_id)
    if job.status == "collecting":
        raise ValueError("진행 중인 복구는 비교할 수 없습니다")
    if destination is None or destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("비교에는 운영 경로 밖의 새 디렉터리가 필요합니다")
    if recovery.protected_hashes(source) != plan.protected:
        raise recovery.RecoveryStop("legacy_inputs_changed")
    await asyncio.to_thread(clone, source, destination)
    codes = [target.code for target in plan.targets]
    stocks = destination / "screener/stocks.parquet"
    pl.read_parquet(stocks).filter(pl.col("code").is_in(codes)).write_parquet(stocks)
    # Preserve any explicitly saved v2 exclusions; the comparison never writes a save.
    for name in ("saves.v2.json", "exclusions.v2.json"):
        if (path := source / "screener" / name).exists():
            (destination / "screener" / name).write_bytes(path.read_bytes())
    legacy_before = [
        await run_screener_scan(data_dir=destination, req=request, now=plan.clock)
        for request in plan.comparisons
    ]
    unreviewed_snapshot = await asyncio.to_thread(_import, source, destination, job)
    reviewed = store.load_snapshot(destination)
    has_corrections = reviewed is not None and bool(reviewed[1].get("corrections"))
    results = []
    for request, before in zip(plan.comparisons, legacy_before, strict=True):
        variants, states, executions = {}, {}, {}
        selected = set(selected_codes(destination, request))
        states["legacy"] = _coverage(before, codes, selected)
        for label in ("raw", "share_adjusted", *(["raw_unreviewed"] if has_corrections else [])):
            variant = _request(request, "separate_bases_v2", "raw" if label == "raw_unreviewed" else label)
            if label == "raw_unreviewed":
                variant = variant.model_copy(update={"snapshot_id": unreviewed_snapshot})
            response = await run_scan(data_dir=destination, req=variant,
                                      now=plan.clock, record=True)
            identity = response.calculation.execution_id if response.calculation else None
            if identity:
                await replay_execution(destination, identity)
            variants[label] = response.model_dump(mode="json")
            states[label] = _coverage(response, codes, selected)
            executions[label] = {"execution_id": identity, "replay_equal": identity is not None}
        after = await run_screener_scan(data_dir=destination, req=request, now=plan.clock)
        unchanged = _stable(before) == _stable(after)
        if not unchanged:
            raise ValueError("복구 전후 기존 정책의 결과가 달라졌습니다")
        results.append({
            "request": request.model_dump(mode="json"), "legacy_before": before.model_dump(mode="json"),
            "legacy_after": after.model_dump(mode="json"), "legacy_equal": unchanged,
            "variants": variants, "codes": states, "executions": executions,
        })
    preserved = recovery.protected_hashes(source) == plan.protected
    if not preserved:
        raise recovery.RecoveryStop("legacy_inputs_changed_during_comparison")
    return {
        "schema_version": 1, "plan_id": plan_id, "comparison_dir": str(destination),
        "scope": "pilot codes intersect each unchanged saved universe; production roster is untouched",
        "codes": codes, "clock": plan.clock.isoformat(), "production_preserved": preserved,
        "job": job.model_dump(mode="json"), "results": results,
    }
