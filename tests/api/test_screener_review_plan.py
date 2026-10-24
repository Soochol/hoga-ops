"""Review adoption retains source identities and publishes the entire selection batch atomically."""

import copy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import (
    screener_recovery as recovery,
    screener_review_plan as review,
    screener_series_store as store,
    screener_series_values as values,
)
from hoga.api.screener_recovery_api import build_router
from tests.api.test_screener_corrections import CODE, corpus as recovery_corpus, prepare, proof_payload
from tests.api.test_screener_recovery import DAYS

corpus = recovery_corpus


async def staged(root, monkeypatch):
    parent, _job, _request = await prepare(root)
    first = proof_payload()
    first["requests"][0]["proofs"] = first["requests"][0]["proofs"][:1]
    recovery.review_corrections(root, parent, first)
    payload = proof_payload()
    payload["requests"][0]["proofs"] = payload["requests"][0]["proofs"][1:]
    before = store.load_snapshot(root)
    old_files = {kind: recovery._path(root, parent, kind).read_bytes() for kind in ("plan", "job")}
    monkeypatch.setattr(recovery, "code_revision", lambda: "new-review-version")
    return parent, payload, before, old_files


async def test_adoption_preserves_observations_prior_corrections_and_source_job(corpus, monkeypatch):
    parent, payload, before, old_files = await staged(corpus, monkeypatch)
    protected = recovery.protected_hashes(corpus)
    with pytest.raises(recovery.RecoveryStop, match="unchanged_code"):
        recovery.review_corrections(corpus, parent, payload)
    child = review.create_plan(corpus, parent, payload)
    assert child != parent and store.load_snapshot(corpus) == before
    plan = recovery.load_plan(corpus, child)
    assert plan.review_binding.parent_plan_id == parent and plan.revision == "new-review-version"
    assert plan.initial_snapshot == recovery.load_plan(corpus, parent).initial_snapshot
    candidate = recovery.load_job(corpus, parent).items[CODE].candidate_id
    result = review.apply_plan(corpus, child)
    assert result["new_selections"] == 1 and not result["already_applied"]
    assert result["job"]["status"] == "complete"
    assert result["job"]["items"][CODE]["candidate_id"] == candidate
    assert result["job"]["items"][CODE]["resolved_conflict_dates"] == [day.isoformat() for day in DAYS[1:]]
    final_id, final = store.load_snapshot(corpus)
    for key, value in before[1].items():
        if key not in {"parent", "corrections"}:
            assert final[key] == value
    for kind, content in old_files.items():
        assert recovery._path(corpus, parent, kind).read_bytes() == content
    assert recovery.protected_hashes(corpus) == protected
    old = values.load_series(corpus, before[1], [CODE])[CODE]
    current = values.load_series(corpus, final, [CODE])[CODE]
    assert old.conflicts == {DAYS[-1]} and current.conflicts == set()
    assert current.quantity(DAYS[-1], DAYS[-1], "share_adjusted") is None
    again = review.apply_plan(corpus, child, payload=payload)
    assert again["already_applied"] and store.load_snapshot(corpus)[0] == final_id


async def test_crash_after_atomic_publication_can_rebuild_job_without_republishing(corpus, monkeypatch):
    parent, payload, before, _files = await staged(corpus, monkeypatch)
    child = review.create_plan(corpus, parent, payload)
    save = recovery._save
    def crash(*_args):
        raise OSError("simulated job persistence failure")
    monkeypatch.setattr(recovery, "_save", crash)
    with pytest.raises(OSError, match="simulated"):
        review.apply_plan(corpus, child)
    published = store.load_snapshot(corpus)[0]
    assert published != before[0]
    monkeypatch.setattr(recovery, "_save", save)
    result = review.apply_plan(corpus, child)
    assert result["already_applied"] and result["snapshot_id"] == published
    assert result["job"]["status"] == "complete"


