"""Immutable observations for v2. Legacy files are inputs, never write targets.

A manifest references content-addressed objects. Readers pin one manifest, while
writers publish its pointer only after every referenced file has been fsynced.
"""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from hoga.api import trading_days
from hoga.util.atomic_write import atomic_write_json

_HASH = re.compile(r"^[a-f0-9]{64}$")
_BASE_FILES = (
    "daily_unadjusted.parquet",
    "daily_adjusted.parquet",
    "factors.parquet",
    "stocks.parquet",
    "status.json",
    "history_evidence.json",
    "saves.json",
    "exclusions.json",
)


@contextmanager
def _series_write_lock(sdir):
    """Share the commit lock, but never recover or write the legacy publication journal."""
    sdir.mkdir(parents=True, exist_ok=True)
    with (sdir / ".writer.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            if (sdir / "history_publish.json").exists():
                raise ValueError("기존 미완료 공개를 보존하기 위해 v2 쓰기를 중단합니다")
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class ShareEvent(BaseModel):
    model_config = {"extra": "forbid"}
    effective_date: dt.date
    kind: Literal["split", "consolidation", "stock_distribution", "cash", "unsupported"]
    numerator: int = Field(default=1, gt=0, le=10**12)
    denominator: int = Field(default=1, gt=0, le=10**12)
    source: str = Field(min_length=1)

    @model_validator(mode="after")
    def cash_has_no_quantity_effect(self):
        if self.kind in {"cash", "unsupported"} and (self.numerator, self.denominator) != (1, 1):
            raise ValueError("현금·미지원 이벤트에 수량 비율을 추정할 수 없습니다")
        return self


class ShareEvidence(BaseModel):
    model_config = {"extra": "forbid"}
    code: str = Field(pattern=r"^[A-Z0-9]{6}$")
    instrument_id: str = Field(min_length=1)
    verified_from: dt.date
    verified_to: dt.date
    observed_at: dt.datetime
    source: str = Field(min_length=1)
    events: list[ShareEvent] = Field(default_factory=list)

    @model_validator(mode="after")
    def range_complete(self):
        if self.verified_from > self.verified_to or self.observed_at.tzinfo is None:
            raise ValueError("수량 이력의 검증 구간·확인 시각이 필요합니다")
        if any(not self.verified_from <= event.effective_date <= self.verified_to for event in self.events):
            raise ValueError("검증 범위 밖의 이벤트입니다")
        identities = [(event.effective_date, event.kind) for event in self.events]
        if len(identities) != len(set(identities)):
            raise ValueError("수량 이벤트가 중복되었습니다")
        return self


def root(data_dir: Path) -> Path:
    return data_dir / "screener" / "series_v2"


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    ).hexdigest()


def _checked(value: str) -> str:
    if not _HASH.fullmatch(value):
        raise ValueError("Invalid snapshot/object identity")
    return value


