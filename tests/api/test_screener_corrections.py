"""Corrections need exact evidence, preserve original snapshots and survive scoped comparison."""

import copy
import hashlib
from fractions import Fraction

import polars as pl
import pytest

from hoga.api import (
    screener_corrections as corrections,
    screener_factors,
    screener_recovery as recovery,
    screener_series_store as store,
    screener_series_values as values,
)
from hoga.api.models import ScanRequest
from hoga.api.screener_recovery_compare import compare
from hoga.api.screener_series_execution import replay_execution
from hoga.api.screener_series_runner import run_scan
from tests.api.test_screener_daily_confirmation import confirmed
from tests.api.test_screener_recovery import DAYS, NOW, corpus as recovery_corpus, observation, spec

corpus = recovery_corpus
CODE = "005930"


def share_event(code=CODE):
    document = "fake primary source for the independently verified 5:1 consolidation"
    return {
        "kind": "verified_share_event", "code": code, "source_document": document,
        "source_document_sha256": hashlib.sha256(document.encode()).hexdigest(),
        "event": {"kind": "consolidation", "effective_date": DAYS[-1].isoformat(),
                  "numerator": 1, "denominator": 5, "source": "test:independently-verified-primary-source"},
    }


def proof_payload(evidence=None):
    evidence = evidence or share_event()
    evidence_id = store.digest(evidence)
    return {"evidence": [evidence], "requests": [{"code": CODE, "proofs": [
        {"date": DAYS[1].isoformat(), "reason": "legacy_reverse_rounding", "evidence_id": evidence_id},
        {"date": DAYS[-1].isoformat(), "reason": "legacy_reverse_basis", "evidence_id": evidence_id},
    ]}]}


async def prepare(root):
    sdir = root / "screener"
    factors = pl.read_parquet(sdir / "factors.parquet").with_columns(
        pl.when(pl.col("code") == CODE).then(pl.lit(5.)).otherwise(pl.col("factor")).alias("factor"),
    )
    factors.write_parquet(sdir / "factors.parquet")
    screener_factors.apply_factors(pl.read_parquet(sdir / "daily_unadjusted.parquet"), factors).write_parquet(
        sdir / "daily_adjusted.parquet",
    )
    request = ScanRequest.model_validate(dict(
        conditions=[dict(type="new_high_vol_today", id="v", params={"period":2})],
        universe={"exclude_etf":False},
    ))
    plan = spec([CODE]).model_copy(update={"confirmation_policy":"historical_recheck_v1", "comparisons":[request]})
    identity = recovery.create_plan(root, plan)
    async def fetch(target, anchor, _check):
        payload = observation(target, anchor)
        for row in payload["unadjusted"]:
            if row["date"] == DAYS[1].isoformat():
                row["volume"] = 88
            elif row["date"] == DAYS[-1].isoformat():
                row.update(open=500., high=500., low=500., close=500., volume=80)
        payload["adjusted"] = copy.deepcopy(payload["unadjusted"])
        for row in payload["adjusted"][:-1]:
            row.update(open=500., high=500., low=500., close=500., volume=round(Fraction(row["volume"],5)))
        return confirmed(payload)
    job = await recovery.run(root, identity, fetch=fetch, now=lambda:NOW)
    assert job.status == "partial" and job.items[CODE].conflict_dates == DAYS[1:]
    return identity, job, request


async def test_proven_corrections_do_not_modify_originals_or_certify_share_history(corpus):
    identity, job, _request = await prepare(corpus)
    before = recovery.protected_hashes(corpus)
    old_snapshot = job.items[CODE].snapshot_id
    result = recovery.review_corrections(corpus, identity, proof_payload())
    assert len(result["reviews"][CODE]["accepted"]) == 2
    assert result["reviews"][CODE]["rejected"] == []
    assert result["job"]["status"] == "complete"
    current = values.load_series(corpus, store.load_snapshot(corpus)[1], [CODE])[CODE]
    assert current.corrected == set(DAYS[1:]) and current.conflicts == set()
    assert current.original[DAYS[-1]]["close"] == 500 and current.original[DAYS[-1]]["volume"] == 80
    assert current.quantity(DAYS[1], DAYS[-1], "raw") == 88
    assert current.quantity(DAYS[1], DAYS[-1], "share_adjusted") is None
    old = values.load_series(corpus, store.load_snapshot(corpus, old_snapshot)[1], [CODE])[CODE]
    assert old.original[DAYS[-1]]["close"] == 100 and set(old.conflicts) == set(DAYS[1:])
    assert recovery.protected_hashes(corpus) == before
    evidence = store.ShareEvidence(code=CODE,instrument_id=f"stock:{CODE}",verified_from=DAYS[0],
                                   verified_to=DAYS[-1],observed_at=NOW,source="test:complete-interval",
                                   events=[share_event()["event"]])
    store.publish_share_evidence(corpus,evidence)
    current = values.load_series(corpus,store.load_snapshot(corpus)[1],[CODE])[CODE]
    assert current.quantity(DAYS[1],DAYS[-1],"share_adjusted") == Fraction(88,5)


