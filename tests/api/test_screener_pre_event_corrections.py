"""Pre-event adjusted rows require independent unit/boundary evidence and exact OHLCV."""

import copy
import datetime as dt
import hashlib
from fractions import Fraction

import polars as pl
import pytest

from hoga.api import (
    screener_recovery as recovery,
    screener_review_plan as review,
    screener_series_store as store,
    screener_series_values as values,
)
from tests.api.test_screener_corrections import CODE, corpus as recovery_corpus, share_event
from tests.api.test_screener_daily_confirmation import confirmed
from tests.api.test_screener_recovery import DAYS, NOW, observation, spec

corpus = recovery_corpus


async def stage(root, ratio, mutation=None):
    if mutation == "factor":
        path = root / "screener/factors.parquet"
        pl.read_parquet(path).with_columns(pl.lit(5.).alias("factor")).write_parquet(path)
    specification = spec([CODE]).model_copy(update={"confirmation_policy": "historical_recheck_v1"})
    parent = recovery.create_plan(root, specification)

    async def fetch(target, anchor, _check):
        payload = observation(target, anchor)
        payload["adjusted"] = copy.deepcopy(payload["unadjusted"])
        for row in payload["unadjusted"]:
            row.update({key: float(Fraction(str(row[key])) * ratio) for key in ("open", "high", "low", "close")})
            row["volume"] = int(Fraction(row["volume"]) / ratio)
        if mutation == "price":
            payload["unadjusted"][1]["high"] += 1
        elif mutation == "volume":
            payload["unadjusted"][1]["volume"] += ratio.denominator
        elif mutation == "adjusted":
            payload["adjusted"][1]["volume"] += 1
        return confirmed(payload)

    job = await recovery.run(root, parent, fetch=fetch, now=lambda: NOW)
    assert job.items[CODE].conflict_dates == DAYS[1:]
    evidence = share_event()
    event_day = DAYS[-1] + dt.timedelta(days=1)
    evidence["event"].update(kind="stock_distribution" if ratio > 1 else "consolidation",
                             numerator=ratio.numerator, denominator=ratio.denominator,
                             effective_date=event_day.isoformat())
    document = "fake exchange notice: actual trading unit boundary, distinct from legal/record/listing date"
    evidence["trading_boundary"] = dict(kind="verified_trading_unit_boundary", code=CODE,
        effective_date=event_day.isoformat(), source_document=document,
        source_document_sha256=hashlib.sha256(document.encode()).hexdigest())
    mutate_evidence(evidence, mutation)
    payload = {"evidence": [evidence], "requests": [{"code": CODE, "proofs": [
        dict(date=day.isoformat(), reason="legacy_pre_event_adjusted_basis", evidence_id=store.digest(evidence))
        for day in DAYS[1:]
    ]}]}
    return parent, payload


def mutate_evidence(evidence, mutation):
    if mutation == "decision_checksum":
        evidence["source_document"] += "tampered"
    elif mutation == "empty_decision":
        evidence["source_document"] = ""
        evidence["source_document_sha256"] = hashlib.sha256(b"").hexdigest()
    elif mutation == "boundary_checksum":
        evidence["trading_boundary"]["source_document"] += "tampered"
    elif mutation == "no_boundary":
        evidence.pop("trading_boundary")
    elif mutation == "malformed_boundary":
        evidence["trading_boundary"] = None
    elif mutation == "boundary_code":
        evidence["trading_boundary"]["code"] = "000660"
    elif mutation == "boundary_date":
        evidence["trading_boundary"]["effective_date"] = DAYS[-1].isoformat()
    elif mutation == "post_event":
        evidence["event"]["effective_date"] = DAYS[1].isoformat()
        evidence["trading_boundary"]["effective_date"] = DAYS[1].isoformat()
    elif mutation == "future_event":
        day = (NOW.date() + dt.timedelta(days=1)).isoformat()
        evidence["event"]["effective_date"] = day
        evidence["trading_boundary"]["effective_date"] = day
    elif mutation == "ratio":
        evidence["event"]["denominator"] *= 3
    elif mutation == "cash_event":
        evidence["event"]["kind"] = "cash_dividend"
    elif mutation == "unit_event":
        evidence["event"].update(numerator=1, denominator=1)


@pytest.mark.parametrize("ratio", [Fraction(1, 5), Fraction(2)])
async def test_pre_event_selection_preserves_legacy_pinned_history_and_quantity_unknown(corpus, ratio):
    parent, payload = await stage(corpus, ratio)
    before = store.load_snapshot(corpus)
    protected = recovery.protected_hashes(corpus)
    child = review.create_plan(corpus, parent, payload)
    result = review.apply_plan(corpus, child)
    assert result["new_selections"] == 2
    assert result["reviews"][CODE]["rejected"] == []
    current = values.load_series(corpus, store.load_snapshot(corpus)[1], [CODE])[CODE]
    old = values.load_series(corpus, before[1], [CODE])[CODE]
    assert current.corrected == set(DAYS[1:]) and current.conflicts == set()
    assert old.conflicts == set(DAYS[1:]) and old.original[DAYS[1]]["close"] == 100
    assert current.original[DAYS[1]]["close"] == 100 * ratio
    assert current.quantity(DAYS[1], DAYS[-1], "share_adjusted") is None
    assert recovery.protected_hashes(corpus) == protected
    assert review.apply_plan(corpus, child)["already_applied"]


@pytest.mark.parametrize("mutation", [
    "factor", "price", "volume", "adjusted", "decision_checksum", "boundary_checksum", "no_boundary",
    "malformed_boundary", "boundary_code", "boundary_date", "post_event", "ratio", "cash_event", "unit_event",
    "empty_decision", "future_event",
])
async def test_any_unproven_row_aborts_whole_review_without_publication(corpus, mutation):
    parent, payload = await stage(corpus, Fraction(1, 5), mutation)
    before = store.load_snapshot(corpus)
    protected = recovery.protected_hashes(corpus)
    with pytest.raises(ValueError, match="review_preflight_rejected"):
        review.create_plan(corpus, parent, payload)
    assert store.load_snapshot(corpus) == before
    assert recovery.protected_hashes(corpus) == protected