def _sync_dir(path: Path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_object(base: Path, value) -> str:
    identity = digest(value)
    path = base / "objects" / f"{identity}.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, value)
        with path.open("rb") as handle:
            os.fsync(handle.fileno())
        _sync_dir(path.parent)
    return identity


def read_object(data_dir: Path, identity: str):
    value = json.loads((root(data_dir) / "objects" / f"{_checked(identity)}.json").read_text())
    if digest(value) != identity:
        raise ValueError("Snapshot object checksum mismatch")
    return value


def _baseline_metadata(stage: Path, files: dict) -> dict:
    import polars as pl  # noqa: PLC0415 — baseline-only metadata scan

    from hoga.api.screener_series_execution import code_revision  # noqa: PLC0415 — runtime avoids import cycle

    inventory = {}
    for name in files:
        if not name.endswith(".parquet"):
            continue
        frame = pl.scan_parquet(stage / name)
        columns = frame.collect_schema().names()
        date = "date" if "date" in columns else "seg_start" if "seg_start" in columns else None
        fields = [pl.len().alias("rows"), pl.col("code").n_unique().alias("codes")]
        if date:
            fields.extend(
                [pl.col(date).min().cast(pl.String).alias("first"), pl.col(date).max().cast(pl.String).alias("last")]
            )
        inventory[name] = frame.select(fields).collect().to_dicts()[0]
    return {
        "schema_version": 1,
        "source": "legacy_unknown",
        "files": files,
        "inventory": inventory,
        "code_revision": code_revision(),
    }


def ensure_baseline(data_dir: Path) -> str:
    base = root(data_dir)
    pointer = base / "baseline.json"
    if pointer.exists():
        return _checked(json.loads(pointer.read_text())["id"])
    base.mkdir(parents=True, exist_ok=True)
    with _series_write_lock(data_dir / "screener"), tempfile.TemporaryDirectory(dir=base) as tmp:
        if pointer.exists():
            return _checked(json.loads(pointer.read_text())["id"])
        stage = Path(tmp)
        files = {}
        for name in _BASE_FILES:
            src = data_dir / "screener" / name
            if not src.exists():
                continue
            dst = stage / name
            shutil.copyfile(src, dst)
            with dst.open("rb") as handle:
                files[name] = hashlib.file_digest(handle, "sha256").hexdigest()
                os.fsync(handle.fileno())
        if "daily_unadjusted.parquet" not in files or "stocks.parquet" not in files:
            raise ValueError("스크리너 기준선 데이터가 없습니다")
        atomic_write_json(stage / "calendar.json", sorted(trading_days.trading_days(data_dir)))
        with (stage / "calendar.json").open("rb") as handle:
            files["calendar.json"] = hashlib.file_digest(handle, "sha256").hexdigest()
        metadata = _baseline_metadata(stage, files)
        identity = digest(metadata)
        atomic_write_json(stage / "manifest.json", metadata)
        target = base / "legacy" / identity
        target.parent.mkdir(exist_ok=True)
        _sync_dir(stage)
        if not target.exists():
            os.rename(stage, target)
        _sync_dir(target.parent)
        atomic_write_json(pointer, {"id": identity})
        _sync_dir(base)
    return identity


def load_snapshot(data_dir: Path, snapshot_id: str | None = None) -> tuple[str, dict] | None:
    base = root(data_dir)
    if snapshot_id is None:
        pointer = base / "current.json"
        if not pointer.exists():
            return None
        snapshot_id = json.loads(pointer.read_text())["id"]
    manifest = read_object(data_dir, _checked(snapshot_id))
    if manifest.get("schema_version") != 1 or not all(
        key in manifest for key in ("baseline", "roster", "observations", "quantity", "adjusted_as_of")
    ):
        raise ValueError("Unsupported series snapshot version")
    return snapshot_id, manifest


def _merge_observations(previous: dict, incoming: dict) -> dict:
    value = {**incoming}
    conflicts = set(previous.get("conflicts", []))
    for field in ("unadjusted", "adjusted"):
        if field == "adjusted" and previous["adjusted_as_of"] != incoming["adjusted_as_of"]:
            continue
        by_day = {row["date"]: row for row in previous[field]}
        for row in incoming[field]:
            old = by_day.get(row["date"])
            if (
                field == "unadjusted"
                and old is not None
                and any(old.get(k) != row.get(k) for k in ("open", "high", "low", "close", "volume"))
            ):
                conflicts.add(row["date"])
            else:
                by_day[row["date"]] = row
        value[field] = [by_day[day] for day in sorted(by_day)]
    value["conflicts"] = sorted(conflicts)
    value["previous_observation"] = digest(previous)
    value["violations"] = previous.get("violations", []) + incoming.get("violations", [])
    return value


def _publish(
    data_dir: Path, section: str, code: str, value: dict, *, anchor: str | None = None,
    expected_snapshot: str | None = None,
) -> str:
    baseline = ensure_baseline(data_dir)
    base = root(data_dir)
    with _series_write_lock(data_dir / "screener"):
        old = load_snapshot(data_dir)
        if expected_snapshot is not None and (old is None or old[0] != expected_snapshot):
            raise ValueError("검토 이후 스냅샷이 변경되어 정정 근거를 다시 확인해야 합니다")
        manifest = (
            old[1]
            if old
            else {"schema_version": 1, "baseline": baseline, "observations": {}, "quantity": {}, "adjusted_as_of": None}
        )
        if section == "observations" and code in manifest[section]:
            previous = read_object(data_dir, manifest[section][code])
            if previous["adjusted_as_of"] > value["adjusted_as_of"]:
                raise ValueError("새 관측의 수정 기준일이 현재 스냅샷보다 과거입니다")
            candidate = _write_object(base, value)
            value = {**_merge_observations(previous, value), "candidate_observation": candidate}
        identity = _write_object(base, value)
        if manifest.get(section, {}).get(code) == identity:
            return old[0]
        manifest = {
            **manifest, section: {**manifest.get(section, {}), code: identity}, "parent": old[0] if old else None,
        }
        if anchor is not None:
            manifest["adjusted_as_of"] = max(anchor, manifest["adjusted_as_of"] or anchor)
        if section == "observations" and value.get("confirmation"):
            manifest["daily_contract_required"] = True
        manifest["calendar"] = sorted(trading_days.trading_days(data_dir))
        roster = data_dir / "screener" / "stocks.parquet"
        import polars as pl  # noqa: PLC0415 — keep the metadata-only reader lightweight

        from hoga.api import symbols  # noqa: PLC0415 — cached master, no provider access

        etfs = symbols.all_etf_etn_codes()
        stocks = pl.read_parquet(roster)
        if etfs is not None:
            stocks = stocks.with_columns(pl.col("code").is_in(etfs).alias("is_etf"))
        manifest["etf_classification"] = "master" if etfs is not None else "legacy_roster"
        manifest["roster"] = _write_object(base, stocks.to_dicts())
        snapshot_id = _write_object(base, manifest)
        atomic_write_json(base / "current.json", {"id": snapshot_id})
        _sync_dir(base)
        return snapshot_id


def publish_share_evidence(data_dir: Path, evidence: ShareEvidence) -> str:
    """Explicit verified import. An empty list certifies only its stated interval."""
    return _publish(data_dir, "quantity", evidence.code, evidence.model_dump(mode="json"))


def publish_correction_reviews(data_dir: Path, reviews: dict[str, dict], *, expected_snapshot: str) -> str:
    """Publish a fully validated review batch once, keeping all observation and metadata identities."""
    base = root(data_dir)
    with _series_write_lock(data_dir / "screener"):
        current = load_snapshot(data_dir)
        if current is None or current[0] != expected_snapshot:
            raise ValueError("검토 이후 스냅샷이 변경되어 정정 근거를 다시 확인해야 합니다")
        manifest = current[1]
        for code, review in reviews.items():
            if (review.get("kind") != "screener_correction_review" or review.get("code") != code
                    or review.get("baseline") != manifest["baseline"]
                    or review.get("observation_id") != manifest["observations"].get(code)):
                raise ValueError("정정 묶음의 관측 바인딩이 다릅니다")
        identities = {code: _write_object(base, review) for code, review in reviews.items()}
        updated = {**manifest, "parent": current[0],
                   "corrections": {**manifest.get("corrections", {}), **identities}}
        identity = _write_object(base, updated)
        atomic_write_json(base / "current.json", {"id": identity})
        _sync_dir(base)
        return identity


def publish_pair(
    data_dir: Path,
    code: str,
    unadjusted: list[dict],
    adjusted: list[dict],
    *,
    adjusted_as_of: str,
    price_events: list[dict],
    observed_at: str,
    violations: list[dict] | None = None,
    provider_rows: dict[str, list[dict]] | None = None,
    confirmation: dict | None = None,
) -> str:
    """Keep valid observations even if legacy factor reconstruction rejects them.

    A new basis can replace derived prices, but conflicting unadjusted values
    remain separate observations; the resolver retains the imported originals.
    """
    if not re.fullmatch(r"[A-Z0-9]{6}", code):
        raise ValueError("Invalid code")
    anchor = dt.date.fromisoformat(adjusted_as_of)
    timestamp = dt.datetime.fromisoformat(observed_at)
    if timestamp.tzinfo is None:
        raise ValueError("관측 시각의 시간대가 필요합니다")
    for rows in (unadjusted, adjusted):
        dates = [dt.date.fromisoformat(row["date"]) for row in rows]
        if len(dates) != len(set(dates)) or any(day > anchor for day in dates):
            raise ValueError("관측 날짜 중복 또는 수정 기준일 이후의 데이터입니다")
    value = {
        "code": code,
        "instrument_id": f"stock:{code}",
        "venue": "KRX",
        "currency": "KRW",
        "source": "kiwoom:ka10081",
        "adjusted_as_of": adjusted_as_of,
        "observed_at": observed_at,
        "unadjusted": unadjusted,
        "adjusted": adjusted,
        "price_events": price_events,
        "violations": violations or [],
        "provider_rows": provider_rows or {},
    }
    if confirmation is not None:
        from hoga.api.screener_daily_confirmation import state  # noqa: PLC0415 — metadata avoids store cycle

        value["confirmation"] = confirmation
        state(value)
    return _publish(data_dir, "observations", code, value, anchor=adjusted_as_of)


def current_observation(data_dir: Path, observation: dict) -> dict:
    """Merged rows keep their old evidence; confirmation belongs to the new candidate only."""
    identity = observation.get("candidate_observation")
    return read_object(data_dir, identity) if identity else observation


@lru_cache(maxsize=32)
def _verify_file(path: Path, size: int, modified_ns: int, checksum: str):
    with path.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != checksum:
            raise ValueError("Legacy baseline checksum mismatch")


def baseline_path(data_dir: Path, manifest: dict, name: str) -> Path:
    if name not in (*_BASE_FILES, "calendar.json"):
        raise ValueError("Invalid baseline file")
    folder = root(data_dir) / "legacy" / _checked(manifest["baseline"])
    metadata = json.loads((folder / "manifest.json").read_text())
    if digest(metadata) != manifest["baseline"]:
        raise ValueError("Legacy baseline identity mismatch")
    path = folder / name
    stat = path.stat()
    _verify_file(path, stat.st_size, stat.st_mtime_ns, metadata["files"][name])
    return path


def snapshot_calendar(data_dir: Path, manifest: dict) -> list[str]:
    if "calendar" in manifest:
        return manifest["calendar"]
    return json.loads(baseline_path(data_dir, manifest, "calendar.json").read_text())
