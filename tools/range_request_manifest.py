"""Strict, reproducible request manifests for Range performance measurements."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from hoga.api.models import validate_bucket_ms
from hoga.api.params import CODE_PATTERN
from hoga.api.timeenc import unix_ms_to_hhmmssms

SourcePolicy = Literal[
    "hogaplay",
    "kis_live",
    "kiwoom_live",
    "kis_api",
    "hogaplay_first",
    "kis_ws_first",
    "kiwoom_ws_first",
    "kis_api_first",
    "completeness_first",
]
RangeMode = Literal["hoga", "sidecar", "candles"]
_BROKER_START_MIN = 900
_BROKER_START_MAX = 1520
_MINUTES_PER_HOUR = 60


class RangeRequestOptions(BaseModel):
    """Every non-identity ``build_range_bundle`` request argument."""

    model_config = ConfigDict(extra="forbid", strict=True)

    bucket_ms: int
    source_pref: SourcePolicy
    mode: RangeMode
    broker_late_entries_enabled: bool
    broker_late_entry_start_hhmm: int
    volume_distribution_bins: int | None = Field(ge=5, le=30)
    trade_volume_poc_bins: int | None = Field(ge=5, le=30)
    volume_distribution_price_min: int | None = Field(ge=0)
    volume_distribution_price_max: int | None = Field(ge=0)
    volume_distribution_cutoff_ms: int | None = Field(ge=0)
    ask_peaks_enabled: bool
    bid_peaks_enabled: bool
    program_trade_enabled: bool
    trade_volume_poc_enabled: bool
    depth_heatmap_enabled: bool
    depth_delta_enabled: bool

    @field_validator("bucket_ms")
    @classmethod
    def _validate_bucket(cls, value: int) -> int:
        return validate_bucket_ms(value)

    @field_validator("broker_late_entry_start_hhmm")
    @classmethod
    def _validate_broker_start(cls, value: int) -> int:
        hour, minute = divmod(value, 100)
        normalized = hour * 100 + minute
        if (
            minute >= _MINUTES_PER_HOUR
            or normalized < _BROKER_START_MIN
            or normalized > _BROKER_START_MAX
        ):
            raise ValueError(
                "broker_late_entry_start_hhmm must be between 900 and 1520"
            )
        return value

    @model_validator(mode="after")
    def _validate_related_options(self) -> RangeRequestOptions:
        price_min = self.volume_distribution_price_min
        price_max = self.volume_distribution_price_max
        if (price_min is None) != (price_max is None):
            raise ValueError(
                "volume_distribution_price_min/max must be supplied together"
            )
        if price_min is not None and price_max is not None and price_max < price_min:
            raise ValueError("volume_distribution_price_max < volume_distribution_price_min")
        if self.volume_distribution_cutoff_ms is not None and self.mode != "sidecar":
            raise ValueError("volume_distribution_cutoff_ms requires mode=sidecar")
        return self


class RangeRequestManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[1]
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    request: RangeRequestOptions

    def normalized(self) -> dict[str, object]:
        return self.model_dump(mode="json")

    def canonical_json(self) -> str:
        return json.dumps(
            self.normalized(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def sha256(self) -> str:
        return hashlib.sha256(self.canonical_json().encode()).hexdigest()

    def request_kwargs(
        self,
        *,
        code: str,
        from_date: str,
        to_date: str,
    ) -> dict[str, object]:
        if re.fullmatch(CODE_PATTERN, code) is None:
            raise ValueError("code does not match the API ticker grammar")
        try:
            parsed_from = datetime.strptime(from_date, "%Y%m%d")
            parsed_to = datetime.strptime(to_date, "%Y%m%d")
        except ValueError as exc:
            raise ValueError("from_date/to_date must use YYYYMMDD") from exc
        if parsed_to < parsed_from:
            raise ValueError("from_date must not be after to_date")
        if (
            self.request.volume_distribution_cutoff_ms is not None
            and from_date != to_date
        ):
            raise ValueError(
                "volume_distribution_cutoff_ms requires a single Stock-Date range"
            )
        if self.request.volume_distribution_cutoff_ms is not None:
            unix_ms_to_hhmmssms(
                from_date,
                self.request.volume_distribution_cutoff_ms,
            )
        return {
            "code": code,
            "from_date": from_date,
            "to_date": to_date,
            **self.request.model_dump(mode="python"),
        }


@dataclass(frozen=True, slots=True)
class LoadedRequestManifest:
    manifest: RangeRequestManifest
    source_name: str

    def metadata(self) -> dict[str, object]:
        return {
            "configuration_name": self.manifest.name,
            "request_manifest_name": self.source_name,
            "request_manifest_sha256": self.manifest.sha256(),
            "request_manifest": self.manifest.normalized(),
        }


def load_request_manifest(path: Path) -> LoadedRequestManifest:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"cannot read request manifest {path.name}") from exc
    try:
        manifest = RangeRequestManifest.model_validate_json(raw)
    except ValueError:
        raise
    return LoadedRequestManifest(manifest=manifest, source_name=path.name)