@pytest.mark.parametrize("mutation", ["code", "legacy", "observation", "quantity", "input", "cancel"])
async def test_changed_inputs_never_publish(corpus, monkeypatch, mutation):
    parent, payload, _before, _files = await staged(corpus, monkeypatch)
    child = review.create_plan(corpus, parent, payload)
    if mutation == "code":
        monkeypatch.setattr(recovery, "code_revision", lambda: "another-version")
    elif mutation == "legacy":
        (corpus / "screener/saves.json").write_text('{}')
    elif mutation == "observation":
        manifest = store.load_snapshot(corpus)[1]
        observation = store.current_observation(corpus, store.read_object(corpus, manifest["observations"][CODE]))
        store._publish(corpus, "observations", CODE, observation, anchor=observation["adjusted_as_of"])
    elif mutation == "quantity":
        store._publish(corpus, "quantity", CODE, {"test": mutation})
    elif mutation == "input":
        payload = copy.deepcopy(payload)
        payload["requests"][0]["proofs"][0]["reason"] = "legacy_reverse_rounding"
    else:
        recovery.cancel(corpus, child)
    before = store.load_snapshot(corpus)[0]
    with pytest.raises((recovery.RecoveryStop, ValueError)):
        review.apply_plan(corpus, child, payload=payload)
    assert store.load_snapshot(corpus)[0] == before


async def test_rejected_proof_preflight_publishes_nothing(corpus, monkeypatch):
    parent, payload, before, _files = await staged(corpus, monkeypatch)
    payload["evidence"][0]["source_document"] += "mutated"
    evidence_id = store.digest(payload["evidence"][0])
    payload["requests"][0]["proofs"][0]["evidence_id"] = evidence_id
    with pytest.raises(ValueError, match="review_preflight_rejected"):
        review.create_plan(corpus, parent, payload)
    assert store.load_snapshot(corpus) == before


async def test_collection_endpoints_cannot_repurpose_review_plan(corpus, monkeypatch):
    parent, payload, _before, _files = await staged(corpus, monkeypatch)
    child = review.create_plan(corpus, parent, payload)
    async def never_fetch(*_args):
        pytest.fail("A review-only plan must never collect")
    with pytest.raises(recovery.RecoveryStop, match="review_plan_cannot_collect"):
        await recovery.run(corpus, child, fetch=never_fetch)
    app = FastAPI()
    app.include_router(build_router(corpus, fetch=never_fetch), prefix="/api/screener")
    with TestClient(app) as client:
        assert client.post(f"/api/screener/recovery/{child}/run", json={"resume": True}).status_code == 409
        response = client.get(f"/api/screener/recovery/{child}")
        assert response.status_code == 200 and response.json()["plan_id"] == child


async def test_atomic_batch_object_write_failure_leaves_snapshot_pointer_unchanged(corpus, monkeypatch):
    parent, payload, before, _files = await staged(corpus, monkeypatch)
    child = review.create_plan(corpus, parent, payload)
    original = store._write_object
    def fail(base, value):
        if value.get("review_plan_id") == child:
            raise OSError("simulated object write failure")
        return original(base, value)
    monkeypatch.setattr(store, "_write_object", fail)
    with pytest.raises(OSError, match="simulated object"):
        review.apply_plan(corpus, child)
    assert store.load_snapshot(corpus) == before


async def test_concurrent_publication_is_rejected_by_batch_compare_and_swap(corpus, monkeypatch):
    parent, payload, _before, _files = await staged(corpus, monkeypatch)
    child = review.create_plan(corpus, parent, payload)
    original = store.publish_correction_reviews
    concurrent = []
    def changed(root, reviews, **kwargs):
        concurrent.append(store._publish(root, "quantity", CODE, {"test": "concurrent"}))
        return original(root, reviews, **kwargs)
    monkeypatch.setattr(store, "publish_correction_reviews", changed)
    with pytest.raises(ValueError, match="스냅샷이 변경"):
        review.apply_plan(corpus, child)
    assert store.load_snapshot(corpus)[0] == concurrent[0]
    assert store.read_object(corpus, store.load_snapshot(corpus)[1]["corrections"][CODE]).get("review_plan_id") is None
