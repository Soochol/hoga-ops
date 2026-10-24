"""Evidence-bound v2 corrections. Legacy rows and all rejected candidates survive.

Verified legacy basis/rounding identities or an exact intraday OHLCV prefix can
select a confirmed provider observation. Closeness and repeated provider values
alone never explain an original conflict.
"""

from __future__ import annotations

import datetime as dt
import hashlib
from fractions import Fraction
from typing import Literal

import polars as pl
from pydantic import BaseModel, Field

from hoga.api import screener_daily_confirmation as confirmation, screener_series_store as store
from hoga.util.timeenc import KST

CorrectionReason = Literal[
    "legacy_reverse_rounding", "legacy_reverse_basis", "intraday_prefix", "legacy_pre_event_adjusted_basis",
]
FIELDS = ("open", "high", "low", "close", "volume")
MINUTE_BUCKET_MS = 60_000


class CorrectionProof(BaseModel):
    model_config = {"extra": "forbid"}
    date: dt.date
    reason: CorrectionReason
    evidence_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    prefix_end_ms: int | None = None


class CorrectionRequest(BaseModel):
    model_config = {"extra": "forbid"}
    code: str = Field(pattern=r"^[A-Z0-9]{6}$")
    proofs: list[CorrectionProof] = Field(min_length=1, max_length=10000)


def same_values(left, right):
    return all(Fraction(str(left[key])) == Fraction(str(right[key])) for key in FIELDS)


def _legacy_factor(data_dir, manifest, code, day):
    frame = pl.read_parquet(store.baseline_path(data_dir, manifest, "factors.parquet"))
    rows = frame.filter(pl.col("code") == code).sort("seg_start").to_dicts()
    eligible = [row for row in rows if row["seg_start"] <= day]
    if not rows:
        raise ValueError("legacy_factor_unavailable")
    return Fraction(str((eligible[-1] if eligible else rows[0])["factor"]))


def _share_event(evidence):
    if evidence.get("kind") != "verified_share_event" or not evidence.get("source_document_sha256"):
        raise ValueError("independent_share_event_required")
    document = evidence.get("source_document")
    if (not isinstance(document, str)
            or hashlib.sha256(document.encode()).hexdigest() != evidence["source_document_sha256"]):
        raise ValueError("independent_source_document_checksum_mismatch")
    event = store.ShareEvent.model_validate(evidence["event"])
    ratio = Fraction(event.numerator, event.denominator)
    if event.kind not in {"split", "consolidation", "stock_distribution"} or ratio == 1:
        raise ValueError("unsupported_share_event")
    return event, ratio


def _pre_event_adjusted(proof, evidence, old, selected, adjusted, factor, anchor):
    event, ratio = _share_event(evidence)
    if not evidence["source_document"] or event.effective_date > dt.date.fromisoformat(anchor):
        raise ValueError("independent_event_within_adjusted_anchor_required")
    boundary = evidence.get("trading_boundary", {})
    if not isinstance(boundary, dict):
        raise ValueError("independent_trading_unit_boundary_required")
    document = boundary.get("source_document")
    if (boundary.get("kind") != "verified_trading_unit_boundary"
            or boundary.get("code") != evidence["code"]
            or boundary.get("effective_date") != event.effective_date.isoformat()
            or not isinstance(document, str) or not document
            or hashlib.sha256(document.encode()).hexdigest() != boundary.get("source_document_sha256")):
        raise ValueError("independent_trading_unit_boundary_required")
    if proof.date >= event.effective_date:
        raise ValueError("adjusted_basis_outside_pre_event_range")
    if factor != 1:
        raise ValueError("adjusted_basis_requires_unit_legacy_factor")
    if adjusted is None or not same_values(old, adjusted):
        raise ValueError("entire_legacy_ohlcv_must_match_adjusted_source")
    if (any(Fraction(str(old[key])) != Fraction(str(selected[key])) / ratio
            for key in FIELDS if key != "volume")
            or Fraction(str(old["volume"])) != round(Fraction(str(selected["volume"])) * ratio)):
        raise ValueError("pre_event_adjusted_basis_identity_not_proven")


