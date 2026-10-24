"""Adopt confirmed observations into a new review-only plan and publish one atomic batch.

No collection, token access, observation republication or legacy journal recovery.
The immutable input and starting snapshot are part of the new plan identity.
"""

from __future__ import annotations

import datetime as dt

from hoga.api import (
    screener_corrections as corrections,
    screener_daily_confirmation as confirmation,
    screener_recovery as recovery,
    screener_series_store as store,
)
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST


def _input(payload, plan, job):
    if set(payload) != {"evidence", "requests"}:
        raise ValueError("review_input_requires_evidence_and_requests")
    requests = [corrections.CorrectionRequest.model_validate(value) for value in payload["requests"]]
    targets = {target.code: target for target in plan.targets}
    if not requests or len({request.code for request in requests}) != len(requests):
        raise ValueError("review_requests_empty_or_duplicate")
    references = set()
    for request in requests:
        if request.code not in targets:
            raise ValueError("review_code_outside_source_plan")
        dates = [proof.date for proof in request.proofs]
        if len(dates) != len(set(dates)) or not set(dates) <= set(job.items[request.code].conflict_dates):
            raise ValueError("review_dates_must_be_distinct_unresolved_conflicts")
        target = targets[request.code]
        if any(not target.first <= day <= target.last for day in dates):
            raise ValueError("review_date_outside_source_window")
        references.update(proof.evidence_id for proof in request.proofs)
    evidence = {store.digest(value): value for value in payload["evidence"]}
    if len(evidence) != len(payload["evidence"]) or set(evidence) != references:
        raise ValueError("review_evidence_must_match_all_references")
    return {"evidence": list(evidence.values()),
            "requests": [request.model_dump(mode="json") for request in requests]}


def _prepare(data_dir, payload, manifest, *, plan_id=None, times=None):
    evidence = {store.digest(value): value for value in payload["evidence"]}
    now = dt.datetime.now(KST)
    reviews = {}
    for value in payload["requests"]:
        request = corrections.CorrectionRequest.model_validate(value)
        reviewed_at = dt.datetime.fromisoformat(times[request.code]) if times else now
        if reviewed_at.tzinfo is None:
            raise ValueError("review_timestamp_requires_timezone")
        review = corrections.prepare_review(
            data_dir, request, manifest, now=reviewed_at, evidence=evidence, review_plan_id=plan_id,
        )
        if review["rejected"]:
            raise ValueError(f"review_preflight_rejected:{request.code}:{review['rejected']}")
        previous_id = manifest.get("corrections", {}).get(request.code)
        previous = store.read_object(data_dir, previous_id)["accepted"] if previous_id else []
        accepted = {row["date"]: row for row in review["accepted"]}
        if any(accepted.get(row["date"]) != row for row in previous):
            raise ValueError("review_would_change_previous_accepted_selection")
        expected = {proof.date.isoformat() for proof in request.proofs}
        if set(accepted) - {row["date"] for row in previous} != expected:
            raise ValueError("review_new_selection_dates_differ")
        reviews[request.code] = review
    return reviews


def _job(data_dir, plan_id, plan, source_job, snapshot_id):
    job = recovery.RecoveryJob.model_validate(source_job)
    job.plan_id, job.current_code, job.error = plan_id, None, None
    for target in plan.targets:
        recovery._summarize(data_dir, plan, target, snapshot_id, job.items[target.code])
    job.status = "partial" if any(item.status != "observed" for item in job.items.values()) else "complete"
    job.preserved = True
    return job


def create_plan(data_dir, source_plan_id, payload):
    with recovery.owner(data_dir):
        source = recovery.load_plan(data_dir, source_plan_id)
        source_job = recovery.load_job(data_dir, source_plan_id)
        if (source_job.status not in {"partial", "complete"} or not source_job.preserved
                or set(source_job.items) != {target.code for target in source.targets}
                or any(item.status not in {"observed", "quarantined"} for item in source_job.items.values())):
            raise recovery.RecoveryStop("review_requires_completed_source_observations")
        if recovery.protected_hashes(data_dir) != source.protected:
            raise recovery.RecoveryStop("legacy_inputs_changed")
        snapshot_id, manifest = store.load_snapshot(data_dir)
        if manifest["baseline"] != source.baseline or manifest["adjusted_as_of"] != source.adjusted_as_of.isoformat():
            raise recovery.RecoveryStop("review_baseline_or_anchor_changed")
        for code, item in source_job.items.items():
            if (manifest["observations"].get(code) != item.observation_id
                    or manifest.get("corrections", {}).get(code) != item.correction_id):
                raise recovery.RecoveryStop("review_source_observation_or_correction_changed")
            candidate = store.read_object(data_dir, item.candidate_id)
            observation = store.current_observation(data_dir, store.read_object(data_dir, item.observation_id))
            if (confirmation.state(observation) != "confirmed" or confirmation.state(candidate) != "confirmed"
                    or candidate.get("code") != code
                    or candidate.get("adjusted_as_of") != source.adjusted_as_of.isoformat()
                    or any(observation.get(key) != value for key, value in candidate.items())):
                raise recovery.RecoveryStop("review_requires_identical_confirmed_candidate")
        payload = _input(payload, source, source_job)
        _prepare(data_dir, payload, manifest)
        revision = recovery.code_revision()
        input_id = store._write_object(store.root(data_dir), {"kind": "screener_review_input", "payload": payload})
        parent_job_id = store._write_object(store.root(data_dir), {
            "kind": "screener_review_source_job", "job": source_job.model_dump(mode="json"),
        })
        plan = source.model_copy(update={
            "revision": revision, "review_binding": recovery.ReviewBinding(
                parent_plan_id=source_plan_id, parent_job_id=parent_job_id, input_id=input_id, snapshot_id=snapshot_id,
            ),
        })
        identity = store.digest(plan.model_dump(mode="json"))
        adopted = _job(data_dir, identity, plan, source_job.model_dump(mode="json"), snapshot_id)
        if (recovery.protected_hashes(data_dir) != source.protected or store.load_snapshot(data_dir)[0] != snapshot_id
                or recovery.code_revision() != revision):
            raise recovery.RecoveryStop("review_inputs_changed_during_planning")
        path = recovery._path(data_dir, identity, "plan")
        if path.exists():
            recovery.load_plan(data_dir, identity)
        else:
            atomic_write_json(path, plan.model_dump(mode="json"))
        if not recovery._path(data_dir, identity, "job").exists():
            recovery._save(data_dir, adopted)
        return identity


