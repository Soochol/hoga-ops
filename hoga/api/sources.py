"""Source-name resolution for /api routes.

The previous incarnation was `hoga.api.bundle._resolve_source`. Promoted
to a public module so the per-spot endpoints (/api/orderbook,
/api/brokers/series) can honor `?source_pref=` without back-importing
from bundle.py.

ADR-0039 (preference + fallback) defines the semantics. ADR-0044
documents the /live hover-spot boundary that motivated this promotion.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Literal, cast

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

SourceName = Literal["hogaplay", "kis_live"]


def resolve_source(engine: "QueryEngine", date: str, code: str, pref: SourceName) -> SourceName:
    """Return the source name actually present on disk for this (date, code).

    Prefers ``pref`` if its meta.json exists; otherwise picks the first other
    source that does. Returns ``pref`` even if nothing exists so the
    downstream StockDateNotFound surfaces naturally.

    Reads only ``engine.data_dir`` (a real ``Path`` in production and in tests,
    which back the engine with a ``tmp_path`` data_dir) — no other engine state,
    so tests need no full QueryEngine, just an object carrying ``data_dir``.
    """
    from hoga.api.disk_state import classify_stock_date

    sd_dir = engine.data_dir / "parquet" / date / code
    per_source = classify_stock_date(sd_dir)
    if pref in per_source:
        return pref
    if per_source:
        # classify_stock_date keys are dir names — guaranteed SourceName by
        # ADR-0037's source-subfolder layout. Cast narrows the dict[str, ...]
        # return without runtime cost.
        return cast(SourceName, next(iter(per_source)))
    return pref
