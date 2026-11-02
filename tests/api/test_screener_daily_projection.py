"""Query projections preserve full confirmation trust and transitive dependencies."""

import datetime as dt
import json
import os
from collections import Counter

import pytest

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_daily_projection as projection,
    screener_series_runner as runner,
    screener_series_store as store,
    screener_series_values as values,
    screener_snapshot_cache as cache,
)
from tests.api.test_screener_daily_confirmation import confirmed, strict_spec
from tests.api.test_screener_recovery import DAYS, NOW, corpus as recovery_corpus, observation
from tests.api.test_screener_snapshot_cache import object_file

corpus = recovery_corpus


def test_confirmed_projection_validates_once_and_retains_exact_rows(corpus, monkeypatch):
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    store.publish_pair(corpus, **payload)
    _, manifest = store.load_snapshot(corpus)
    identity = manifest["observations"]["005930"]
    cache.shared.clear()
    calls = Counter()
    state = confirmation.state
    read = store.read_object

    def counted_state(value):
        calls["state"] += 1
        assert "provider_rows" in value["confirmation"]["second"]
        return state(value)

    def counted_read(data_dir, object_id):
        calls[object_id] += 1
        return read(data_dir, object_id)

    monkeypatch.setattr(confirmation, "state", counted_state)
    monkeypatch.setattr(store, "read_object", counted_read)
    runner._confirmed_at(corpus, manifest, ["005930"], NOW.date())
    values.load_series(corpus, manifest, ["005930"], first=DAYS[0], last=DAYS[-1])
    runner._daily_contract(corpus, manifest, ["005930"])
    facts = projection.read(corpus, identity)
    assert calls[identity] == calls["state"] == 1
    assert facts.candidate.identity == identity
    assert facts.candidate.unadjusted == payload["unadjusted"]
    assert facts.candidate.confirmed_dates == {day.isoformat() for day in DAYS}
    facts.candidate.unadjusted[0]["volume"] = 1
    assert projection.read(corpus, identity).candidate.unadjusted == payload["unadjusted"]
    assert read(corpus, identity)["confirmation"] == payload["confirmation"]


@pytest.mark.parametrize("damage", ["provider_rows", "duplicate", "second_values"])
def test_projection_rejects_original_confirmation_damage(tmp_path, damage):
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    if damage == "provider_rows":
        payload["provider_rows"] = {"raw": [{"price": "different"}]}
    elif damage == "duplicate":
        for sample in (payload, payload["confirmation"]["first"], payload["confirmation"]["second"]):
            sample["unadjusted"].append(dict(sample["unadjusted"][0]))
    else:
        payload["confirmation"]["second"]["unadjusted"][0]["volume"] += 1
    identity, _ = object_file(tmp_path, payload)
    with pytest.raises(ValueError):
        projection.read(tmp_path, identity)


@pytest.mark.parametrize("damage", ["tamper", "delete", "during_read"])
def test_merged_projection_forwards_candidate_attestation(tmp_path, monkeypatch, damage):
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    candidate_id, candidate_path = object_file(tmp_path, payload)
    merged = {**payload, "candidate_observation": candidate_id, "conflicts": [DAYS[0].isoformat()]}
    identity, _ = object_file(tmp_path, merged)
    cache.shared.clear()
    key = (str(tmp_path.resolve()), "wrapper")

    def load():
        return projection.read(tmp_path, identity)

    first = cache.shared.obtain(key, load)
    assert first.candidate.identity == candidate_id
    if damage == "delete":
        candidate_path.unlink()
        expected = FileNotFoundError
    elif damage == "tamper":
        stamp = candidate_path.stat()
        encoded = candidate_path.read_text()
        changed = encoded.replace('"volume": 100', '"volume": 101', 1)
        assert len(changed) == len(encoded) and changed != encoded
        candidate_path.write_text(changed)
        os.utime(candidate_path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        expected = ValueError
    else:
        cache.shared.clear()
        read = store.read_object

        def mutate(data_dir, object_id):
            value = read(data_dir, object_id)
            if object_id == candidate_id:
                candidate_path.write_text(json.dumps({**payload, "changed": True}))
            return value

        monkeypatch.setattr(store, "read_object", mutate)
        assert cache.shared.obtain(key, load) == first
        assert not cache.shared.entries
        return
    with pytest.raises(expected):
        cache.shared.obtain(key, load)


def test_candidate_invalid_dates_remain_distinct_from_merged_dates(tmp_path):
    payload = observation(strict_spec().targets[0], NOW.date())
    candidate_id, _ = object_file(tmp_path, payload)
    merged = {
        **payload, "candidate_observation": candidate_id,
        "violations": [{"date_yyyymmdd": "20180502", "basis": "adjusted"}],
    }
    identity, _ = object_file(tmp_path, merged)
    facts = projection.read(tmp_path, identity)
    assert facts.invalid_adjusted == {dt.date(2018, 5, 2)}
    assert facts.candidate.invalid_adjusted == set()
    assert facts.candidate.confirmed_dates is None


@pytest.mark.parametrize("exact_selection", [True, False])
def test_correction_selection_matches_full_candidate_rows(corpus, exact_selection):
    payload = observation(strict_spec().targets[0], NOW.date())
    selected = payload["unadjusted"][1]
    selected.update(volume=2**60 + 1, trade_value_won=1234, source_detail={"unit": "shares"})
    payload = confirmed(payload)
    store.publish_pair(corpus, **payload)
    _, manifest = store.load_snapshot(corpus)
    identity = manifest["observations"]["005930"]
    candidate = store.current_observation(corpus, store.read_object(corpus, identity))
    selected = candidate["unadjusted"][1]
    accepted = dict(selected) if exact_selection else {key: value for key, value in selected.items()
                                                    if key != "source_detail"}
    preserved = dict(selected, volume=90)
    review = {
        "kind": "screener_correction_review", "baseline": manifest["baseline"],
        "observation_id": identity, "candidate_id": store.digest(candidate),
        "accepted": [{"date": DAYS[1].isoformat(), "preserved": preserved, "selected": accepted}],
    }
    review_id, _ = object_file(corpus, review)
    manifest = {**manifest, "corrections": {"005930": review_id}}
    item = values.load_series(corpus, manifest, ["005930"], first=DAYS[0], last=DAYS[-1])["005930"]
    if exact_selection:
        assert item.corrected == {DAYS[1]}
        assert item.original[DAYS[1]] == selected
        assert item.quantity(DAYS[1], DAYS[-1], "raw") == 2**60 + 1
        assert item.amount(DAYS[1]) == 1234
    else:
        assert not item.corrected
        assert DAYS[1] in item.conflicts
