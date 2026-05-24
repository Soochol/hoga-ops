"""Invariants catalog — pure-function checks on meta dicts."""
from __future__ import annotations

from hoga.api.invariants import (
    INVARIANTS,
    Invariant,
    Severity,
    Violation,
    check,
)


# Field-encoding sanity references (HHMMSS-ms):
# 09:00:00.000 = 90_000_000 (within open range 04:00-12:00)
# 15:30:00.000 = 153_000_000 (within close range 12:00-18:00)
# 12:30:00.000 = 123_000_000 (half-day close, within close range)


def _healthy_meta() -> dict:
    return {
        "regular_session_open_ms": 32_400_000,  # 09:00:00 in ms since midnight
        "regular_session_close_ms": 55_800_000,  # 15:30:00 in ms since midnight
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
    assert violations[0].ctx["open_ms"] == 32_400_000
    assert violations[0].ctx["close_ms"] == 0


# --- error: meta.open_in_kst_range ---

def test_open_in_kst_range_fires_when_open_too_early() -> None:
    meta = _healthy_meta() | {"regular_session_open_ms": 14_399_999}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.open_in_kst_range" in ids


def test_open_in_kst_range_fires_when_open_too_late() -> None:
    meta = _healthy_meta() | {"regular_session_open_ms": 43_200_001}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.open_in_kst_range" in ids


# --- error: meta.close_in_kst_range ---

def test_close_in_kst_range_fires_when_close_zero() -> None:
    meta = _healthy_meta() | {"regular_session_close_ms": 0}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.close_in_kst_range" in ids


def test_close_in_kst_range_accepts_half_day_close() -> None:
    meta = _healthy_meta() | {"regular_session_close_ms": 45_000_000}  # 12:30:00 in ms
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
    meta = _healthy_meta() | {"pages_collected": 4132, "total_unique_events": 1553}
    violations = [v for v in check(meta) if v.invariant_id == "collection.unique_events_ratio"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.warn


def test_unique_events_ratio_passes_at_50_percent() -> None:
    meta = _healthy_meta() | {"pages_collected": 100, "total_unique_events": 50}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids


def test_unique_events_ratio_passes_when_pages_zero() -> None:
    meta = _healthy_meta() | {"pages_collected": 0, "total_unique_events": 0}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids


# --- Legacy meta absorption ---

def test_legacy_meta_without_optional_keys_does_not_error() -> None:
    legacy = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
    }
    violations = check(legacy)
    ids = {v.invariant_id for v in violations}
    assert "collection.finished" in ids
    assert "collection.unique_events_ratio" not in ids


# --- Regression fixture: real 5/18 003490 meta ---

def test_real_20260518_003490_fires_expected_invariants() -> None:
    real = {
        "code": "003490",
        "name": "대한항공",
        "regular_session_open_ms": 32_400_000,  # 09:00:00 in ms (HHMMSSmmm 90000000)
        "regular_session_close_ms": 0,
        "collection_complete": False,
        "is_partial": False,
        "pages_collected": 4132,
        "total_unique_events": 1553,
    }
    fired = {v.invariant_id for v in check(real)}
    assert fired == {
        "meta.close_after_open",
        "meta.close_in_kst_range",
        "collection.finished",
        "collection.unique_events_ratio",
    }
