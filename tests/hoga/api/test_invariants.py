"""Invariants catalog — pure-function checks on meta dicts."""
from __future__ import annotations

from hoga.api.invariants import (
    INVARIANTS,
    Severity,
    Violation,
    check,
)


# Field-encoding sanity references (HHMMSSmmm = HH*10_000_000 + MM*100_000 + SS*1000 + ms).
# Production session_open_ms / close_ms use this encoding — see
# hoga/api/disk_state.py:_SESSION_OPEN_MS = HogaMs(90000000)  # 09:00:00.000.
#   04:00:00.000 =  40_000_000 (open range floor)
#   09:00:00.000 =  90_000_000 (within open range 04:00-12:00)
#   12:00:00.000 = 120_000_000 (open range ceiling, close range floor)
#   12:30:00.000 = 123_000_000 (half-day close, within close range)
#   15:30:00.000 = 153_000_000 (within close range 12:00-18:00)
#   18:00:00.000 = 180_000_000 (close range ceiling)


def _healthy_meta() -> dict:
    return {
        "regular_session_open_ms": 90_000_000,   # 09:00:00.000 HHMMSSmmm
        "regular_session_close_ms": 153_000_000,  # 15:30:00.000 HHMMSSmmm
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 80,
    }


# --- Type smoke ---

def test_severity_has_two_levels() -> None:
    assert {s.value for s in Severity} == {"error", "warn"}


def test_violation_as_dict_serializes_all_fields() -> None:
    v = Violation("x.y", Severity.error, "msg", {"k": 1})
    assert v.as_dict() == {
        "invariant_id": "x.y",
        "severity": "error",
        "message": "msg",
        "ctx": {"k": 1},
    }


def test_catalog_has_five_invariants() -> None:
    assert len(INVARIANTS) == 5
    assert {inv.id for inv in INVARIANTS} == {
        "meta.close_after_open",
        "meta.open_in_kst_range",
        "meta.close_in_kst_range",
        "collection.finished",
        "collection.unique_events_ratio",
    }


# --- Healthy path ---

def test_check_returns_empty_for_healthy_meta() -> None:
    assert check(_healthy_meta()) == []


# --- error: meta.close_after_open ---

