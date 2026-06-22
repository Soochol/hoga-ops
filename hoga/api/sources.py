"""Source-name resolution for /api routes."""
from __future__ import annotations

from typing import TYPE_CHECKING, Literal, cast

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

SourceName = Literal["hogaplay", "kis_live", "kis_api"]
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


def ordered_sources(policy: str) -> tuple[SourceName, ...]:
    try:
        return _POLICY_ORDER[policy]
    except KeyError as e:
        raise ValueError(f"unknown source policy: {policy}") from e


def resolve_source(engine: "QueryEngine", date: str, code: str, pref: str) -> SourceName:
    from hoga.api.disk_state import DiskState, classify_stock_date

    order = ordered_sources(pref)
    sd_dir = engine.data_dir / "parquet" / date / code
    per_source = classify_stock_date(sd_dir)
    healthy = {
        source
        for source, classification in per_source.items()
        if classification.state != DiskState.INVALID
    }
    for source in order:
        if source in healthy:
            return source
    return cast(SourceName, order[0])
