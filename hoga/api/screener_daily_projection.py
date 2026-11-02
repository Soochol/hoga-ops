"""Publisher-owned daily query facts bound to pinned immutable observations."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import time
import zlib
from bisect import bisect_right
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_series_store as store,
    screener_snapshot_cache as snapshots,
)
from hoga.api.read_shutdown import checkpoint
from hoga.util.atomic_write import _atomic_target
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
FORMAT = "daily_query_json_zlib_v1"
VERIFIER = "daily_confirmation_v1"
MAX_COMPRESSED_BYTES = 8 * 1024 * 1024
MAX_DECODED_BYTES = 64 * 1024 * 1024
MAX_HEADER_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 256 * 1024


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


@dataclass(frozen=True)
class DailySummary:
    adjusted_as_of: str
    session_scope: str
    policy: str
    confirmed_dates: frozenset[str] | None
    eligible_adjusted_dates: tuple[dt.date, ...]

    def confirmed_at_or_before(self, cutoff: dt.date, *, required: bool) -> int | None:
        if required and self.confirmed_dates is None:
            return None
        index = bisect_right(self.eligible_adjusted_dates, cutoff)
        if not index:
            return None
        hour = dt.time(15, 30) if self.confirmed_dates is None else dt.time(confirmation.FINALIZATION_HOUR)
        return int(dt.datetime.combine(self.eligible_adjusted_dates[index - 1], hour, KST).timestamp() * 1000)


class _Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _CandidateRows(_Schema):
    identity: str = Field(pattern=r"^[a-f0-9]{64}$")
    unadjusted: list[dict]
    confirmed_dates: list[str] | None
    invalid_adjusted: list[str] | None
    session_scope: str
    policy: str


class _Rows(_Schema):
    unadjusted: list[dict]
    adjusted: list[dict]
    adjusted_as_of: str
    conflicts: list[str]
    invalid_unadjusted: list[str] | None
    invalid_adjusted: list[str] | None
    candidate: _CandidateRows


class _Receipt(_Schema):
    identity: str = Field(pattern=r"^[a-f0-9]{64}$")
    stamp: list[int] = Field(min_length=5, max_length=5)


class _Header(_Schema):
    format: Literal["daily_query_json_zlib_v1"]
    verifier: Literal["daily_confirmation_v1"]
    observation_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    candidate_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    body_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    decoded_bytes: int = Field(ge=1, le=MAX_DECODED_BYTES)
    compressed_bytes: int = Field(ge=1, le=MAX_COMPRESSED_BYTES)
    sources: list[_Receipt] = Field(min_length=1)
    adjusted_as_of: str
    confirmed_dates: list[str] | None
    eligible_adjusted_dates: list[str]
    session_scope: str
    policy: str

    @model_validator(mode="after")
    def dependency_closure(self):
        identities = [source.identity for source in self.sources]
        if len(set(identities)) != len(identities) or not {self.observation_id, self.candidate_id} <= set(identities):
            raise ValueError("Invalid daily query source closure")
        dates = [dt.date.fromisoformat(day) for day in self.eligible_adjusted_dates]
        if dates != sorted(set(dates)):
            raise ValueError("Invalid daily query eligible dates")
        dt.date.fromisoformat(self.adjusted_as_of)
        if self.confirmed_dates is not None:
            for day in self.confirmed_dates:
                dt.date.fromisoformat(day)
            if not set(self.eligible_adjusted_dates) <= set(self.confirmed_dates):
                raise ValueError("Unconfirmed daily query date")
        return self

    def summary(self):
        return DailySummary(
            self.adjusted_as_of, self.session_scope, self.policy,
            frozenset(self.confirmed_dates) if self.confirmed_dates is not None else None,
            tuple(dt.date.fromisoformat(day) for day in self.eligible_adjusted_dates),
        )


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


def _source_path(data_dir, identity):
    return store.root(data_dir) / "objects" / f"{store._checked(identity)}.json"


def _body_path(data_dir, identity):
    return store.root(data_dir) / "daily_query" / f"{store._checked(identity)}.json.zlib"


def _attest(files, *, stop=None):
    for path, stamp in files.items():
        checkpoint(stop)
        store._assert_file(path, stamp)
    checkpoint(stop)


def _compile_legacy(data_dir, identity, *, stop=None):
    files, active = {}, set()

    def compile_one(source_id):
        checkpoint(stop)
        if source_id in active:
            raise ValueError("Cyclic daily candidate reference")
        active.add(source_id)
        path = _source_path(data_dir, source_id)
        stamp = snapshots.signature(path)
        # The disk target, including pre-existing targets, is the attested input.
        value = store.read_object(data_dir, source_id, stop=stop)
        files[path] = stamp
        store._assert_file(path, stamp)
        candidate_id = value.get("candidate_observation")
        if candidate_id:
            candidate = compile_one(candidate_id).candidate
        else:
            verified = confirmation.confirmed_dates(value) if value.get("confirmation") else None
            metadata = value.get("confirmation", {})
            candidate = Candidate(
                source_id, value["unadjusted"], verified, violation_dates(value, "adjusted"),
                metadata.get("session_scope", "legacy_unknown"), metadata.get("policy", "legacy_unverified"),
            )
        active.remove(source_id)
        return Observation(
            value["unadjusted"], value["adjusted"], value["adjusted_as_of"],
            {dt.date.fromisoformat(day) for day in value.get("conflicts", [])},
            violation_dates(value, "unadjusted"), violation_dates(value, "adjusted"), candidate,
        )

    facts = compile_one(identity)
    _attest(files, stop=stop)
    return facts, files


def _summary(facts):
    from hoga.api.screener_series_values import valid_price  # noqa: PLC0415

    candidate = facts.candidate
    invalid, verified = candidate.invalid_adjusted, candidate.confirmed_dates
    dates = sorted({
        dt.date.fromisoformat(row["date"]) for row in facts.adjusted
        if row.get("complete", True) and valid_price(row) and invalid is not None
        and dt.date.fromisoformat(row["date"]) not in invalid
        and (verified is None or row["date"] in verified)
    })
    return DailySummary(facts.adjusted_as_of, candidate.session_scope, candidate.policy,
                        frozenset(verified) if verified is not None else None, tuple(dates))


def _dates(value):
    return sorted(str(day) for day in value) if value is not None else None


def _encode(facts):
    candidate = facts.candidate
    value = {
        "unadjusted": facts.unadjusted, "adjusted": facts.adjusted, "adjusted_as_of": facts.adjusted_as_of,
        "conflicts": _dates(facts.conflicts), "invalid_unadjusted": _dates(facts.invalid_unadjusted),
        "invalid_adjusted": _dates(facts.invalid_adjusted),
        "candidate": {
            "identity": candidate.identity, "unadjusted": candidate.unadjusted,
            "confirmed_dates": _dates(candidate.confirmed_dates),
            "invalid_adjusted": _dates(candidate.invalid_adjusted),
            "session_scope": candidate.session_scope, "policy": candidate.policy,
        },
    }
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _decode(encoded):
    rows = _Rows.model_validate(json.loads(encoded))
    candidate = rows.candidate
    def as_dates(dates):
        return {dt.date.fromisoformat(day) for day in dates} if dates is not None else None

    dt.date.fromisoformat(rows.adjusted_as_of)
    verified = candidate.confirmed_dates
    if verified is not None:
        for day in verified:
            dt.date.fromisoformat(day)
    return Observation(
        rows.unadjusted, rows.adjusted, rows.adjusted_as_of, as_dates(rows.conflicts),
        as_dates(rows.invalid_unadjusted), as_dates(rows.invalid_adjusted),
        Candidate(candidate.identity, candidate.unadjusted, set(verified) if verified is not None else None,
                  as_dates(candidate.invalid_adjusted), candidate.session_scope, candidate.policy),
    )


def _decompress(packed, *, decoded_bytes=None, maximum=MAX_DECODED_BYTES, stop=None):
    decoder, parts, size = zlib.decompressobj(), [], 0
    for start in range(0, len(packed), CHUNK_BYTES):
        checkpoint(stop)
        remaining = packed[start:start + CHUNK_BYTES]
        while remaining:
            checkpoint(stop)
            budget = CHUNK_BYTES if maximum is None else min(CHUNK_BYTES, maximum - size + 1)
            part = decoder.decompress(remaining, budget)
            size += len(part)
            if maximum is not None and size > maximum:
                raise ValueError("Daily query decoded budget exceeded")
            parts.append(part)
            remaining = decoder.unconsumed_tail
        if decoder.unused_data:
            raise ValueError("Trailing daily query compressed content")
    if not decoder.eof or (decoded_bytes is not None and size != decoded_bytes):
        raise ValueError("Incomplete daily query body")
    checkpoint(stop)
    return b"".join(parts)


def _header_id(manifest, code):
    query = manifest.get("daily_query", {})
    if query.get("format") != FORMAT or query.get("verifier") != VERIFIER:
        return None
    return query.get("headers", {}).get(code)


def _read_header(data_dir, identity, observation_id, *, stop=None):
    path = _source_path(data_dir, identity)
    encoded, stamp = store._read_file(path, limit=MAX_HEADER_BYTES, stop=stop)
    value = json.loads(encoded)
    if store.digest(value) != identity:
        raise ValueError("Daily query header checksum mismatch")
    header = _Header.model_validate(value)
    if header.observation_id != observation_id:
        raise ValueError("Daily query observation binding mismatch")
    files = {_source_path(data_dir, source.identity): tuple(source.stamp) for source in header.sources}
    files[path] = stamp
    _attest(files, stop=stop)
    return header, files


def _read_body(data_dir, header, files, *, stop=None):
    path = _body_path(data_dir, header.body_id)
    packed, stamp = store._read_file(path, limit=MAX_COMPRESSED_BYTES, stop=stop)
    files[path] = stamp
    if len(packed) != header.compressed_bytes or hashlib.sha256(packed).hexdigest() != header.body_id:
        raise ValueError("Daily query body checksum mismatch")
    return packed


def _compact(data_dir, manifest, code, *, rows, stop=None):
    identity = _header_id(manifest, code)
    if identity is None:
        return None
    header, files = _read_header(data_dir, identity, manifest["observations"][code], stop=stop)
    if not rows:
        _attest(files, stop=stop)
        return header.summary()
    packed = _read_body(data_dir, header, files, stop=stop)
    facts = _decode(_decompress(packed, decoded_bytes=header.decoded_bytes, maximum=MAX_DECODED_BYTES, stop=stop))
    if facts.candidate.identity != header.candidate_id or _summary(facts) != header.summary():
        raise ValueError("Daily query body binding mismatch")
    _attest(files, stop=stop)
    return packed


def _load(data_dir, manifest, code, *, rows, stop=None):
    try:
        compact = _compact(data_dir, manifest, code, rows=rows, stop=stop)
        if compact is not None:
            return compact
    except (OSError, ValueError, KeyError, TypeError, zlib.error) as exc:
        log.warning("daily_query.verified_fallback", extra={"code": code, "reason": str(exc), "rows": rows})
    facts, files = _compile_legacy(data_dir, manifest["observations"][code], stop=stop)
    result = zlib.compress(_encode(facts)) if rows else _summary(facts)
    _attest(files, stop=stop)
    return result


def summary(data_dir: Path, manifest: dict, code: str, *, stop=None) -> DailySummary | None:
    if not manifest["observations"].get(code):
        return None
    return snapshots.obtain(data_dir, manifest, "daily-query-summary-v1", code,
                            lambda: _load(data_dir, manifest, code, rows=False, stop=stop), stop=stop)


def read(data_dir: Path, manifest: dict, code: str, *, stop=None) -> Observation | None:
    if not manifest["observations"].get(code):
        return None
    packed = snapshots.obtain(data_dir, manifest, "daily-query-rows-v1", code,
                              lambda: _load(data_dir, manifest, code, rows=True, stop=stop), stop=stop)
    checkpoint(stop)
    # Oversized legacy facts retain their existing in-memory fallback semantics.
    facts = _decode(_decompress(packed, maximum=None, stop=stop))
    checkpoint(stop)
    return facts


def _write_query_file(path, encoded, *, limit):
    try:
        installed, _ = store._read_file(path, limit=limit)
    except (FileNotFoundError, ValueError):
        installed = None
    if installed != encoded:
        # Only derived query artifacts can be restored. Source observations are never rewritten.
        with _atomic_target(path) as temporary, temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        store._sync_dir(path.parent)
        store._sync_dir(path.parent.parent)
    installed, _ = store._read_file(path, limit=limit)
    if installed != encoded:
        raise ValueError("Installed daily query artifact checksum mismatch")


def _write_body(data_dir, packed):
    identity = hashlib.sha256(packed).hexdigest()
    _write_query_file(_body_path(data_dir, identity), packed, limit=MAX_COMPRESSED_BYTES)
    return identity


def _write_header(data_dir, value):
    identity = store.digest(value)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    _write_query_file(_source_path(data_dir, identity), encoded, limit=MAX_HEADER_BYTES)
    return identity


def _prepare_code(data_dir, identity):
    facts, files = _compile_legacy(data_dir, identity)
    encoded = _encode(facts)
    if len(encoded) > MAX_DECODED_BYTES:
        return None
    packed = zlib.compress(encoded)
    if len(packed) > MAX_COMPRESSED_BYTES:
        return None
    body_id = _write_body(data_dir, packed)
    daily = _summary(facts)
    header = _Header(
        format=FORMAT, verifier=VERIFIER, observation_id=identity, candidate_id=facts.candidate.identity,
        body_id=body_id, decoded_bytes=len(encoded), compressed_bytes=len(packed),
        sources=[_Receipt(identity=path.stem, stamp=list(stamp)) for path, stamp in files.items()],
        adjusted_as_of=daily.adjusted_as_of, confirmed_dates=_dates(daily.confirmed_dates),
        eligible_adjusted_dates=_dates(daily.eligible_adjusted_dates),
        session_scope=daily.session_scope, policy=daily.policy,
    )
    value = header.model_dump()
    header_id = _write_header(data_dir, value)
    _read_header(data_dir, header_id, identity)
    _attest(files)
    return header_id


def _prepare_publication(data_dir, manifest, changed_codes):
    headers = {}
    for code in manifest["observations"]:
        identity = _header_id(manifest, code)
        if not identity:
            continue
        try:
            _read_header(data_dir, identity, manifest["observations"][code])
            headers[code] = identity
        except (OSError, ValueError, TypeError, KeyError):
            pass
    for code in sorted(changed_codes):
        identity = manifest["observations"].get(code)
        if not identity:
            continue
        header_id = _prepare_code(data_dir, identity)
        headers.pop(code, None)
        if header_id:
            headers[code] = header_id
        else:
            log.warning("daily_query.oversize", extra={"code": code, "observation_id": identity})
    if not headers and "daily_query" not in manifest:
        return manifest
    return {**manifest, "daily_query": {"format": FORMAT, "verifier": VERIFIER, "headers": headers}}


def _attest_publication(data_dir, manifest):
    files = {}
    for code in manifest.get("daily_query", {}).get("headers", {}):
        header, dependencies = _read_header(data_dir, _header_id(manifest, code), manifest["observations"][code])
        files.update(dependencies)
        _read_body(data_dir, header, files)
    _attest(files)


def prepare_existing_query_data(data_dir: Path, *, expected_snapshot: str, codes: list[str]):
    """Explicit, local-only child publication; old immutable snapshots remain pinned."""
    started = time.monotonic()
    source = store.load_snapshot(data_dir, expected_snapshot)
    selected = {code: source[1]["observations"].get(code) for code in set(codes)}
    prepared, oversized, headers = [], [], {}
    with store._series_write_lock(data_dir / "screener"):
        current = store.load_snapshot(data_dir)
        if current is None or any(
            current[1]["observations"].get(code) != identity for code, identity in selected.items()
        ):
            raise ValueError("Query preparation snapshot changed; retry the selected observations")
        for code, identity in selected.items():
            if not identity:
                continue
            old_header = _header_id(current[1], code)
            if old_header:
                try:
                    _compact(data_dir, current[1], code, rows=True)
                    headers[code] = old_header
                    continue
                except (OSError, ValueError, TypeError, KeyError, zlib.error):
                    pass
            header_id = _prepare_code(data_dir, identity)
            if header_id:
                headers[code] = header_id
                prepared.append(code)
            else:
                oversized.append(code)
        manifest = current[1]
        merged = {code: _header_id(manifest, code) for code in manifest["observations"] if _header_id(manifest, code)}
        merged.update(headers)
        updated = {**manifest, "daily_query": {"format": FORMAT, "verifier": VERIFIER, "headers": merged}}
        if updated == manifest:
            snapshot_id = current[0]
        else:
            snapshot_id = store._commit_snapshot(data_dir, {**updated, "parent": current[0]})
        sizes, sources = {}, {}
        for code, identity in headers.items():
            header, _ = _read_header(data_dir, identity, selected[code])
            sizes[code] = {"compressed_bytes": header.compressed_bytes, "decoded_bytes": header.decoded_bytes}
            sources.update({source.identity: source.stamp[2] for source in header.sources})
    return {
        "expected_snapshot": expected_snapshot, "previous_snapshot": current[0],
        "snapshot_id": snapshot_id, "no_op": snapshot_id == current[0],
        "prepared": sorted(prepared), "reused": sorted(set(headers) - set(prepared)), "oversized": sorted(oversized),
        "compressed_bytes": sum(size["compressed_bytes"] for size in sizes.values()),
        "decoded_bytes": sum(size["decoded_bytes"] for size in sizes.values()),
        "max_compressed_bytes": max((size["compressed_bytes"] for size in sizes.values()), default=0),
        "max_decoded_bytes": max((size["decoded_bytes"] for size in sizes.values()), default=0),
        "source_bytes": sum(sources.values()), "sizes": sizes, "elapsed_seconds": time.monotonic() - started,
    }