def _reverse(proof, evidence, old, selected, adjusted, factor):
    event, ratio = _share_event(evidence)
    if factor != 1 / ratio:
        raise ValueError("legacy_factor_does_not_match_evidence")
    old_numbers = {key: Fraction(str(old[key])) for key in FIELDS}
    new_numbers = {key: Fraction(str(selected[key])) for key in FIELDS}
    if proof.reason == "legacy_reverse_rounding":
        if proof.date >= event.effective_date or adjusted is None:
            raise ValueError("rounding_outside_pre_event_range")
        if any(old_numbers[key] != new_numbers[key] for key in FIELDS if key != "volume"):
            raise ValueError("rounding_must_not_change_price")
        adjusted_volume = round(new_numbers["volume"] * ratio)
        if adjusted["volume"] != adjusted_volume or old_numbers["volume"] != round(Fraction(adjusted_volume) / ratio):
            raise ValueError("rounding_identity_not_proven")
    else:
        if proof.date < event.effective_date:
            raise ValueError("wrong_basis_outside_post_event_range")
        if (any(old_numbers[key] / ratio != new_numbers[key] for key in FIELDS if key != "volume")
                or old_numbers["volume"] * ratio != new_numbers["volume"]):
            raise ValueError("inverse_basis_identity_not_proven")


def _basis_rule(proof, evidence, old, selected, adjusted, factor, anchor):
    if proof.reason == "legacy_pre_event_adjusted_basis":
        _pre_event_adjusted(proof, evidence, old, selected, adjusted, factor, anchor)
    else:
        _reverse(proof, evidence, old, selected, adjusted, factor)


def _prefix(proof, evidence, old, selected):
    response = evidence.get("response", {})
    day = proof.date.strftime("%Y%m%d")
    if (evidence.get("kind") != "provider_minute_prefix" or evidence.get("source") != "kiwoom:ka10080"
            or response.get("venue") != "KRX"
            or response.get("code") != evidence["code"] or response.get("data_warnings")
            or response.get("from") != day or response.get("to") != day
            or response.get("bucket_ms") != MINUTE_BUCKET_MS):
        raise ValueError("same_code_day_krx_minute_evidence_required")
    rows = response.get("candles", [])
    times = [row["t_ms"] for row in rows]
    if not rows or times != sorted(set(times)) or proof.prefix_end_ms not in times:
        raise ValueError("invalid_minute_prefix")
    boundary = dt.datetime.fromtimestamp(proof.prefix_end_ms / 1000, KST)
    if boundary.date() != proof.date or boundary.time() >= dt.time(20):
        raise ValueError("prefix_must_precede_full_day_close")
    factor = Fraction(str(response["adjust_factors"][day]))
    if factor <= 0:
        raise ValueError("invalid_minute_price_factor")
    prefix = [row for row in rows if row["t_ms"] <= proof.prefix_end_ms]
    if any(dt.datetime.fromtimestamp(row["t_ms"] / 1000, KST).date() != proof.date for row in prefix):
        raise ValueError("minute_prefix_crosses_day")
    numbers = {
        "open": Fraction(str(prefix[0]["open"])) / factor,
        "high": max(Fraction(str(row["high"])) for row in prefix) / factor,
        "low": min(Fraction(str(row["low"])) for row in prefix) / factor,
        "close": Fraction(str(prefix[-1]["close"])) / factor,
        "volume": sum(Fraction(str(row["volume"])) for row in prefix),
    }
    if any(numbers[key] != Fraction(str(old[key])) for key in FIELDS):
        raise ValueError("entire_ohlcv_prefix_does_not_match")
    if (selected["open"] != old["open"] or selected["high"] < old["high"]
            or selected["low"] > old["low"] or selected["volume"] < old["volume"]):
        raise ValueError("candidate_is_not_a_full_day_extension")


def publish_review(data_dir, request: CorrectionRequest, *, now=None):
    """Called under recovery ownership; atomic publication rejects a changed snapshot."""
    snapshot_id, manifest = store.load_snapshot(data_dir)
    review = prepare_review(data_dir, request, manifest, now=now)
    identity = store._publish(data_dir, "corrections", request.code, review, expected_snapshot=snapshot_id)
    return identity, review