def _applied(data_dir, plan_id, payload, initial, snapshot_id, manifest):
    if manifest.get("parent") != snapshot_id:
        raise recovery.RecoveryStop("review_snapshot_changed")
    def fixed(value):
        return {key: item for key, item in value.items() if key not in {"parent", "corrections"}}
    if fixed(manifest) != fixed(initial):
        raise recovery.RecoveryStop("review_snapshot_changed")
    records = {value["code"]: store.read_object(data_dir, manifest.get("corrections", {}).get(value["code"], ""))
               for value in payload["requests"]}
    if any(record.get("review_plan_id") != plan_id for record in records.values()):
        raise recovery.RecoveryStop("review_snapshot_changed")
    expected = _prepare(data_dir, payload, initial, plan_id=plan_id,
                        times={code: record["reviewed_at"] for code, record in records.items()})
    identities = {code: store.digest(record) for code, record in expected.items()}
    if (records != expected or manifest.get("corrections") != {**initial.get("corrections", {}), **identities}):
        raise recovery.RecoveryStop("review_snapshot_changed")
    return records


def _guard(data_dir, plan_id, plan):
    if plan.review_binding is None:
        raise ValueError("review_only_plan_required")
    if recovery.code_revision() != plan.revision:
        raise recovery.RecoveryStop("code_or_runtime_changed")
    if recovery._path(data_dir, plan_id, "cancel").exists():
        raise recovery.RecoveryStop("cancel_requested")
    if recovery.protected_hashes(data_dir) != plan.protected:
        raise recovery.RecoveryStop("legacy_inputs_changed")
    return plan.review_binding


def apply_plan(data_dir, plan_id, *, payload=None):
    with recovery.owner(data_dir):
        plan = recovery.load_plan(data_dir, plan_id)
        binding = _guard(data_dir, plan_id, plan)
        saved = store.read_object(data_dir, binding.input_id)
        source = store.read_object(data_dir, binding.parent_job_id)
        if saved.get("kind") != "screener_review_input" or source.get("kind") != "screener_review_source_job":
            raise ValueError("invalid_review_adoption_objects")
        frozen = saved["payload"]
        if payload is not None:
            normalized = _input(payload, plan, recovery.RecoveryJob.model_validate(source["job"]))
            if store.digest(normalized) != store.digest(frozen):
                raise ValueError("review_input_changed")
        initial = store.load_snapshot(data_dir, binding.snapshot_id)[1]
        current_id, current = store.load_snapshot(data_dir)
        already_applied = current_id != binding.snapshot_id
        if already_applied:
            reviews = _applied(data_dir, plan_id, frozen, initial, binding.snapshot_id, current)
            final_id = current_id
        else:
            reviews = _prepare(data_dir, frozen, initial, plan_id=plan_id)
            if recovery.code_revision() != plan.revision or recovery.protected_hashes(data_dir) != plan.protected:
                raise recovery.RecoveryStop("review_inputs_changed_during_preflight")
            for evidence in frozen["evidence"]:
                store._write_object(store.root(data_dir), evidence)
            final_id = store.publish_correction_reviews(data_dir, reviews, expected_snapshot=binding.snapshot_id)
        if recovery.protected_hashes(data_dir) != plan.protected:
            raise recovery.RecoveryStop("legacy_inputs_changed_after_review")
        job = _job(data_dir, plan_id, plan, source["job"], final_id)
        if (store.load_snapshot(data_dir)[0] != final_id or recovery.protected_hashes(data_dir) != plan.protected
                or recovery.code_revision() != plan.revision):
            raise recovery.RecoveryStop("review_inputs_changed_after_publication")
        recovery._save(data_dir, job)
        return {"job": job.model_dump(mode="json"), "reviews": reviews, "already_applied": already_applied,
                "new_selections": sum(len(value["proofs"]) for value in frozen["requests"]), "snapshot_id": final_id}
