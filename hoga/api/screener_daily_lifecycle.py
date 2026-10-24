"""Reviewed terminal lifecycle facts; never infer retirement from an empty vendor response."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from hoga.api import screener_history_evidence as history, screener_series_store as series
from hoga.util.atomic_write import atomic_write_json


class LifecycleSource(BaseModel):
    model_config = {"extra": "forbid"}
    url: str = Field(pattern=r"^https://")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class LifecycleRecord(BaseModel):
    model_config = {"extra": "forbid"}
    code: str = Field(pattern=r"^[A-Z0-9]{6}$")
    name: str
    reason: Literal["delisted", "matured"]
    closed_from: dt.date
    checked_at: dt.datetime
    sources: list[LifecycleSource] = Field(min_length=1)

    @model_validator(mode="after")
    def aware(self):
        if self.checked_at.tzinfo is None:
            raise ValueError("Lifecycle evidence needs an aware observation timestamp")
        return self


class LifecycleReview(BaseModel):
    model_config = {"extra": "forbid"}
    schema_version: Literal[1] = 1
    records: dict[str, LifecycleRecord]

    @model_validator(mode="after")
    def identities(self):
        if any(code != row.code for code, row in self.records.items()):
            raise ValueError("Lifecycle record identity mismatch")
        return self


def root(data_dir):
    return data_dir / "screener/daily_ingest/lifecycle"


def reviewed(data_dir):
    pointer = root(data_dir) / "current.json"
    if not pointer.exists():
        return None, {}
    identity = series._checked(json.loads(pointer.read_bytes())["id"])
    payload = json.loads((root(data_dir) / "objects" / f"{identity}.json").read_bytes())
    if series.digest(payload) != identity:
        raise ValueError("Lifecycle review checksum mismatch")
    return identity, LifecycleReview.model_validate(payload).records


def scope(data_dir, now):
    """Preserve the old evidence file; layer reviewed dates into this collection only."""
    facts = history.load(data_dir)
    identity, records = reviewed(data_dir)
    retired = {c: "delisted" for c, fact in facts.items()
               if fact.delisting_date and fact.delisting_date <= now.date() and fact.checked_at <= now}
    for code, row in records.items():
        if row.checked_at > now:
            continue
        old = facts.get(code)
        if old and old.delisting_date not in {None, row.closed_from}:
            raise ValueError(f"Conflicting sourced lifecycle dates: {code}")
        urls = [source.url for source in row.sources]
        fact = old or history.HistoryEvidence(name=row.name, checked_at=row.checked_at, sources=urls)
        facts[code] = fact.model_copy(update={
            "delisting_date": row.closed_from, "sources": list(dict.fromkeys([*fact.sources, *urls])),
        })
        if row.closed_from <= now.date():
            retired[code] = row.reason
    return facts, retired, identity


def register(data_dir: Path, review: LifecycleReview, sources: Path):
    """Publish a complete reviewed set with immutable source bytes, without changing prices or conditions."""
    from hoga.api.screener_recovery import owner  # noqa: PLC0415
    from hoga.api.screener_write_lock import screener_write_lock  # noqa: PLC0415

    blobs = {}
    for record in review.records.values():
        identity_bound = False
        for source in record.sources:
            compressed = (sources / f"{source.sha256}.gz").read_bytes()
            raw = gzip.decompress(compressed)
            if hashlib.sha256(raw).hexdigest() != source.sha256:
                raise ValueError(f"Lifecycle source checksum mismatch: {record.code}")
            identity_bound |= record.code.encode() in raw
            blobs[source.sha256] = compressed
        if not identity_bound:
            raise ValueError(f"Lifecycle source identity missing: {record.code}")
    with owner(data_dir), screener_write_lock(data_dir / "screener"):
        for identity, blob in blobs.items():
            path = root(data_dir) / "evidence" / f"{identity}.gz"
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                if hashlib.sha256(gzip.decompress(path.read_bytes())).hexdigest() != identity:
                    raise ValueError("Stored lifecycle evidence changed")
            else:
                from hoga.util.atomic_write import _atomic_target  # noqa: PLC0415

                with _atomic_target(path) as temporary:
                    temporary.write_bytes(blob)
        identity = series._write_object(root(data_dir), review.model_dump(mode="json"))
        atomic_write_json(root(data_dir) / "current.json", {"id": identity})
    return identity


def reclassify(data_dir, now):
    """Reuse the last actual samples; do not fetch, confirm a new observation, or reset retry budgets."""
    import time  # noqa: PLC0415

    from hoga.api import screener_daily_ingest as ingest  # noqa: PLC0415
    from hoga.api.screener_recovery import owner  # noqa: PLC0415

    with owner(data_dir):
        state = ingest.load(data_dir)
        if not state["summary"] or state["summary"].get("commit_pending"):
            raise ValueError("A completed collection is required for lifecycle reclassification")
        facts, retired, identity = scope(data_dir, now)
        sample_ids = {e["code"]: e["sample_id"] for e in state["entries"].values() if e.get("sample_id")}
        sample_ids.update({c: e["sample_id"] for c, e in state.get("missing_dates", {}).items() if e.get("sample_id")})
        samples = {}
        for code, sample_id in sample_ids.items():
            sample_path = ingest.root(data_dir) / "samples" / f"{sample_id}.json.gz"
            payload = json.loads(gzip.decompress(sample_path.read_bytes()))
            if series.digest(payload) != sample_id or payload["code"] != code:
                raise ValueError("Original collection evidence changed")
            samples[code, 0] = sample_id, payload
        days = sorted({e["date"] for e in state["entries"].values()}
                      | {day for e in state.get("missing_dates", {}).values() for day in e["dates"]})
        old = dict(state["summary"])
        failures = dict(old.get("errors", {}))
        # Only recalculate coverage for the last recheck window, not old sticky conflicts.
        days = state.get("last_window", days[-ingest.RECHECK_DAYS:])
        clock = dt.datetime.fromisoformat(old["last_attempt_at"])
        ingest._finish_state(
            state, sorted(sample_ids), days, samples, failures, clock, time.monotonic(), facts, retired,
        )
        for key in ("last_attempt_at", "checked_on", "attempts_today", "provider_pages", "reused_samples",
                    "elapsed_ms", "sample_count", "codes", "skipped_codes"):
            if key in old:
                state["summary"][key] = old[key]
        state["summary"]["commit_pending"] = False
        state["lifecycle_revision"] = identity
        ingest._publish(data_dir, state)
        return state["summary"]