def test_close_after_open_fires_when_close_le_open() -> None:
    meta = _healthy_meta() | {"regular_session_close_ms": 0}
    violations = [v for v in check(meta) if v.invariant_id == "meta.close_after_open"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.error
    assert violations[0].ctx["open_ms"] == 90_000_000
    assert violations[0].ctx["close_ms"] == 0


# --- error: meta.open_in_kst_range ---

def test_open_in_kst_range_fires_when_open_too_early() -> None:
    # 03:59:59.999 < 04:00:00.000 floor (HHMMSSmmm encoding)
    meta = _healthy_meta() | {"regular_session_open_ms": 39_999_999}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.open_in_kst_range" in ids


def test_open_in_kst_range_fires_when_open_too_late() -> None:
    # 12:00:00.001 > 12:00:00.000 ceiling (HHMMSSmmm encoding)
    meta = _healthy_meta() | {"regular_session_open_ms": 120_000_001}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.open_in_kst_range" in ids


# --- error: meta.close_in_kst_range ---

def test_close_in_kst_range_fires_when_close_zero() -> None:
    meta = _healthy_meta() | {"regular_session_close_ms": 0}
    ids = [v.invariant_id for v in check(meta)]
    # Both close_after_open AND close_in_kst_range fire — that's intended.
    assert "meta.close_in_kst_range" in ids


def test_close_in_kst_range_accepts_half_day_close() -> None:
    # 12:30 KST half-day close — 123_000_000 is within [120_000_000, 180_000_000]
    meta = _healthy_meta() | {"regular_session_close_ms": 123_000_000}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.close_in_kst_range" not in ids


# --- warn: collection.finished ---

def test_collection_finished_fires_when_complete_false() -> None:
    meta = _healthy_meta() | {"collection_complete": False}
    violations = [v for v in check(meta) if v.invariant_id == "collection.finished"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.warn


# --- warn: collection.unique_events_ratio ---

def test_unique_events_ratio_fires_below_50_percent() -> None:
    # 1553 events from 4132 pages = 37% < 50% — the real 5/18 case.
    meta = _healthy_meta() | {"pages_collected": 4132, "total_unique_events": 1553}
    violations = [v for v in check(meta) if v.invariant_id == "collection.unique_events_ratio"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.warn


def test_unique_events_ratio_passes_at_50_percent() -> None:
    meta = _healthy_meta() | {"pages_collected": 100, "total_unique_events": 50}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids


def test_unique_events_ratio_passes_when_pages_zero() -> None:
    # Empty capture is a different failure mode — don't double-flag.
    meta = _healthy_meta() | {"pages_collected": 0, "total_unique_events": 0}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids


def test_unique_events_ratio_skips_tiny_captures() -> None:
    """Stagnation needs ≥20 pages to be a meaningful signal — fewer pages
    carry no information regardless of the events count (test fixtures,
    very short trading days, halts all fall here)."""
    # pages=1 (e.g. tiny_tsv parser fixture) with any events count → skip.
    meta = _healthy_meta() | {"pages_collected": 1, "total_unique_events": 9}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids
    # pages=19 (just below threshold) also skips.
    meta = _healthy_meta() | {"pages_collected": 19, "total_unique_events": 1}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids
    # pages=20 (at threshold) WITH low ratio fires.
    meta = _healthy_meta() | {"pages_collected": 20, "total_unique_events": 5}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" in ids


# --- Legacy meta absorption ---

def test_legacy_meta_without_optional_keys_does_not_error() -> None:
    # Older meta lacks the optional keys (collection_complete, pages_collected).
    # Invariants must absorb absence via .get() — no KeyError.
    legacy = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
    }
    violations = check(legacy)
    ids = {v.invariant_id for v in violations}
    # collection.finished defaults to False → fires (warn)
    assert "collection.finished" in ids
    # unique_events_ratio uses .get(..., 0) → pages=0 → skip per above
    assert "collection.unique_events_ratio" not in ids


def test_meta_without_session_keys_does_not_fire_kst_range_invariants() -> None:
    """Key-presence semantics: missing key → invariant skips (legacy meta is silent).

    Old test fixtures across the codebase write meta.json with only
    {collection_complete, is_partial} and no session bounds. Those must
    classify based on collection_complete alone — the range invariants
    must not fire (otherwise classify_from_meta returns INVALID and breaks
    every consumer's test fixture).
    """
    minimal = {"collection_complete": True, "is_partial": False}
    violations = check(minimal)
    ids = {v.invariant_id for v in violations}
    # Range invariants have no key to check — they must not fire.
    assert "meta.open_in_kst_range" not in ids
    assert "meta.close_in_kst_range" not in ids
    # close_after_open also needs both keys present — must not fire.
    assert "meta.close_after_open" not in ids
    # collection_complete is True → collection.finished does not fire either.
    assert "collection.finished" not in ids
    # The minimal meta is fully clean.
    assert violations == []


# --- Regression fixture: real 5/18 003490 meta on disk ---

def test_real_20260518_003490_fires_expected_invariants() -> None:
    real = {
        "code": "003490",
        "name": "대한항공",
        "regular_session_open_ms": 90_000_000,   # production HHMMSSmmm encoding
        "regular_session_close_ms": 0,            # ← upstream stagnation artefact
        "collection_complete": False,
        "is_partial": False,
        "pages_collected": 4132,
        "total_unique_events": 1553,
    }
    fired = {v.invariant_id for v in check(real)}
    assert fired == {
        "meta.close_after_open",          # error
        "meta.close_in_kst_range",        # error
        "collection.finished",            # warn
        "collection.unique_events_ratio",  # warn
    }


def test_real_20260520_005930_healthy_meta_fires_nothing() -> None:
    """Regression: every healthy production day must remain integral.

    This is the bug that nearly shipped — earlier (ms-since-midnight) boundaries
    fired meta.open_in_kst_range + meta.close_in_kst_range against this exact
    shape, which would have excluded EVERY captured Stock-Date from the chart.
    """
    healthy = {
        "code": "005930",
        "name": "삼성전자",
        "regular_session_open_ms": 90_000_000,    # 09:00 HHMMSSmmm
        "regular_session_close_ms": 153_000_000,  # 15:30 HHMMSSmmm
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 200,
        "total_unique_events": 180,
    }
    assert check(healthy) == []


def test_meta_invariants_alias_exists_for_backward_compat() -> None:
    """ADR-0020 §3c: INVARIANTS stays as alias for META_INVARIANTS."""
    from hoga.api.invariants import INVARIANTS, META_INVARIANTS
    assert INVARIANTS is META_INVARIANTS
    assert len(META_INVARIANTS) == 5  # unchanged catalog


def test_series_invariants_catalog_exists_and_is_populated() -> None:
    """Scaffolding present and registered rules (3 series invariants land in
    Tasks 3-5 of the series-level invariants plan)."""
    from hoga.api.invariants import SERIES_INVARIANTS
    assert len(SERIES_INVARIANTS) >= 1
    assert all(hasattr(inv, "id") for inv in SERIES_INVARIANTS)


def test_stock_date_artifacts_accepts_optional_fields() -> None:
    """Partial loading: any of candles/snapshots/trades may be None."""
    from hoga.api.invariants import StockDateArtifacts
    a = StockDateArtifacts(meta={})
    assert a.meta == {}
    assert a.candles is None
    assert a.snapshots is None
    assert a.trades is None

    b = StockDateArtifacts(meta={"k": 1}, candles=[])
    assert b.candles == []


def test_check_series_returns_empty_when_catalog_empty() -> None:
    from hoga.api.invariants import StockDateArtifacts, check_series
    assert check_series(StockDateArtifacts(meta={})) == []