@pytest.mark.parametrize("mutation", [
    "no_independent_source","wrong_document","wrong_code","wrong_ratio","wrong_event_day",
])
async def test_no_tolerance_or_price_ratio_fallback(corpus, mutation):
    identity, _job, _request = await prepare(corpus)
    before = recovery.protected_hashes(corpus)
    event = share_event()
    if mutation == "no_independent_source":
        event.pop("source_document_sha256")
    elif mutation == "wrong_document":
        event["source_document"] += " changed after verification"
    elif mutation == "wrong_code":
        event["code"] = "000660"
    elif mutation == "wrong_ratio":
        event["event"]["denominator"] = 10
    else:
        event["event"]["effective_date"] = DAYS[0].isoformat()
    result = recovery.review_corrections(corpus,identity,proof_payload(event))
    review = result["reviews"][CODE]
    if mutation == "wrong_event_day":
        assert [row["date"] for row in review["rejected"]] == [DAYS[1].isoformat()]
    else:
        assert len(review["rejected"]) == 2 and review["accepted"] == []
    assert recovery.protected_hashes(corpus) == before


async def test_unknown_proof_date_and_duplicate_are_retained_as_rejections(corpus):
    identity, _job, _request = await prepare(corpus)
    payload = proof_payload()
    payload["requests"][0]["proofs"] = [payload["requests"][0]["proofs"][0]] * 2
    result = recovery.review_corrections(corpus,identity,payload)
    assert result["reviews"][CODE]["accepted"] == []
    assert result["reviews"][CODE]["rejected"][0]["error"] == "duplicate_proof_date"


async def test_new_observation_invalidates_old_correction_but_pinned_version_survives(corpus):
    identity, _job, _request = await prepare(corpus)
    recovery.review_corrections(corpus,identity,proof_payload())
    corrected_snapshot, manifest = store.load_snapshot(corpus)
    current = store.current_observation(corpus,store.read_object(corpus,manifest["observations"][CODE]))
    store.publish_pair(corpus,**{field:current[field] for field in (
        "code","unadjusted","adjusted","adjusted_as_of","observed_at","price_events","provider_rows",
        "violations","confirmation",
    )})
    latest = values.load_series(corpus,store.load_snapshot(corpus)[1],[CODE])[CODE]
    pinned = values.load_series(corpus,store.load_snapshot(corpus,corrected_snapshot)[1],[CODE])[CODE]
    assert latest.corrected == set() and set(latest.conflicts) == set(DAYS[1:])
    assert pinned.corrected == set(DAYS[1:]) and pinned.conflicts == set()


async def test_exact_result_replay_and_import_keep_baseline_and_correction_identity(corpus,tmp_path_factory):
    identity, _job, request = await prepare(corpus)
    recovery.review_corrections(corpus,identity,proof_payload())
    result = await compare(corpus,identity,tmp_path_factory.mktemp("scoped") / "comparison")
    row = result["results"][0]
    assert result["production_preserved"] and row["legacy_equal"]
    assert [item["code"] for item in row["legacy_before"]["rows"]] == [CODE]
    assert row["variants"]["raw"]["rows"] == []
    assert row["variants"]["raw"]["bar_coverage"]["complete"] == 1
    assert row["variants"]["raw"]["calculation"]["daily_session_scope"] == "provider_daily_all_sessions"
    assert row["variants"]["raw_unreviewed"]["bar_coverage"]["complete"] == 0
    assert all(item["replay_equal"] for item in row["executions"].values())
    variant = request.model_copy(update={"calculation_policy":"separate_bases_v2"})
    response = await run_scan(data_dir=corpus,req=variant,now=NOW,record=True)
    replay = await replay_execution(corpus,response.calculation.execution_id)
    assert replay.rows == response.rows
    assert replay.calculation.correction_revision == response.calculation.correction_revision
    assert response.calculation.daily_session_scope == "mixed"
    assert response.calculation.daily_confirmation_policy == "mixed"


async def test_atomic_publication_rejects_stale_snapshot(corpus,monkeypatch):
    _identity, _job, _request = await prepare(corpus)
    payload = proof_payload()
    for evidence in payload["evidence"]:
        store._write_object(store.root(corpus),evidence)
    original = store._publish
    def changed(root,section,code,value,**kwargs):
        original(root,"quantity",code,{"test":"concurrent write"})
        return original(root,section,code,value,**kwargs)
    monkeypatch.setattr(store,"_publish",changed)
    request = corrections.CorrectionRequest.model_validate(payload["requests"][0])
    with pytest.raises(ValueError,match="스냅샷이 변경"):
        corrections.publish_review(corpus,request)
    assert store.load_snapshot(corpus)[1].get("corrections") is None


