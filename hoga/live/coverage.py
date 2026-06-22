"""Live Coverage planning for WS capture and Viewed-Code Poll exclusion."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api.models import WatchlistDocument
from hoga.api.watchlist_projection import capture_ordered_codes, display_ordered_codes

from .ws_fields import TRS

_log = logging.getLogger(__name__)

KIS_WS_MAX_REGISTRATIONS = 30
TRS_PER_CODE = len(TRS)
_PER_ACCOUNT_MAX = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE
LIVE_SET_MAX_CODES = _PER_ACCOUNT_MAX


@dataclass(frozen=True)
class LiveCoveragePlan:
    live_set: tuple[str, ...]
    partitions: tuple[tuple[str, ...], ...]
    poller_excluded: frozenset[str]


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order contiguous allocation: account k = codes[k*W:(k+1)*W]."""
    return [codes[k * _PER_ACCOUNT_MAX:(k + 1) * _PER_ACCOUNT_MAX] for k in range(n)]


def plan_live_coverage(
    ordered_codes: list[str],
    *,
    n_configured: int,
    per_account_max: int = _PER_ACCOUNT_MAX,
) -> LiveCoveragePlan:
    max_codes = per_account_max * n_configured
    live_set = tuple(ordered_codes[:max_codes])
    partitions = tuple(
        tuple(live_set[k * per_account_max:(k + 1) * per_account_max])
        for k in range(n_configured)
    )
    return LiveCoveragePlan(
        live_set=live_set,
        partitions=partitions,
        poller_excluded=frozenset(live_set),
    )


def select_live_set(
    ordered_codes: list[str],
    *,
    known_codes: set[str],
    max_codes: int,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Apply Symbol Master filter then truncate. Empty known set means cold-cache fallback."""
    if not known_codes:
        return tuple(ordered_codes[:max_codes]), ()
    dropped = tuple(code for code in ordered_codes if code not in known_codes)
    selected = tuple(code for code in ordered_codes if code in known_codes)
    return selected[:max_codes], dropped


def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    """Load Watchlist, filter unknown symbols, and return dynamic-N Live Set."""
    from hoga.api import symbols as _symbols  # noqa: PLC0415
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    ordered = capture_ordered_codes(load_document(data_dir))
    known = {h.code for h in _symbols.search("", limit=10_000)}
    selected, dropped = select_live_set(
        ordered,
        known_codes=known,
        max_codes=_PER_ACCOUNT_MAX * n_configured,
    )
    if dropped:
        _log.warning("live.stream.codes_unknown dropped=%r", list(dropped))
    return list(selected)


def live_set_codes(doc: WatchlistDocument) -> list[str]:
    """Live Set = display-order top LIVE_SET_MAX_CODES. Test helper."""
    return capture_ordered_codes(doc)[:LIVE_SET_MAX_CODES]