def prepare_review(data_dir, request: CorrectionRequest, manifest, *, now=None, evidence=None, review_plan_id=None):
    """Validate against a pinned manifest without writing objects or publishing a selection."""
    from hoga.api.screener_series_values import valid_row  # noqa: PLC0415 — resolver uses accepted records

    observation_id = manifest["observations"].get(request.code)
    if observation_id is None:
        raise ValueError("provider_observation_required")
    observation = store.current_observation(data_dir, store.read_object(data_dir, observation_id))
    if confirmation.state(observation) != "confirmed":
        raise ValueError("confirmed_historical_observation_required")
    original = pl.scan_parquet(store.baseline_path(data_dir, manifest, "daily_unadjusted.parquet")).filter(
        pl.col("code") == request.code,
    ).collect()
    preserved = {row["date"].isoformat(): {**row, "date": row["date"].isoformat()}
                 for row in original.to_dicts()}
    candidates = {row["date"]: row for row in observation["unadjusted"]}
    adjusted = {row["date"]: row for row in observation["adjusted"]}
    confirmed = confirmation.confirmed_dates(observation)
    invalid = {v.get("date_yyyymmdd") for v in observation.get("violations", [])
               if v.get("basis", "unadjusted") == "unadjusted"}
    unlocalized_violation = False
    for day in invalid:
        try:
            dt.datetime.strptime(day, "%Y%m%d")
        except (TypeError, ValueError):
            unlocalized_violation = True
    prior_id = manifest.get("corrections", {}).get(request.code)
    prior = store.read_object(data_dir, prior_id) if prior_id else {}
    accepted = {row["date"]: row for row in prior.get("accepted", [])} if (
        prior.get("observation_id") == observation_id and prior.get("baseline") == manifest["baseline"]
    ) else {}
    rejected, seen = [], set()
    for proof in request.proofs:
        date = proof.date.isoformat()
        try:
            if date in seen:
                raise ValueError("duplicate_proof_date")
            seen.add(date)
            old, selected = preserved.get(date), candidates.get(date)
            if (date not in confirmed or proof.date.strftime("%Y%m%d") in invalid or unlocalized_violation
                    or old is None or selected is None or not valid_row(selected) or same_values(old, selected)):
                raise ValueError("valid_confirmed_conflicting_row_required")
            source = (evidence[proof.evidence_id] if evidence is not None
                      else store.read_object(data_dir, proof.evidence_id))
            if source.get("code") != request.code:
                raise ValueError("evidence_code_mismatch")
            if proof.reason == "intraday_prefix":
                _prefix(proof, source, old, selected)
            else:
                factor = _legacy_factor(data_dir, manifest, request.code, proof.date)
                _basis_rule(proof, source, old, selected, adjusted.get(date), factor, observation["adjusted_as_of"])
            accepted[date] = {**proof.model_dump(mode="json"), "preserved": old, "selected": selected}
        except (ValueError, KeyError, FileNotFoundError, TypeError) as exc:
            accepted.pop(date, None)
            rejected.append({**proof.model_dump(mode="json"), "error": str(exc)})
    review = {
        "kind": "screener_correction_review", "schema_version": 1, "code": request.code,
        "policy": "proven_legacy_correction_v1", "baseline": manifest["baseline"],
        "observation_id": observation_id, "candidate_id": store.digest(observation),
        "reviewed_at": (now or dt.datetime.now(KST)).isoformat(), "previous_review": prior_id,
        "accepted": [accepted[date] for date in sorted(accepted)], "rejected": rejected,
    }
    if review_plan_id is not None:
        review["review_plan_id"] = review_plan_id
        review["requested_proofs_id"] = store.digest(request.model_dump(mode="json"))
    return review


def apply_review(data_dir, manifest, code, original, conflicts, observation, confirmed):
    identity = manifest.get("corrections", {}).get(code)
    if not identity:
        return set()
    review = store.read_object(data_dir, identity)
    if (review.get("kind") != "screener_correction_review" or review.get("baseline") != manifest["baseline"]
            or review.get("observation_id") != manifest["observations"].get(code)
            or review.get("candidate_id") != store.digest(observation)):
        return set()
    candidates = {row["date"]: row for row in observation["unadjusted"]}
    corrected = set()
    for row in review["accepted"]:
        day = dt.date.fromisoformat(row["date"])
        current, selected = original.get(day), candidates.get(row["date"])
        if (row["date"] in confirmed and current is not None and selected is not None
                and same_values(current, row["preserved"]) and row["selected"] == selected):
            original[day] = selected
            conflicts.discard(day)
            corrected.add(day)
    return corrected
