"""Session identity and historical recheck gates, including incomplete and changing data."""

import copy
import datetime as dt

import pytest
from pydantic import ValidationError

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_recovery as recovery,
    screener_series_store as store,
    screener_series_values as values,
)
from tests.api.test_screener_recovery import DAYS, NOW, corpus as recovery_corpus, observation, spec

corpus = recovery_corpus


def confirmed(payload, *, first=None, started=None):
    payload = copy.deepcopy(payload)
    started = started or NOW - dt.timedelta(seconds=confirmation.RECHECK_SECONDS)
    first_sample = dict(
        started_at=started.isoformat(), finished_at=started.isoformat(),
        **{field: copy.deepcopy(payload[field]) for field in (*confirmation.FIELDS, "provider_rows")},
    )
    if first:
        first_sample.update(first)
    second_sample = dict(
        started_at=NOW.isoformat(), finished_at=NOW.isoformat(),
        **{field: copy.deepcopy(payload[field]) for field in (*confirmation.FIELDS, "provider_rows")},
    )
    payload["observed_at"] = NOW.isoformat()
    payload["confirmation"] = confirmation.DailyConfirmation(
        first=first_sample, second=second_sample,
    ).model_dump(mode="json")
    return payload


def strict_spec():
    return spec(["005930"]).model_copy(update={"confirmation_policy": "historical_recheck_v1"})


async def test_new_plan_requires_confirmation_before_publication(corpus):
    identity = recovery.create_plan(corpus, strict_spec())
    async def fetch(target, anchor, _check):
        return observation(target, anchor)
    job = await recovery.run(corpus, identity, fetch=fetch, now=lambda:NOW)
    assert job.status == "partial" and job.items["005930"].status == "failed"
    assert store.load_snapshot(corpus) is None


@pytest.mark.parametrize("change", ["unadjusted", "adjusted", "price_events"])
async def test_unstable_rounds_are_retained_but_cannot_supply_prices_or_quantity(corpus, change):
    before = recovery.protected_hashes(corpus)
    identity = recovery.create_plan(corpus, strict_spec())
    async def fetch(target, anchor, _check):
        result = confirmed(observation(target, anchor))
        first = result["confirmation"]["first"]
        if change == "price_events":
            first[change] = [{"unverified_provider_event": "different"}]
        else:
            first[change][0]["volume"] += 1
        return result
    job = await recovery.run(corpus, identity, fetch=fetch, now=lambda:NOW)
    assert job.status == "partial" and job.items["005930"].confirmation_state == "unstable"
    item = values.load_series(corpus, store.load_snapshot(corpus)[1], ["005930"])["005930"]
    assert item.prices == {} and item.quantity(DAYS[-1], DAYS[-1], "raw") is None
    assert recovery.protected_hashes(corpus) == before


def test_cutoff_is_after_full_day_not_1530_and_identity_is_bound():
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()),
                        started=dt.datetime.combine(DAYS[-1], dt.time(21,59), NOW.tzinfo))
    assert confirmation.state(payload) == "too_early"
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    assert confirmation.state(payload) == "confirmed"
    assert payload["confirmation"]["close_semantics"] == "provider_last_price"
    payload["unadjusted"][0]["volume"] += 1
    with pytest.raises(ValueError, match="표본과 공개 후보"):
        confirmation.state(payload)


def test_rechecks_must_be_separated_and_wrong_venue_is_rejected():
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    payload["confirmation"]["second"]["started_at"] = payload["confirmation"]["first"]["finished_at"]
    with pytest.raises(ValidationError, match="독립 재조회"):
        confirmation.state(payload)
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    payload["confirmation"]["venue"] = "NXT"
    with pytest.raises(ValidationError):
        confirmation.state(payload)


async def test_latest_confirmed_candidate_does_not_certify_older_merged_rows(corpus):
    target = spec(["005930"]).targets[0]
    old_snapshot = store.publish_pair(corpus, **observation(target, NOW.date()))
    payload = confirmed(observation(target, NOW.date()))
    for sample in [payload, payload["confirmation"]["first"], payload["confirmation"]["second"]]:
        for field in ("unadjusted", "adjusted"):
            sample[field] = sample[field][-1:]
    snapshot = store.publish_pair(corpus, **payload)
    item = values.load_series(corpus, store.load_snapshot(corpus, snapshot)[1], ["005930"])["005930"]
    assert set(item.prices) == {DAYS[-1]}
    assert item.quantity(DAYS[1], DAYS[-1], "raw") is None
    # The old pinned version keeps its original contract.
    old = values.load_series(corpus, store.load_snapshot(corpus, old_snapshot)[1], ["005930"])["005930"]
    assert old.quantity(DAYS[1], DAYS[-1], "raw") is not None


def test_v2_writer_never_recovers_legacy_journal(corpus):
    before = recovery.protected_hashes(corpus)
    sdir = corpus / "screener"
    pending = sdir / "daily_unadjusted.parquet.history-pending"
    pending.write_bytes(b"do not publish")
    journal = sdir / "history_publish.json"
    journal.write_text('{"files":["daily_unadjusted.parquet"]}')
    with pytest.raises(ValueError, match="기존 미완료 공개"):
        store.ensure_baseline(corpus)
    assert journal.exists() and pending.read_bytes() == b"do not publish"
    journal.unlink()
    assert recovery.protected_hashes(corpus) == before


async def test_confirmed_snapshot_contract_cannot_be_downgraded_by_a_legacy_writer(corpus):
    target = strict_spec().targets[0]
    snapshot = store.publish_pair(corpus,**confirmed(observation(target,NOW.date())))
    store.publish_pair(corpus,**observation(target,NOW.date()))
    current_manifest = store.load_snapshot(corpus)[1]
    assert current_manifest["daily_contract_required"] is True
    item = values.load_series(corpus,current_manifest,[target.code])[target.code]
    assert item.prices == {} and item.quantity(DAYS[-1],DAYS[-1],"raw") is None
    previous = values.load_series(corpus,store.load_snapshot(corpus,snapshot)[1],[target.code])[target.code]
    assert previous.quantity(DAYS[-1],DAYS[-1],"raw") is not None


def test_new_specs_are_strict_but_old_saved_plan_contract_is_not_rewritten(corpus):
    import json

    payload=spec().model_dump(mode="json")
    payload.pop("confirmation_policy")
    assert recovery.RecoverySpec.model_validate(payload).confirmation_policy == "historical_recheck_v1"
    identity=recovery.create_plan(corpus,spec())
    original=json.loads(recovery._path(corpus,identity,"plan").read_text())
    original.pop("confirmation_policy")
    old_id=store.digest(original)
    path=recovery._path(corpus,old_id,"plan")
    text=json.dumps(original)
    path.write_text(text)
    assert recovery.load_plan(corpus,old_id).confirmation_policy == "legacy_unverified"
    assert path.read_text() == text
