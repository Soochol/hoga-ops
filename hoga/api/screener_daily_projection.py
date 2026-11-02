"""Attested daily query facts without retaining original provider samples."""

from __future__ import annotations

import datetime as dt
import pickle
import zlib
from dataclasses import dataclass
from pathlib import Path

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_series_store as store,
    screener_snapshot_cache as snapshots,
)


@dataclass(frozen=True)
class Candidate:
    identity: str
    unadjusted: list[dict]
    confirmed_dates: set[str] | None
    invalid_adjusted: set[dt.date] | None
    session_scope: str
    policy: str


@dataclass(frozen=True)
class Observation:
    unadjusted: list[dict]
    adjusted: list[dict]
    adjusted_as_of: str
    conflicts: set[dt.date]
    invalid_unadjusted: set[dt.date] | None
    invalid_adjusted: set[dt.date] | None
    candidate: Candidate


def violation_dates(observation, basis):
    dates = set()
    for violation in observation.get("violations", []):
        if violation.get("basis", "unadjusted") != basis:
            continue
        try:
            dates.add(dt.datetime.strptime(violation["date_yyyymmdd"], "%Y%m%d").date())
        except (ValueError, KeyError):
            return None
    return dates


def read(data_dir: Path, identity: str) -> Observation:
    key = (str(Path(data_dir).resolve()), "daily-query-v1", identity)
    packed = snapshots.shared.obtain(key, lambda: _load(data_dir, identity))
    return pickle.loads(zlib.decompress(packed))


def _load(data_dir, identity):
    observation = store.read_object(data_dir, identity)
    candidate_id = observation.get("candidate_observation")
    if candidate_id:
        candidate = read(data_dir, candidate_id).candidate
    else:
        verified = confirmation.confirmed_dates(observation) if observation.get("confirmation") else None
        metadata = observation.get("confirmation", {})
        candidate = Candidate(
            identity, observation["unadjusted"], verified,
            violation_dates(observation, "adjusted"),
            metadata.get("session_scope", "legacy_unknown"), metadata.get("policy", "legacy_unverified"),
        )
    facts = Observation(
        observation["unadjusted"], observation["adjusted"], observation["adjusted_as_of"],
        {dt.date.fromisoformat(day) for day in observation.get("conflicts", [])},
        violation_dates(observation, "unadjusted"), violation_dates(observation, "adjusted"), candidate,
    )
    return zlib.compress(pickle.dumps(facts, protocol=pickle.HIGHEST_PROTOCOL))
