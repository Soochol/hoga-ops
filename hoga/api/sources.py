"""Source-name resolution for /api routes."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, cast

from hoga.api.disk_state import (
    Classification,
    DiskState,
    classify_from_meta,
    classify_stock_date,
)

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

SourceName = Literal["hogaplay", "kis_live", "kis_api"]
MissingReason = Literal["stock_date_missing", "source_missing"]
SourcePolicy = Literal[
    "hogaplay",
    "kis_live",
    "kis_api",
    "hogaplay_first",
    "kis_ws_first",
    "kis_api_first",
]

_POLICY_ORDER: dict[str, tuple[SourceName, ...]] = {
    "hogaplay": ("hogaplay", "kis_live", "kis_api"),
    "hogaplay_first": ("hogaplay", "kis_live", "kis_api"),
    "kis_live": ("kis_live", "kis_api", "hogaplay"),
    "kis_ws_first": ("kis_live", "kis_api", "hogaplay"),
    "kis_api": ("kis_api", "kis_live", "hogaplay"),
    "kis_api_first": ("kis_api", "kis_live", "hogaplay"),
}


@dataclass(frozen=True, slots=True)
class SourceResolution:
    """Resolved read-path Source plus the disk facts that made it win.

    ``source`` is always populated so callers can echo a Source honestly even
    when the Stock-Date is absent. ``path`` and ``classification`` are populated
    only when the winning Source has a readable ``meta.json`` on disk.
    """

    source: SourceName
    path: Path | None
    classification: Classification | None
    missing_reason: MissingReason | None = None


def ordered_sources(policy: str) -> tuple[SourceName, ...]:
    try:
        return _POLICY_ORDER[policy]
    except KeyError as e:
        raise ValueError(f"unknown source policy: {policy}") from e


def _classify_flat_legacy_meta(stock_date_dir: Path) -> Classification | None:
    """Classify pre-ADR-0037 flat Stock-Date layout when present."""
    meta_path = stock_date_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return Classification(state=DiskState.INVALID)
    return classify_from_meta(meta)


def resolve_source_result(
    engine: QueryEngine, date: str, code: str, pref: str,
) -> SourceResolution:
    order = ordered_sources(pref)
    sd_dir = engine.data_dir / "parquet" / date / code
    if not isinstance(sd_dir, Path):
        return SourceResolution(
            source=order[0],
            path=None,
            classification=None,
            missing_reason="stock_date_missing",
        )
    if not sd_dir.exists():
        return SourceResolution(
            source=order[0],
            path=None,
            classification=None,
            missing_reason="stock_date_missing",
        )

    per_source = classify_stock_date(sd_dir)

    # Legacy flat layout has no source subdirectory. Preserve the old contract:
    # the requested first Source wins, and QueryEngine resolves it to sd_dir.
    flat_classification = _classify_flat_legacy_meta(sd_dir)
    if not per_source and flat_classification is not None:
        return SourceResolution(
            source=order[0],
            path=sd_dir,
            classification=flat_classification,
        )

    healthy = {
        source
        for source, classification in per_source.items()
        if classification.state != DiskState.INVALID
    }
    for source in order:
        if source in healthy:
            return SourceResolution(
                source=source,
                path=sd_dir / source,
                classification=per_source[source],
            )

    source = cast(SourceName, order[0])
    if source in per_source:
        return SourceResolution(
            source=source,
            path=sd_dir / source,
            classification=per_source[source],
        )
    return SourceResolution(
        source=source,
        path=None,
        classification=None,
        missing_reason="source_missing",
    )


def resolve_source(engine: QueryEngine, date: str, code: str, pref: str) -> SourceName:
    return resolve_source_result(engine, date, code, pref).source
