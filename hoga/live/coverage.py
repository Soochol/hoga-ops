"""Live Coverage planning for WS capture and Viewed-Code Poll exclusion."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api.models import LiveStoragePolicy, WatchlistDocument
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


@dataclass(frozen=True)
class LiveStorageTargets:
    ws_targets: tuple[str, ...]
    kis_api_targets: tuple[str, ...]
    capture_candidates: tuple[str, ...]


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order contiguous allocation: account k = codes[k*W:(k+1)*W]."""
    return [codes[k * _PER_ACCOUNT_MAX:(k + 1) * _PER_ACCOUNT_MAX] for k in range(n)]


def plan_live_coverage(
    ordered_codes: list[str],
    *,
    n_configured: int,
    per_account_max: int | None = None,
) -> LiveCoveragePlan:
    if per_account_max is None:
        per_account_max = _PER_ACCOUNT_MAX
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


def plan_storage_targets(
    capture_candidates: list[str],
    *,
    n_configured: int,
    storage_policy: LiveStoragePolicy,
    current_ws_live_set: tuple[str, ...] = (),
    per_account_max: int | None = None,
    rest_extra_candidates: tuple[str, ...] = (),
) -> LiveStorageTargets:
    """Split capture_candidates into WS slots + REST 30s remainder.

    rest_extra_candidates (ADR-0097: heatmap codes) never compete for WS
    slots — they are appended to kis_api_targets only, after dedup against
    capture_candidates, and are dropped entirely under ws_only (the policy
    forbids KIS API storage, not just watchlist REST spillover).
    """
    if per_account_max is None:
        per_account_max = _PER_ACCOUNT_MAX
    candidates = tuple(capture_candidates)
    candidate_set = set(candidates)
    rest_extra = tuple(
        code for code in dict.fromkeys(rest_extra_candidates) if code not in candidate_set
    )
    max_codes = per_account_max * n_configured
    if storage_policy == "rest_only":
        return LiveStorageTargets(
            ws_targets=(),
            kis_api_targets=candidates + rest_extra,
            capture_candidates=candidates,
        )
    ws_targets = candidates[:max_codes]
    if storage_policy == "ws_only":
        rest_targets: tuple[str, ...] = ()
    else:
        ws_set = set(ws_targets)
        rest_targets = tuple(code for code in candidates if code not in ws_set) + rest_extra
    return LiveStorageTargets(
        ws_targets=ws_targets,
        kis_api_targets=rest_targets,
        capture_candidates=candidates,
    )


def _known_symbol_codes() -> set[str]:
    from hoga.api import symbols as _symbols  # noqa: PLC0415

    return {h.code for h in _symbols.search("", limit=10_000)}


def _compute_capture_candidates(data_dir: Path) -> list[str]:
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    known = _known_symbol_codes()
    doc = load_document(data_dir)
    candidates = capture_ordered_codes(doc, known_codes=known if known else None)
    if known:
        all_enabled = capture_ordered_codes(doc)
        dropped = tuple(code for code in all_enabled if code not in known)
        if dropped:
            _log.warning("live.capture.codes_unknown dropped=%r", list(dropped))
    return candidates


def _compute_heatmap_rest_extras(data_dir: Path) -> tuple[str, ...]:
    """Heatmap codes as REST-only capture extras (ADR-0097).

    Document order preserved; symbol-master filter mirrors
    _compute_capture_candidates (cold cache keeps all)."""
    from hoga.api.heatmap import load_heatmap  # noqa: PLC0415

    codes = list(dict.fromkeys(entry.code for entry in load_heatmap(data_dir)))
    known = _known_symbol_codes()
    if not known:
        return tuple(codes)
    dropped = [code for code in codes if code not in known]
    if dropped:
        _log.warning("live.capture.heatmap_codes_unknown dropped=%r", dropped)
    return tuple(code for code in codes if code in known)


def _compute_ws_targets(
    data_dir: Path,
    n_configured: int = 1,
    storage_policy: LiveStoragePolicy = "ws_plus_rest",
) -> list[str]:
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        storage_policy=storage_policy,
    )
    return list(targets.ws_targets)


def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    """Load Watchlist and return dynamic-N WS targets with current default policy."""
    return _compute_ws_targets(data_dir, n_configured, "ws_plus_rest")


def live_set_codes(doc: WatchlistDocument) -> list[str]:
    """Live Set compatibility helper based on capture-enabled folder order."""
    return capture_ordered_codes(doc)[:LIVE_SET_MAX_CODES]