@pytest.mark.parametrize("mutation", [None,"quantity","price","venue","factor","duplicate_minute"])
async def test_entire_intraday_prefix_is_exact_and_price_adjustment_never_changes_volume(corpus, mutation):
    import datetime as dt

    plan = spec([CODE]).model_copy(update={"confirmation_policy":"historical_recheck_v1"})
    identity = recovery.create_plan(corpus,plan)
    async def fetch(target,anchor,_check):
        payload = observation(target,anchor)
        for field in ("unadjusted","adjusted"):
            payload[field] = copy.deepcopy(payload[field])
            payload[field][1].update(high=110.,low=90.,close=105.,volume=95)
        return confirmed(payload)
    await recovery.run(corpus,identity,fetch=fetch,now=lambda:NOW)
    before = recovery.protected_hashes(corpus)
    start = int(dt.datetime.combine(DAYS[1],dt.time(9),NOW.tzinfo).timestamp()*1000)
    response = {
        "code":CODE,"venue":"KRX","from":DAYS[1].strftime("%Y%m%d"),"to":DAYS[1].strftime("%Y%m%d"),
        "bucket_ms":60_000,"adjust_factors":{DAYS[1].strftime("%Y%m%d"):0.2},"data_warnings":[],
        "candles":[
            dict(t_ms=start,open=20.,high=20.,low=20.,close=20.,volume=45.),
            dict(t_ms=start+60_000,open=20.,high=20.,low=20.,close=20.,volume=45.),
            dict(t_ms=start+120_000,open=20.,high=22.,low=18.,close=21.,volume=5.),
        ],
    }
    if mutation == "quantity":
        response["candles"][0]["volume"] -= 1
    elif mutation == "price":
        response["candles"][1]["close"] += 0.01
    elif mutation == "venue":
        response["venue"] = "NXT"
    elif mutation == "factor":
        response["adjust_factors"][DAYS[1].strftime("%Y%m%d")] = 1.
    elif mutation == "duplicate_minute":
        response["candles"][0]["t_ms"] = response["candles"][1]["t_ms"]
    evidence = {"code":CODE,"kind":"provider_minute_prefix","source":"kiwoom:ka10080","response":response}
    payload = {"evidence":[evidence],"requests":[{"code":CODE,"proofs":[{
        "date":DAYS[1].isoformat(),"reason":"intraday_prefix","evidence_id":store.digest(evidence),
        "prefix_end_ms":start+60_000,
    }]}]}
    result = recovery.review_corrections(corpus,identity,payload)
    review = result["reviews"][CODE]
    item = values.load_series(corpus,store.load_snapshot(corpus)[1],[CODE])[CODE]
    if mutation is None:
        assert len(review["accepted"]) == 1 and review["rejected"] == []
        assert item.original[DAYS[1]]["volume"] == 95 and DAYS[1] not in item.conflicts
    else:
        assert review["accepted"] == [] and len(review["rejected"]) == 1
        assert item.original[DAYS[1]]["volume"] == 90 and DAYS[1] in item.conflicts
    assert recovery.protected_hashes(corpus) == before


def test_old_new_comparison_ignores_only_runtime_match_receipt_times():
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_recovery_compare import _stable

    original=ScreenerResponse.model_validate({"status":"ok","basis_at_ms":1,"rows":[{
        "code":CODE,"name":"test","market":"KOSPI","price":100,"trade_value_won":1000,"change_pct":None,
        "occurrences":[{"condition_id":"p","condition_key":"p","date":"2018-05-04",
          "bar_price_match":{"timeframe":"D","source":"close","value":100.,"reference":99.,
                             "window_start_ms":1,"is_open":False,"fetched_at_ms":1},
          "bar_trade_value_match":{"timeframe":"D","trade_value_won":1000.,"method":"ohlcv_estimate",
                                   "is_open":False,"fetched_at_ms":1}}],
    }]})
    later=original.model_copy(deep=True)
    later.rows[0].occurrences[0].bar_price_match.fetched_at_ms += 1
    later.rows[0].occurrences[0].bar_trade_value_match.fetched_at_ms += 1
    assert original.model_dump()!=later.model_dump()
    assert _stable(original)==_stable(later)
    later.rows[0].occurrences[0].bar_price_match.reference += 0.01
    assert _stable(original)!=_stable(later)
    later=original.model_copy(deep=True)
    later.rows[0].occurrences[0].bar_trade_value_match.trade_value_won += 1
    assert _stable(original)!=_stable(later)
    later=original.model_copy(deep=True)
    later.basis_at_ms += 1
    assert _stable(original)!=_stable(later)
